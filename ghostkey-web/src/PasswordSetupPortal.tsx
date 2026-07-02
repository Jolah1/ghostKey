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
 *
 * Heir-key threat model (#116 L4):
 *   - Door A (default, no-wallet heir): the heir's key is generated in
 *     THIS browser and sealed under a random claim token via HKDF. Only
 *     the ciphertext leaves the browser; the server stores the sealed
 *     blob and the claim token sealed at rest under the per-vault master
 *     key (so it can email the link once the owner is gone). The earlier
 *     direct master-key DERIVATION of the heir key (F2) was removed, but
 *     be precise about what remains: the at-rest token is sealed under
 *     the master key, and the heir blob is sealed under that token, so a
 *     holder of the master key CAN reconstruct the heir xprv. The server
 *     in fact opens the at-rest token routinely, to send the link. Door A
 *     is therefore NOT reconstruction-proof — never claim it is. The
 *     guards are the on-chain timelock (nothing moves while the owner
 *     checks in), public on-chain visibility, and keeping the master key
 *     in a KMS (#184). At claim time the server also momentarily handles
 *     the unsealed key to build+sign the one-shot send. Door B below is
 *     the only fully non-custodial option.
 *   - Door B (heir holds own key): the owner pastes the heir's xpub; the
 *     server stores only that public key and never anything spendable.
 *     Strictly non-custodial; the residual above does not apply.
 */
import { useEffect, useState } from "react";
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
  type SealedSetup,
  type GuardianParty,
  type VaultBalanceView,
} from "./api";
import { saveVaultMeta } from "./vaultStore";
import {
  buildHeirEnvelope,
  downloadHeirEnvelope,
  type HeirEnvelope,
} from "./independenceProof";
import { AssistChat } from "./AssistChat";
import { VideoMessageRecorder, type RecordedClip } from "./VideoMessageRecorder";
import { prepareVideo } from "./crypto/video";
import {
  checkPassword,
  preloadStrengthChecker,
  type StrengthResult,
} from "./passwordStrength";
import { passwordStepError } from "./setupGates";
import {
  generateParty,
  wipe,
  type Network,
} from "./crypto/keygen";
import {
  sealVaultSecrets,
  sealWithKey,
  deriveClaimKek,
  hashEmailForLookup,
  b64encode,
} from "./crypto/sealing";
import { randomBytes } from "@noble/hashes/utils.js";
import { unlockYearToHeight, minUnlockYear } from "./unlockHeight";
import { usePrice, btcAndUsd } from "./fiat";
import {
  DEFAULT_CADENCE_ID,
  DEFAULT_GRACE_ID,
  DEFAULT_DEMO_WAITING_ID,
  DEMO_WAITING_PRESETS,
  cadencePresetsFor,
  gracePresetsFor,
  defaultCadenceIdFor,
  defaultGraceIdFor,
  cadenceByIdAnywhere,
  graceByIdAnywhere,
  demoWaitingById,
} from "./timing";

interface Props {
  onCancel: () => void;
  onCreated: (v: VaultListItem) => void;
  /** Sent to the sign-in page when this email already has a vault. */
  onSignIn: () => void;
}

type ContactChannel = "sms" | "email" | "whatsapp";

/**
 * One heir's worth of contact info. The setup wizard collects an
 * array of these (`Draft.heirs`) so multi-heir vaults are possible:
 * each heir gets a separate vault with its own claim token and
 * one-time link. All vaults in the same wizard run share the same
 * owner xpub, timelock, cadence, and grace, and they get the same
 * `groupId` in localStorage so the Dashboard renders them as one
 * card.
 */
interface HeirDraft {
  name: string;
  contact: string;
  channel: ContactChannel;
  /** #98 Part 2 (item 3): optional short note from the owner, shown to
   *  this heir in the claim message ("They left you a note: ..."). */
  note?: string;
  /** Door B (advanced): the heir holds their own key. When true, we use
   *  `heirXpub` for the descriptor and seal no heir material server-side,
   *  so GhostKey holds nothing that can spend. Default (false) is Door A:
   *  we generate and seal a key for them. */
  ownKey?: boolean;
  /** The heir's own account xpub, origin-tagged (`[fp/86h/..]xpub...`),
   *  required when `ownKey` is true. */
  heirXpub?: string;
}

/** One guardian's contact details for a guardian vault (#81). The
 *  guardian's key is generated and sealed in the browser at submit; the
 *  owner only fills in who to reach and how. */
interface GuardianDraft {
  name: string;
  contact: string;
  channel: ContactChannel;
}

/** Largest number of heirs the wizard allows. Arbitrary cap. */
const MAX_HEIRS = 5;

/* ---- xpub input helpers (Door B). Mirror SetupPortal.tsx. ---- */

/** True if the string looks like a (possibly origin-tagged) xpub. */
function looksLikeXpub(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  const body = t.startsWith("[") ? t.replace(/^\[[^\]]+\]/, "") : t;
  return /^[xtvuyz]pub[1-9A-HJ-NP-Za-km-z]{50,}$/.test(body);
}

