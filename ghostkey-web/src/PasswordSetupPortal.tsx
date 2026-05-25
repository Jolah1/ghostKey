/**
 * Password-vault setup wizard — three steps.
 *
 *   1. Heir       — name, contact channel + value, waiting period.
 *   2. Password   — owner email (for cross-device recovery) plus the
 *                   password the vault will unlock with. Argon2id +
 *                   in-browser BIP86 keygen happens here. The owner is
 *                   never shown a seed phrase: the password *is* the
 *                   only secret.
 *   3. Fund       — the freshly-derived first receive address, with a
 *                   copy button and a reminder that funds sent here
 *                   are testnet-only during alpha.
 *
 * Why three steps, not four (like the legacy wallet-paste flow)?
 *
 *   The legacy flow asks for two xpubs (owner + heir). The whole point
 *   of the password-vault redesign is that the *browser* generates both
 *   xpubs locally, seals them, and ships only ciphertext. So those
 *   collection steps disappear. The remaining decisions reduce to:
 *   who inherits, what unlocks it, where the money goes.
 *
 * What happens behind the scenes when the user clicks "Create vault":
 *
 *   a. We mint two fresh BIP86 account keys (owner + heir) via
 *      `generateParty()`. 256-bit BIP39 entropy each; the mnemonic
 *      itself is dropped on the floor immediately.
 *   b. We generate a fresh 256-bit claim token in-browser. This token
 *      is the input to the heir-xprv KEK (HKDF-SHA256), and is also
 *      what the scheduler will eventually email the heir as part of
 *      their claim URL fragment.
 *   c. We derive an Argon2id KEK from the owner's password
 *      (`deriveOwnerKek`) and seal the owner xprv, the soon-to-be-
 *      issued owner token, and the heir xprv (under the claim-token
 *      KEK). All three become opaque base64 ciphertexts.
 *   d. We hash the owner email (SHA-256 of the lowercased, NFKC
 *      normalised value) for cross-device lookup.
 *   e. We POST everything to `/vaults/from-xpub` along with the xpubs
 *      (the server still needs those to build the descriptor pair).
 *      The server returns the vault id and the raw owner token — the
 *      latter is the bearer credential for authenticated endpoints,
 *      and we cache it in localStorage for the dashboard.
 *   f. We fetch `/vaults/:id/address` and display the receive address.
 *
 * Notes on what we deliberately do NOT do here:
 *
 *   - We do not store the password. Not in localStorage, not in
 *     sessionStorage. The owner re-types it on the dashboard when
 *     they want to do an on-chain check-in or change settings.
 *   - We do not show the user the generated mnemonic or xprv. The
 *     product brief is "one secret, the password" — exposing a backup
 *     phrase would defeat that promise and confuse users into thinking
 *     they need to write something down.
 *   - We do not call `/vaults/:id/checkin` here. The vault is created
 *     with the next_deadline_at already set by the server based on
 *     the check-in cadence; no further action is needed before
 *     funding.
 */
import { useMemo, useState } from "react";
import {
  Button,
  Field,
  ProgressBar,
  Tile,
  InlineAlert,
  Disclosure,
} from "./ui";
import { ApiError, api, type VaultListItem, type SealedSetup } from "./api";
import { saveVaultMeta } from "./vaultStore";
import {
  generateParty,
  wipe,
  type Network,
} from "./crypto/keygen";
import {
  sealVaultSecrets,
  sealWithKey,
  hashEmailForLookup,
  b64encode,
} from "./crypto/sealing";
import { randomBytes } from "@noble/hashes/utils.js";

interface Props {
  onCancel: () => void;
  onCreated: (v: VaultListItem) => void;
}

type ContactChannel = "sms" | "email" | "whatsapp";

interface Draft {
  // Step 1 — heir + timing
  heirName: string;
  heirContact: string;
  heirContactChannel: ContactChannel;
  waitingMonths: number;
  reminderEveryTwoWeeks: boolean;

  // Step 2 — owner identity + password
  ownerEmail: string;
  password: string;
  passwordConfirm: string;
}

