/**
 * Legacy setup wizard — click-driven, four steps:
 *
 *   1. Wallet  — owner's xpub (with origin info or fingerprint + bare xpub)
 *   2. Heir    — name, contact (sms / email / whatsapp), and their xpub
 *   3. Timing  — waiting period (timelock) + reminder cadence
 *   4. Review  — summary + activate
 *
 * This is the demoted #/setup-legacy flow. The default at #/setup is
 * now `PasswordSetupPortal`, which generates keys in-browser and seals
 * them under the user's password. This file is kept for advanced users
 * who already hold an xpub in Sparrow / BlueWallet / Coldcard / etc.
 * and want to bring their own wallet rather than have GhostKey mint
 * keys for them.
 *
 * Vaults created here do NOT participate in the password-vault flow:
 * no sealed blobs, no cross-device sign-in. The owner_token only lives
 * on the browser that ran setup; losing localStorage on that device
 * means losing programmatic access to the vault.
 *
 * The xpubs flow through POST /vaults/from-xpub, which the Rust server
 * uses to render the real Taproot inheritance descriptor. The legacy
 * "paste a raw descriptor pair" path is still available behind the
 * Advanced disclosure on step 1 for users who came from the CLI and
 * already have descriptors in hand.
 *
 * Why the paste? An xpub is a public key — it cannot spend, only watch
 * — but it is the unique piece of information the wallet has to share
 * for GhostKey to build the inheritance script. There is no programmatic
 * API for Cake / Sparrow / BlueWallet / Coldcard to hand it over, so
 * paste is the universal connector. The "What is this?" disclosure
 * tells the user where to find it in each wallet.
 */
import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Field,
  ProgressBar,
  Tile,
  InlineAlert,
  Disclosure,
} from "./ui";
import {
  ApiError,
  api,
  type VaultListItem,
  type PartyXpub,
} from "./api";
import { saveVaultMeta } from "./vaultStore";
import {
  DEFAULT_CADENCE_ID,
  DEFAULT_GRACE_ID,
  cadencePresetsFor,
  gracePresetsFor,
  defaultCadenceIdFor,
  defaultGraceIdFor,
  cadenceByIdAnywhere,
  graceByIdAnywhere,
} from "./timing";

interface Props {
  onCancel: () => void;
  onCreated: (v: VaultListItem) => void;
}

type ContactChannel = "sms" | "email" | "whatsapp";

interface Draft {
  // Owner side
  ownerXpub: string;            // bare or origin-tagged
  ownerFingerprint: string;     // optional when ownerXpub is origin-tagged
  ownerWallet: string | null;   // soft hint, not used in payload
  // Where to send "you missed your check-in" reminders. Optional —
  // a vault without one still works, the owner just won't get an
  // email when their deadline passes. We capture it on the Wallet
  // step so it's near the other owner-side fields. Empty means
  // "don't notify me".
  ownerEmail: string;

  // Heir side
  heirName: string;
  heirContact: string;
  heirContactChannel: ContactChannel;
  heirXpub: string;
  heirFingerprint: string;

  // Timing
  waitingMonths: number;
  // String ids into CADENCE_PRESETS / GRACE_PRESETS — see
  // ./timing.ts. Replaces the legacy single `reminderEveryTwoWeeks`
  // boolean and the hard-coded 3-day grace.
  cadenceId: string;
  graceId: string;

  // Legacy fallback (Advanced disclosure)
  descriptorExternal: string;
  descriptorInternal: string;
}

const EMPTY: Draft = {
  ownerXpub: "",
  ownerFingerprint: "",
  ownerWallet: null,
  ownerEmail: "",
  heirName: "",
  heirContact: "",
  heirContactChannel: "sms",
  heirXpub: "",
  heirFingerprint: "",
  waitingMonths: 3,
  cadenceId: DEFAULT_CADENCE_ID,
  graceId: DEFAULT_GRACE_ID,
  descriptorExternal: "",
  descriptorInternal: "",
};

const STEPS = ["Wallet", "Heir", "Timing", "Review"] as const;

/* ------------------------ xpub parsing helpers ----------------------------- */

