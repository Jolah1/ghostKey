/**
 * Sign-in portal — email + password unlock from any device.
 *
 * Replaces the legacy `CheckinPortal` (which required the user to know
 * the vault UUID and only worked on the device where the vault was
 * created). The lookup-by-id path lives on as `CheckinPortal` at
 * #/checkin-legacy for users with vaults created before the password
 * flow shipped.
 *
 * Flow:
 *
 *   1. User types email + password.
 *   2. Browser computes `hashEmailForLookup(email)` — SHA-256 over the
 *      lowercased, NFKC-normalised value. We POST the *hash*, never
 *      the plaintext email, so the server's index never sees raw
 *      addresses (`/vaults/find`).
 *   3. Server returns 0–N matching vault summaries. 0 → "no vault
 *      with that email"; 1 → auto-proceed; N → show a chooser.
 *   4. For the chosen vault we GET `/vaults/:id/sealed-blobs` to fetch
 *      the password-wrapped ciphertexts. No auth required — the blobs
 *      are useless without the password the user just typed.
 *   5. `unsealOwner()` runs Argon2id on the user's password with the
 *      stored salt + params; if the resulting KEK opens both the
 *      owner_xprv blob and the owner_token blob, we have full
 *      credentials.
 *   6. We persist a VaultMeta in localStorage with the recovered
 *      owner_token so the dashboard works on this device, mark the
 *      vault as active, and navigate to /dashboard.
 *
 * Failure modes called out by name in the UI:
 *
 *   - Wrong password → `unsealOwner` throws on the auth-tag check.
 *     We catch and show "Wrong password" (not "decryption failed" —
 *     that's noise to a non-cryptographer).
 *   - Vault row was created before the password flow shipped → the
 *     server returns 422 from /sealed-blobs. We show a specific
 *     "this vault was created in the legacy flow; check in from the
 *     original device" message.
 *   - The post-create owner-token re-seal call failed silently during
 *     setup, so the owner-token ciphertext on the server is still the
 *     placeholder. Unsealing the placeholder gives us the literal
 *     string `ghostkey-placeholder-owner-token-v1`; we detect this
 *     and tell the user to do one check-in from the original device.
 */
import { useState } from "react";
import {
  Button,
  Field,
  InlineAlert,
} from "./ui";
import {
  ApiError,
  api,
  type FoundVault,
  type SealedBlobsView,
} from "./api";
import { hashEmailForLookup, unsealOwner } from "./crypto/sealing";
import { saveVaultMeta, setActiveVaultId } from "./vaultStore";
import type { Route } from "./App";

const PLACEHOLDER_OWNER_TOKEN = "ghostkey-placeholder-owner-token-v1";

/** The sealed blobs don't carry the heir's name, but the vault label
 *  does ("Ada's share" / "Ada's inheritance"). Pull the name back out
 *  so cross-device sign-in shows the real name, not a placeholder. */