const EMPTY: Draft = {
  heirName: "",
  heirContact: "",
  heirContactChannel: "email",
  waitingMonths: 3,
  reminderEveryTwoWeeks: true,
  ownerEmail: "",
  password: "",
  passwordConfirm: "",
};

const STEPS = ["Heir", "Password", "Fund"] as const;

// Alpha: testnet only. Mirrors the comment in SetupPortal.tsx — we
// will flip this to "bitcoin" when the operational story is finished.
const NETWORK: Network = "testnet";

// Bitcoin block cadence: ~144 blocks/day, 30 days/month. Min 144 (1d)
// guards against the user dragging the slider to zero on an edge case.
function monthsToBlocks(months: number): number {
  return Math.max(144, months * 30 * 144);
}

/* ============================================================ */

export function PasswordSetupPortal({ onCancel, onCreated }: Props) {
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [kdfProgress, setKdfProgress] = useState<number>(0);

  // After creation we move to step 3 (Fund) and need to remember the
  // vault id + address. We keep them in component state so a page
  // refresh sends the user back to the dashboard (which can re-derive
  // the address via the same /vaults/:id/address endpoint).
  const [created, setCreated] = useState<{
    vaultId: string;
    address: string | null;
  } | null>(null);

  function patch(p: Partial<Draft>) {
    setDraft((d) => ({ ...d, ...p }));
    setError(null);
  }

  function validate(s: number): string | null {
    if (s === 0) {
      if (!draft.heirName.trim()) return "Tell us who is inheriting.";
      if (!draft.heirContact.trim()) {
        return "Add a phone number or email so we can reach them when the time comes.";
      }
      if (
        draft.heirContactChannel === "email" &&
        !/^.+@.+\..+$/.test(draft.heirContact.trim())
      ) {
        return "That email looks off. Double-check it.";
      }
    }
    if (s === 1) {
      if (!draft.ownerEmail.trim()) {
        return "Your email lets you recover this vault on any device. We never use it for marketing.";
      }
      if (!/^.+@.+\..+$/.test(draft.ownerEmail.trim())) {
        return "That email looks off. Double-check it.";
      }
      if (draft.password.length < 10) {
        return "Pick a password that's at least 10 characters. Longer is better.";
      }
      if (draft.password !== draft.passwordConfirm) {
        return "The two passwords don't match.";
      }
    }
    return null;
  }

  function next() {
    const err = validate(step);
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    setStep((s) => Math.min(STEPS.length - 1, s + 1));
  }

  function back() {
    if (created) return; // can't step back after creation
    setError(null);
    setStep((s) => Math.max(0, s - 1));
  }

  async function activate() {
    // Final guard — UI calls validate(0) + validate(1) when stepping
    // forward, but the user might mutate state via devtools. Belt
    // and suspenders.
    const err = validate(0) ?? validate(1);
    if (err) {
      setError(err);
      return;
    }

    setBusy(true);
    setError(null);
    setKdfProgress(0);

    // We declare these out here so we can wipe() them in the `finally`
    // even if something throws partway through.
    let ownerParty: ReturnType<typeof generateParty> | null = null;
    let heirParty: ReturnType<typeof generateParty> | null = null;
    let claimToken: Uint8Array | null = null;
    let ownerKek: Uint8Array | null = null;

    try {
      // (a) Mint fresh keys + claim token.
      ownerParty = generateParty(NETWORK);
      heirParty = generateParty(NETWORK);
      claimToken = randomBytes(32);

      // (b) Seal under password. We ship a placeholder for the
      // owner_token slot — the server only mints the real token in
      // its response, so we re-seal it in step (g) below with the
      // same KEK (kept in memory via keepOwnerKek).
      //
      // Why a placeholder rather than e.g. an empty string? The
      // server validates that the nonce field is well-formed; sealing
      // a known-bad string ensures the column is never accidentally
      // openable to a meaningful value before the real seal lands.
      const tokenPlaceholder = "ghostkey-placeholder-owner-token-v1";

      const sealed = await sealVaultSecrets({
        password: draft.password,
        ownerXprv: ownerParty.xprv,
        heirXprv: heirParty.xprv,
        ownerToken: tokenPlaceholder,
        claimTokenRaw: claimToken,
        keepOwnerKek: true,
        onProgress: (p) => setKdfProgress(Math.round(p * 100)),
      });
      ownerKek = sealed._owner_kek ?? null;

      // (c) Hash the owner email for cross-device lookup.
      const ownerEmailHash = hashEmailForLookup(draft.ownerEmail);

      // (d) Build the SealedSetup body the server wants.
      const sealedBody: SealedSetup = {
        password_salt_b64: sealed.password_salt,
        password_kdf_mem_kib: sealed.password_kdf_mem_kib,
        password_kdf_iters: sealed.password_kdf_iters,
        owner_xprv_ct_b64: sealed.owner_xprv.ct,
        owner_xprv_nonce_b64: sealed.owner_xprv.nonce,
        owner_token_ct_b64: sealed.owner_token.ct,
        owner_token_nonce_b64: sealed.owner_token.nonce,
        heir_xprv_ct_b64: sealed.heir_xprv.ct,
        heir_xprv_nonce_b64: sealed.heir_xprv.nonce,
        owner_email_hash: ownerEmailHash,
        claim_token_b64: b64encode(claimToken),
      };

      // (e) Submit. The server builds the Taproot descriptor from
      // the two xpubs and persists the ciphertexts atomically.
      const label = `${draft.heirName.trim()}'s inheritance`;
      const timelockBlocks = monthsToBlocks(draft.waitingMonths);
      const checkinSecs = draft.reminderEveryTwoWeeks ? 14 * 86_400 : 30 * 86_400;
      const graceSecs = 3 * 86_400;

      const heirContactPayload = JSON.stringify({
        name: draft.heirName.trim(),
        contact: draft.heirContact.trim(),
        channel: draft.heirContactChannel,
      });

      const resp = await api.createVaultFromXpub({
        label,
        network: NETWORK,
        owner: {
          xpub: ownerParty.xpub,
          fingerprint: ownerParty.fingerprint,
        },
        heir: {
          xpub: heirParty.xpub,
          fingerprint: heirParty.fingerprint,
        },
        timelock_blocks: timelockBlocks,
        checkin_period_secs: checkinSecs,
        grace_period_secs: graceSecs,
        owner_contact: draft.ownerEmail.trim(),
        heir_contact: heirContactPayload,
        heir_contact_channel: draft.heirContactChannel,
        sealed: sealedBody,
      });

      // (f) Re-seal the *real* owner_token under the same password
      // KEK and ship it to the server. This is the second half of
      // the chicken-and-egg dance described in the SealedSetup
      // comments. We failure-tolerate this: the local owner_token
      // cache in localStorage continues to work even if this fails,
      // and the user can re-trigger via cross-device sign-in.
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
          // Non-fatal. The local copy still works on this device.
          // Log so we notice in dev; production has no console.
          console.warn(
            "owner-token re-seal failed; cross-device sign-in will need a fresh check-in first",
            e,
          );
        }
      }

      // (g) Persist local metadata for the dashboard. Same shape the
      // legacy flow uses, except `owner.address` carries the email
      // for now (the user-facing "your account" identifier).
      saveVaultMeta({
        id: resp.id,
        label,
        owner: {
          address: draft.ownerEmail.trim(),
          wallet: null,
        },
        heir: {
          name: draft.heirName.trim(),
          email:
            draft.heirContactChannel === "email"
              ? draft.heirContact.trim()
              : "",
          address: "", // unknown; the heir's xpub is sealed and never
                      // surfaces in the UI.
        },
        createdAt: new Date().toISOString(),
        ownerToken: resp.owner_token,
      });

      // (h) Fetch the receive address. Non-fatal if it fails — the
      // user can grab it from the dashboard. We surface the error in
      // a small inline note instead of bailing the whole flow.
      let address: string | null = null;
      try {
        const a = await api.getVaultAddress(resp.id);
        address = a.address;
      } catch (e) {
        console.warn("address fetch failed", e);
      }

      setCreated({ vaultId: resp.id, address });
      setStep(2);

      // Tell the parent we created a vault. We pass the VaultListItem
      // shape it expects; the parent uses it to navigate to dashboard.
      // We don't navigate immediately because the user is staring at
      // the funding address; let them dismiss it.
      onCreated({
        id: resp.id,
        label: resp.label,
        status: resp.status,
        next_deadline_at: resp.next_deadline_at,
      });
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : String(e),
      );
    } finally {
      // Best-effort wipe of plaintext key material in memory.
      if (ownerParty) {
        // xprv strings are JS strings — can't wipe. Replace the
        // reference and hope GC clears it; this is documented in
        // keygen.ts as "best-effort, not a security boundary".
        ownerParty = null;
      }
      if (heirParty) heirParty = null;
      if (claimToken) wipe(claimToken);
      if (ownerKek) wipe(ownerKek);
      setBusy(false);
    }
  }

  const progress = ((step + 1) / STEPS.length) * 100;

  return (
    <main className="bg-app fade-in">
      <div className="mx-auto max-w-xl px-5 py-12 md:py-16">
        <ProgressBar value={progress} />

        <div className="mt-10">
          <p className="eyebrow-dim">
            Step {step + 1} of {STEPS.length} · {STEPS[step]}
          </p>
        </div>

        <div className="mt-8">
          {step === 0 && <StepHeir draft={draft} patch={patch} />}
          {step === 1 && (
            <StepPassword
              draft={draft}
              patch={patch}
              busy={busy}
              kdfProgress={kdfProgress}
            />
          )}
          {step === 2 && created && (
            <StepFund vaultId={created.vaultId} address={created.address} />
          )}
        </div>

        {error ? (
          <div className="mt-6">
            <InlineAlert tone="alarm">{error}</InlineAlert>
          </div>
        ) : null}

        <div className="mt-10 flex items-center justify-between border-t border-app pt-6">
          {step === 0 ? (
            <Button variant="quiet" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
          ) : created ? (
            // After creation, no "Back" — the vault is live, going
            // back would only confuse. The button still exists as a
            // dismiss action.
            <Button variant="quiet" onClick={onCancel}>
              Dismiss
            </Button>
          ) : (
            <Button variant="quiet" onClick={back} disabled={busy}>
              Back
            </Button>
          )}

          {step < STEPS.length - 1 ? (
            step === 1 ? (
              <Button onClick={activate} loading={busy}>
                Create vault
              </Button>
            ) : (
              <Button onClick={next}>Continue</Button>
            )
          ) : created ? (
            <Button onClick={onCancel}>Done</Button>
          ) : null}
        </div>
      </div>
    </main>
  );
}