/** Extract the lowercase fingerprint from an origin tag, or null. */
function extractFingerprint(s: string): string | null {
  const m = s.trim().match(/^\[([0-9a-fA-F]{8})\//);
  return m ? m[1].toLowerCase() : null;
}

/** A heir xpub is usable for Door B only if it parses AND carries an
 *  origin tag — the server rejects a bare xpub with no fingerprint. */
function isValidHeirXpub(s: string | undefined): boolean {
  return Boolean(s) && looksLikeXpub(s!) && extractFingerprint(s!) !== null;
}

interface Draft {
  // Step 1 — heirs + timing
  /** "standard" = the default single/multi adult-heir flow. "guardian"
   *  = #81: one heir who is a child or otherwise needs help, plus two
   *  guardians, one of whom must co-sign the claim. */
  vaultKind: "standard" | "guardian";
  heirs: HeirDraft[];
  /** Exactly two, used only when `vaultKind === "guardian"`. */
  guardians: GuardianDraft[];
  /** Optional guardian-vault unlock year (#81 P5): hold the funds until
   *  around 1 Jan of this year (e.g. until a child reaches an age), on top
   *  of the inactivity wait. `null` = no extra lock. */
  unlockYear: number | null;
  waitingMonths: number;
  // Replaces the legacy `reminderEveryTwoWeeks: boolean`. Holds the
  // string id of a CADENCE_PRESETS entry. See ./timing.ts for the
  // full enumeration.
  cadenceId: string;
  // New: explicit grace period (previously hard-coded to 3 days).
  // Holds the string id of a GRACE_PRESETS entry.
  graceId: string;
  // Demo-mode-only: seconds-scale "waiting period" picker. Replaces
  // the months slider when the server reports `demo_mode: true`. The
  // chosen seconds value drives `grace_period_secs` on submit and the
  // dashboard's "Waiting period" StatCard. Holds the id of a
  // DEMO_WAITING_PRESETS entry.
  demoWaitingId: string;

  // Step 2 — owner identity + password
  ownerEmail: string;
  /** #98 Part 2 (item 3): owner's display name, shown to the heir as
   *  "<name> set this up for you" in the claim message. Optional. */
  ownerName: string;
  password: string;
  passwordConfirm: string;
  /** The user has confirmed they saved the password somewhere they
   *  can get it back. Gates "Create vault": the password can never be
   *  reset, so a fresh setup is the one moment we can insist they
   *  store it before any money is at stake. */
  savedPassword: boolean;

  /** F4: optional trusted contact who is alerted if the owner ever
   *  pays the panic-stop LNURL. Same channel vocabulary as heirs;
   *  the dashboard surfaces this field as "Trusted contact (panic-stop)". */
  trustedContact: string;
  trustedContactChannel: ContactChannel;
}

const EMPTY_HEIR: HeirDraft = {
  name: "",
  contact: "",
  channel: "email",
};

const EMPTY_GUARDIAN: GuardianDraft = {
  name: "",
  contact: "",
  channel: "email",
};

const EMPTY: Draft = {
  vaultKind: "standard",
  heirs: [{ ...EMPTY_HEIR }],
  guardians: [{ ...EMPTY_GUARDIAN }, { ...EMPTY_GUARDIAN }],
  unlockYear: null,
  waitingMonths: 3,
  cadenceId: DEFAULT_CADENCE_ID,
  graceId: DEFAULT_GRACE_ID,
  demoWaitingId: DEFAULT_DEMO_WAITING_ID,
  ownerEmail: "",
  ownerName: "",
  password: "",
  passwordConfirm: "",
  savedPassword: false,
  trustedContact: "",
  trustedContactChannel: "email",
};

const STEPS = ["Heir", "Password", "Fund"] as const;

// Default Bitcoin network for new vaults on this server. Overridden
// at runtime from the server's `/health.default_network` value if it
// emits one (older servers don't). The `NETWORK` const stays here as
// the SAFE fallback when /health is unreachable or the field is
// missing — picking testnet rather than mainnet on the failure path
// is by design: a wrong-network vault is recoverable, a mainnet vault
// created against an unconfigured server is not.
const NETWORK_FALLBACK: Network = "testnet";

// Bitcoin block cadence: ~144 blocks/day, 30 days/month. Min 144 (1d)
// guards against the user dragging the slider to zero on an edge case.
function monthsToBlocks(months: number): number {
  return Math.max(144, months * 30 * 144);
}

/* ============================================================ */

export function PasswordSetupPortal({ onCancel, onCreated, onSignIn }: Props) {
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  // True when create failed because this email already has a vault —
  // we steer the user to sign in and use Add Heir instead.
  const [emailTaken, setEmailTaken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [kdfProgress, setKdfProgress] = useState<number>(0);
  // Optional owner video message (#85), captured on the password step
  // and uploaded silently during creation. Not in `draft` because a
  // Blob isn't serialisable to localStorage.
  const [videoClip, setVideoClip] = useState<RecordedClip | null>(null);
  // The video upload is best-effort (a failure must not abort a good
  // vault), but the owner still has to HEAR about it — silently losing
  // the clip means the heir finds out at claim time (#222).
  const [videoSaveFailed, setVideoSaveFailed] = useState(false);
  // Demo-mode flag from /health. See SetupPortal.tsx for the
  // rationale; both portals share the same gating logic so the
  // experience is consistent across the two creation paths.
  const [demoMode, setDemoMode] = useState(false);
  // Bitcoin network for this server. Read from /health on mount;
  // falls back to NETWORK_FALLBACK ("testnet") if /health is
  // unreachable or the server is old enough not to emit the field.
  // See `crates/ghostkey-server/src/config.rs` for the env var.
  const [network, setNetwork] = useState<Network>(NETWORK_FALLBACK);

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
        if (alive) {
          setDemoMode(false);
          // Leave `network` at the fallback ("testnet").
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  // After creation we move to step 3 (Fund) and need to remember the
  // vaults + addresses. Multi-heir wizards produce N entries here,
  // one per heir; single-heir wizards produce a one-element list.
  // We keep them in component state only — a page refresh during
  // the funding step will lose the addresses (the user is bounced
  // to /dashboard which doesn't display addresses today), but the
  // funds are safe on-chain regardless and each address can be
  // re-derived from /vaults/:id/address at any time.
  const [created, setCreated] = useState<
    | {
        groupId: string;
        vaults: Array<{
          vaultId: string;
          heirName: string;
          address: string | null;
          /** Heir envelope (block A), built at setup while the heir
           *  xprv is in memory. Absent for F2 no-wallet heirs and on
           *  best-effort build failure. */
          envelope?: HeirEnvelope;
        }>;
      }
    | null
  >(null);

  function patch(p: Partial<Draft>) {
    setDraft((d) => ({ ...d, ...p }));
    setError(null);
  }

  // Live zxcvbn verdict for the current password draft. Owned here
  // (not in StepPassword) because `validate(1)` gates the wizard on
  // it. Null = empty password or check still in flight.
  const [strength, setStrength] = useState<StrengthResult | null>(null);

  // Start downloading the zxcvbn dictionaries as soon as the user
  // reaches the password step, so the meter responds instantly by
  // the time they finish typing.
  useEffect(() => {
    if (step === 1) preloadStrengthChecker();
  }, [step]);

  useEffect(() => {
    if (!draft.password) {
      setStrength(null);
      return;
    }
    let alive = true;
    // Small debounce: zxcvbn is fast but there's no point scoring
    // every intermediate keystroke of a 20-character passphrase.
    const timer = window.setTimeout(() => {
      // Feed zxcvbn the words an attacker targeting THIS user would
      // try first: their own email and the heir names/contacts they
      // typed one step ago. "Margaret2024" is a fine password for
      // strangers and a terrible one when your heir is Margaret.
      const personal = [
        draft.ownerEmail,
        ...draft.heirs.flatMap((h) => [h.name, h.contact]),
      ].filter(Boolean);
      void checkPassword(draft.password, personal).then((r) => {
        if (alive) setStrength(r);
      });
    }, 150);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [draft.password, draft.ownerEmail, draft.heirs]);

  function validate(s: number): string | null {
    if (s === 0) {
      // Validate every heir in turn. Empty array would be a UX bug
      // (the wizard always seeds one); guard against it anyway.
      if (draft.heirs.length === 0) {
        return "Add at least one heir.";
      }
      for (let i = 0; i < draft.heirs.length; i++) {
        const heir = draft.heirs[i];
        const tag = draft.heirs.length === 1 ? "" : ` (heir #${i + 1})`;
        if (!heir.name.trim()) {
          return `Tell us who is inheriting${tag}.`;
        }
        if (!heir.contact.trim()) {
          return `Add a phone number or email so we can reach them${tag}.`;
        }
        if (
          heir.channel === "email" &&
          !/^.+@.+\..+$/.test(heir.contact.trim())
        ) {
          return `That email looks off${tag}. Double-check it.`;
        }
      }
      // Each heir contact must be unique across the group. The
      // claim flow is keyed on (vault_id, claim_token), so duplicate
      // contacts technically work but they're almost always a typo
      // — the user pasted "alice@example.com" twice by mistake.
      const contacts = draft.heirs.map((h) => h.contact.trim().toLowerCase());
      const dup = contacts.find((c, i) => contacts.indexOf(c) !== i);
      if (dup) {
        return `Two heirs share the same contact (${dup}). Each heir needs a different email or phone.`;
      }

      // Guardian vaults (#81): the child needs exactly two guardians, one
      // of whom co-signs the claim. Validate both, and make sure no two
      // people in the vault share a contact (a typo would otherwise send
      // two of them the same link).
      if (draft.vaultKind === "guardian") {
        for (let i = 0; i < draft.guardians.length; i++) {
          const g = draft.guardians[i];
          const tag = ` (guardian #${i + 1})`;
          if (!g.name.trim()) {
            return `Tell us who the guardian is${tag}.`;
          }
          if (!g.contact.trim()) {
            return `Add a phone number or email for the guardian${tag}.`;
          }
          if (g.channel === "email" && !/^.+@.+\..+$/.test(g.contact.trim())) {
            return `That guardian email looks off${tag}. Double-check it.`;
          }
        }
        const everyone = [
          ...draft.heirs.map((h) => h.contact.trim().toLowerCase()),
          ...draft.guardians.map((g) => g.contact.trim().toLowerCase()),
        ];
        const clash = everyone.find((c, i) => everyone.indexOf(c) !== i);
        if (clash) {
          return `Two people in this vault share the same contact (${clash}). The heir and each guardian need a different email or phone.`;
        }
      }
    }
    if (s === 1) {
      // Single source of truth, shared with the "Create vault" button's
      // disable condition and the unit tests (#116 L2).
      return passwordStepError({
        ownerEmail: draft.ownerEmail,
        password: draft.password,
        passwordConfirm: draft.passwordConfirm,
        savedPassword: draft.savedPassword,
        strength,
      });
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

    // Door B safety: if a heir is set to hold their own key, the xpub
    // must be valid. Otherwise `doorB` would be false and we'd silently
    // generate a key instead — the opposite of what the owner asked for.
    const badHeir = draft.heirs.find(
      (h) => h.ownKey && !isValidHeirXpub(h.heirXpub),
    );
    if (badHeir) {
      setError(
        `${badHeir.name.trim() || "Your heir"} is set to hold their own key, but the xpub is missing or isn't origin-tagged. Paste one that starts with [fingerprint/...].`,
      );
      return;
    }

    setBusy(true);
    setError(null);
    setEmailTaken(false);
    setKdfProgress(0);

    // Multi-heir is N parallel vaults that share owner xpub +
    // timelock + cadence + grace. We generate the owner keys ONCE,
    // then for each heir mint a fresh heir xprv + claim token,
    // seal everything under the owner's password, POST, and save
    // the local meta with a shared `groupId`. The Dashboard then
    // renders the N vaults as one card.
    //
    // If a POST fails partway through (e.g. heir #3 of 5), the
    // first two vaults are real on the server and registered in
    // localStorage — we surface a clear error pointing at them
    // and the user can either accept the partial group or delete
    // the partial vaults from the server. We deliberately don't
    // try to roll back a partial multi-vault setup: each vault is
    // independently usable, and "delete two of the five" needs an
    // admin route that doesn't exist yet.

    // We declare these out here so we can wipe() them in the
    // `finally` even if something throws partway through.
    let ownerParty: ReturnType<typeof generateParty> | null = null;
    const heirParties: Array<ReturnType<typeof generateParty>> = [];
    const claimTokens: Uint8Array[] = [];
    let ownerKek: Uint8Array | null = null;

    try {
      // ---- Guardian vault (#81) -----------------------------------
      // A child heir plus two guardians, one of whom co-signs the claim.
      // Always browser-keygen (no Door B): we generate owner + heir + two
      // guardian keys, seal each, and POST to /vaults/guardian. Single
      // vault, single heir — the multi-heir parallel loop below is for
      // standard vaults only.
      if (draft.vaultKind === "guardian") {
        const heir = draft.heirs[0];

        // Shared timing + lookup, same maths as the standard path.
        const ownerEmailHash = hashEmailForLookup(draft.ownerEmail);
        const checkinSecs = cadenceByIdAnywhere(draft.cadenceId).seconds;
        const timelockBlocks = demoMode
          ? 1
          : monthsToBlocks(draft.waitingMonths);
        const graceSecs = demoMode
          ? demoWaitingById(draft.demoWaitingId).seconds
          : graceByIdAnywhere(draft.graceId).seconds;
        const groupId = crypto.randomUUID();

        // Mint the four parties + three claim tokens (heir + 2 guardians).
        // Owner key is sealed under the password; the heir and each
        // guardian key under their own claim token, so the server never
        // holds anything spendable without a delivered link.
        ownerParty = generateParty(network);
        const heirParty = generateParty(network);
        heirParties.push(heirParty);
        const heirToken = randomBytes(32);
        claimTokens.push(heirToken);

        setKdfProgress(0);
        const sealed = await sealVaultSecrets({
          password: draft.password,
          ownerXprv: ownerParty.xprv,
          heirXprv: heirParty.xprv,
          ownerToken: "ghostkey-placeholder-owner-token-v1",
          claimTokenRaw: heirToken,
          keepOwnerKek: true,
          onProgress: (p) => setKdfProgress(Math.round(p * 100)),
        });
        ownerKek = sealed._owner_kek ?? null;

        const sealedBody: SealedSetup = {
          password_salt_b64: sealed.password_salt,
          password_kdf_mem_kib: sealed.password_kdf_mem_kib,
          password_kdf_iters: sealed.password_kdf_iters,
          owner_xprv_ct_b64: sealed.owner_xprv.ct,
          owner_xprv_nonce_b64: sealed.owner_xprv.nonce,
          owner_token_ct_b64: sealed.owner_token.ct,
          owner_token_nonce_b64: sealed.owner_token.nonce,
          owner_email_hash: ownerEmailHash,
          heir_xprv_ct_b64: sealed.heir_xprv.ct,
          heir_xprv_nonce_b64: sealed.heir_xprv.nonce,
          claim_token_b64: b64encode(heirToken),
        };

        // Seal each guardian's freshly minted key under its own claim
        // token (same scheme as the heir key). The token is wiped via
        // `claimTokens` in the `finally`; the KEK is wiped here.
        const guardianParties: GuardianParty[] = draft.guardians.map((g) => {
          const gParty = generateParty(network);
          const gToken = randomBytes(32);
          claimTokens.push(gToken);
          const gKek = deriveClaimKek(gToken);
          const gSealed = sealWithKey(
            gKek,
            new TextEncoder().encode(gParty.xprv),
          );
          gKek.fill(0);
          return {
            xpub: gParty.xpub,
            fingerprint: gParty.fingerprint,
            xprv_ct_b64: gSealed.ct,
            xprv_nonce_b64: gSealed.nonce,
            claim_token_b64: b64encode(gToken),
            contact: g.contact.trim(),
            contact_channel: g.channel,
          };
        });

        const label = `${heir.name.trim()}'s inheritance`;
        const heirContactPayload = JSON.stringify({
          name: heir.name.trim(),
          contact: heir.contact.trim(),
          channel: heir.channel,
        });

        const resp = await api.createVaultGuardian({
          label,
          network,
          owner: { xpub: ownerParty.xpub, fingerprint: ownerParty.fingerprint },
          heir: { xpub: heirParty.xpub, fingerprint: heirParty.fingerprint },
          guardian1: guardianParties[0],
          guardian2: guardianParties[1],
          timelock_blocks: timelockBlocks,
          checkin_period_secs: checkinSecs,
          grace_period_secs: graceSecs,
          owner_contact: draft.ownerEmail.trim(),
          owner_contact_channel: "email",
          heir_contact: heirContactPayload,
          heir_contact_channel: heir.channel,
          sealed: sealedBody,
          from_name: draft.ownerName.trim() || null,
          heir_note: heir.note?.trim() || null,
          // P5: optional absolute unlock. demoMode pins the on-chain
          // timelock to the minimum, so we skip the multi-year CLTV there
          // (the off-chain demo can't wait years of blocks anyway).
          unlock_height: demoMode ? null : unlockYearToHeight(draft.unlockYear),
        });

        // Re-seal the REAL owner_token under the password KEK (the server
        // only issues it in the response). Non-fatal on failure.
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
            console.warn("owner-token re-seal failed for guardian vault", e);
          }
        }

        // Owner video message, sealed under the HEIR's claim token (the
        // heir's link unlocks it). Best-effort.
        if (videoClip) {
          try {
            const bytes = new Uint8Array(await videoClip.blob.arrayBuffer());
            const prepared = prepareVideo(ownerParty.xprv, heirToken, bytes);
            await api.uploadVideo(resp.id, resp.owner_token, {
              ...prepared,
              mime: videoClip.mime,
              duration_ms: Math.round(videoClip.durationMs),
            });
          } catch (e) {
            console.warn("video upload failed for guardian vault", resp.id, e);
            setVideoSaveFailed(true);
          }
        }

        saveVaultMeta({
          id: resp.id,
          label,
          owner: { address: draft.ownerEmail.trim() },
          heir: {
            name: heir.name.trim(),
            email: heir.channel === "email" ? heir.contact.trim() : "",
            address: "",
          },
          createdAt: new Date().toISOString(),
          ownerToken: resp.owner_token,
          groupId,
        });

        let address: string | null = null;
        try {
          const a = await api.getVaultAddress(resp.id);
          address = a.address;
        } catch (e) {
          console.warn("address fetch failed for guardian vault", resp.id, e);
        }

        // Block A heir envelope — the heir's own offline copy. For a
        // guardian vault this alone cannot claim (a guardian key is also
        // needed), but it preserves the owner-recovery-file backstop and
        // the heir's record. Best-effort.
        let envelope: HeirEnvelope | undefined;
        if (resp.descriptor_external && resp.descriptor_internal) {
          try {
            setKdfProgress(0);
            envelope = await buildHeirEnvelope({
              vaultId: resp.id,
              label: resp.label ?? label,
              network,
              timelockBlocks,
              descriptorExternal: resp.descriptor_external,
              descriptorInternal: resp.descriptor_internal,
              heirName: heir.name.trim(),
              heirXprv: heirParty.xprv,
              onProgress: (pp) => setKdfProgress(Math.round(pp * 100)),
            });
          } catch (e) {
            console.warn("heir envelope build failed for guardian vault", e);
          }
        }

        onCreated({
          id: resp.id,
          label: resp.label,
          status: resp.status,
          next_deadline_at: resp.next_deadline_at,
        });
        setCreated({
          groupId,
          vaults: [
            { vaultId: resp.id, heirName: heir.name.trim(), address, envelope },
          ],
        });
        setStep(2);
        return;
      }

      // (a) Mint owner keys ONCE. Every heir's vault uses the same
      // owner xpub; the same keypath spend works across all of them.
      ownerParty = generateParty(network);

      // (b) Mint heir keys + claim token per heir. Heir xprvs are
      // independent so a compromise of one heir's claim link doesn't
      // touch the others.
      for (let i = 0; i < draft.heirs.length; i++) {
        heirParties.push(generateParty(network));
        claimTokens.push(randomBytes(32));
      }

      // (c) Hash the owner email for cross-device lookup. Shared
      // across all vaults in the group — sign-in by email returns
      // every vault on the same owner key.
      const ownerEmailHash = hashEmailForLookup(draft.ownerEmail);

      // (d) Compute shared timing once. In demo mode the user picked
      // a single seconds-scale "waiting period" that subsumes the
      // grace-period picker; we map it to `grace_period_secs` and pin
      // `timelock_blocks` to the minimum (the demo flow only exercises
      // the off-chain portion of the claim).
      const checkinSecs = cadenceByIdAnywhere(draft.cadenceId).seconds;
      const timelockBlocks = demoMode ? 1 : monthsToBlocks(draft.waitingMonths);
      const graceSecs = demoMode
        ? demoWaitingById(draft.demoWaitingId).seconds
        : graceByIdAnywhere(draft.graceId).seconds;

      // (e) Single shared groupId — only meaningful client-side
      // (the Dashboard uses it to render the N vaults as one card).
      // crypto.randomUUID is available in every browser we target.
      const groupId = crypto.randomUUID();

      const createdEntries: Array<{
        vaultId: string;
        heirName: string;
        address: string | null;
        envelope?: HeirEnvelope;
      }> = [];

      // (f) Per-heir loop: seal, POST, persist.
      for (let i = 0; i < draft.heirs.length; i++) {
        const heir = draft.heirs[i];
        const heirParty = heirParties[i];
        const claimToken = claimTokens[i];

        // Placeholder owner-token slot — server returns the real
        // one in the response, we re-seal it in (g) per vault.
        const tokenPlaceholder = "ghostkey-placeholder-owner-token-v1";

        // KDF progress is reported as the fraction of THIS heir's
        // sealing pass. For a 5-heir group that means the bar runs
        // 0→100 five times, with the step indicator showing
        // "Heir 2 of 5" etc. Acceptable for an MVP.
        setKdfProgress(0);
        const sealed = await sealVaultSecrets({
          password: draft.password,
          ownerXprv: ownerParty.xprv,
          heirXprv: heirParty.xprv,
          ownerToken: tokenPlaceholder,
          claimTokenRaw: claimToken,
          keepOwnerKek: true,
          onProgress: (p) => setKdfProgress(Math.round(p * 100)),
        });
        // Keep the most recent owner_kek so the post-loop re-seal
        // pass (g) can run with the same key material. All heirs
        // use the same owner password so all sealVaultSecrets calls
        // derive the same KEK; we just need ONE reference for the
        // re-seal step.
        ownerKek = sealed._owner_kek ?? ownerKek;

        // Door B (advanced): the heir holds their own key. We use their
        // pasted xpub for the descriptor and seal NO heir material —
        // GhostKey then holds nothing that can spend. The generated
        // `heirParty`/`claimToken` above are discarded for this heir; we
        // still seal the owner side (the owner always uses the password
        // flow). Door A is the default: seal the generated heir key.
        const doorB = Boolean(heir.ownKey) && isValidHeirXpub(heir.heirXpub);

        const sealedBody: SealedSetup = {
          password_salt_b64: sealed.password_salt,
          password_kdf_mem_kib: sealed.password_kdf_mem_kib,
          password_kdf_iters: sealed.password_kdf_iters,
          owner_xprv_ct_b64: sealed.owner_xprv.ct,
          owner_xprv_nonce_b64: sealed.owner_xprv.nonce,
          owner_token_ct_b64: sealed.owner_token.ct,
          owner_token_nonce_b64: sealed.owner_token.nonce,
          owner_email_hash: ownerEmailHash,
          // Door A only: the heir's sealed key + the token it's sealed
          // under. Omitted for Door B so the server stores nothing
          // spendable and mints a fresh claim token at trigger time.
          ...(doorB
            ? {}
            : {
                heir_xprv_ct_b64: sealed.heir_xprv.ct,
                heir_xprv_nonce_b64: sealed.heir_xprv.nonce,
                claim_token_b64: b64encode(claimToken),
              }),
        };

        // Label disambiguates per-heir for the Dashboard list.
        const label =
          draft.heirs.length === 1
            ? `${heir.name.trim()}'s inheritance`
            : `${heir.name.trim()}'s share`;

        const heirContactPayload = JSON.stringify({
          name: heir.name.trim(),
          contact: heir.contact.trim(),
          channel: heir.channel,
        });

        // The heir key is always the browser-generated `heirParty`,
        // sealed under this heir's claim token (above). We never ask
        // the server to derive the heir key from its master key — that
        // would make every such heir key recoverable from one secret.
        // `heir_derivation` is therefore always null on new vaults.
        const resp = await api.createVaultFromXpub({
          label,
          network,
          owner: {
            xpub: ownerParty.xpub,
            fingerprint: ownerParty.fingerprint,
          },
          heir: doorB
            ? {
                xpub: heir.heirXpub!.trim(),
                fingerprint: extractFingerprint(heir.heirXpub!) ?? undefined,
              }
            : {
                xpub: heirParty.xpub,
                fingerprint: heirParty.fingerprint,
              },
          timelock_blocks: timelockBlocks,
          checkin_period_secs: checkinSecs,
          grace_period_secs: graceSecs,
          owner_contact: draft.ownerEmail.trim(),
          owner_contact_channel: "email",
          heir_contact: heirContactPayload,
          heir_contact_channel: heir.channel,
          sealed: sealedBody,
          heir_derivation: null,
          trusted_contact: draft.trustedContact.trim() || null,
          trusted_contact_channel: draft.trustedContact.trim()
            ? draft.trustedContactChannel
            : null,
          // #98 Part 2 (item 3): named, personal first contact.
          from_name: draft.ownerName.trim() || null,
          heir_note: heir.note?.trim() || null,
        });

        // (g) Re-seal the REAL owner_token under the same password
        // KEK. Same chicken-and-egg dance as the single-heir flow;
        // see the SealedSetup comments. Non-fatal on failure.
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
            console.warn(
              "owner-token re-seal failed for vault",
              resp.id,
              "; cross-device sign-in will need a fresh check-in first",
              e,
            );
          }
        }

        // (g2) Upload the owner's video message, if recorded (#85).
        // Sealed under THIS heir's claim token (so their link unlocks
        // it) and signed with the owner key (so a swapped clip fails
        // the heir's verification). Best-effort: a failure here must
        // not abort an otherwise-good vault — the message is a nicety,
        // not the inheritance.
        //
        // Skipped for Door B: the video is sealed under `claimToken`, but
        // a Door B vault has the scheduler mint a *different* token at
        // trigger, so the heir could never decrypt it. Better to not
        // store an undeliverable clip than to promise one.
        if (videoClip && !doorB) {
          try {
            const bytes = new Uint8Array(await videoClip.blob.arrayBuffer());
            const prepared = prepareVideo(ownerParty.xprv, claimToken, bytes);
            await api.uploadVideo(resp.id, resp.owner_token, {
              ...prepared,
              mime: videoClip.mime,
              duration_ms: Math.round(videoClip.durationMs),
            });
          } catch (e) {
            console.warn("video upload failed for vault", resp.id, e);
            setVideoSaveFailed(true);
          }
        }

        // (h) Persist local meta with the shared groupId so the
        // Dashboard groups this vault with its siblings.
        saveVaultMeta({
          id: resp.id,
          label,
          owner: {
            address: draft.ownerEmail.trim(),
          },
          heir: {
            name: heir.name.trim(),
            email: heir.channel === "email" ? heir.contact.trim() : "",
            address: "",
          },
          createdAt: new Date().toISOString(),
          ownerToken: resp.owner_token,
          groupId,
        });

        // (i) Fetch the receive address. Same per-heir best-effort.
        let address: string | null = null;
        try {
          const a = await api.getVaultAddress(resp.id);
          address = a.address;
        } catch (e) {
          console.warn("address fetch failed for vault", resp.id, e);
        }

        // (i2) Block A — heir envelope. Built here, the one moment the
        // heir's account key is reachable in this browser. Sealed under a
        // one-off passphrase (returned to show the owner once) so it can
        // be handed down without sharing the sign-in password.
        //
        // The heir key is the `heirParty` we minted above (same key the
        // server holds sealed under the claim token). Best-effort: a
        // failure here must never abort an otherwise-good vault.
        // Door B heirs hold their own key, so there is no envelope to
        // build — the server never had a heir secret to seal.
        let envelope: HeirEnvelope | undefined;
        if (!doorB && resp.descriptor_external && resp.descriptor_internal) {
          try {
            const heirXprv = heirParty.xprv;
            if (heirXprv) {
              setKdfProgress(0);
              envelope = await buildHeirEnvelope({
                vaultId: resp.id,
                label: resp.label ?? label,
                network,
                timelockBlocks,
                descriptorExternal: resp.descriptor_external,
                descriptorInternal: resp.descriptor_internal,
                heirName: heir.name.trim(),
                heirXprv,
                onProgress: (pp) => setKdfProgress(Math.round(pp * 100)),
              });
            }
          } catch (e) {
            console.warn("heir envelope build failed for vault", resp.id, e);
          }
        }

        createdEntries.push({
          vaultId: resp.id,
          heirName: heir.name.trim(),
          address,
          envelope,
        });

        // Notify the parent once per vault. The parent uses this to
        // update its own state but doesn't navigate.
        onCreated({
          id: resp.id,
          label: resp.label,
          status: resp.status,
          next_deadline_at: resp.next_deadline_at,
        });
      }

      setCreated({ groupId, vaults: createdEntries });
      setStep(2);
    } catch (e) {
      // Partial failure: any vaults already created above are real
      // on the server AND in localStorage; we leave them alone. The
      // user sees the error message and can decide what to do.
      // localStorage will have entries with the SAME groupId as the
      // ones that succeeded — the Dashboard will simply render N-1
      // of N. If they retry, they'll get a NEW groupId; the partial
      // group from this attempt stays as-is. Acceptable for an MVP
      // (the alternative is a server-side group rollback API that
      // doesn't exist yet).
      if (e instanceof ApiError && e.status === 409) {
        setEmailTaken(true);
        setError(
          "You already have a vault for this email. Sign in and use " +
            "Add Heir to add another.",
        );
      } else {
        setError(
          e instanceof ApiError
            ? e.message
            : e instanceof Error
              ? e.message
              : String(e),
        );
      }
    } finally {
      // Best-effort wipe of plaintext key material in memory.
      if (ownerParty) {
        // xprv strings are JS strings — can't wipe. Replace the
        // reference and hope GC clears it; this is documented in
        // keygen.ts as "best-effort, not a security boundary".
        ownerParty = null;
      }
      heirParties.length = 0;
      for (const t of claimTokens) wipe(t);
      claimTokens.length = 0;
      if (ownerKek) wipe(ownerKek);
      setBusy(false);
    }
  }

  const progress = ((step + 1) / STEPS.length) * 100;

  // The password-step gate, computed once: drives both the "Create vault"
  // disable and the inline reason below it (#116 L2).
  const gateReason = passwordStepError({
    ownerEmail: draft.ownerEmail,
    password: draft.password,
    passwordConfirm: draft.passwordConfirm,
    savedPassword: draft.savedPassword,
    strength,
  });

  return (
    <main className="bg-app fade-in">
      {/* pb-28 keeps the wizard's Continue/Back row clear of the
          floating GhostKey AI launcher (fixed bottom-right). */}
      <div className="mx-auto max-w-xl px-5 pt-12 pb-28 md:pt-16 lg:grid lg:max-w-5xl lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start lg:gap-14">
        <div className="min-w-0 lg:max-w-xl">
        <ProgressBar value={progress} />

        <div className="mt-10">
          <p className="eyebrow-dim">
            Step {step + 1} of {STEPS.length} · {STEPS[step]}
          </p>
        </div>

        <div className="mt-8">
          {step === 0 && <StepHeir draft={draft} patch={patch} demoMode={demoMode} />}
          {step === 1 && (
            <>
              <StepPassword
                draft={draft}
                patch={patch}
                busy={busy}
                kdfProgress={kdfProgress}
                strength={strength}
              />
              <div className="mt-6">
                {/* P4 (#120): a face+voice clip is the most identifying
                    data in the product; say where it lives before they
                    record. */}
                <p className="mb-2 text-xs text-dim">
                  If you record a message, it's encrypted like the rest of
                  your vault and stored that way. No one at GhostKey can play
                  it. It's released only to the heir you named, only when
                  they claim.
                </p>
                <VideoMessageRecorder
                  heirName={
                    draft.heirs.length === 1 ? draft.heirs[0]?.name : undefined
                  }
                  onChange={setVideoClip}
                  disabled={busy}
                />
              </div>

              {/* P1 (#120): the save-password attestation is the one thing
                  that prevents permanent loss — re-affirm it as the last
                  thing before "Create vault" (the button is also disabled
                  until the box above is ticked). */}
              <p className="mt-6 text-xs text-muted">
                Last thing before you create the vault: make sure your
                password is really saved. We can never reset it.
              </p>
            </>
          )}
          {step === 2 && created && <StepFund created={created} />}
        </div>

        {/* Best-effort video upload failed: the vault is real and safe,
            but the clip was lost. Say so here, because nothing else
            will (#222). */}
        {step === 2 && created && videoSaveFailed ? (
          <div className="mt-6">
            <InlineAlert tone="warning">
              Your video message didn't save. Your vault is fine. You can
              record the video again anytime from your dashboard.
            </InlineAlert>
          </div>
        ) : null}

        {error ? (
          <div className="mt-6">
            <InlineAlert tone="alarm">{error}</InlineAlert>
            {emailTaken ? (
              <div className="mt-3">
                <Button variant="ghost" size="sm" onClick={onSignIn}>
                  Sign in
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* When "Create vault" is disabled, say why — a dead button with
            no explanation is worse than the old guarded-click error. Only
            once the owner has started filling the step, so a pristine
            form doesn't shout. (#116 L2) */}
        {step === 1 &&
        !created &&
        (draft.ownerEmail.trim() || draft.password) &&
        gateReason ? (
          <p className="mt-6 text-right text-xs text-muted">{gateReason}</p>
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
              <Button
                onClick={activate}
                loading={busy}
                disabled={gateReason !== null}
              >
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

        <SetupRail step={step} draft={draft} demoMode={demoMode} />
      </div>
      <AssistChat
        intro="Setting up a vault? Ask anything about who needs what, what your heir will see, or how the waiting period works."
      />
    </main>
  );
}

/* ============================================================ */
/* Desktop context rail                                           */
/* ============================================================ */

/**
 * Right-hand rail shown only at `lg` and up. The wizard column stays
 * narrow on purpose (focused forms read better); this fills the rest
 * of a desktop viewport with a live recap of the plan plus the
 * reassurance copy that on mobile lives inline. Hidden below `lg`,
 * so phones see exactly the layout they did before.
 */
function SetupRail({
  step,
  draft,
  demoMode,
}: {
  step: number;
  draft: Draft;
  demoMode: boolean;
}) {
  const namedHeirs = draft.heirs
    .map((h) => h.name.trim())
    .filter((n) => n.length > 0);

  return (
    <aside className="hidden lg:block" aria-label="Plan summary">
      <div className="sticky top-24 space-y-4">
        <div className="card-quiet p-5">
          <p className="eyebrow-dim">Your plan so far</p>
          <dl className="mt-4 space-y-3 text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-muted">Who inherits</dt>
              <dd className="text-right font-medium">
                {namedHeirs.length > 0
                  ? namedHeirs.join(", ")
                  : draft.heirs.length > 1
                    ? `${draft.heirs.length} heirs`
                    : "Not named yet"}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-muted">They can claim after</dt>
              <dd className="text-right font-medium">
                {demoMode
                  ? demoWaitingById(draft.demoWaitingId).label
                  : monthsLabel(draft.waitingMonths)}{" "}
                of silence
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-muted">You check in</dt>
              <dd className="text-right font-medium">
                {cadenceByIdAnywhere(draft.cadenceId).label.toLowerCase()}
              </dd>
            </div>
            {!demoMode ? (
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-muted">Grace period</dt>
                <dd className="text-right font-medium">
                  {graceByIdAnywhere(draft.graceId).label}
                </dd>
              </div>
            ) : null}
          </dl>
        </div>

        {step === 0 ? (
          <div className="card-quiet p-5 text-sm text-muted">
            <p className="font-medium text-[var(--text)]">
              Nothing happens today
            </p>
            <p className="mt-2">
              Your heir gets no message when you finish this. We only
              reach out the way you choose to reach them here if you ever stop
              checking in. Then they claim from a link, with no wallet
              or technical steps needed.
            </p>
          </div>
        ) : null}

        {step === 1 ? (
          <div className="card-quiet p-5 text-sm text-muted">
            <p className="font-medium text-[var(--text)]">
              Your password is the key
            </p>
            <p className="mt-2">
              It locks your vault on this device before anything is
              sent to us. We never see it and can't reset it. Write
              it down somewhere safe, like you would a house key.
            </p>
            <p className="mt-2">
              Your email is only for check-in reminders. We never email
              your heir from it.
            </p>
          </div>
        ) : null}

        {step === 2 ? (
          <div className="card-quiet p-5 text-sm text-muted">
            <p className="font-medium text-[var(--text)]">What's next</p>
            <ul className="mt-2 space-y-2">
              <li>• Send a small test amount first, then the rest.</li>
              <li>
                • Download the recovery file from your dashboard. It
                works even if GhostKey disappears.
              </li>
              <li>
                • We'll remind you before every check-in. One tap keeps
                the vault quiet.
              </li>
            </ul>
          </div>
        ) : null}
      </div>
    </aside>
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

function monthsLabel(n: number): string {
  if (n === 12) return "1 year";
  return `${n} month${n === 1 ? "" : "s"}`;
}

function StepHeir({
  draft,
  patch,
  demoMode,
}: {
  draft: Draft;
  patch: (p: Partial<Draft>) => void;
  demoMode: boolean;
}) {
  const cadenceList = cadencePresetsFor(demoMode);
  const graceList = gracePresetsFor(demoMode);

  // Per-heir mutation helpers. Each heir is mutated by index; the
  // top-level Draft holds the heirs array.
  const updateHeir = (index: number, p: Partial<HeirDraft>) => {
    patch({
      heirs: draft.heirs.map((h, i) => (i === index ? { ...h, ...p } : h)),
    });
  };
  const removeHeir = (index: number) => {
    if (draft.heirs.length <= 1) return; // must always have at least one
    patch({ heirs: draft.heirs.filter((_, i) => i !== index) });
  };
  const addHeir = () => {
    if (draft.heirs.length >= MAX_HEIRS) return;
    patch({ heirs: [...draft.heirs, { ...EMPTY_HEIR }] });
  };

  const guardian = draft.vaultKind === "guardian";
  const updateGuardian = (index: number, p: Partial<GuardianDraft>) => {
    patch({
      guardians: draft.guardians.map((g, i) =>
        i === index ? { ...g, ...p } : g,
      ),
    });
  };
  // Switching to a guardian vault forces a single heir (the child) and
  // clears the Door B "heir holds their own key" option — a guardian
  // vault is always browser-keygen so the heir + guardian keys can be
  // sealed under their claim links.
  const setVaultKind = (kind: Draft["vaultKind"]) => {
    if (kind === "guardian") {
      const first = draft.heirs[0] ?? { ...EMPTY_HEIR };
      patch({
        vaultKind: "guardian",
        heirs: [{ ...first, ownKey: false, heirXpub: undefined }],
      });
    } else {
      patch({ vaultKind: "standard" });
    }
  };

  return (
    <div>
      <h1 className="font-serif text-3xl md:text-4xl">
        {guardian
          ? "Who are you protecting"
          : draft.heirs.length === 1
            ? "Who should receive this"
            : `Who should receive this (${draft.heirs.length} heirs)`}
      </h1>
      <p className="mt-2 text-muted">
        They never have to know about this until the time comes. When it does,
        we reach them the way you choose to reach them and they claim from a link.
        No wallet install, no setup on their end.
      </p>

      {/* Vault type (#81). The default is a single adult heir who can
          claim alone. The guardian option is for a child or anyone who
          needs help: the heir plus one of two guardians must claim
          together, so the child can't spend alone and the guardians
          can't take it without the child. */}
      <Field label="Who is your heir">
        <div className="grid gap-2 sm:grid-cols-2">
          <Tile
            title="An adult I trust"
            sub="They can claim on their own"
            selected={!guardian}
            onClick={() => setVaultKind("standard")}
          />
          <Tile
            title="A child or someone who needs help"
            sub="A guardian helps them claim"
            selected={guardian}
            onClick={() => setVaultKind("guardian")}
          />
        </div>
      </Field>

      <div className="mt-8 flex flex-col gap-5">
        {draft.heirs.map((heir, i) => (
          <HeirCard
            key={i}
            index={i}
            heir={heir}
            removable={!guardian && draft.heirs.length > 1}
            showHeading={!guardian && draft.heirs.length > 1}
            hideOwnKey={guardian}
            onChange={(p) => updateHeir(i, p)}
            onRemove={() => removeHeir(i)}
          />
        ))}

        {/* Guardian vaults (#81): two guardians, one of whom co-signs the
            claim with the child. We collect both here; their keys are
            generated and sealed in the browser at the end, like the
            heir's. */}
        {guardian && (
          <>
            <div className="rounded-lg border border-app bg-[var(--surface-1)] px-4 py-3 text-sm text-muted">
              <p className="font-medium text-[var(--text)]">
                Two guardians help {draft.heirs[0]?.name.trim() || "your heir"}{" "}
                claim
              </p>
              <p className="mt-1 text-xs">
                When the time comes, {draft.heirs[0]?.name.trim() || "your heir"}{" "}
                plus one of these two guardians claim together. One guardian is
                enough, so a guardian who is away or unreachable can't strand
                the inheritance, and no single guardian can take it on their
                own.
              </p>
            </div>
            {draft.guardians.map((g, i) => (
              <GuardianCard
                key={i}
                index={i}
                guardian={g}
                onChange={(p) => updateGuardian(i, p)}
              />
            ))}

            {/* Optional unlock year (#81 P5). On top of the inactivity
                wait, hold the funds until around a chosen year, e.g. when
                the child reaches an age. Hidden in demo mode, where the
                on-chain timelock is pinned to the minimum. */}
            {!demoMode && (
              <Field label="Hold until a certain year (optional)">
                <select
                  className="input"
                  value={draft.unlockYear ?? ""}
                  onChange={(e) =>
                    patch({
                      unlockYear: e.target.value ? Number(e.target.value) : null,
                    })
                  }
                  aria-label="Unlock year"
                >
                  <option value="">No extra hold</option>
                  {Array.from({ length: 25 }, (_, i) => minUnlockYear() + i).map(
                    (y) => (
                      <option key={y} value={y}>
                        {y}
                      </option>
                    ),
                  )}
                </select>
                <p className="mt-2 text-xs text-dim">
                  {draft.unlockYear
                    ? `${draft.heirs[0]?.name.trim() || "Your heir"} and a guardian can only claim from around ${draft.unlockYear}, even if your check-ins stop sooner. The date is approximate (Bitcoin counts blocks, not calendars). You can always recover the funds yourself earlier with your recovery file.`
                    : "Leave as is to let them claim once the waiting period passes. Pick a year to hold the funds until a child is older."}
                </p>
              </Field>
            )}

            {/* Honest independence note (design-review Move 1). A
                guardian vault works through GhostKey: the heir + guardian
                links are how the keys come out. If GhostKey is ever gone,
                the owner's own recovery file is the way through, not the
                heir or guardian links alone. */}
            <p className="text-xs text-dim">
              A guardian vault is claimed through GhostKey: the links we send
              the heir and guardians are how their keys are unlocked. If
              GhostKey ever disappears, your own recovery file (saved at the
              end of setup) is the way to recover the funds. Keep it safe.
            </p>
          </>
        )}

        {/* Cap + helper text. We deliberately keep the cap small (5)
            because each heir multiplies the on-chain funding tx
            outputs the owner has to send. Bigger groups need the
            server-side `vault_groups` table the JOURNAL flags as
            Phase 2; today everything is client-side. A guardian vault is
            always a single heir, so the add-heir control is hidden. */}
        {guardian ? null : draft.heirs.length < MAX_HEIRS ? (
          <button
            type="button"
            onClick={addHeir}
            className="btn btn-ghost self-start"
          >
            + Add another heir
          </button>
        ) : (
          <p className="text-xs text-muted">
            Maximum of {MAX_HEIRS} heirs per setup. Need more? File an issue
            and we'll lift the cap when there's a real reason to.
          </p>
        )}

        <Field label="If you stop checking in, wait this long before they can claim">
          {demoMode ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {DEMO_WAITING_PRESETS.map((w) => (
                <Tile
                  key={w.id}
                  title={w.label}
                  sub={w.sub}
                  selected={draft.demoWaitingId === w.id}
                  onClick={() => patch({ demoWaitingId: w.id })}
                />
              ))}
            </div>
          ) : (
            <select
              className="input"
              value={draft.waitingMonths}
              onChange={(e) => patch({ waitingMonths: Number(e.target.value) })}
              aria-label="Waiting period"
            >
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                <option key={m} value={m}>
                  {monthsLabel(m)}
                </option>
              ))}
            </select>
          )}
        </Field>

        <Field label="Remind me to check in">
          {demoMode && (
            <div
              role="note"
              className="mb-2 rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-xs text-amber-200"
            >
              Demo server: check-in timers run in seconds. Not for real funds.
            </div>
          )}
          {demoMode ? (
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
          ) : (
            <select
              className="input"
              value={draft.cadenceId}
              onChange={(e) => patch({ cadenceId: e.target.value })}
              aria-label="How often to remind me to check in"
            >
              {cadenceList.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                  {c.sub ? `, ${c.sub.toLowerCase()}` : ""}
                </option>
              ))}
            </select>
          )}
        </Field>

        {demoMode ? null : (
          <Field
            label="Grace period after a missed reminder"
            hint="Extra time before the countdown to inheritance begins. The heir still cannot claim for the full waiting period above."
          >
            <select
              className="input"
              value={draft.graceId}
              onChange={(e) => patch({ graceId: e.target.value })}
              aria-label="Grace period"
            >
              {graceList.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.label}
                  {g.sub ? `, ${g.sub.toLowerCase()}` : ""}
                </option>
              ))}
            </select>
          </Field>
        )}

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

/**
 * One heir's name + channel + contact, in a compact card. Rendered
 * once per entry in `draft.heirs`. The "Remove" button is hidden
 * when there's only one heir (the wizard always keeps at least one).
 */
function HeirCard({
  index,
  heir,
  removable,
  showHeading,
  hideOwnKey,
  onChange,
  onRemove,
}: {
  index: number;
  heir: HeirDraft;
  removable: boolean;
  showHeading: boolean;
  /** Guardian vaults are always browser-keygen, so the Door B
   *  "heir holds their own key" option is hidden for them (#81). */
  hideOwnKey?: boolean;
  onChange: (p: Partial<HeirDraft>) => void;
  onRemove: () => void;
}) {
  const channelMeta =
    CHANNELS.find((c) => c.id === heir.channel) ?? CHANNELS[0];

  return (
    <div className="card-flat p-4 md:p-5">
      {showHeading && (
        <div className="mb-3 flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-[var(--text)]">
            Heir #{index + 1}
          </span>
          {removable && (
            <button
              type="button"
              onClick={onRemove}
              className="text-xs text-muted hover:text-alarm"
              aria-label={`Remove heir #${index + 1}`}
            >
              Remove
            </button>
          )}
        </div>
      )}

      <Field label="Their name">
        <input
          type="text"
          value={heir.name}
          onChange={(e) => onChange({ name: e.target.value })}
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
              selected={heir.channel === c.id}
              onClick={() => onChange({ channel: c.id })}
            />
          ))}
        </div>
        {/* #119 privacy line: SMS is the least private heir channel (the
            nudge travels through phone carriers). Only surfaced when chosen,
            so it informs without nagging. */}
        {heir.channel === "sms" ? (
          <p className="mt-2 text-xs text-dim">
            SMS is the least private option. The reminder travels through phone
            carriers. WhatsApp or email keep it more private.
          </p>
        ) : null}
      </Field>

      <Field
        label={
          heir.channel === "email" ? "Their email" : "Their phone number"
        }
        hint="Stored encrypted. We don't message them unless you stop checking in."
      >
        <input
          type={heir.channel === "email" ? "email" : "tel"}
          value={heir.contact}
          onChange={(e) => onChange({ contact: e.target.value })}
          placeholder={channelMeta.placeholder}
          autoComplete="off"
          inputMode={heir.channel === "email" ? "email" : "tel"}
          className="input"
        />
      </Field>

      {/* L4 (#116): say plainly how the heir's key comes to exist on the
          default path, so the owner chooses knowingly. The key is made in
          this browser and sealed under the claim link; GhostKey holds the
          locked pieces and, with its master key, could reconstruct it (see
          the Door A note in this file's header). Disclose that honestly. */}
      <p className="text-xs text-dim">
        By default, GhostKey makes a key for your heir right here in your
        browser and locks it so only their one-time claim link can open it,
        and only after the waiting period. Nothing can move it while you're
        checking in.{" "}
        <span className="text-muted">
          Honest trade-off: so we can send your heir that link if you're
          gone, GhostKey stores the locked pieces, which means it could in
          principle rebuild their key. The waiting-period timelock still
          blocks any move while you check in, and every move shows on the
          public Bitcoin chain.
        </span>
        {hideOwnKey
          ? ""
          : " For full self-custody, where GhostKey holds nothing that can ever spend, have your heir hold their own key (advanced option below)."}
      </p>

      <details
        className={`mt-1 rounded-lg border border-app px-3 py-2${hideOwnKey ? " hidden" : ""}`}
      >
        <summary className="cursor-pointer text-xs text-muted">
          Advanced: your heir holds their own key
        </summary>
        <div className="mt-3 space-y-3">
          <label className="flex items-start gap-2 text-xs text-muted">
            <input
              type="checkbox"
              checked={Boolean(heir.ownKey)}
              onChange={(e) => onChange({ ownKey: e.target.checked })}
              className="mt-0.5"
            />
            <span>
              Use my heir's own wallet key instead. GhostKey never holds
              anything that can spend their Bitcoin, not even during a
              claim. The trade: your heir keeps their wallet's recovery
              words safe, and at claim time signs with a wallet that can
              handle the vault's timelock script (Bitcoin Core can).
            </span>
          </label>
          {heir.ownKey ? (
            <div>
              <textarea
                value={heir.heirXpub ?? ""}
                onChange={(e) => onChange({ heirXpub: e.target.value })}
                placeholder="[a1b2c3d4/86'/0'/0']xpub6..."
                autoComplete="off"
                spellCheck={false}
                rows={3}
                className="input font-mono text-xs"
              />
              <p className="mt-1 text-xs text-dim">
                {!heir.heirXpub?.trim()
                  ? "Paste your heir's account xpub. Most wallets export it under a 'key origin' or descriptor option."
                  : isValidHeirXpub(heir.heirXpub)
                    ? "Looks good. This vault will be non-custodial: GhostKey holds nothing that can spend it."
                    : "This needs to include the part in [brackets] at the front (the key origin). A plain xpub on its own can't be used."}
              </p>
            </div>
          ) : null}
        </div>
      </details>

      <Field label="A short note for them (optional)">
        <textarea
          value={heir.note ?? ""}
          onChange={(e) => onChange({ note: e.target.value })}
          placeholder="A few words they'll see when they claim. No need to explain how it works."
          rows={2}
          maxLength={500}
          className="input"
        />
      </Field>

      <p className="mt-2 text-xs text-muted">
        Tip: tell this person, with no details, that if they ever hear
        from GhostKey it is real and from you. A quiet word now makes
        the message easy to trust later.
      </p>
    </div>
  );
}

