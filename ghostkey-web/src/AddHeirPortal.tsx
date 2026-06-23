/**
 * Add-a-heir modal.
 *
 * An owner who already has a vault can add another heir at any time
 * without re-running setup. Each heir is its own vault row sharing the
 * same owner key — so this is a focused mini-setup:
 *
 *   1. The owner types their password (the only secret).
 *   2. We fetch a sibling vault's sealed blobs and `unsealOwner()` to
 *      recover the owner xprv in this tab. This both proves the
 *      password and gives us the key needed to sign the video and seal
 *      the new vault's blobs.
 *   3. The owner's *public* identity (xpub + master fingerprint) is
 *      reused verbatim from the sibling's descriptor fragment — the
 *      account-level xprv can't reproduce the master fingerprint, so we
 *      pass the sibling's `[fp/86'/0'/0']xpub` as an origin-tagged
 *      `owner.xpub`. The server then rebuilds an *identical* owner
 *      branch, which is how the new vault joins the group (and passes
 *      the same-owner-email guard).
 *   4. We mint a fresh heir key + claim token, seal everything under
 *      the same password, and POST a new vault that reuses the group's
 *      cadence / waiting period.
 *
 * The new heir runs on its own clock anchored to *now* (the server sets
 * its first deadline at creation), so heirs added at different times
 * have independent countdowns — exactly as intended. A single check-in
 * on the dashboard still resets every sibling at once.
 */
import { useState } from "react";

import { Button, Field, InlineAlert } from "./ui";
import { ApiError, api, type VaultView } from "./api";
import {
  b64encode,
  hashEmailForLookup,
  sealVaultSecrets,
  sealWithKey,
  unsealOwner,
} from "./crypto/sealing";
import { generateParty, wipe, type Network } from "./crypto/keygen";
import { prepareVideo } from "./crypto/video";
import { randomBytes } from "@noble/hashes/utils.js";
import { getVaultMeta, saveVaultMeta, setActiveVaultId } from "./vaultStore";
import { VideoMessageRecorder, type RecordedClip } from "./VideoMessageRecorder";

const PLACEHOLDER_OWNER_TOKEN = "ghostkey-placeholder-owner-token-v1";

type Channel = "email" | "sms" | "whatsapp";

interface Props {
  /** The active group vault we unseal owner credentials from. */
  siblingVaultId: string;
  /** The active vault's server view — source of network + cadence so
   *  the new heir inherits identical owner settings. */
  vault: VaultView;
  /** Existing group id, or undefined for a solo vault about to become
   *  a group of two. */
  groupId?: string;
  /** Owner's email (the group's `owner_email_hash` source). */
  ownerEmail: string;
  onClose: () => void;
  /** Called after the new heir vault is created and persisted. The
   *  parent reloads so the dashboard re-renders against the group. */
  onAdded: () => void;
}

type Phase =
  | { kind: "form" }
  | { kind: "unlocking"; pct: number }
  | { kind: "creating" }
  | { kind: "done"; heirName: string; address: string | null };

/** Strip the `/<chain>/*` receive-path suffix off a descriptor key
 *  fragment, leaving an origin-tagged xpub the server accepts as
 *  `owner.xpub`. e.g. `[fp/86'/0'/0']xpub.../0/*` → `[fp/86'/0'/0']xpub...` */
function fragmentToOriginTaggedXpub(fragment: string): string {
  return fragment.replace(/\/\d+\/\*$/, "");
}

