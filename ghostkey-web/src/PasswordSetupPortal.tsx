/**
 * Password-vault setup: one question per screen, savings first,
 * inheritance optional.
 *
 *   goal → email → password → type it again → "save it now"
 *   → "should someone get your savings?"
 *        Not now: the vault is made with a spare heir key sealed under the
 *        owner's password and no check-in clock (choose someone from Home).
 *        Choose someone: their name → their email → how long to wait →
 *        a word for them → the vault is made.
 *   → their heir code (if an heir was chosen) → Add money.
 *
 * The wait is written into the vault's address, so a saver who skips the
 * heir gets the default wait; it shows, fixed, when they choose one later.
 * One heir here; more are added from Family. The trusted emergency
 * contact is no longer asked at setup.
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
import { GOAL_PRESETS } from "./savings";
import { ReceiveCard } from "./ReceiveCard";
import {
  Button,
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
  type VaultBalanceView,
} from "./api";
import { saveVaultMeta } from "./vaultStore";
import type { HeirContactChannel } from "./heirChannels";
import {
  useChannelCapability,
  CHANNEL_UNAVAILABLE_NOTE,
} from "./useChannelCapability";
import {
  buildHeirEnvelope,
  type HeirEnvelope,
} from "./independenceProof";
import {
  checkPassword,
  preloadStrengthChecker,
  type StrengthResult,
} from "./passwordStrength";
import { confirmError, emailError, newPasswordError, passwordStepError } from "./setupGates";
import {
  generateParty,
  wipe,
  type Network,
} from "./crypto/keygen";
import {
  sealVaultSecrets,
  sealVaultSecretsHeirLater,
  sealWithKey,
  hashEmailForLookup,
} from "./crypto/sealing";
import { lockHeirKey, type HeirKeyLock } from "./crypto/heirCode";
import { HeirCodeCard } from "./HeirCodeCard";
import { formatAmount, useFiatLine, useUnit } from "./units";
import {
  DEFAULT_CADENCE_ID,
  DEFAULT_GRACE_ID,
  DEFAULT_DEMO_WAITING_ID,
  DEMO_WAITING_PRESETS,
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

type ContactChannel = HeirContactChannel;

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
  /** "What are you saving for?" (#367). Optional. Saved as each new
   *  share's savings goal title once the vaults exist. */
  savingsGoal: string;
  // Step 1 — heirs + timing
  heirs: HeirDraft[];
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
   *  triggers the panic stop. Same channel vocabulary as heirs;
   *  the dashboard surfaces this field as "Trusted contact (panic-stop)". */
  trustedContact: string;
  trustedContactChannel: ContactChannel;
}

const EMPTY_HEIR: HeirDraft = {
  name: "",
  contact: "",
  channel: "email",
};