/** One guardian's contact block for a guardian vault (#81). Simpler
 *  than HeirCard: no note, no own-key option, no inheritance framing —
 *  a guardian only helps the heir claim. */
function GuardianCard({
  index,
  guardian,
  onChange,
}: {
  index: number;
  guardian: GuardianDraft;
  onChange: (p: Partial<GuardianDraft>) => void;
}) {
  const channelMeta =
    CHANNELS.find((c) => c.id === guardian.channel) ?? CHANNELS[0];

  return (
    <div className="card-flat p-4 md:p-5">
      <div className="mb-3">
        <span className="text-sm font-medium text-[var(--text)]">
          Guardian #{index + 1}
        </span>
      </div>

      <Field label="Their name">
        <input
          type="text"
          value={guardian.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="Aunt Grace"
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
              selected={guardian.channel === c.id}
              onClick={() => onChange({ channel: c.id })}
            />
          ))}
        </div>
        {guardian.channel === "sms" ? (
          <p className="mt-2 text-xs text-dim">
            SMS is the least private option. The message travels through phone
            carriers. WhatsApp or email keep it more private.
          </p>
        ) : null}
      </Field>

      <Field
        label={
          guardian.channel === "email"
            ? "Their email"
            : "Their phone number"
        }
        hint="Stored encrypted. We only reach them if you stop checking in."
      >
        <input
          type={guardian.channel === "email" ? "email" : "tel"}
          value={guardian.contact}
          onChange={(e) => onChange({ contact: e.target.value })}
          placeholder={channelMeta.placeholder}
          autoComplete="off"
          inputMode={guardian.channel === "email" ? "email" : "tel"}
          className="input"
        />
      </Field>

      <p className="mt-2 text-xs text-muted">
        Tip: tell this person, with no details, that if they ever hear from
        GhostKey it is real and from you. A quiet word now makes the message
        easy to trust later.
      </p>
    </div>
  );
}