export function AddHeirPortal({
  siblingVaultId,
  vault,
  groupId,
  ownerEmail,
  onClose,
  onAdded,
}: Props) {
  const [heirName, setHeirName] = useState("");
  const [contact, setContact] = useState("");
  const [channel, setChannel] = useState<Channel>("email");
  const [password, setPassword] = useState("");
  const [videoClip, setVideoClip] = useState<RecordedClip | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "form" });
  const [error, setError] = useState<string | null>(null);

  const busy = phase.kind === "unlocking" || phase.kind === "creating";

  function validate(): string | null {
    if (!heirName.trim()) return "Give this heir a name.";
    if (!contact.trim()) return "Enter how to reach this heir.";
    if (channel === "email" && !/^.+@.+\..+$/.test(contact.trim())) {
      return "That email looks off. Double-check it.";
    }
    if (!password) return "Enter your password to authorise this.";
    return null;
  }

  async function onSubmit() {
    setError(null);
    const v = validate();
    if (v) {
      setError(v);
      return;
    }

    // (1) Recover the owner key + the group's public owner identity.
    setPhase({ kind: "unlocking", pct: 0 });
    let ownerXprv: string;
    let ownerXpubTagged: string;
    try {
      const blobs = await api.getSealedBlobs(siblingVaultId);
      if (!blobs.owner_xpub_fragment_external) {
        setPhase({ kind: "form" });
        setError(
          "This vault predates the add-a-heir feature. Add this heir from " +
            "the device where you originally set it up.",
        );
        return;
      }
      ownerXpubTagged = fragmentToOriginTaggedXpub(
        blobs.owner_xpub_fragment_external,
      );
      const unsealed = await unsealOwner({
        password,
        passwordSalt: blobs.password_salt_b64,
        memKiB: blobs.password_kdf_mem_kib,
        iters: blobs.password_kdf_iters,
        ownerXprvBlob: {
          v: 1,
          ct: blobs.owner_xprv_ct_b64,
          nonce: blobs.owner_xprv_nonce_b64,
        },
        ownerTokenBlob: {
          v: 1,
          ct: blobs.owner_token_ct_b64,
          nonce: blobs.owner_token_nonce_b64,
        },
        onProgress: (pct) =>
          setPhase({ kind: "unlocking", pct: Math.round(pct * 100) }),
      });
      ownerXprv = unsealed.ownerXprv;
    } catch (e) {
      setPhase({ kind: "form" });
      setError(
        e instanceof ApiError
          ? e.message
          : "That password didn't unlock the vault. Check it and try again.",
      );
      return;
    }

    // (2) Mint this heir's key + claim token and create the vault.
    setPhase({ kind: "creating" });
    const network = vault.network as Network;
    const heirParty = generateParty(network);
    const claimToken = randomBytes(32);
    let ownerKek: Uint8Array | undefined;
    try {
      const sealed = await sealVaultSecrets({
        password,
        ownerXprv,
        heirXprv: heirParty.xprv,
        ownerToken: PLACEHOLDER_OWNER_TOKEN,
        claimTokenRaw: claimToken,
        keepOwnerKek: true,
      });
      ownerKek = sealed._owner_kek;

      const label = `${heirName.trim()}'s share`;
      const resp = await api.createVaultFromXpub({
        label,
        network: vault.network,
        owner: { xpub: ownerXpubTagged },
        heir: { xpub: heirParty.xpub, fingerprint: heirParty.fingerprint },
        timelock_blocks: vault.timelock_blocks,
        checkin_period_secs: vault.checkin_period_secs,
        grace_period_secs: vault.grace_period_secs,
        owner_contact: ownerEmail.trim(),
        owner_contact_channel: "email",
        heir_contact: JSON.stringify({
          name: heirName.trim(),
          contact: contact.trim(),
          channel,
        }),
        heir_contact_channel: channel,
        sealed: {
          password_salt_b64: sealed.password_salt,
          password_kdf_mem_kib: sealed.password_kdf_mem_kib,
          password_kdf_iters: sealed.password_kdf_iters,
          owner_xprv_ct_b64: sealed.owner_xprv.ct,
          owner_xprv_nonce_b64: sealed.owner_xprv.nonce,
          owner_token_ct_b64: sealed.owner_token.ct,
          owner_token_nonce_b64: sealed.owner_token.nonce,
          heir_xprv_ct_b64: sealed.heir_xprv.ct,
          heir_xprv_nonce_b64: sealed.heir_xprv.nonce,
          owner_email_hash: hashEmailForLookup(ownerEmail),
          claim_token_b64: b64encode(claimToken),
        },
        heir_derivation: null,
      });

      // (3) Re-seal the REAL owner token under the same password KEK so
      // cross-device sign-in to this new vault works. Best-effort.
      if (ownerKek) {
        try {
          const realSealed = sealWithKey(
            ownerKek,
            new TextEncoder().encode(resp.owner_token),
          );
          await api.sealOwnerToken(resp.id, resp.owner_token, {
            owner_token_ct_b64: realSealed.ct,
            owner_token_nonce_b64: realSealed.nonce,
          });
        } catch (e) {
          console.warn("owner-token re-seal failed for new heir", resp.id, e);
        }
      }

      // (4) Optional video, sealed under THIS heir's claim token and
      // signed with the owner key. Best-effort.
      if (videoClip) {
        try {
          const bytes = new Uint8Array(await videoClip.blob.arrayBuffer());
          const prepared = prepareVideo(ownerXprv, claimToken, bytes);
          await api.uploadVideo(resp.id, resp.owner_token, {
            ...prepared,
            mime: videoClip.mime,
            duration_ms: Math.round(videoClip.durationMs),
          });
        } catch (e) {
          console.warn("video upload failed for new heir", resp.id, e);
        }
      }

      // (5) Persist locally under the group id. If the sibling had no
      // group yet, mint one and back-fill it onto the sibling so the
      // dashboard renders them as one card.
      const gid = groupId ?? crypto.randomUUID();
      if (!groupId) {
        const sib = getVaultMeta(siblingVaultId);
        if (sib) saveVaultMeta({ ...sib, groupId: gid });
      }
      saveVaultMeta({
        id: resp.id,
        label,
        owner: { address: ownerEmail.trim() },
        heir: {
          name: heirName.trim(),
          email: channel === "email" ? contact.trim() : "",
          address: "",
        },
        createdAt: new Date().toISOString(),
        ownerToken: resp.owner_token,
        groupId: gid,
      });
      // Land on the new heir after the reload. If the sibling we added
      // from was already claimed, the dashboard would otherwise reopen
      // on its closed card — point it at the fresh, manageable heir.
      setActiveVaultId(resp.id);

      // (6) Fetch the receive address to show the owner where to fund
      // this heir's share. Best-effort.
      let address: string | null = null;
      try {
        address = (await api.getVaultAddress(resp.id)).address;
      } catch (e) {
        console.warn("address fetch failed for new heir", resp.id, e);
      }

      setPhase({ kind: "done", heirName: heirName.trim(), address });
    } catch (e) {
      setPhase({ kind: "form" });
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      wipe(claimToken);
      if (ownerKek) wipe(ownerKek);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-heir-title"
    >
      <div className="card relative w-full max-w-md p-6 max-h-[90vh] overflow-y-auto">
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          disabled={busy}
          className="absolute right-3 top-3 rounded-full p-2 text-muted hover:bg-surface-2 hover:text-[var(--text)]"
        >
          ✕
        </button>

        {phase.kind === "done" ? (
          <>
            <h2 id="add-heir-title" className="font-serif text-2xl">
              {phase.heirName} is now an heir ✓
            </h2>
            <p className="mt-2 text-sm text-muted">
              They share your check-in. A single check-in keeps
              every heir's plan alive. This heir has their own share: fund the
              address below with whatever you want them to inherit. Nothing is
              pooled with your other heirs.
            </p>
            {phase.address ? (
              <div className="mt-4">
                <p className="text-xs uppercase tracking-wider text-dim">
                  {phase.heirName}'s deposit address
                </p>
                <p className="mt-1 break-all font-mono text-sm text-[var(--text)]">
                  {phase.address}
                </p>
              </div>
            ) : (
              <p className="mt-4 text-sm text-muted">
                Open this heir from your dashboard to see their deposit address.
              </p>
            )}
            <div className="mt-6 flex justify-end">
              <Button onClick={onAdded}>Done</Button>
            </div>
          </>
        ) : (
          <>
            <h2 id="add-heir-title" className="font-serif text-2xl">
              Add Heir
            </h2>
            <p className="mt-2 text-sm text-muted">
              They get their own share and their own claim link. Just add their
              details and your password.
            </p>

            <div className="mt-5 space-y-4">
              <Field label="Their name">
                <input
                  className="input"
                  value={heirName}
                  onChange={(e) => setHeirName(e.target.value)}
                  placeholder="e.g. Ada"
                  disabled={busy}
                />
              </Field>

              <Field label="How to reach them">
                <div className="flex gap-2">
                  <select
                    className="input w-28"
                    value={channel}
                    onChange={(e) => setChannel(e.target.value as Channel)}
                    disabled={busy}
                    aria-label="Contact method"
                  >
                    <option value="email">Email</option>
                    <option value="sms">SMS</option>
                    <option value="whatsapp">WhatsApp</option>
                  </select>
                  <input
                    className="input flex-1"
                    value={contact}
                    onChange={(e) => setContact(e.target.value)}
                    type={channel === "email" ? "email" : "tel"}
                    inputMode={channel === "email" ? "email" : "tel"}
                    placeholder={
                      channel === "email" ? "them@example.com" : "+1 555 0100"
                    }
                    disabled={busy}
                  />
                </div>
              </Field>

              <div>
                <p className="text-xs uppercase tracking-wider text-dim">
                  Optional video message
                </p>
                <p className="mt-1 mb-2 text-xs text-muted">
                  A short clip only this heir can unlock. Proof the claim link
                  is really from you.
                </p>
                <VideoMessageRecorder
                  heirName={heirName.trim() || undefined}
                  onChange={setVideoClip}
                  disabled={busy}
                />
              </div>

              <Field label="Your password">
                <input
                  className="input"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  placeholder="The password you set up the vault with"
                  disabled={busy}
                />
              </Field>

              {phase.kind === "unlocking" ? (
                <div>
                  <p className="text-sm text-muted">
                    Setting things up… {phase.pct}%
                  </p>
                  <div className="mt-2 h-1.5 w-full overflow-hidden rounded bg-[var(--surface-2)]">
                    <div
                      className="h-full bg-[var(--accent)] transition-[width] duration-200"
                      style={{ width: `${Math.max(5, phase.pct)}%` }}
                    />
                  </div>
                </div>
              ) : null}

              {phase.kind === "creating" ? (
                <p className="text-sm text-muted">Creating this heir's plan…</p>
              ) : null}

              {error ? <InlineAlert tone="alarm">{error}</InlineAlert> : null}
            </div>

            <div className="mt-6 flex items-center justify-end gap-2">
              <Button variant="quiet" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button onClick={onSubmit} loading={busy} disabled={busy}>
                Add heir
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