/* ============================================================ */
/* Step 1: heir + timing                                          */
/* ============================================================ */

const CHANNELS: {
  id: ContactChannel;
  title: string;
  sub: string;
  placeholder: string;
}[] = [
  {
    id: "email",
    title: "Email",
    sub: "Inbox",
    placeholder: "sarah@example.com",
  },
  {
    id: "sms",
    title: "SMS",
    sub: "Phone number",
    placeholder: "+234 800 000 0000",
  },
  {
    id: "whatsapp",
    title: "WhatsApp",
    sub: "Same number",
    placeholder: "+234 800 000 0000",
  },
];

const MONTH_OPTIONS = [1, 2, 3, 6, 9, 12];

function monthsLabel(n: number): string {
  if (n === 12) return "1 year";
  return `${n} month${n === 1 ? "" : "s"}`;
}

function StepHeir({
  draft,
  patch,
}: {
  draft: Draft;
  patch: (p: Partial<Draft>) => void;
}) {
  const channelMeta =
    CHANNELS.find((c) => c.id === draft.heirContactChannel) ?? CHANNELS[0];

  return (
    <div>
      <h1 className="font-serif text-3xl md:text-4xl">
        Who should receive this
      </h1>
      <p className="mt-2 text-muted">
        They never have to know about this until the time comes. When it does,
        we reach them on the channel you pick and they claim from a link —
        no wallet install, no setup on their end.
      </p>

      <div className="mt-8">
        <Field label="Their name">
          <input
            type="text"
            value={draft.heirName}
            onChange={(e) => patch({ heirName: e.target.value })}
            placeholder="Sarah"
            autoComplete="off"
            className="input"
          />
        </Field>

        <Field label="How should we reach them">
          <div className="grid grid-cols-3 gap-2">
            {CHANNELS.map((c) => (
              <Tile
                key={c.id}
                title={c.title}
                sub={c.sub}
                selected={draft.heirContactChannel === c.id}
                onClick={() => patch({ heirContactChannel: c.id })}
              />
            ))}
          </div>
        </Field>

        <Field
          label={
            draft.heirContactChannel === "email"
              ? "Their email"
              : "Their phone number"
          }
          hint="Stored encrypted. We don't message them until the alarm fires."
        >
          <input
            type={draft.heirContactChannel === "email" ? "email" : "tel"}
            value={draft.heirContact}
            onChange={(e) => patch({ heirContact: e.target.value })}
            placeholder={channelMeta.placeholder}
            autoComplete="off"
            inputMode={
              draft.heirContactChannel === "email" ? "email" : "tel"
            }
            className="input"
          />
        </Field>

        <Field label="If you stop checking in, wait this long before they can claim">
          <div className="flex items-center gap-4">
            <input
              type="range"
              min={1}
              max={12}
              value={draft.waitingMonths}
              onChange={(e) =>
                patch({ waitingMonths: Number(e.target.value) })
              }
              aria-label="Waiting period in months"
              className="w-full accent-[var(--accent)]"
              list="month-marks"
            />
            <datalist id="month-marks">
              {MONTH_OPTIONS.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            <span className="min-w-[5.5rem] text-right font-display text-3xl font-bold tracking-tight text-accent">
              {monthsLabel(draft.waitingMonths)}
            </span>
          </div>
        </Field>

        <Field label="Remind me to check in">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Tile
              selected={draft.reminderEveryTwoWeeks}
              onClick={() => patch({ reminderEveryTwoWeeks: true })}
              title="Every 2 weeks"
              sub="Recommended"
            />
            <Tile
              selected={!draft.reminderEveryTwoWeeks}
              onClick={() => patch({ reminderEveryTwoWeeks: false })}
              title="Every month"
              sub="More relaxed"
            />
          </div>
        </Field>

        <p className="mt-6 text-center text-xs text-muted">
          Already have a Bitcoin wallet you'd rather keep?{" "}
          <a
            href="#/setup-legacy"
            className="underline hover:text-[var(--text)]"
          >
            Use the advanced flow
          </a>{" "}
          to paste your own xpub instead.
        </p>
      </div>
    </div>
  );
}

/* ============================================================ */
/* Step 2: password                                               */
/* ============================================================ */

function StepPassword({
  draft,
  patch,
  busy,
  kdfProgress,
}: {
  draft: Draft;
  patch: (p: Partial<Draft>) => void;
  busy: boolean;
  kdfProgress: number;
}) {
  // Very rough strength meter — entropy-by-character with a cap.
  // We deliberately don't try to be clever about pattern detection;
  // the goal is to nudge users toward "longer" without lying about
  // what we can actually measure on a single string.
  const strength = useMemo(() => {
    const len = draft.password.length;
    if (len === 0) return null;
    if (len < 10) return { label: "Too short", tone: "bad" as const };
    if (len < 14) return { label: "Okay", tone: "ok" as const };
    if (len < 20) return { label: "Strong", tone: "good" as const };
    return { label: "Excellent", tone: "good" as const };
  }, [draft.password]);

  return (
    <div>
      <h1 className="font-serif text-3xl md:text-4xl">Pick your password</h1>
      <p className="mt-2 text-muted">
        This unlocks your vault on any device. Lose it and the timer runs out
        — your heir inherits on the schedule you picked. There is no recovery
        email and no support contact. That's the trade we make to be honestly
        non-custodial.
      </p>

      <div className="mt-8">
        <Field
          label="Your email"
          hint="So you can sign in on another device. We never email you anything except check-in reminders."
        >
          <input
            type="email"
            value={draft.ownerEmail}
            onChange={(e) => patch({ ownerEmail: e.target.value })}
            placeholder="you@example.com"
            autoComplete="email"
            inputMode="email"
            className="input"
            disabled={busy}
          />
        </Field>

        <Field
          label="Password"
          hint="Longer is better. Aim for 14 characters or more."
        >
          <input
            type="password"
            value={draft.password}
            onChange={(e) => patch({ password: e.target.value })}
            autoComplete="new-password"
            className="input"
            disabled={busy}
          />
          {strength ? (
            <p
              className="mt-2 text-xs"
              style={{
                color:
                  strength.tone === "good"
                    ? "var(--accent-text)"
                    : strength.tone === "ok"
                      ? "var(--text)"
                      : "var(--alarm)",
              }}
            >
              {strength.label}
            </p>
          ) : null}
        </Field>

        <Field label="Confirm password">
          <input
            type="password"
            value={draft.passwordConfirm}
            onChange={(e) => patch({ passwordConfirm: e.target.value })}
            autoComplete="new-password"
            className="input"
            disabled={busy}
          />
        </Field>

        {busy ? (
          <div className="mt-6">
            <p className="text-sm text-muted">
              Generating your keys… {kdfProgress > 0 ? `${kdfProgress}%` : ""}
            </p>
            <div className="mt-2">
              <ProgressBar value={Math.max(5, kdfProgress)} />
            </div>
            <p className="mt-2 text-xs text-muted">
              We're running a deliberately slow key derivation. This takes
              a couple of seconds on most phones — it's what makes your
              password expensive to brute-force.
            </p>
          </div>
        ) : (
          <Disclosure
            summary={
              <span>What exactly happens when I click "Create vault"?</span>
            }
          >
            <ol className="space-y-2 pl-5 text-sm text-muted list-decimal">
              <li>
                Your browser generates two fresh Bitcoin keys — one for you,
                one for the person you named. They never leave this tab.
              </li>
              <li>
                Your password is fed into a slow key-derivation function
                (Argon2id, 64 MiB, ~2 seconds). The result wraps your key
                so the server only sees opaque ciphertext.
              </li>
              <li>
                The wrapped keys get sent to the server, along with the
                Bitcoin descriptor that tells the chain how this vault
                works (your key spends always; their key spends after the
                waiting period).
              </li>
              <li>
                You'll get an address on the next screen — fund it with
                testnet BTC and you're done.
              </li>
            </ol>
          </Disclosure>
        )}
      </div>
    </div>
  );
}

/* ============================================================ */
/* Step 3: fund                                                   */
/* ============================================================ */

function StepFund({
  vaultId,
  address,
}: {
  vaultId: string;
  address: string | null;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Some browsers (older Safari over http) block clipboard access.
      // Falling back to manual select is fine — the address is visible.
    }
  }

  return (
    <div>
      <h1 className="font-serif text-3xl md:text-4xl">Fund your vault</h1>
      <p className="mt-2 text-muted">
        Send Bitcoin to the address below. It lands in a script only you can
        spend right now, and only your heir can spend after the waiting
        period if you stop checking in.
      </p>

      {address ? (
        <div className="mt-8">
          <Field
            label="Your vault address"
            hint="Testnet only during alpha. Don't send real-money BTC here."
          >
            <div className="card flex items-center gap-3 px-4 py-3">
              <code className="flex-1 break-all font-mono text-sm">
                {address}
              </code>
              <Button variant="quiet" onClick={copy}>
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          </Field>

          <InlineAlert tone="neutral">
            Bookmark this page or note your vault id (
            <code className="font-mono text-xs">{shortId(vaultId)}</code>) —
            the dashboard is also reachable from any browser by signing in
            with your email and password.
          </InlineAlert>
        </div>
      ) : (
        <div className="mt-8">
          <InlineAlert tone="warning">
            We couldn't fetch the address automatically. Open the dashboard to
            see it.
          </InlineAlert>
        </div>
      )}
    </div>
  );
}

function shortId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}