const EMPTY: Draft = {
  savingsGoal: "",
  heirs: [{ ...EMPTY_HEIR }],
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

/** One question per screen. The first group runs before the vault
 *  exists; the last two after. */
type Screen =
  | "goal"
  | "email"
  | "password"
  | "confirm"
  | "saved"
  | "heir-ask"
  | "heir-name"
  | "heir-email"
  | "wait"
  | "heir-note"
  | "heir-code"
  | "fund";

const PRE_CREATE: Screen[] = [
  "goal",
  "email",
  "password",
  "confirm",
  "saved",
  "heir-ask",
  "heir-name",
  "heir-email",
  "wait",
  "heir-note",
];

const PRIMARY_LABEL: Record<Screen, (d: { savingsGoal: string }) => string> = {
  goal: (d) => (d.savingsGoal.trim() ? "Next" : "Skip"),
  email: () => "Next",
  password: () => "Next",
  confirm: () => "Next",
  saved: () => "I've saved it",
  "heir-ask": () => "Choose someone",
  "heir-name": () => "Next",
  "heir-email": () => "Next",
  wait: () => "Next",
  "heir-note": () => "Create my vault",
  "heir-code": () => "Next",
  fund: () => "Go to Home",
};


/** The waiting periods setup offers. It is written into the vault's
 *  address, so it can only change later by moving the money. */
const WAIT_CHOICES = [3, 6, 9, 12] as const;

/** Save the setup's "What are you saving for?" as a new share's goal.
 *  Best effort: setup must never fail because of it, and the owner can
 *  always add or change the goal from the dashboard. */
async function saveInitialGoal(
  vaultId: string,
  ownerToken: string,
  title: string | undefined,
): Promise<void> {
  const t = (title ?? "").trim();
  if (!t) return;
  try {
    await api.setSavingsGoal(vaultId, ownerToken, {
      title: t,
      amount_sat: null,
      target_date: null,
    });
  } catch {
    /* not fatal: the dashboard offers it again */
  }
}

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

/** How long without signing in before the heir is contacted: the same
 *  choice as the on-chain wait, so the two can't disagree. Demo mode
 *  keeps its short test cadence. */
function checkinSecsFor(draft: { cadenceId: string; waitingMonths: number }, demoMode: boolean): number {
  return demoMode ? cadenceByIdAnywhere(draft.cadenceId).seconds : draft.waitingMonths * 30 * 86_400;
}

/* ============================================================ */

export function PasswordSetupPortal({ onCancel, onCreated, onSignIn }: Props) {
  const [screen, setScreen] = useState<Screen>("goal");
  const [showPassword, setShowPassword] = useState(false);
  const cap = useChannelCapability();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  // True when create failed because this email already has a vault —
  // we steer the user to sign in and use Add Heir instead.
  const [emailTaken, setEmailTaken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [kdfProgress, setKdfProgress] = useState<number>(0);
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
          /** The heir code, shown on the heir card. Absent for Door B. */
          heirCode?: string;
        }>;
        /** Made without an heir: the owner chooses one later. */
        heirLater?: boolean;
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
    if (screen === "email" || screen === "password") preloadStrengthChecker();
  }, [screen]);

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
    // Step 0 (the plan) has nothing required: the goal is optional and
    // the wait always has a value.
    if (s === 2) {
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

  // Each screen is a browser history entry, so the phone's back button
  // steps back. Once the vault exists there's no going back before it.
  useEffect(() => {
    window.history.replaceState({ gkSetup: "goal" }, "", window.location.href);
  }, []);
  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const s = (e.state as { gkSetup?: Screen } | null)?.gkSetup ?? "goal";
      if (created && PRE_CREATE.includes(s)) {
        window.history.pushState({ gkSetup: screen }, "", window.location.href);
        return;
      }
      setError(null);
      setScreen(s);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [created, screen]);

  function go(next: Screen) {
    setError(null);
    window.history.pushState({ gkSetup: next }, "", window.location.href);
    setScreen(next);
    window.scrollTo(0, 0);
  }

  function onPrimary() {
    if (busy) return;
    switch (screen) {
      case "goal":
        return go("email");
      case "email":
        return go("password");
      case "password":
        return go("confirm");
      case "confirm":
        return go("saved");
      case "saved":
        patch({ savedPassword: true });
        return go("heir-ask");
      case "heir-ask":
        return go("heir-name");
      case "heir-name":
        return go("heir-email");
      case "heir-email":
        return go("wait");
      case "wait":
        return go("heir-note");
      case "heir-note":
        return void activate(false);
      case "heir-code":
        return go("fund");
      case "fund":
        return onCancel();
    }
  }

  async function activate(heirLater = false) {
    // Final guard: the UI validates each step when moving forward, but
    // the user might mutate state via devtools. The heir step only
    // counts when an heir is being chosen now.
    const err = validate(1) ?? (heirLater ? null : validate(2));
    if (err) {
      setError(err);
      return;
    }

    // Door B safety: if a heir is set to hold their own key, the xpub
    // must be valid. Otherwise `doorB` would be false and we'd silently
    // generate a key instead — the opposite of what the owner asked for.
    const badHeir = heirLater
      ? undefined
      : draft.heirs.find((h) => h.ownKey && !isValidHeirXpub(h.heirXpub));
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
    let ownerKek: Uint8Array | null = null;

    try {
      // ---- Heir chosen later ----------------------------------------
      // Savings first: one vault, owner key as usual, and a spare heir
      // key sealed under the owner's password. No claim token and no
      // heir contact leave this browser, so nothing the server holds can
      // reach the heir branch, and the check-in clock stays off until
      // the owner chooses someone from Home (POST /heir/choose).
      if (heirLater) {
        ownerParty = generateParty(network);
        const heirParty = generateParty(network);
        heirParties.push(heirParty);
        const checkinSecs = checkinSecsFor(draft, demoMode);
        const timelockBlocks = demoMode ? 1 : monthsToBlocks(draft.waitingMonths);
        const graceSecs = demoMode
          ? demoWaitingById(draft.demoWaitingId).seconds
          : graceByIdAnywhere(draft.graceId).seconds;
        const groupId = crypto.randomUUID();
        const tokenPlaceholder = "ghostkey-placeholder-owner-token-v1";

        setKdfProgress(0);
        const sealed = await sealVaultSecretsHeirLater({
          password: draft.password,
          ownerXprv: ownerParty.xprv,
          heirXprv: heirParty.xprv,
          ownerToken: tokenPlaceholder,
          onProgress: (p) => setKdfProgress(Math.round(p * 100)),
        });
        ownerKek = sealed._owner_kek;

        const label = "Savings";
        const resp = await api.createVaultFromXpub({
          label,
          network,
          owner: { xpub: ownerParty.xpub, fingerprint: ownerParty.fingerprint },
          heir: { xpub: heirParty.xpub, fingerprint: heirParty.fingerprint },
          timelock_blocks: timelockBlocks,
          checkin_period_secs: checkinSecs,
          grace_period_secs: graceSecs,
          owner_contact: draft.ownerEmail.trim(),
          owner_contact_channel: "email",
          heir_contact: null,
          heir_contact_channel: null,
          sealed: {
            password_salt_b64: sealed.password_salt,
            password_kdf_mem_kib: sealed.password_kdf_mem_kib,
            password_kdf_iters: sealed.password_kdf_iters,
            owner_xprv_ct_b64: sealed.owner_xprv.ct,
            owner_xprv_nonce_b64: sealed.owner_xprv.nonce,
            owner_token_ct_b64: sealed.owner_token.ct,
            owner_token_nonce_b64: sealed.owner_token.nonce,
            owner_email_hash: hashEmailForLookup(draft.ownerEmail),
            heir_xprv_owner_ct_b64: sealed.heir_xprv_owner.ct,
            heir_xprv_owner_nonce_b64: sealed.heir_xprv_owner.nonce,
          },
          heir_derivation: null,
          trusted_contact: null,
          trusted_contact_channel: null,
          from_name: draft.ownerName.trim() || null,
          heir_note: null,
        });

        // Re-seal the real owner token, as the other paths do.
        let realOwnerTokenBlob: { v: 1; ct: string; nonce: string } | undefined;
        try {
          const realSealed = sealWithKey(ownerKek, new TextEncoder().encode(resp.owner_token));
          await api.sealOwnerToken(resp.id, resp.owner_token, {
            owner_token_ct_b64: realSealed.ct,
            owner_token_nonce_b64: realSealed.nonce,
          });
          realOwnerTokenBlob = realSealed;
        } catch (e) {
          console.warn("owner-token re-seal failed for vault", resp.id, e);
        }

        saveVaultMeta({
          id: resp.id,
          label,
          owner: { address: draft.ownerEmail.trim() },
          heir: { name: "", email: "", address: "" },
          createdAt: new Date().toISOString(),
          ownerToken: resp.owner_token,
          ownerTokenLock: realOwnerTokenBlob
            ? {
                passwordSalt: sealed.password_salt,
                memKiB: sealed.password_kdf_mem_kib,
                iters: sealed.password_kdf_iters,
                ownerTokenBlob: realOwnerTokenBlob,
                ownerEmailHash: hashEmailForLookup(draft.ownerEmail),
                validated: true,
              }
            : undefined,
          groupId,
        });

        let address: string | null = null;
        try {
          address = (await api.getVaultAddress(resp.id)).address;
        } catch (e) {
          console.warn("address fetch failed for vault", resp.id, e);
        }
        await saveInitialGoal(resp.id, resp.owner_token, draft.savingsGoal);
        onCreated({
          id: resp.id,
          label: resp.label,
          status: resp.status,
          next_deadline_at: resp.next_deadline_at,
        });
        setCreated({
          groupId,
          vaults: [{ vaultId: resp.id, heirName: "", address }],
          heirLater: true,
        });
        go("fund");
        return;
      }

      // (a) Mint owner keys ONCE. Every heir's vault uses the same
      // owner xpub; the same keypath spend works across all of them.
      ownerParty = generateParty(network);

      // (b) Mint one heir key per heir. Each is locked with its own heir
      // code below, so one heir's code opens nothing of another's.
      for (let i = 0; i < draft.heirs.length; i++) {
        heirParties.push(generateParty(network));
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
      const checkinSecs = checkinSecsFor(draft, demoMode);
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
        heirCode?: string;
      }> = [];

      // (f) Per-heir loop: seal, POST, persist.
      for (let i = 0; i < draft.heirs.length; i++) {
        const heir = draft.heirs[i];
        const heirParty = heirParties[i];

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

        // Door A: lock the heir's key with a fresh heir code (option a).
        // The server gets the locked key and nothing that opens it; the
        // code goes on the heir card, for the owner to hand over.
        let heirLock: HeirKeyLock | undefined;
        if (!doorB) {
          setKdfProgress(0);
          heirLock = await lockHeirKey(heirParty.xprv, sealed._owner_kek!, (p) =>
            setKdfProgress(Math.round(p * 100)),
          );
        }

        const sealedBody: SealedSetup = {
          password_salt_b64: sealed.password_salt,
          password_kdf_mem_kib: sealed.password_kdf_mem_kib,
          password_kdf_iters: sealed.password_kdf_iters,
          owner_xprv_ct_b64: sealed.owner_xprv.ct,
          owner_xprv_nonce_b64: sealed.owner_xprv.nonce,
          owner_token_ct_b64: sealed.owner_token.ct,
          owner_token_nonce_b64: sealed.owner_token.nonce,
          owner_email_hash: ownerEmailHash,
          // Door A: the heir's key locked with the heir code, and how.
          // Omitted for Door B. Either way no claim token is sent: the
          // scheduler mints the heir's link when it's needed.
          ...(heirLock
            ? {
                heir_xprv_ct_b64: heirLock.heir_xprv_ct_b64,
                heir_xprv_nonce_b64: heirLock.heir_xprv_nonce_b64,
                heir_code: heirLock.heir_code,
              }
            : {}),
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
        let realOwnerTokenBlob: { v: 1; ct: string; nonce: string } | undefined;
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
            realOwnerTokenBlob = realSealed;
          } catch (e) {
            console.warn(
              "owner-token re-seal failed for vault",
              resp.id,
              "; cross-device sign-in will need a fresh check-in first",
              e,
            );
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
          ownerTokenLock: realOwnerTokenBlob
            ? {
                passwordSalt: sealed.password_salt,
                memKiB: sealed.password_kdf_mem_kib,
                iters: sealed.password_kdf_iters,
                ownerTokenBlob: realOwnerTokenBlob,
                ownerEmailHash: hashEmailForLookup(draft.ownerEmail),
                validated: true,
              }
            : undefined,
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
                lock: heirLock ? { code: heirLock.code, sealed: heirLock.sealed } : undefined,
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
          heirCode: heirLock?.code,
        });

        await saveInitialGoal(resp.id, resp.owner_token, draft.savingsGoal);
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
      go(createdEntries.some((v) => v.heirCode || v.envelope) ? "heir-code" : "fund");
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
      if (ownerKek) wipe(ownerKek);
      setBusy(false);
    }
  }

  // The full gate, still checked before anything is created, so a screen
  // skipped some other way can't slip through.
  const gateReason = passwordStepError({
    ownerEmail: draft.ownerEmail,
    password: draft.password,
    passwordConfirm: draft.passwordConfirm,
    savedPassword: draft.savedPassword,
    strength,
  });

  const heir = draft.heirs[0];
  const heirName = heir.name.trim() || "them";
  const updateHeir = (p: Partial<HeirDraft>) =>
    patch({ heirs: draft.heirs.map((h, i) => (i === 0 ? { ...h, ...p } : h)) });

  // What stops each screen moving on, if anything.
  const screenError: string | null = (() => {
    switch (screen) {
      case "email":
        return emailError(draft.ownerEmail);
      case "password":
        return newPasswordError(draft.password, strength);
      case "confirm":
        return confirmError(draft.password, draft.passwordConfirm);
      case "heir-name":
        return heir.name.trim() ? null : "Add their name.";
      case "heir-email":
        if (heir.ownKey && !isValidHeirXpub(heir.heirXpub)) {
          return "Paste their wallet key with the part in [brackets] at the front.";
        }
        if (!heir.contact.trim()) return "Add a way to reach them.";
        if (heir.channel === "email" && !/^.+@.+\..+$/.test(heir.contact.trim())) {
          return "That email looks off. Double-check it.";
        }
        if (heir.contact.trim().toLowerCase() === draft.ownerEmail.trim().toLowerCase()) {
          return "That's your own email. Add theirs.";
        }
        return null;
      default:
        return null;
    }
  })();
  // Only say why once they've typed something: an empty screen doesn't shout.
  const touched: Record<string, string> = {
    email: draft.ownerEmail,
    password: draft.password,
    confirm: draft.passwordConfirm,
    "heir-name": heir.name,
    "heir-email": heir.contact,
  };
  const showScreenError = Boolean(screenError && touched[screen]);

  const preCreate = PRE_CREATE.indexOf(screen);
  const progress = preCreate >= 0 ? ((preCreate + 1) / PRE_CREATE.length) * 100 : 100;
  const firstVault = created?.vaults[0];
  const busyLabel = `Making your vault… ${kdfProgress > 0 ? `${kdfProgress}%` : ""}`;

  return (
    <main className="bg-app fade-in">
      <div className="mx-auto max-w-xl px-5 pt-8 pb-28 md:pt-14">
        {preCreate >= 0 ? <ProgressBar value={progress} label="Setup progress" /> : null}

        <div className="mt-6 h-6">
          {screen === "goal" ? (
            <button type="button" onClick={onCancel} className="text-sm text-muted underline hover:text-[var(--text)]">
              Cancel
            </button>
          ) : preCreate >= 0 && !busy ? (
            <button
              type="button"
              onClick={() => window.history.back()}
              className="text-sm text-muted underline hover:text-[var(--text)]"
            >
              ← Back
            </button>
          ) : null}
        </div>

        <form
          className="mt-6"
          onSubmit={(e) => {
            e.preventDefault();
            onPrimary();
          }}
        >
          {screen === "goal" ? (
            <>
              <h1 className="font-serif text-3xl md:text-4xl">What are you saving for?</h1>
              <div className="mt-6 flex flex-wrap gap-2" role="group" aria-label="Savings goal ideas">
                {GOAL_PRESETS.map((g) => (
                  <button
                    key={g}
                    type="button"
                    aria-pressed={draft.savingsGoal.trim() === g}
                    onClick={() => patch({ savingsGoal: draft.savingsGoal.trim() === g ? "" : g })}
                    className={`rounded-full border px-4 py-2 text-sm transition-colors ${
                      draft.savingsGoal.trim() === g
                        ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_18%,transparent)] font-medium text-[var(--text)]"
                        : "border-app text-[var(--text)] hover:bg-[var(--surface-2)]"
                    }`}
                  >
                    {g}
                  </button>
                ))}
              </div>
              <input
                className="input mt-4 w-full"
                aria-label="Or type your own goal"
                maxLength={60}
                placeholder="Or type your own"
                value={(GOAL_PRESETS as readonly string[]).includes(draft.savingsGoal.trim()) ? "" : draft.savingsGoal}
                onChange={(e) => patch({ savingsGoal: e.target.value })}
              />
            </>
          ) : null}

          {screen === "email" ? (
            <>
              <h1 className="font-serif text-3xl md:text-4xl">Your email</h1>
              <p className="mt-2 text-sm text-muted">To sign in on another device.</p>
              <input
                type="email"
                aria-label="Your email"
                value={draft.ownerEmail}
                onChange={(e) => patch({ ownerEmail: e.target.value })}
                placeholder="you@example.com"
                autoComplete="email"
                inputMode="email"
                className="input mt-6 w-full"
              />
            </>
          ) : null}

          {screen === "password" ? (
            <>
              <h1 className="font-serif text-3xl md:text-4xl">Create a password</h1>
              <p className="mt-2 text-sm text-muted">Three or four unrelated words work well.</p>
              <div className="relative mt-6">
                <input
                  type={showPassword ? "text" : "password"}
                  aria-label="Password"
                  value={draft.password}
                  onChange={(e) => patch({ password: e.target.value })}
                  autoComplete="new-password"
                  className="input w-full pr-16"
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
                <div className="mt-3 flex items-center gap-2" aria-live="polite">
                  <StrengthBar score={strength.score} tone={strength.tone} />
                  <span className="text-xs text-muted">{strength.label}</span>
                </div>
              ) : null}
            </>
          ) : null}

          {screen === "confirm" ? (
            <>
              <h1 className="font-serif text-3xl md:text-4xl">Type it again</h1>
              <input
                type={showPassword ? "text" : "password"}
                aria-label="Password again"
                value={draft.passwordConfirm}
                onChange={(e) => patch({ passwordConfirm: e.target.value })}
                autoComplete="new-password"
                className="input mt-6 w-full"
              />
            </>
          ) : null}

          {screen === "saved" ? (
            <>
              <h1 className="font-serif text-3xl md:text-4xl">Save your password now</h1>
              <p className="mt-3 text-muted">
                It&apos;s the only way into your savings. We can&apos;t reset it.
              </p>
            </>
          ) : null}

          {screen === "heir-ask" ? (
            <>
              <h1 className="font-serif text-3xl md:text-4xl">
                Should someone get your savings if you stop signing in?
              </h1>
              <p className="mt-3 text-muted">You can choose later.</p>
            </>
          ) : null}

          {screen === "heir-name" ? (
            <>
              <h1 className="font-serif text-3xl md:text-4xl">Who should get it?</h1>
              <input
                type="text"
                aria-label="Their name"
                value={heir.name}
                onChange={(e) => updateHeir({ name: e.target.value })}
                placeholder="Their name"
                autoComplete="off"
                className="input mt-6 w-full"
              />
            </>
          ) : null}

          {screen === "heir-email" ? (
            <>
              <h1 className="font-serif text-3xl md:text-4xl">
                {heir.channel === "email" ? `${heirName}'s email` : `${heirName}'s phone number`}
              </h1>
              <p className="mt-2 text-sm text-muted">We only contact them if you stop signing in.</p>
              {cap.sms || cap.whatsapp ? (
                <div className="mt-6 grid grid-cols-3 gap-2">
                  {CHANNELS.map((c) => (
                    <Tile
                      key={c.id}
                      title={c.title}
                      sub={cap[c.id] ? c.sub : CHANNEL_UNAVAILABLE_NOTE}
                      selected={heir.channel === c.id}
                      onClick={() => updateHeir({ channel: c.id })}
                      disabled={!cap[c.id]}
                    />
                  ))}
                </div>
              ) : null}
              <input
                type={heir.channel === "email" ? "email" : "tel"}
                aria-label={heir.channel === "email" ? "Their email" : "Their phone number"}
                value={heir.contact}
                onChange={(e) => updateHeir({ contact: e.target.value })}
                placeholder={(CHANNELS.find((c) => c.id === heir.channel) ?? CHANNELS[0]).placeholder}
                autoComplete="off"
                inputMode={heir.channel === "email" ? "email" : "tel"}
                className="input mt-6 w-full"
              />
              <Disclosure summary={<span>{heirName === "them" ? "They" : heirName} already has a Bitcoin wallet</span>}>
                <label className="flex items-start gap-2 text-sm text-muted">
                  <input
                    type="checkbox"
                    checked={Boolean(heir.ownKey)}
                    onChange={(e) => updateHeir({ ownKey: e.target.checked })}
                    className="mt-1"
                  />
                  <span>Use their own wallet key, so GhostKey never holds anything that can spend.</span>
                </label>
                {heir.ownKey ? (
                  <textarea
                    aria-label="Their wallet key"
                    value={heir.heirXpub ?? ""}
                    onChange={(e) => updateHeir({ heirXpub: e.target.value })}
                    placeholder="[a1b2c3d4/86'/0'/0']xpub6..."
                    autoComplete="off"
                    spellCheck={false}
                    rows={3}
                    className="input mt-3 font-mono text-xs"
                  />
                ) : null}
              </Disclosure>
            </>
          ) : null}

          {screen === "wait" ? (
            <>
              <h1 className="font-serif text-3xl md:text-4xl">
                If you stop signing in, how long until {heirName} can claim?
              </h1>
              <p className="mt-2 text-sm text-muted">We email you first. Signing in starts it again.</p>
              <div className={`mt-6 grid gap-2 ${demoMode ? "grid-cols-3" : "grid-cols-2 sm:grid-cols-4"}`}>
                {demoMode
                  ? DEMO_WAITING_PRESETS.map((w) => (
                      <Tile
                        key={w.id}
                        title={w.label}
                        sub={w.sub}
                        selected={draft.demoWaitingId === w.id}
                        onClick={() => patch({ demoWaitingId: w.id })}
                      />
                    ))
                  : WAIT_CHOICES.map((m) => (
                      <Tile
                        key={m}
                        title={monthsLabel(m)}
                        selected={draft.waitingMonths === m}
                        onClick={() => patch({ waitingMonths: m })}
                      />
                    ))}
              </div>
            </>
          ) : null}

          {screen === "heir-note" ? (
            <>
              <h1 className="font-serif text-3xl md:text-4xl">A word for {heirName}</h1>
              <p className="mt-2 text-sm text-muted">Optional. They see it if they ever claim.</p>
              <input
                type="text"
                aria-label="Your name"
                value={draft.ownerName}
                onChange={(e) => patch({ ownerName: e.target.value })}
                placeholder="Your name"
                autoComplete="name"
                maxLength={80}
                className="input mt-6 w-full"
              />
              <textarea
                aria-label="A short note"
                value={heir.note ?? ""}
                onChange={(e) => updateHeir({ note: e.target.value })}
                placeholder="A short note"
                rows={3}
                maxLength={500}
                className="input mt-3 w-full"
              />
            </>
          ) : null}

          {screen === "heir-code" && created ? (
            <>
              <h1 className="font-serif text-3xl md:text-4xl">
                Give {firstVault?.heirName || "your heir"} this code
              </h1>
              <p className="mt-2 text-sm text-muted">
                They need it to claim. Only you two know it, so we can&apos;t send it for you.
              </p>
              <div className="mt-6 flex flex-col gap-4">
                {created.vaults.map((v) =>
                  v.heirCode || v.envelope ? (
                    <HeirCodeCard
                      key={v.vaultId}
                      heirName={v.heirName}
                      code={v.heirCode ?? v.envelope!.passphrase}
                      envelope={v.envelope}
                    />
                  ) : null,
                )}
              </div>
            </>
          ) : null}

          {screen === "fund" && created ? (
            <>
              <h1 className="font-serif text-3xl md:text-4xl">Add money</h1>
              <p className="mt-2 text-sm text-muted">Any amount, any time. Only you can spend it.</p>
              <div className="mt-6 flex flex-col gap-6">
                {created.vaults.map((v) => (
                  <div key={v.vaultId} className="flex flex-col gap-3">
                    {created.vaults.length > 1 ? (
                      <p className="text-xs uppercase tracking-wider text-dim">{v.heirName}&apos;s share</p>
                    ) : null}
                    <ReceiveCard vaultId={v.vaultId} embedded autoShow />
                    <FundingBalanceLine vaultId={v.vaultId} />
                  </div>
                ))}
              </div>
            </>
          ) : null}

          {showScreenError ? (
            <p className="mt-4 text-sm text-alarm" role="alert">
              {screenError}
            </p>
          ) : null}
          {error ? (
            <div className="mt-6">
              <InlineAlert tone="alarm">{error}</InlineAlert>
              {emailTaken ? (
                <div className="mt-3">
                  <Button variant="ghost" size="sm" type="button" onClick={onSignIn}>
                    Sign in
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
          {busy ? (
            <div className="mt-6" aria-live="polite">
              <p className="text-sm text-muted">{busyLabel}</p>
              <div className="mt-2">
                <ProgressBar value={Math.max(5, kdfProgress)} label="Vault progress" />
              </div>
            </div>
          ) : null}

          <div className="mt-10 flex flex-col gap-3">
            <Button
              type="submit"
              size="lg"
              loading={busy}
              disabled={Boolean(screenError) || ((screen === "heir-note" || screen === "heir-ask") && gateReason !== null)}
            >
              {PRIMARY_LABEL[screen](draft)}
            </Button>
            {screen === "heir-ask" ? (
              <Button
                type="button"
                variant="ghost"
                size="lg"
                disabled={busy || gateReason !== null}
                onClick={() => void activate(true)}
              >
                Not now
              </Button>
            ) : null}
          </div>
        </form>
      </div>
    </main>
  );
}

/* ============================================================ */
/* Heir contact channels                                          */
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

/* ============================================================ */
/* Password strength meter                                        */
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

/**
 * Inline balance under the deposit address. Auto-fetches on mount so
 * the owner sees "0 sat" immediately, and provides a manual refresh
 * after they send funds so they can confirm the deposit landed.
 */
function FundingBalanceLine({ vaultId }: { vaultId: string }) {
  const [balance, setBalance] = useState<VaultBalanceView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fiatLineOf = useFiatLine();
  const unit = useUnit();

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
          {balance ? formatAmount(balance.total_sat, unit) : loading ? "…" : "—"}
        </span>
        {balance && balance.total_sat > 0 && fiatLineOf(balance.total_sat) ? (
          <span className="ml-1 text-dim">{fiatLineOf(balance.total_sat)}</span>
        ) : null}
        {balance && balance.unconfirmed_sat > 0 ? (
          <span className="ml-1 text-dim">
            ({formatAmount(balance.unconfirmed_sat, unit)} pending)
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