function heirNameFromLabel(label: string | null): string {
  const m = label?.match(/^(.+?)'s (?:share|inheritance)$/i);
  return m ? m[1] : "Heir";
}

interface Props {
  onNavigate: (r: Route) => void;
}

type Phase =
  | { kind: "idle" }
  | { kind: "looking" }
  | { kind: "unsealing"; vaultId: string; progress: number }
  | { kind: "done" };

export function SignInPortal({ onNavigate }: Props) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setError(null);
  }

  async function lookUp() {
    reset();
    if (!email.trim() || !password) {
      setError("Enter your email and password.");
      return;
    }
    if (!/^.+@.+\..+$/.test(email.trim())) {
      setError("That email looks off. Double-check it.");
      return;
    }
    setPhase({ kind: "looking" });
    try {
      const hash = hashEmailForLookup(email);
      const vaults = await api.findVaultsByEmailHash(hash);
      if (vaults.length === 0) {
        setError(
          "We don't recognise that email. Either there's no vault for it, " +
            "or it was set up with a different address.",
        );
        setPhase({ kind: "idle" });
        return;
      }
      if (vaults.length === 1) {
        await openVault(vaults[0]);
      } else {
        // Multiple vaults under one email are this owner's heir group
        // (the server only allows additional vaults for the *same* owner
        // key). Recover them all and stamp a shared group id so this
        // device renders them as one vault — same as the setup device.
        await openGroup(vaults);
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setPhase({ kind: "idle" });
    }
  }

  async function openVault(v: FoundVault) {
    setPhase({ kind: "unsealing", vaultId: v.id, progress: 0 });
    setError(null);
    let blobs: SealedBlobsView;
    try {
      blobs = await api.getSealedBlobs(v.id);
    } catch (e) {
      if (e instanceof ApiError && e.status === 422) {
        setError(
          "This vault was set up before the password flow shipped. " +
            "Check in from the device you used originally; cross-device " +
            "sign-in isn't available for it.",
        );
      } else {
        setError(e instanceof ApiError ? e.message : String(e));
      }
      setPhase({ kind: "idle" });
      return;
    }

    try {
      const out = await unsealOwner({
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
        onProgress: (p) =>
          setPhase({
            kind: "unsealing",
            vaultId: v.id,
            progress: Math.round(p * 100),
          }),
      });

      if (out.ownerToken === PLACEHOLDER_OWNER_TOKEN) {
        // Setup completed but the post-create re-seal call failed.
        // The user can fix this by checking in once from the device
        // where they originally set up the vault — that browser still
        // has the real owner_token in localStorage and the next
        // check-in will keep that working.
        setError(
          "We can open your vault but the sign-in credentials aren't " +
            "ready yet for this device. Check in once from the device " +
            "you used to set up the vault, then try again here.",
        );
        setPhase({ kind: "idle" });
        return;
      }

      // Land everything we need in localStorage so the dashboard
      // works exactly like it does on the original device. We keep
      // the heir's local-only fields (name, etc.) empty here — the
      // sealed blobs don't carry them. The dashboard tolerates that
      // gracefully (it shows "—" for unknown values).
      saveVaultMeta({
        id: v.id,
        label: v.label ?? "Your vault",
        owner: { address: email.trim() },
        heir: { name: heirNameFromLabel(v.label), email: "", address: "" },
        createdAt: v.created_at,
        ownerToken: out.ownerToken,
      });
      setActiveVaultId(v.id);
      setPhase({ kind: "done" });
      onNavigate("dashboard");
    } catch (e) {
      // @noble/ciphers throws a generic Error on a bad auth tag.
      // We don't differentiate further — wrong password is by far
      // the most common cause.
      const msg = e instanceof Error ? e.message : String(e);
      const isAuthTagFail = /poly1305|tag|invalid|decryp/i.test(msg);
      setError(
        isAuthTagFail
          ? "Wrong password. Try again."
          : msg,
      );
      setPhase({ kind: "idle" });
    }
  }

  /**
   * Recover every vault in an owner's heir group and persist them under
   * one shared group id so this device renders them as a single vault
   * (matching the setup device). All siblings share the owner password,
   * so we unseal each in turn; a failure on the first is almost
   * certainly a wrong password and aborts before anything is written.
   *
   * Cost: one Argon2id unwrap per heir. We show aggregate progress
   * across the group so a multi-heir owner sees steady movement rather
   * than a bar that restarts N times.
   */
  async function openGroup(vaults: FoundVault[]) {
    setError(null);
    const groupId = crypto.randomUUID();
    let firstId: string | null = null;

    for (let i = 0; i < vaults.length; i++) {
      const v = vaults[i];
      setPhase({ kind: "unsealing", vaultId: v.id, progress: 0 });
      let blobs: SealedBlobsView;
      try {
        blobs = await api.getSealedBlobs(v.id);
      } catch (e) {
        // A legacy (non-password) row can't be recovered cross-device;
        // skip it rather than failing the whole group.
        if (e instanceof ApiError && e.status === 422) continue;
        setError(e instanceof ApiError ? e.message : String(e));
        setPhase({ kind: "idle" });
        return;
      }

      try {
        const out = await unsealOwner({
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
          onProgress: (p) =>
            setPhase({
              kind: "unsealing",
              vaultId: v.id,
              progress: Math.round(((i + p) / vaults.length) * 100),
            }),
        });

        // A placeholder owner_token means setup's re-seal never landed
        // for this sibling. We still add it to the group so it's visible,
        // but without a token its mutations will need a check-in from the
        // original device first. `undefined` (not the placeholder string)
        // keeps the dashboard's "no credential" handling intact.
        const ownerToken =
          out.ownerToken === PLACEHOLDER_OWNER_TOKEN
            ? undefined
            : out.ownerToken;

        saveVaultMeta({
          id: v.id,
          label: v.label ?? "Your vault",
          owner: { address: email.trim() },
          heir: { name: heirNameFromLabel(v.label), email: "", address: "" },
          createdAt: v.created_at,
          ownerToken,
          groupId,
        });
        if (!firstId) firstId = v.id;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const isAuthTagFail = /poly1305|tag|invalid|decryp/i.test(msg);
        setError(isAuthTagFail ? "Wrong password. Try again." : msg);
        setPhase({ kind: "idle" });
        return;
      }
    }

    if (!firstId) {
      setError(
        "These vaults were set up before cross-device sign-in shipped. " +
          "Check in from the device you used originally.",
      );
      setPhase({ kind: "idle" });
      return;
    }
    setActiveVaultId(firstId);
    setPhase({ kind: "done" });
    onNavigate("dashboard");
  }

  return (
    <main className="bg-app fade-in">
      <div className="mx-auto max-w-md px-5 py-12 md:py-16">
        <header className="text-center">
          <p className="eyebrow">Sign in</p>
          <h1 className="mt-6 font-serif text-3xl md:text-4xl">
            Open your vault on this device
          </h1>
          <p className="mx-auto mt-3 text-sm text-muted">
            Use the email and password you picked when you set the vault up.
            We unlock your vault right here on your device. Nothing leaves
            the browser.
          </p>
        </header>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void lookUp();
          }}
          className="mt-10"
        >
          <Field label="Email">
            <input
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                reset();
              }}
              placeholder="you@example.com"
              autoComplete="username"
              inputMode="email"
              className="input"
              disabled={phase.kind === "looking" || phase.kind === "unsealing"}
            />
          </Field>

          <Field label="Password">
            <input
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                reset();
              }}
              autoComplete="current-password"
              className="input"
              disabled={phase.kind === "looking" || phase.kind === "unsealing"}
            />
          </Field>

          {phase.kind === "unsealing" ? (
            <div className="mt-4">
              <p className="text-sm text-muted">
                Signing you in… {phase.progress}%
              </p>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded bg-[var(--surface-2)]">
                <div
                  className="h-full bg-[var(--accent)] transition-[width] duration-200"
                  style={{ width: `${Math.max(5, phase.progress)}%` }}
                />
              </div>
            </div>
          ) : null}

          {error ? (
            <div className="mt-4">
              <InlineAlert tone="alarm">{error}</InlineAlert>
            </div>
          ) : null}

          <div className="mt-6">
            <Button
              type="submit"
              size="lg"
              loading={phase.kind === "looking" || phase.kind === "unsealing"}
              disabled={
                phase.kind === "looking" || phase.kind === "unsealing"
              }
            >
              Sign in
            </Button>
          </div>
        </form>

        <div className="mt-10 border-t border-app pt-6 text-center text-xs text-muted">
          New here?{" "}
          <button
            type="button"
            className="underline hover:text-[var(--text)]"
            onClick={() => onNavigate("setup")}
          >
            Set up a vault
          </button>
        </div>
      </div>
    </main>
  );
}