/**
 * Quick client-side shape check. Accepts:
 *   - bare xpub starting with `xpub`, `tpub`, `vpub`, `upub`, `ypub`, `zpub`
 *   - origin-tagged `[FP/path]xpub...`
 *
 * We do NOT validate the BIP32 checksum on the client — that's the
 * server's job. The purpose of this check is to catch obvious typos
 * before round-tripping to the API.
 */
function looksLikeXpub(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  const body = t.startsWith("[")
    ? t.replace(/^\[[^\]]+\]/, "")
    : t;
  return /^[xtvuyz]pub[1-9A-HJ-NP-Za-km-z]{50,}$/.test(body);
}

/** True if the string is origin-tagged (`[FP/path]xpub...`). */
function isOriginTagged(s: string): boolean {
  return s.trim().startsWith("[");
}

/** Extract the fingerprint from an origin tag, or null if not tagged. */
function extractFingerprint(s: string): string | null {
  const m = s.trim().match(/^\[([0-9a-fA-F]{8})\//);
  return m ? m[1].toLowerCase() : null;
}

function isHexFingerprint(s: string): boolean {
  return /^[0-9a-fA-F]{8}$/.test(s.trim());
}

/* ----------------------------- Component ----------------------------------- */

export function SetupPortal({ onCancel, onCreated }: Props) {
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Demo-mode flag from /health. When true we surface the
  // seconds-scale cadence/grace presets and adjust the initial
  // selection so the picker has a valid default for this server.
  // Read once on mount; a server that flips the flag mid-session
  // would only take effect on the next page load.
  const [demoMode, setDemoMode] = useState(false);
  // Bitcoin network for this server, mirrored from /health. Falls
  // back to "testnet" if /health is unreachable or the server is too
  // old to emit the field. See PasswordSetupPortal.tsx and
  // `crates/ghostkey-server/src/config.rs` for the rationale.
  const [network, setNetwork] = useState<"bitcoin" | "testnet" | "signet" | "regtest">("testnet");

  useEffect(() => {
    let alive = true;
    api
      .health()
      .then((h) => {
        if (!alive) return;
        const d = Boolean(h.demo_mode);
        setDemoMode(d);
        if (h.default_network) {
          setNetwork(h.default_network);
        }
        // Realign the initial cadence/grace selection if the user
        // hasn't picked anything yet. Without this, a demo-mode
        // server would show the production defaults (bi-weekly / 3d)
        // selected by EMPTY and the demo pickers wouldn't visually
        // reflect the current draft.
        setDraft((draft0) => {
          if (
            draft0.cadenceId !== DEFAULT_CADENCE_ID ||
            draft0.graceId !== DEFAULT_GRACE_ID
          ) {
            return draft0;
          }
          return {
            ...draft0,
            cadenceId: defaultCadenceIdFor(d),
            graceId: defaultGraceIdFor(d),
          };
        });
      })
      .catch(() => {
        // Health probe failed; assume production posture. The user
        // can still create a vault; the server will validate.
        if (alive) setDemoMode(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  function patch(p: Partial<Draft>) {
    setDraft((d) => ({ ...d, ...p }));
    setError(null);
  }

  function validate(s: number): string | null {
    const hasAdvancedDescriptor =
      draft.descriptorExternal.trim() && draft.descriptorInternal.trim();

    if (s === 0) {
      // If the user is going down the Advanced (paste descriptor) path,
      // we don't require an xpub — the descriptors already encode it.
      if (hasAdvancedDescriptor) return null;

      if (!draft.ownerXpub.trim()) {
        return "Paste your wallet's xpub to continue.";
      }
      if (!looksLikeXpub(draft.ownerXpub)) {
        return "That doesn't look like an xpub. It should start with xpub, tpub, or vpub.";
      }
      if (!isOriginTagged(draft.ownerXpub) && !isHexFingerprint(draft.ownerFingerprint)) {
        return "Your xpub has no origin tag. Add your wallet's fingerprint (8 hex characters).";
      }
      // Owner email is optional. Only sanity-check shape when supplied.
      const oe = draft.ownerEmail.trim();
      if (oe.length > 0 && !/^.+@.+\..+$/.test(oe)) {
        return "That email looks off. Double-check it, or leave the field blank to skip reminders.";
      }
    }
    if (s === 1) {
      if (!draft.heirName.trim()) return "Tell us who is inheriting.";
      if (!draft.heirContact.trim()) {
        return "Add a phone number or email so we can reach them when the time comes.";
      }
      if (draft.heirContactChannel === "email" &&
          !/^.+@.+\..+$/.test(draft.heirContact.trim())) {
        return "That email looks off. Double-check it.";
      }
      if (hasAdvancedDescriptor) return null;

      if (!draft.heirXpub.trim()) {
        return "Paste the heir's xpub. They never have to know. You get this from them in advance, or from any wallet you set aside for them.";
      }
      if (!looksLikeXpub(draft.heirXpub)) {
        return "That doesn't look like an xpub. It should start with xpub, tpub, or vpub.";
      }
      if (!isOriginTagged(draft.heirXpub) && !isHexFingerprint(draft.heirFingerprint)) {
        return "Heir's xpub has no origin tag. Add the wallet's fingerprint (8 hex characters).";
      }
      if (
        draft.ownerXpub.trim() &&
        draft.ownerXpub.trim() === draft.heirXpub.trim()
      ) {
        return "Owner and heir xpubs must be different.";
      }
    }
    return null;
  }

  function next() {
    const err = validate(step);
    if (err) { setError(err); return; }
    setError(null);
    setStep((s) => Math.min(STEPS.length - 1, s + 1));
  }

  function back() {
    setError(null);
    setStep((s) => Math.max(0, s - 1));
  }

  async function activate() {
    setBusy(true);
    setError(null);
    try {
      const label = `${draft.heirName.trim()}'s inheritance`;
      // Months → Bitcoin blocks. ~144 blocks/day, 30 days/month.
      const timelockBlocks = Math.max(144, draft.waitingMonths * 30 * 144);
      const checkinSecs = cadenceByIdAnywhere(draft.cadenceId).seconds;
      const graceSecs = graceByIdAnywhere(draft.graceId).seconds;

      const heirContactPayload = JSON.stringify({
        name: draft.heirName.trim(),
        contact: draft.heirContact.trim(),
        channel: draft.heirContactChannel,
      });

      const advExt = draft.descriptorExternal.trim();
      const advInt = draft.descriptorInternal.trim();
      const useAdvanced = advExt && advInt;

      // Owner contact: empty string means "skip notifications for me".
      // The server treats null and "" identically (the route's
      // `match req.owner_contact.as_deref() { Some(pt) if !pt.is_empty() =>
      // ... }` clause filters both out), so we can ship either; null
      // makes the wire intent clearer when the owner declined.
      const ownerEmail = draft.ownerEmail.trim();
      const ownerContact: string | null = ownerEmail.length > 0 ? ownerEmail : null;
      const ownerContactChannel: "email" | null = ownerContact ? "email" : null;

      const resp = useAdvanced
        ? await api.createVault({
            label,
            // Network is read from the server's /health.default_network
            // (set via GHOSTKEY_DEFAULT_NETWORK env var on the server).
            // Defaults to "testnet" — historical alpha posture, also the
            // safe fallback for any older server that doesn't emit the
            // field. To run a vault on signet, set the env var on the
            // server; no UI change needed.
            network,
            descriptor_external: advExt,
            descriptor_internal: advInt,
            timelock_blocks: timelockBlocks,
            checkin_period_secs: checkinSecs,
            grace_period_secs: graceSecs,
            owner_contact: ownerContact,
            owner_contact_channel: ownerContactChannel,
            heir_contact: heirContactPayload,
          })
        : await api.createVaultFromXpub({
            label,
            network,
            owner: partyFromDraft(draft.ownerXpub, draft.ownerFingerprint),
            heir: partyFromDraft(draft.heirXpub, draft.heirFingerprint),
            timelock_blocks: timelockBlocks,
            checkin_period_secs: checkinSecs,
            grace_period_secs: graceSecs,
            owner_contact: ownerContact,
            owner_contact_channel: ownerContactChannel,
            heir_contact: heirContactPayload,
            heir_contact_channel: draft.heirContactChannel,
          });

      // Mirror the structured heir info locally so the dashboard can
      // render it without round-tripping to the server. We deliberately
      // do NOT mirror the xpub here — it's enough that the server holds
      // the descriptors; the device-local store is just for friendly UI.
      //
      // The owner_token is captured here for the first and only time.
      // It's the bearer credential needed on every authenticated
      // route. Losing this entry on this device means losing the
      // ability to drive this vault's check-in from any browser —
      // vaults created via the legacy flow can't use the password
      // sign-in flow, so there is no cross-device recovery for them.
      saveVaultMeta({
        id: resp.id,
        label,
        owner: {
          address: draft.ownerXpub.trim() || advExt,
        },
        heir: {
          name: draft.heirName.trim(),
          email: draft.heirContactChannel === "email" ? draft.heirContact.trim() : "",
          address: draft.heirXpub.trim() || "",
        },
        createdAt: new Date().toISOString(),
        ownerToken: resp.owner_token,
      });

      onCreated({
        id: resp.id,
        label: resp.label,
        status: resp.status,
        next_deadline_at: resp.next_deadline_at,
      });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const progress = ((step + 1) / STEPS.length) * 100;

  return (
    <main className="bg-app fade-in">
      <div className="mx-auto max-w-xl px-5 py-12 md:py-16">
        <ProgressBar value={progress} label="Setup progress" />

        <div className="mt-10">
          <p className="eyebrow-dim">
            Step {step + 1} of {STEPS.length} · {STEPS[step]}
          </p>
        </div>

        <div className="mt-8">
          {step === 0 && <StepWallet draft={draft} patch={patch} />}
          {step === 1 && <StepHeir   draft={draft} patch={patch} />}
          {step === 2 && <StepTiming draft={draft} patch={patch} demoMode={demoMode} />}
          {step === 3 && <StepReview draft={draft} />}
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
          ) : (
            <Button variant="quiet" onClick={back} disabled={busy}>
              Back
            </Button>
          )}

          {step < STEPS.length - 1 ? (
            <Button onClick={next}>Continue</Button>
          ) : (
            <Button onClick={activate} loading={busy}>
              Activate vault
            </Button>
          )}
        </div>
      </div>
    </main>
  );
}

/** Build the PartyXpub payload, dropping the explicit fingerprint when
 *  the xpub already carries an origin tag. The server accepts both. */
function partyFromDraft(xpub: string, fingerprint: string): PartyXpub {
  const t = xpub.trim();
  if (isOriginTagged(t)) {
    return { xpub: t };
  }
  return { xpub: t, fingerprint: fingerprint.trim().toLowerCase() };
}

/* --------------------------- Step 1: wallet ------------------------------- */

const WALLETS = [
  { id: "Sparrow",    title: "Sparrow",    sub: "Desktop"  },
  { id: "BlueWallet", title: "Blue",       sub: "Mobile"   },
  { id: "Cake",       title: "Cake",       sub: "Mobile"   },
  { id: "Coldcard",   title: "Coldcard",   sub: "Hardware" },
];

function StepWallet({
  draft,
  patch,
}: {
  draft: Draft;
  patch: (p: Partial<Draft>) => void;
}) {
  const hasOriginTag = isOriginTagged(draft.ownerXpub);
  const detectedFp = hasOriginTag ? extractFingerprint(draft.ownerXpub) : null;

  return (
    <div>
      <h1 className="font-serif text-3xl md:text-4xl">Connect your wallet</h1>
      <p className="mt-2 text-muted">
        Paste your wallet's xpub. This is a public key. It can watch, but it cannot
        spend. GhostKey never sees your private keys.
      </p>

      <div className="mt-8">
        <Field
          label="Your xpub"
          hint={
            hasOriginTag && detectedFp
              ? `Fingerprint detected: ${detectedFp}`
              : "Most wallets export this from a 'Show xpub' or 'Account info' screen."
          }
        >
          <textarea
            rows={3}
            value={draft.ownerXpub}
            onChange={(e) => patch({ ownerXpub: e.target.value })}
            placeholder="[d34db33f/86'/0'/0']xpub6C..."
            spellCheck={false}
            autoComplete="off"
            className="textarea"
          />
        </Field>

        {!hasOriginTag && draft.ownerXpub.trim() ? (
          <Field
            label="Wallet fingerprint"
            hint="Eight hex characters. Sparrow shows it under 'Settings → Keystore'. Coldcard shows it on the home screen."
          >
            <input
              type="text"
              value={draft.ownerFingerprint}
              onChange={(e) =>
                patch({ ownerFingerprint: e.target.value.replace(/\s+/g, "") })
              }
              placeholder="d34db33f"
              spellCheck={false}
              autoComplete="off"
              maxLength={8}
              className="input font-mono text-[13px] uppercase"
            />
          </Field>
        ) : null}

        <Field label="Which wallet did this come from?">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {WALLETS.map((w) => (
              <Tile
                key={w.id}
                title={w.title}
                sub={w.sub}
                selected={draft.ownerWallet === w.id}
                onClick={() =>
                  patch({
                    ownerWallet: draft.ownerWallet === w.id ? null : w.id,
                  })
                }
              />
            ))}
          </div>
        </Field>

        <Field
          label="Your email (optional)"
          hint="If you miss a check-in we'll send a reminder here before your heir is contacted. Leave blank if you'd rather not be reminded."
        >
          <input
            type="email"
            value={draft.ownerEmail}
            onChange={(e) => patch({ ownerEmail: e.target.value })}
            placeholder="you@example.com"
            spellCheck={false}
            autoComplete="email"
            inputMode="email"
            className="input"
          />
        </Field>

        <div className="mt-2 space-y-2">
          <Disclosure summary={<span>What is an xpub, and where do I get it?</span>}>
            <p className="mb-3 text-sm text-muted">
              An xpub (extended public key) is a string that starts with{" "}
              <code className="font-mono">xpub</code>,{" "}
              <code className="font-mono">tpub</code>, or{" "}
              <code className="font-mono">vpub</code>. It lets GhostKey watch
              every address your wallet ever generates and build an inheritance
              script around them. It cannot move funds.
            </p>
            <ul className="space-y-2 pl-4 text-sm text-muted list-disc">
              <li>
                <strong className="text-[var(--text)]">Sparrow:</strong>{" "}
                File → New Wallet → existing wallet → Settings → Keystores → Show xpub.
              </li>
              <li>
                <strong className="text-[var(--text)]">BlueWallet:</strong>{" "}
                Wallet → ⋯ → Wallet details → Show xpub.
              </li>
              <li>
                <strong className="text-[var(--text)]">Cake Wallet:</strong>{" "}
                Menu → Wallets → Show keys → Public key. (Cake exports a single
                xpub per account.)
              </li>
              <li>
                <strong className="text-[var(--text)]">Coldcard:</strong>{" "}
                Advanced/Tools → Export Wallet → Generic JSON → copy the{" "}
                <code className="font-mono">bip86</code> entry.
              </li>
            </ul>
            <p className="mt-3 text-xs text-muted">
              Need step-by-step screenshots? See the{" "}
              <a
                href="https://github.com/Jolah1/ghostKey/tree/main/docs/xpub-guides"
                target="_blank"
                rel="noreferrer noopener"
                className="underline"
              >
                wallet xpub export guides
              </a>{" "}
              (Sparrow, BlueWallet, Cake, Specter, Coldcard).
            </p>
          </Disclosure>

          <Disclosure summary={<span>Advanced (paste a descriptor pair)</span>}>
            <p className="mb-4 text-xs text-muted">
              Already have a Taproot descriptor pair from the GhostKey
              command-line app? Paste both lines below and we'll skip the xpub
              step entirely.
            </p>
            <Field
              label="descriptor_external"
              hint="From vault.json. Starts with tr( and ends with /0/*)"
            >
              <textarea
                rows={3}
                value={draft.descriptorExternal}
                onChange={(e) => patch({ descriptorExternal: e.target.value })}
                placeholder="tr(...,or_d(pk([.../0/*)..."
                className="textarea"
                spellCheck={false}
              />
            </Field>
            <Field
              label="descriptor_internal"
              hint="Same shape, ends with /1/*)"
            >
              <textarea
                rows={3}
                value={draft.descriptorInternal}
                onChange={(e) => patch({ descriptorInternal: e.target.value })}
                placeholder="tr(...,or_d(pk([.../1/*)..."
                className="textarea"
                spellCheck={false}
              />
            </Field>
          </Disclosure>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------- Step 2: heir -------------------------------- */

const CHANNELS: { id: ContactChannel; title: string; sub: string; placeholder: string }[] = [
  { id: "sms",      title: "SMS",      sub: "Phone number", placeholder: "+234 800 000 0000" },
  { id: "whatsapp", title: "WhatsApp", sub: "Same number",  placeholder: "+234 800 000 0000" },
  { id: "email",    title: "Email",    sub: "Inbox",        placeholder: "sarah@example.com" },
];

function StepHeir({
  draft,
  patch,
}: {
  draft: Draft;
  patch: (p: Partial<Draft>) => void;
}) {
  const channelMeta =
    CHANNELS.find((c) => c.id === draft.heirContactChannel) ?? CHANNELS[0];
  const hasOriginTag = isOriginTagged(draft.heirXpub);
  const detectedFp = hasOriginTag ? extractFingerprint(draft.heirXpub) : null;

  return (
    <div>
      <h1 className="font-serif text-3xl md:text-4xl">Who should receive this</h1>
      <p className="mt-2 text-muted">
        They never have to know about this until the time comes. When it does,
        we reach them the way you choose to reach them below and they claim from there.
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
          hint="Stored encrypted. We don't message them unless you stop checking in."
        >
          <input
            type={draft.heirContactChannel === "email" ? "email" : "tel"}
            value={draft.heirContact}
            onChange={(e) => patch({ heirContact: e.target.value })}
            placeholder={channelMeta.placeholder}
            autoComplete="off"
            inputMode={draft.heirContactChannel === "email" ? "email" : "tel"}
            className="input"
          />
        </Field>

        <Field
          label="Their xpub"
          hint={
            hasOriginTag && detectedFp
              ? `Fingerprint detected: ${detectedFp}`
              : "Same kind of key as yours. If they don't have a wallet yet, set one up on a spare phone, export the xpub, and keep that phone safe."
          }
        >
          <textarea
            rows={3}
            value={draft.heirXpub}
            onChange={(e) => patch({ heirXpub: e.target.value })}
            placeholder="[c0ffee01/86'/0'/0']xpub6C..."
            spellCheck={false}
            autoComplete="off"
            className="textarea"
          />
        </Field>

        {!hasOriginTag && draft.heirXpub.trim() ? (
          <Field label="Their wallet fingerprint">
            <input
              type="text"
              value={draft.heirFingerprint}
              onChange={(e) =>
                patch({ heirFingerprint: e.target.value.replace(/\s+/g, "") })
              }
              placeholder="c0ffee01"
              spellCheck={false}
              autoComplete="off"
              maxLength={8}
              className="input font-mono text-[13px] uppercase"
            />
          </Field>
        ) : null}
      </div>
    </div>
  );
}

/* --------------------------- Step 3: timing ------------------------------- */

const MONTH_OPTIONS = [1, 2, 3, 6, 9, 12];

function StepTiming({
  draft,
  patch,
  demoMode,
}: {
  draft: Draft;
  patch: (p: Partial<Draft>) => void;
  demoMode: boolean;
}) {
  // Pick the right preset list for this server's posture. The lookup
  // is centralised in timing.ts so the two setup portals stay in
  // lockstep — see cadencePresetsFor / gracePresetsFor there.
  const cadenceList = cadencePresetsFor(demoMode);
  const graceList = gracePresetsFor(demoMode);
  return (
    <div>
      {demoMode && <DemoTimingNote />}
      <h1 className="font-serif text-3xl md:text-4xl">How long should we wait</h1>
      <p className="mt-2 text-muted">
        If you stop checking in, this is how long before the person you named can
        claim. Longer gives you more margin if you forget.
      </p>

      <div className="mt-8">
        <Field label="Waiting period">
          <div className="flex items-center gap-4">
            <input
              type="range"
              min={1}
              max={12}
              value={draft.waitingMonths}
              onChange={(e) => patch({ waitingMonths: Number(e.target.value) })}
              aria-label="Waiting period in months"
              className="w-full accent-[var(--accent)]"
              list="month-marks"
            />
            <datalist id="month-marks">
              {MONTH_OPTIONS.map((m) => <option key={m} value={m} />)}
            </datalist>
            <span className="min-w-[5.5rem] text-right font-display text-3xl font-bold tracking-tight text-accent">
              {monthsLabel(draft.waitingMonths)}
            </span>
          </div>
        </Field>

        <Field label="Check-in reminder">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {cadenceList.map((c) => (
              <Tile
                key={c.id}
                title={c.label}
                sub={c.sub}
                selected={draft.cadenceId === c.id}
                onClick={() => patch({ cadenceId: c.id })}
              />
            ))}
          </div>
        </Field>

        <Field
          label="Grace period"
          hint="Extra time after a missed reminder, before the countdown to inheritance begins."
        >
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {graceList.map((g) => (
              <Tile
                key={g.id}
                title={g.label}
                sub={g.sub}
                selected={draft.graceId === g.id}
                onClick={() => patch({ graceId: g.id })}
              />
            ))}
          </div>
        </Field>
      </div>
    </div>
  );
}

function monthsLabel(n: number): string {
  if (n === 12) return "1 year";
  return `${n} month${n === 1 ? "" : "s"}`;
}

/**
 * Small inline reminder shown above the timing pickers when the
 * server reports demo mode. It's deliberately the only signal in
 * this step; the global red banner shipped by App.tsx already tells
 * the user this is a demo server, but it's easy to forget at the
 * moment of choosing a 10-second cadence. This note is in their
 * eyeline at the exact instant they make that choice.
 */
function DemoTimingNote() {
  return (
    <div
      role="note"
      className="mb-4 rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-sm text-amber-200"
    >
      <strong className="font-semibold">Demo server.</strong>{" "}
      Cadences and grace periods are measured in seconds so the alarm
      and claim flow are observable in real time. Don't use this server
      for real funds.
    </div>
  );
}

/* --------------------------- Step 4: review ------------------------------- */

function StepReview({ draft }: { draft: Draft }) {
  const usedAdvanced =
    draft.descriptorExternal.trim() && draft.descriptorInternal.trim();

  const summary = useMemo(
    () => [
      ["Goes to", draft.heirName || "—"],
      ["Reach them by",
        draft.heirContactChannel === "sms" ? "SMS"
        : draft.heirContactChannel === "whatsapp" ? "WhatsApp"
        : "Email"],
      ["Their contact", short(draft.heirContact) || "—"],
      ["Their xpub", usedAdvanced ? "(in descriptor)" : (short(draft.heirXpub) || "—")],
      ["Waiting period", monthsLabel(draft.waitingMonths)],
      ["Reminder", cadenceByIdAnywhere(draft.cadenceId).label],
      ["Grace period", graceByIdAnywhere(draft.graceId).label],
      ["Your xpub", usedAdvanced ? "(in descriptor)" : (short(draft.ownerXpub) || "—")],
    ],
    [draft, usedAdvanced],
  );

  return (
    <div>
      <h1 className="font-serif text-3xl md:text-4xl">Review and activate</h1>
      <p className="mt-2 text-muted">
        This is what we'll set up. You can change anything later while you're
        still checking in.
      </p>

      <dl className="mt-8 card divide-y divide-[var(--border)]">
        {summary.map(([k, v]) => (
          <div
            key={k}
            className="flex items-baseline justify-between gap-4 px-5 py-4 text-sm"
          >
            <dt className="text-muted">{k}</dt>
            <dd className="text-right font-medium text-[var(--text)]">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function short(s: string): string {
  if (!s) return "";
  if (s.length <= 14) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}