/* ============================================================ */
/* Step 2: password                                               */
/* ============================================================ */

/** Four-segment meter. Fills left to right with the zxcvbn score;
 *  colour follows the verdict tone so "2 of 4 but red" reads as
 *  "not there yet", not "halfway to fine". */
function StrengthBar({
  score,
  tone,
}: {
  score: 0 | 1 | 2 | 3 | 4;
  tone: "bad" | "ok" | "good";
}) {
  const fill =
    tone === "good"
      ? "var(--accent-text)"
      : tone === "ok"
        ? "var(--text)"
        : "var(--alarm)";
  return (
    <div className="flex gap-1" aria-hidden="true">
      {[1, 2, 3, 4].map((seg) => (
        <span
          key={seg}
          className="inline-block h-1 w-6 rounded-full"
          style={{
            background: seg <= score ? fill : "var(--border)",
          }}
        />
      ))}
    </div>
  );
}

function StepPassword({
  draft,
  patch,
  busy,
  kdfProgress,
  strength,
}: {
  draft: Draft;
  patch: (p: Partial<Draft>) => void;
  busy: boolean;
  kdfProgress: number;
  /** Live zxcvbn verdict, owned by the wizard (it also gates Next).
   *  Null while the password is empty or the check is in flight. */
  strength: StrengthResult | null;
}) {
  // P2 (#120): a password that can never be reset deserves a reveal
  // toggle so the owner can check what they typed before committing.
  const [showPassword, setShowPassword] = useState(false);

  return (
    <div>
      <h1 className="font-serif text-3xl md:text-4xl">Pick your password</h1>
      <p className="mt-2 text-muted">
        This unlocks your vault on any device. Lose it and the timer runs
        out, and your heir inherits on the schedule you picked. There is no recovery
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
        {/* L5 (#116): the email is load-bearing — reminders ride on it.
            Set the expectation now that a confirmation link is coming, so
            an unconfirmed address doesn't silently swallow reminders and
            trigger inheritance by accident. The dashboard enforces it too. */}
        <p className="mt-1.5 text-xs text-muted">
          After you create the vault, we'll email you a link to confirm this
          address. Open it. Your check-in reminders ride on it. If it's
          never confirmed, a reminder could go missing and start the
          inheritance by accident.
        </p>

        <Field
          label="Your name (optional)"
          hint="Shown to your heir as 'this person set it up for you', so the message feels personal and not like a scam."
        >
          <input
            type="text"
            value={draft.ownerName}
            onChange={(e) => patch({ ownerName: e.target.value })}
            placeholder="Jane Adeyemi"
            autoComplete="name"
            maxLength={80}
            className="input"
            disabled={busy}
          />
        </Field>

        <Field
          label="Password"
          hint="Three or four unrelated words make a password that's easy to remember and hard to guess."
        >
          <div className="relative">
            <input
              type={showPassword ? "text" : "password"}
              value={draft.password}
              onChange={(e) => patch({ password: e.target.value })}
              autoComplete="new-password"
              className="input pr-16"
              disabled={busy}
            />
            <button
              type="button"
              onClick={() => setShowPassword((s) => !s)}
              className="absolute inset-y-0 right-3 my-auto h-6 text-xs text-muted underline-offset-2 hover:underline"
              aria-pressed={showPassword}
            >
              {showPassword ? "Hide" : "Show"}
            </button>
          </div>
          {draft.password && strength ? (
            <div className="mt-2" aria-live="polite">
              <div className="flex items-center gap-2">
                <StrengthBar score={strength.score} tone={strength.tone} />
                <p
                  className="text-xs"
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
              </div>
              {strength.advice ? (
                <p className="mt-1 text-xs text-muted">{strength.advice}</p>
              ) : null}
            </div>
          ) : null}
        </Field>

        <Field label="Confirm password">
          <input
            type={showPassword ? "text" : "password"}
            value={draft.passwordConfirm}
            onChange={(e) => patch({ passwordConfirm: e.target.value })}
            autoComplete="new-password"
            className="input"
            disabled={busy}
          />
        </Field>

        <div className="mt-5">
          <InlineAlert tone="warning">
            <p className="font-medium text-[var(--text)]">
              Save this password now, before you go on.
            </p>
            <p className="mt-1">
              It is the only key to your money. We never see it and we
              can never reset it. Let your browser or a password manager
              save it, or write it down and keep it somewhere safe like a
              house key. If you lose it, the only way the funds move is to
              your heir, on the schedule you set.
            </p>
            <label className="mt-3 flex items-start gap-2 text-sm text-[var(--text)]">
              <input
                type="checkbox"
                checked={draft.savedPassword}
                onChange={(e) => patch({ savedPassword: e.target.checked })}
                className="mt-0.5"
                disabled={busy}
              />
              <span>I have saved my password somewhere I can get it back.</span>
            </label>
          </InlineAlert>
        </div>

        {/* P3 (#120): lead with the outcome and tuck the Lightning
            mechanics behind a disclosure — it's optional and dense. */}
        <Disclosure
          summary={
            <span>Advanced: freeze this vault for 90 days from any device</span>
          }
        >
          <Field
            label="Trusted contact (optional)"
            hint="If your wallet is ever stolen, you can freeze this vault for 90 days from any device. Behind the scenes that's a tiny 'panic stop' payment from any wallet; this person is alerted that you triggered it. Leave blank to skip."
          >
            <input
              type="email"
              value={draft.trustedContact}
              onChange={(e) => patch({ trustedContact: e.target.value })}
              placeholder="someone-who-can-help@example.com"
              autoComplete="off"
              className="input"
              disabled={busy}
            />
          </Field>
        </Disclosure>

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
              a couple of seconds on most phones. It's what makes your
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
                Your browser generates two fresh Bitcoin keys: one for you,
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
                You'll get an address on the next screen. Fund it with
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
  created,
}: {
  created: {
    groupId: string;
    vaults: Array<{
      vaultId: string;
      heirName: string;
      address: string | null;
      envelope?: HeirEnvelope;
    }>;
  };
}) {
  const isGroup = created.vaults.length > 1;
  const anyEnvelope = created.vaults.some((v) => v.envelope);
  return (
    <div>
      <h1 className="font-serif text-3xl md:text-4xl">
        {isGroup ? "Fund your vaults" : "Fund your vault"}
      </h1>
      <p className="mt-2 text-muted">
        {isGroup ? (
          <>
            Each heir gets their own vault address. Send each one the
            share you want them to inherit. Your wallet probably lets
            you batch all {created.vaults.length} sends into a single
            transaction (one fee, one signature). Sparrow and Bitcoin
            Core both do, most others do too.
          </>
        ) : (
          <>
            Send Bitcoin to the address below. It lands in a script only
            you can spend right now, and only your heir can spend after
            the waiting period if you stop checking in.
          </>
        )}
      </p>

      <div className="mt-8 flex flex-col gap-4">
        {created.vaults.map((v) => (
          <div key={v.vaultId} className="flex flex-col gap-2">
            <FundAddressCard
              heirName={v.heirName}
              address={v.address}
              vaultId={v.vaultId}
              showHeading={isGroup}
            />
            <FundingBalanceLine vaultId={v.vaultId} />
          </div>
        ))}
      </div>

      <p className="mt-3 px-1 text-xs text-dim">
        Tip: send at least a few thousand sats so there's plenty left for
        {isGroup ? " your heirs" : " your heir"} after the small network fee at
        claim time. You can add more any time by sending again to the same
        address.
      </p>

      <div className="mt-6">
        <InlineAlert tone="neutral">
          {isGroup ? (
            <>
              Bookmark this page or write down any of your vault ids.
              The dashboard is also reachable from any browser by signing
              in with your email and password. All {created.vaults.length}
              {" "}vaults appear together once you sign in.
            </>
          ) : (
            <>
              Bookmark this page or note your vault id (
              <code className="font-mono text-xs">
                {shortId(created.vaults[0]?.vaultId ?? "")}
              </code>
              ). The dashboard is also reachable from any browser by
              signing in with your email and password.
            </>
          )}
        </InlineAlert>
      </div>

      {anyEnvelope && (
        <div className="mt-10">
          <h2 className="font-serif text-2xl">
            Extra safety for {isGroup ? "your heirs" : "your heir"} (optional)
          </h2>
          <p className="mt-2 text-muted">
            {isGroup ? "Each file below" : "This file"} lets{" "}
            {isGroup ? "each heir" : "your heir"} reach the Bitcoin even if
            GhostKey no longer exists. It's locked, and useless until the
            waiting period passes, so it's safe to keep for them. Save it
            somewhere they'll find it if you're gone, together with its
            secret code. Without GhostKey, this is the only way they get in
            on their own, so if it matters to you, do it now.
          </p>
          <div className="mt-6 flex flex-col gap-4">
            {created.vaults.map((v) =>
              v.envelope ? (
                <HeirEnvelopeCard
                  key={v.vaultId}
                  heirName={v.heirName}
                  envelope={v.envelope}
                  showHeading={isGroup}
                />
              ) : null,
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * One heir-envelope download card on the funding screen. Shows the
 * one-off passphrase once (we never persist it) and lets the owner
 * download the sealed file. Copy is deliberately blunt: the file and
 * the code only help together, and only if the owner is gone.
 */
function HeirEnvelopeCard({
  heirName,
  envelope,
  showHeading,
}: {
  heirName: string;
  envelope: HeirEnvelope;
  showHeading: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [downloaded, setDownloaded] = useState(false);

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(envelope.passphrase);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard may be blocked; the owner can select the text instead.
    }
  }

  return (
    <div className="card-flat p-5">
      {showHeading && (
        <p className="font-serif text-lg">For {heirName || "your heir"}</p>
      )}
      <p className="text-xs uppercase tracking-wider text-dim">
        Secret code, write it down with the file
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <code className="select-all rounded bg-[var(--bg-elev)] px-3 py-2 font-mono text-sm">
          {envelope.passphrase}
        </code>
        <Button variant="ghost" onClick={() => void copyCode()}>
          {copied ? "Copied" : "Copy code"}
        </Button>
      </div>
      <p className="mt-3 text-sm text-muted">
        The file is locked with this code. We won't show the code again,
        and we never store it. Keep them together.
      </p>
      <div className="mt-4">
        <Button
          onClick={() => {
            downloadHeirEnvelope(envelope);
            setDownloaded(true);
          }}
        >
          {downloaded ? "Download again" : "Download the file"}
        </Button>
      </div>
    </div>
  );
}

/**
 * One address card. Used both by the single-heir and multi-heir
 * funding step; `showHeading` controls the per-heir label.
 */
function FundAddressCard({
  heirName,
  address,
  vaultId,
  showHeading,
}: {
  heirName: string;
  address: string | null;
  vaultId: string;
  showHeading: boolean;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Some browsers block clipboard access; the address is still
      // visible for manual selection.
    }
  }

  return (
    <div>
      {showHeading && (
        <div className="mb-2 flex items-center justify-between gap-3">
          <span className="text-sm font-medium text-[var(--text)]">
            For {heirName || "this heir"}
          </span>
          <code className="font-mono text-[10px] text-dim">
            vault {shortId(vaultId)}
          </code>
        </div>
      )}
      {address ? (
        showHeading ? (
          // In group mode the heading + vault id already names the
          // card; render the address row directly without the Field
          // wrapper (which insists on a label).
          <div className="card flex items-center gap-3 px-4 py-3">
            <code className="flex-1 break-all font-mono text-sm">
              {address}
            </code>
            <Button variant="quiet" onClick={copy}>
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        ) : (
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
        )
      ) : (
        <InlineAlert tone="warning">
          We couldn't fetch this address automatically. Open the
          dashboard to see it.
        </InlineAlert>
      )}
    </div>
  );
}

function shortId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

/**
 * Inline balance under the deposit address. Auto-fetches on mount so
 * the owner sees "0 sat" immediately, and provides a manual refresh
 * after they send funds so they can confirm the deposit landed.
 */
function FundingBalanceLine({ vaultId }: { vaultId: string }) {
  const [balance, setBalance] = useState<VaultBalanceView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const usdPerBtc = usePrice();

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const b = await api.getVaultBalance(vaultId);
      setBalance(b);
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : String(e),
      );
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultId]);

  return (
    <div className="flex items-center justify-between px-1 text-xs">
      <span className="text-muted">
        Balance:{" "}
        <span className="font-mono text-[var(--text)]">
          {balance ? `${balance.total_sat.toLocaleString()} sat` : loading ? "…" : "—"}
        </span>
        {balance && balance.total_sat > 0 ? (
          <span className="ml-1 text-dim">{btcAndUsd(balance.total_sat, usdPerBtc)}</span>
        ) : null}
        {balance && balance.unconfirmed_sat > 0 ? (
          <span className="ml-1 text-dim">
            ({balance.unconfirmed_sat.toLocaleString()} pending)
          </span>
        ) : null}
      </span>
      <button
        type="button"
        className="text-dim underline-offset-2 hover:underline disabled:opacity-50"
        onClick={() => void load()}
        disabled={loading}
      >
        {loading ? "Checking…" : "Refresh"}
      </button>
      {error ? (
        <span className="ml-2 text-alarm">{error}</span>
      ) : null}
    </div>
  );
}
