/**
 * Typed client for the ghostkey-server REST API.
 *
 * The shapes mirror `crates/ghostkey-server/src/routes.rs`. If those
 * structs change, regenerate or update this file by hand — there is no
 * code generation in this project on purpose (the surface is tiny and
 * a hand-written client keeps the dependency footprint minimal).
 */

export type VaultStatus =
  | "unfunded"
  | "ok"
  | "warning"
  | "alarmed"
  | "timelock_started"
  | "claiming"
  | "claimed"
  | "frozen";

export interface VaultListItem {
  id: string;
  label: string | null;
  status: VaultStatus;
  next_deadline_at: string; // RFC3339
}

/** The heir's decrypted details for the owner's dashboard. Backed by
 *  `crates/ghostkey-server/src/routes.rs::HeirProfileView`. */
export interface HeirProfileView {
  name: string | null;
  contact: string | null;
  channel: string | null;
  note: string | null;
}

export interface VaultView {
  id: string;
  label: string | null;
  network: string;
  timelock_blocks: number;
  checkin_period_secs: number;
  grace_period_secs: number;
  status: VaultStatus;
  created_at: string;
  last_checkin_at: string | null;
  next_deadline_at: string;
  /** When the heir becomes eligible to claim if the owner doesn't check in.
   *  Surfaced by the dashboard as "X days until heir is notified". */
  claim_eligible_at?: string | null;
  /** Present only when `status === "frozen"`: when the panic freeze
   *  auto-releases (90 days after activation). */
  panic_frozen_until?: string | null;
  /** Bech32 `lnurl1...` for the static check-in QR code. `null` when
   *  the server's Lightning sidecar isn't configured. */
  lnurl_checkin?: string | null;
  /** Bech32 `lnurl1...` for the panic-stop QR code. */
  lnurl_panic?: string | null;
  /** Whether the owner's reminder email has been confirmed via the
   *  verification link. Absent/null when the vault has no email on
   *  file; `false` drives the dashboard's "confirm your email" card. */
  owner_contact_verified?: boolean | null;
  /** Whether a trusted contact is on file. Gates the panic-stop
   *  copy's "your trusted contact will be alerted" promise — only
   *  rendered when true (issue #70). Absent on list/create
   *  responses. */
  has_trusted_contact?: boolean | null;
  /** Descriptor pair. Present only on the owner-authenticated
   *  `GET /vaults/:id`; embedded into the downloadable independence
   *  proof so the owner can reconstruct the wallet without GhostKey. */
  descriptor_external?: string | null;
  descriptor_internal?: string | null;
  /** Rough wall-clock time the on-chain timelock matures (RFC3339), from
   *  the server's cached maturity scan. Present only on the owner
   *  `GET /vaults/:id` when the vault has been scanned and hasn't matured.
   *  Drives the "waiting to claim — unlocks around <date>" copy. */
  unlock_eta?: string | null;
  /** Claim fire-drill progress (#223): when the owner last sent a
   *  practice run, when the heir first opened it, and when the heir
   *  finished it. Present only on the owner `GET /vaults/:id`. */
  drill_started_at?: string | null;
  drill_opened_at?: string | null;
  drill_completed_at?: string | null;
}

export interface CreateVaultRequest {
  label: string | null;
  network: string;
  descriptor_external: string;
  descriptor_internal: string;
  timelock_blocks: number;
  checkin_period_secs: number;
  grace_period_secs: number;
  owner_contact?: string | null;
  owner_contact_channel?: "sms" | "email" | "whatsapp" | null;
  heir_contact?: string | null;
}

/**
 * One party's xpub material. Either supply `fingerprint` alongside a
 * bare xpub string, or paste an origin-tagged xpub
 * (`[fingerprint/86'/0'/0']xpub6C...`) and leave `fingerprint` undefined.
 *
 * Sparrow, BlueWallet desktop, Specter, and Coldcard all export the
 * origin-tagged form by default. Mobile BlueWallet exports the bare
 * form plus a separate fingerprint string.
 */
export interface PartyXpub {
  xpub: string;
  fingerprint?: string | null;
}

/**
 * The web-friendly setup request: the server builds the Taproot
 * descriptor itself from the two xpubs. See
 * `crates/ghostkey-server/src/routes.rs::create_vault_from_xpub`.
 */
export interface CreateVaultFromXpubRequest {
  label: string | null;
  network: string;
  owner: PartyXpub;
  heir: PartyXpub;
  timelock_blocks: number;
  checkin_period_secs: number;
  grace_period_secs: number;
  owner_contact?: string | null;
  /** Optional channel hint for the owner contact above. Defaults to
   *  `"email"` server-side when an `owner_contact` is supplied
   *  without an explicit channel. Mirrors `heir_contact_channel`. */
  owner_contact_channel?: "sms" | "email" | "whatsapp" | null;
  heir_contact?: string | null;
  heir_contact_channel?: "sms" | "email" | "whatsapp" | null;
  /**
   * Optional sealed material from the in-browser password-vault flow.
   * When present, the server stores the ciphertexts verbatim and the
   * vault is openable on any device with email + password. When omitted,
   * the legacy "bring-your-own-wallet" flow is used and the owner_token
   * returned in the response is the only credential.
   *
   * Mirrors `crates/ghostkey-server/src/routes.rs::SealedSetup`.
   */
  sealed?: SealedSetup | null;
  /**
   * F2: opt the heir into server-side key derivation. When set, the
   * server derives the heir's xpub deterministically from the email,
   * the vault id, and the master key — the `heir` xpub above is
   * ignored. The heir's browser re-derives the matching xprv at claim
   * time via `crypto/heirKey.ts`. Use this when the heir has no
   * Bitcoin wallet yet.
   */
  heir_derivation?: { email: string } | null;
  /** F4: trusted contact who will be alerted if the owner triggers
   *  a panic-stop. Optional. */
  trusted_contact?: string | null;
  trusted_contact_channel?: "sms" | "email" | "whatsapp" | null;
  /** #98 Part 2 (item 3): named, personal first contact. The owner's
   *  display name and a short note, shown to the heir in the claim
   *  message. Both optional, sealed at rest server-side. */
  from_name?: string | null;
  heir_note?: string | null;
}

/**
 * One guardian's xpub + browser-sealed key material for a guardian
 * vault (#81). Mirrors `routes.rs::GuardianParty`. The guardian key is
 * generated and sealed in the owner's browser under this guardian's
 * own claim token, exactly like the heir key; the server stores only
 * ciphertext and the token hash.
 */
export interface GuardianParty {
  xpub: string;
  fingerprint?: string | null;
  xprv_ct_b64: string;
  xprv_nonce_b64: string;
  claim_token_b64: string;
  contact?: string | null;
  contact_channel?: "sms" | "email" | "whatsapp" | null;
}

/**
 * Guardian-vault setup request (#81): an heir who needs a guardian's
 * help to claim. The spend branch is `heir AND (g1 OR g2)`, so the
 * child alone can't move the funds and one missing guardian doesn't
 * strand them. Always browser-keygen (no Door B): the heir key is
 * sealed in `sealed`, each guardian key in its `GuardianParty`.
 *
 * Mirrors `crates/ghostkey-server/src/routes.rs::CreateGuardianVaultRequest`.
 */
export interface CreateVaultGuardianRequest {
  label: string | null;
  network: string;
  owner: PartyXpub;
  heir: PartyXpub;
  guardian1: GuardianParty;
  guardian2: GuardianParty;
  timelock_blocks: number;
  checkin_period_secs: number;
  grace_period_secs: number;
  owner_contact?: string | null;
  owner_contact_channel?: "sms" | "email" | "whatsapp" | null;
  heir_contact?: string | null;
  heir_contact_channel?: "sms" | "email" | "whatsapp" | null;
  /** Required: a guardian vault always seals the owner + heir keys in
   *  the browser. Unlike `CreateVaultFromXpubRequest`, this is not
   *  optional. */
  sealed: SealedSetup;
  from_name?: string | null;
  heir_note?: string | null;
  /** Optional absolute unlock height (#81 P5). When set, the claim branch
   *  gains an `after(H)` CLTV so the heir + guardian can't spend before
   *  block `H` (e.g. until a child reaches a chosen age). The browser
   *  computes this height from the owner's chosen unlock year. */
  unlock_height?: number | null;
}

/** Snake-cased to match the Rust struct exactly; the server is the
 *  source of truth for this shape. See sealing.ts for how each blob
 *  is produced in the browser. */
export interface SealedSetup {
  password_salt_b64: string;
  password_kdf_mem_kib: number;
  password_kdf_iters: number;

  owner_xprv_ct_b64: string;
  owner_xprv_nonce_b64: string;
  owner_token_ct_b64: string;
  owner_token_nonce_b64: string;

  /** Absent for Door B vaults (heir holds their own key; the server
   *  stores nothing that can spend). Present with `claim_token_b64`, or
   *  both absent, never one without the other. */
  heir_xprv_ct_b64?: string;
  heir_xprv_nonce_b64?: string;

  owner_email_hash: string;
  /** Absent for Door B — the scheduler mints a fresh claim token at
   *  trigger time, since no heir secret is bound to it. */
  claim_token_b64?: string;
}

/** One vault entry returned after one-time recovery-link exchange. */
export interface FoundVault {
  id: string;
  label: string | null;
  status: VaultStatus;
  created_at: string;
  next_deadline_at: string;
}

export interface OwnerRecoveryBundle {
  vault: FoundVault;
  sealed_blobs: SealedBlobsView;
}

export interface OwnerRecoveryExchange {
  owner_email: string;
  vaults: OwnerRecoveryBundle[];
}

/** Sealed blobs the server hands the owner's browser during cross-device
 *  recovery. The browser unwraps these locally with the password. */
export interface SealedBlobsView {
  vault_id: string;
  password_salt_b64: string;
  password_kdf_mem_kib: number;
  password_kdf_iters: number;
  owner_xprv_ct_b64: string;
  owner_xprv_nonce_b64: string;
  owner_token_ct_b64: string;
  owner_token_nonce_b64: string;
  network: string;
  timelock_blocks: number;
  /** Owner descriptor key fragment (`[fp/86'/0'/0']xpub.../0/*`). The
   *  "add a heir" flow strips the `/0/*` suffix and passes the rest as
   *  an origin-tagged `owner.xpub` so the new sibling vault is built
   *  under the identical owner key. `null` on legacy rows. */
  owner_xpub_fragment_external?: string | null;
}

/** First external (receive) address derived from the vault descriptor.
 *  Public information; no auth required. */
export interface VaultAddressView {
  vault_id: string;
  network: string;
  address: string;
}

export interface VaultBalanceView {
  vault_id: string;
  network: string;
  confirmed_sat: number;
  unconfirmed_sat: number;
  total_sat: number;
}

/** Response from `POST /vaults/:id/send` — the owner spend flow. */
export interface OwnerSendResponse {
  txid: string;
  explorer_url: string;
  sent_sat: number;
  fee_sat: number;
  remaining_sat: number;
}

export interface AssistChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface CheckinResponse {
  vault_id: string;
  last_checkin_at: string;
  next_deadline_at: string;
  status: VaultStatus;
}

export interface VaultEvent {
  id: number;
  vault_id: string;
  kind: string;
  detail: unknown | null;
  created_at: string;
}

/**
 * What the heir sees after clicking their claim link.
 *
 * The server omits any field that would be useful to an attacker or
 * unhelpful to the heir (descriptor strings, owner xpub, raw contact
 * value). Channel is a hint about how the link arrived; display name
 * is the heir's own name as the owner typed it during setup.
 *
 * Backed by `crates/ghostkey-server/src/routes.rs::ClaimView`.
 */
export interface ClaimView {
  vault_id: string;
  label: string | null;
  network: string;
  status: VaultStatus;
  timelock_blocks: number;
  next_deadline_at: string;
  heir_channel: string | null;
  heir_display_name: string | null;
  /** When the claim-challenge safety wait ends and the claim can be
   *  completed. Absent/null when there's no wait (window disabled or
   *  already elapsed). While set in the future, the claim page shows
   *  the wait screen and the claim endpoints answer 409. */
  claim_available_at?: string | null;
  /** "standard" or "guardian" (#81). A guardian vault needs the heir
   *  plus one guardian, so the claim page renders the two-link flow. */
  vault_kind: "standard" | "guardian";
  /** Which party opened this link: "heir" or "guardian". */
  token_role: "heir" | "guardian";
  /** For a guardian token, which slot (1 or 2). Null for heir tokens. */
  guardian_slot?: number | null;
  /** True when this link is a practice run (#223): the page walks the
   *  heir through the claim without moving anything. Optional so an
   *  older server (which never sends it) reads as "not a drill". */
  drill?: boolean;
  /** Set only after the claim completed: the txid of the broadcast
   *  that moved the funds. The page shows the heir their receipt
   *  instead of a "link already used" dead end. */
  claimed_txid?: string | null;
  /** Explorer link for `claimed_txid`. */
  claimed_explorer_url?: string | null;
}

/** Response from `POST /vaults/:id/drill` (#223). */
export interface DrillStartView {
  vault_id: string;
  started_at: string;
  /** Whether a practice message was queued for the heir. False when
   *  the vault has no deliverable heir contact. */
  heir_notified: boolean;
  /** The practice link, so the owner can also share it directly. A
   *  drill link cannot reach key material or move coins. */
  claim_url: string;
}

/** Response from `POST /claim/:token/drill-complete` (#223). */
export interface DrillCompleteView {
  completed_at: string;
}

/** On-chain unlock estimate, from `GET /claim/:token/unlock-estimate`.
 *  The CSV timelock is separate from the server's safety wait: the funds
 *  can't move until the coins are `timelock_blocks` deep, regardless of
 *  what the server allows. */
export interface UnlockEstimateView {
  /** True once the timelock has elapsed — the claim can complete now. */
  matured: boolean;
  /** Chain tip height at the estimate. */
  tip_height: number;
  /** Block at/after which the heir can spend, or null when no confirmed
   *  coin yet anchors the timelock. */
  unlock_height: number | null;
  /** Blocks left until maturity (0 once reached). */
  blocks_remaining: number;
  /** Rough wall-clock unlock time (RFC3339), or null when matured or not
   *  yet anchored. "Around": block spacing drifts. */
  unlock_eta: string | null;
}

/** Owner-side video metadata from `GET /vaults/:id/video` (#222).
 *  Mirrors `video_routes.rs::VideoStatusView`. */
export interface VideoStatusView {
  has_video: boolean;
  mime: string | null;
  duration_ms: number | null;
  created_at: string | null;
}

/** The heir's claim token from `GET /vaults/:id/claim-token` (#222).
 *  Mirrors `video_routes.rs::ClaimTokenView`. */
export interface ClaimTokenView {
  claim_token_b64: string;
}

/** Encrypted owner video message returned by `GET /claim/:token/video`
 *  (#85). The clip is sealed under the claim-token KEK; the signature is
 *  verified client-side against `owner_xpub`. */
export interface ClaimVideoView {
  vault_id: string;
  video_ct_b64: string;
  video_nonce_b64: string;
  mime: string;
  duration_ms: number | null;
  owner_sig_b64: string;
  signed_sha256_hex: string;
  owner_xpub: string;
}

/**
 * Heir-claim PSBT build request. The heir supplies the destination
 * Bitcoin address (where the funds should land) and optionally a fee
 * rate in sat/vB. The server reconstructs the vault from its stored
 * descriptor pair, scans the chain for UTXOs at vault addresses, and
 * returns an unsigned PSBT that takes the timelocked recovery branch.
 *
 * Backed by `crates/ghostkey-server/src/psbt_routes.rs::BuildClaimPsbtRequest`.
 */
export interface BuildClaimPsbtRequest {
  destination: string;
  fee_rate_sat_per_vb?: number | null;
}

export interface BuildClaimPsbtResponse {
  psbt_b64: string;
  total_input_sats: number;
  output_sats: number;
  fee_sats: number;
  network: string;
  /**
   * Whether the server was able to finalise the PSBT without the
   * heir's signature. For a watch-only build this is always false —
   * the heir's wallet still has to sign before broadcast.
   */
  finalized: boolean;
}

export interface BroadcastClaimRequest {
  signed_psbt_b64: string;
}

export interface BroadcastClaimResponse {
  txid: string;
  explorer_url: string;
}

/**
 * Returned by `GET /claim/:token/heir-derivation-params` for F2
 * server-derived heirs. The browser HKDFs the `vault_secret_hex` with
 * `heir_email` to reach the BIP39 entropy that built the heir's xpub,
 * then derives the corresponding xprv locally.
 */
export interface HeirDerivationParamsView {
  vault_id: string;
  network: string;
  timelock_blocks: number;
  vault_secret_hex: string;
  heir_email: string;
  /** Public watch-only descriptor pair. Lets the heir's browser build a
   *  self-contained recovery file (block B) it can sign offline. */
  descriptor_external: string;
  descriptor_internal: string;
}

/**
 * Returned by `GET /claim/:token/sealed-heir` for password-vault
 * claims. The browser unwraps `heir_xprv_ct_b64` locally using a KEK
 * derived from the raw claim token (HKDF-SHA256, same path the setup
 * browser used to seal it). Door A stores that claim token reversibly
 * under the production master key for future delivery, so DB + master
 * key can also open it.
 *
 * Backed by
 * `crates/ghostkey-server/src/psbt_routes.rs::SealedHeirView`.
 */
export interface SealedHeirView {
  vault_id: string;
  network: string;
  timelock_blocks: number;
  heir_xprv_ct_b64: string;
  heir_xprv_nonce_b64: string;
  /** Public watch-only descriptor pair. Lets the heir's browser build a
   *  self-contained recovery file (block B) it can sign offline. */
  descriptor_external: string;
  descriptor_internal: string;
}

/**
 * One-shot heir claim: the browser ships the just-unwrapped heir
 * account xprv over TLS along with the destination address. The
 * server builds, signs, and broadcasts in a single function scope;
 * the xprv is held in memory only, never written to disk or logs.
 *
 * Why ship the xprv at all? At the moment of this call the on-chain
 * timelock has matured and the only key in scope is the heir's. An
 * attacker who briefly compromises the server could only redirect
 * funds to a Bitcoin address Bitcoin's UTXO set then records
 * publicly — the same threat surface a hardware wallet signer has
 * when its host machine is compromised. We accept that exposure in
 * exchange for not shipping a Taproot script-path PSBT signer to the
 * browser.
 *
 * Backed by
 * `crates/ghostkey-server/src/psbt_routes.rs::HeirClaimRequest`.
 */
export interface HeirClaimRequest {
  destination: string;
  fee_rate_sat_per_vb?: number | null;
  /** Heir account xprv at `m/86'/coin'/0'`, base58 (`tprv...` /
   *  `xprv...`). The browser unwraps this from the sealed blob via
   *  the URL-fragment claim token; the server uses it once and
   *  discards. */
  heir_xprv: string;
}

/**
 * Returned by `GET /claim/:token/sealed-guardian` for a guardian vault
 * (#81). Same shape as `SealedHeirView` but for one guardian's key; the
 * browser unwraps `guardian_xprv_ct_b64` locally with the guardian's
 * claim token. `slot` is which guardian (1 or 2) the token belongs to.
 *
 * Backed by `crates/ghostkey-server/src/psbt_routes.rs::SealedGuardianView`.
 */
export interface SealedGuardianView {
  vault_id: string;
  slot: number;
  network: string;
  timelock_blocks: number;
  guardian_xprv_ct_b64: string;
  guardian_xprv_nonce_b64: string;
  descriptor_external: string;
  descriptor_internal: string;
}

/**
 * Two-key guardian claim (#81). The browser unwraps the heir key (from
 * the heir's sealed-heir blob) and one guardian key (from a
 * sealed-guardian blob), then ships both here. Posted to the HEIR
 * token's endpoint (the vault's primary claim token, which this call
 * consumes). The server splices both keys, signs, broadcasts, and
 * discards them.
 *
 * Backed by `crates/ghostkey-server/src/psbt_routes.rs::GuardianClaimRequest`.
 */
export interface GuardianClaimRequest {
  destination: string;
  fee_rate_sat_per_vb?: number | null;
  heir_xprv: string;
  guardian_xprv: string;
}

/** Cached BTC/USD spot price for fiat display. Backed by
 *  `crates/ghostkey-server/src/price.rs::PriceView`. */
export interface PriceView {
  usd_per_btc: number;
  fetched_at: string;
  /** True when the server is serving a stale cached value (a refresh
   *  failed). The UI can show the estimate more cautiously. */
  stale: boolean;
}

/** Response shape from `POST /vaults/:id/lightning-checkin/invoice`. */
export interface LightningInvoiceView {
  bolt11: string;
  payment_hash: string;
  amount_sat: number;
  expires_at: string;
  status: string;
}

/** Response shape from
 *  `GET /vaults/:id/lightning-checkin/status/:payment_hash`. */
export interface LightningInvoiceStatusView {
  payment_hash: string;
  status: string;
  paid_at: string | null;
  expires_at: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Base URL of the API.
 *
 * - In dev: Vite proxies `/api/*` to the local server, so `/api` works.
 * - In prod on a single host: keep `/api` and reverse-proxy at the edge.
 * - In prod with split hosts (e.g. Cloudflare Pages + VPS): set
 *   `VITE_API_BASE=https://api.example.com` in the build environment.
 */
const BASE: string =
  ((import.meta as unknown as { env?: { VITE_API_BASE?: string } }).env
    ?.VITE_API_BASE ?? "/api");

/**
 * Per-vault owner authentication.
 *
 * Most server routes require an `Authorization: Bearer <token>` header
 * that maps to a SHA-256 hash stored at vault creation time. The token
 * is returned exactly once in the `CreatedVault` response and is
 * persisted on the client (see `vaultStore.ts`). It never appears in
 * a URL or a query string.
 *
 * Pass `null` or omit the argument for routes that don't need auth
 * (`/health`, `/claim/:token/*`, the create-vault endpoints
 * themselves).
 */
function authHeaders(token?: string | null): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  ownerToken?: string | null,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...authHeaders(ownerToken),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    // Non-JSON body — a proxy or CDN error page, not our server.
    // Leave body null so the status line below becomes the message
    // instead of a raw SyntaxError reaching the user.
  }
  if (!res.ok) {
    const msg =
      (body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : null) ?? `${res.status} ${res.statusText}`;
    throw new ApiError(res.status, body, msg);
  }
  return body as T;
}

/**
 * Response shape from `POST /vaults` and `POST /vaults/from-xpub`.
 * The `owner_token` field is the bearer credential the caller must
 * keep — it's never returned again by any other route.
 */
export interface CreatedVault extends VaultView {
  owner_token: string;
  /** F2 only: the vault secret the owner's browser HKDFs with the heir
   *  email to derive the heir's account key, so it can build the heir
   *  envelope (block A) at setup. Absent for bring-your-own-xpub heirs. */
  vault_secret_hex?: string | null;
}

export const api = {
  health: () =>
    request<{
      ok: boolean;
      version: string;
      lightning_enabled: boolean;
      demo_mode: boolean;
      /** Which Bitcoin network the server wants the UI to default
       *  new vaults to. Mirrors GHOSTKEY_DEFAULT_NETWORK on the
       *  server side. Falls back to `"testnet"` on older servers
       *  that don't yet emit this field. */
      default_network?: "bitcoin" | "testnet" | "signet" | "regtest";
      /** Whether the AI onboarding guide is reachable. False on older
       *  servers that don't yet emit the field; the UI treats it as off. */
      assist_enabled?: boolean;
      /** VAPID public key for web push, or null/absent when the
       *  server has no push keypair configured. Presence gates the
       *  reminder opt-in card on the dashboard. */
      push_public_key?: string | null;
      /** Which contact channels this server can actually deliver
       *  (#277). Absent on older servers — treated as deliverable so
       *  a stale pairing doesn't lock every channel away. The setup
       *  and edit-heir flows disable channels reported false. */
      email_enabled?: boolean;
      sms_enabled?: boolean;
      whatsapp_enabled?: boolean;
    }>("/health"),
  /** Deep probe of the Lightning sidecar. `/health` only tells us
   *  whether the operator wired up env vars; this issues the
   *  sidecar's `/v1/health` and reports the result. Server caches
   *  the underlying call for 5s so this can be polled cheaply.
   *  Older servers without this endpoint return 404 — callers must
   *  treat that as "unknown" and skip the badge. */
  healthLightning: () =>
    request<{
      enabled: boolean;
      ready: boolean;
      error?: string;
    }>("/health/lightning"),
  getVault: (id: string, ownerToken: string | null) =>
    request<VaultView>(`/vaults/${id}`, {}, ownerToken),
  /** Owner-only: the heir's decrypted details (name, contact, channel,
   *  and the note left for them) for the dashboard heir panel. */
  getVaultHeir: (id: string, ownerToken: string | null) =>
    request<HeirProfileView>(`/vaults/${id}/heir`, {}, ownerToken),
  /** Owner-only: change how the heir is reached (contact address +
   *  channel). The heir's name is preserved server-side. Returns the
   *  updated profile. On `heir_derived` vaults the server refuses an
   *  address change (400) because the heir's key is tied to their email. */
  updateVaultHeir: (
    id: string,
    ownerToken: string | null,
    body: { contact: string; channel: "sms" | "email" | "whatsapp" },
  ) =>
    request<HeirProfileView>(
      `/vaults/${id}/heir`,
      { method: "PUT", body: JSON.stringify(body) },
      ownerToken,
    ),
  /** Owner-initiated vault deletion. The server clears its metadata
   *  (vault row + cascaded events/notifications/lightning invoices).
   *  On-chain funds remain spendable by the owner — GhostKey never
   *  held the keys. Returns 204; we return null. */
  deleteVault: (id: string, ownerToken: string) =>
    request<null>(`/vaults/${id}`, { method: "DELETE" }, ownerToken),
  /** Register (or refresh — the server upserts on endpoint) this
   *  browser's push subscription so check-in reminders reach the
   *  device even when the tab is closed. Returns 204; we return null. */
  pushSubscribe: (
    id: string,
    sub: { endpoint: string; p256dh: string; auth: string },
    ownerToken: string,
  ) =>
    request<null>(
      `/vaults/${id}/push-subscriptions`,
      { method: "POST", body: JSON.stringify(sub) },
      ownerToken,
    ),
  /** Remove one device's subscription (keyed by endpoint). Other
   *  devices the owner subscribed stay registered. Idempotent. */
  pushUnsubscribe: (id: string, endpoint: string, ownerToken: string) =>
    request<null>(
      `/vaults/${id}/push-subscriptions`,
      { method: "DELETE", body: JSON.stringify({ endpoint }) },
      ownerToken,
    ),
  createVault: (req: CreateVaultRequest) =>
    request<CreatedVault>("/vaults", {
      method: "POST",
      body: JSON.stringify(req),
    }),
  createVaultFromXpub: (req: CreateVaultFromXpubRequest) =>
    request<CreatedVault>("/vaults/from-xpub", {
      method: "POST",
      body: JSON.stringify(req),
    }),
  /** Guardian vault (#81): heir + two guardians, spend branch
   *  `heir AND (g1 OR g2)`. See `CreateVaultGuardianRequest`. */
  createVaultGuardian: (req: CreateVaultGuardianRequest) =>
    request<CreatedVault>("/vaults/guardian", {
      method: "POST",
      body: JSON.stringify(req),
    }),
  /** Request a cross-device recovery email. The response is deliberately
   *  identical whether or not the hash belongs to a vault. */
  requestOwnerRecovery: (owner_email_hash: string) =>
    request<{ accepted: boolean }>("/recovery/request", {
      method: "POST",
      body: JSON.stringify({ owner_email_hash }),
    }),
  /** Atomically consume the one-time email challenge and receive the
   *  matching summaries + password-encrypted blobs. */
  exchangeOwnerRecovery: (token: string) =>
    request<OwnerRecoveryExchange>("/recovery/exchange", {
      method: "POST",
      body: JSON.stringify({ token }),
    }),
  /** Fetch sealed owner material for an already authenticated owner
   *  workflow. Public recovery uses the one-time exchange above. */
  getSealedBlobs: (id: string, ownerToken: string) =>
    request<SealedBlobsView>(
      `/vaults/${id}/sealed-blobs`,
      undefined,
      ownerToken,
    ),
  /** Password unlock on an existing trusted device. The owner token proves
   *  device possession; the typed email is sent only as its normalized hash. */
  trustedDeviceUnlock: (
    id: string,
    ownerToken: string,
    owner_email_hash: string,
  ) =>
    request<SealedBlobsView>(
      `/vaults/${id}/trusted-unlock`,
      {
        method: "POST",
        body: JSON.stringify({ owner_email_hash }),
      },
      ownerToken,
    ),
  /** Next external (receive) address from the vault descriptor.
   *  Public; used to fund a freshly-created vault. */
  getVaultAddress: (id: string) =>
    request<VaultAddressView>(`/vaults/${id}/address`),
  /** Owner spend: server signs with the transiently-POSTed account
   *  xprv (unsealed in this browser by the password — see
   *  crypto/sealing.ts) and broadcasts. Omit amount_sat to send the
   *  whole balance. The xprv is held in server memory only for the
   *  duration of the call; same contract as the heir claim. */
  ownerSend: (
    id: string,
    ownerToken: string,
    body: {
      destination: string;
      amount_sat?: number;
      fee_rate_sat_per_vb?: number;
      owner_xprv: string;
    },
  ) =>
    request<OwnerSendResponse>(
      `/vaults/${id}/send`,
      { method: "POST", body: JSON.stringify(body) },
      ownerToken,
    ),
  /** Watch-only balance of the vault, synced from Esplora. Public:
   *  the descriptor's addresses are public, and the chain is public.
   *  Owners use this from the dashboard right after funding to confirm
   *  sats landed. */
  getVaultBalance: (id: string) =>
    request<VaultBalanceView>(`/vaults/${id}/balance`),
  /** AI onboarding guide. Server proxies to the Anthropic API with a
   *  pinned system prompt. The handler refuses to forward seed phrases,
   *  xprvs, or other secret-shaped strings. No vault auth — the chat
   *  is purely educational. Returns 503-style errors if the server has
   *  no ANTHROPIC_API_KEY configured. */
  assistChat: (messages: AssistChatMessage[]) =>
    request<{ reply: string }>("/assist/chat", {
      method: "POST",
      body: JSON.stringify({ messages }),
    }),

  /** Re-seal the owner token after vault creation. Solves the
   *  chicken-and-egg in the password-vault setup flow: the browser
   *  needs the server-issued owner_token before it can seal it, but
   *  vault creation is a single atomic call. We ship a placeholder
   *  during create and call this immediately after with the real one.
   *  Requires the freshly-issued owner_token as the Bearer credential. */
  sealOwnerToken: (
    id: string,
    ownerToken: string,
    body: { owner_token_ct_b64: string; owner_token_nonce_b64: string },
  ) =>
    request<null>(
      `/vaults/${id}/seal-owner-token`,
      { method: "POST", body: JSON.stringify(body) },
      ownerToken,
    ),
  /** Owner-side video status (#222): whether this vault has a clip and
   *  its metadata. Never the ciphertext (the owner can't decrypt it —
   *  it's sealed under the claim-token KEK, not the password). */
  getVideoStatus: (id: string, ownerToken: string | null) =>
    request<VideoStatusView>(`/vaults/${id}/video`, {}, ownerToken),
  /** Remove the vault's video message (#222). */
  deleteVideo: (id: string, ownerToken: string | null) =>
    request<null>(`/vaults/${id}/video`, { method: "DELETE" }, ownerToken),
  /** The heir's claim token, released to the authenticated owner so the
   *  browser can seal a (re-)recorded video for an EXISTING vault under
   *  the claim-token KEK (#222) — the same sealing setup performs. 404
   *  for Door B / legacy vaults, which store no token at rest. */
  getVaultClaimToken: (id: string, ownerToken: string | null) =>
    request<ClaimTokenView>(`/vaults/${id}/claim-token`, {}, ownerToken),
  /** Store the owner's encrypted video message (#85). OwnerAuth via the
   *  freshly-issued owner_token. The clip is sealed under the claim-token
   *  KEK and signed with the owner key client-side; the server only ever
   *  sees ciphertext + signature. */
  uploadVideo: (
    id: string,
    ownerToken: string,
    body: {
      video_ct_b64: string;
      video_nonce_b64: string;
      mime: string;
      duration_ms: number | null;
      owner_sig_b64: string;
      signed_sha256_hex: string;
    },
  ) =>
    request<null>(
      `/vaults/${id}/video`,
      { method: "POST", body: JSON.stringify(body) },
      ownerToken,
    ),
  checkin: (id: string, ownerToken: string | null) =>
    request<CheckinResponse>(
      `/vaults/${id}/checkin`,
      { method: "POST" },
      ownerToken,
    ),
  /** One-tap check-in from the link in a reminder or alarm email.
   *  No Authorization header — the per-cycle token in the URL IS
   *  the auth. Returns 404 if the token doesn't match, 409 if it
   *  was already tapped, 200 with the new deadline on success.
   *  Mirrors `crates/ghostkey-server/src/routes.rs::checkin_from_link`. */
  checkinFromLink: (id: string, token: string) =>
    request<CheckinResponse>(
      `/vaults/${id}/checkin-from-link/${encodeURIComponent(token)}`,
      { method: "POST" },
      null,
    ),
  /** Confirm the owner's reminder email from the link we sent. Same
   *  token-IS-the-auth model as `checkinFromLink`: works on a device
   *  that has never seen this vault. 204 on success (idempotent —
   *  tapping the link twice is still a success), 404 on a stale or
   *  wrong token. */
  verifyContact: (id: string, token: string) =>
    request<null>(
      `/vaults/${id}/verify-contact/${encodeURIComponent(token)}`,
      { method: "POST" },
      null,
    ),
  /** Re-send the confirmation email (OwnerAuth). 204 on success or
   *  when already verified; 409 if one was sent in the last minute. */
  resendVerification: (id: string, ownerToken: string | null) =>
    request<null>(
      `/vaults/${id}/resend-verification`,
      { method: "POST" },
      ownerToken,
    ),
  /** Lightning check-in: mint a 1-sat BOLT11 invoice. Paying it from
   *  any Lightning wallet resets the vault's check-in deadline,
   *  identical semantics to the regular HTTP `checkin` above.
   *  Returns 4xx with `error: "lightning provider not configured..."`
   *  if the server has no Breez backend wired up — call `health()`
   *  first and hide the option when `lightning_enabled === false`. */
  lightningCreateInvoice: (id: string, ownerToken: string | null) =>
    request<LightningInvoiceView>(
      `/vaults/${id}/lightning-checkin/invoice`,
      { method: "POST" },
      ownerToken,
    ),
  /** Poll an invoice's status while the user is paying. The server's
   *  background poller updates the row on a ~3s tick; this just
   *  surfaces whatever is in the DB. */
  lightningInvoiceStatus: (
    id: string,
    paymentHash: string,
    ownerToken: string | null,
  ) =>
    request<LightningInvoiceStatusView>(
      `/vaults/${id}/lightning-checkin/status/${encodeURIComponent(paymentHash)}`,
      {},
      ownerToken,
    ),
  /** Same as lightningCreateInvoice, but authenticated by a one-tap
   *  check-in link token instead of the owner bearer, so the owner can
   *  pay the check-in straight from a reminder email without signing in.
   *  Mirrors `lightning_create_invoice_from_link`. */
  lightningCreateInvoiceFromLink: (id: string, token: string) =>
    request<LightningInvoiceView>(
      `/vaults/${id}/checkin-link/${encodeURIComponent(token)}/lightning-invoice`,
      { method: "POST" },
      null,
    ),
  /** Poll a link-minted invoice's status (token-gated, no owner auth). */
  lightningInvoiceStatusFromLink: (id: string, token: string, paymentHash: string) =>
    request<LightningInvoiceStatusView>(
      `/vaults/${id}/checkin-link/${encodeURIComponent(token)}/lightning-status/${encodeURIComponent(paymentHash)}`,
      {},
      null,
    ),
  listEvents: (id: string, ownerToken: string | null) =>
    request<VaultEvent[]>(`/vaults/${id}/events`, {}, ownerToken),
  resolveClaim: (token: string) =>
    request<ClaimView>(`/claim/${encodeURIComponent(token)}`),
  /** Start a practice claim (#223): mints a drill token, emails the
   *  heir a clearly-labelled rehearsal link. Owner-authenticated. */
  startDrill: (id: string, ownerToken: string) =>
    request<DrillStartView>(
      `/vaults/${id}/drill`,
      { method: "POST" },
      ownerToken,
    ),
  /** The heir finished the practice walkthrough. Records the permanent
   *  fact on the vault and tells the owner. Idempotent. */
  completeDrill: (token: string) =>
    request<DrillCompleteView>(
      `/claim/${encodeURIComponent(token)}/drill-complete`,
      { method: "POST" },
    ),
  /** On-chain unlock estimate for this claim. Tells the heir when the
   *  funds actually become spendable (the CSV timelock), separate from
   *  the server's safety wait. Drives the "unlocks around <date>" screen. */
  claimUnlockEstimate: (token: string) =>
    request<UnlockEstimateView>(
      `/claim/${encodeURIComponent(token)}/unlock-estimate`,
    ),
  /** Fetch the owner's encrypted video message for this claim (#85).
   *  404 when the vault has no video. The browser decrypts it with the
   *  claim token and verifies `owner_sig_b64` against `owner_xpub`. */
  getClaimVideo: (token: string) =>
    request<ClaimVideoView>(`/claim/${encodeURIComponent(token)}/video`),
  buildClaimPsbt: (token: string, req: BuildClaimPsbtRequest) =>
    request<BuildClaimPsbtResponse>(
      `/claim/${encodeURIComponent(token)}/build-psbt`,
      { method: "POST", body: JSON.stringify(req) },
    ),
  broadcastClaim: (token: string, req: BroadcastClaimRequest) =>
    request<BroadcastClaimResponse>(
      `/claim/${encodeURIComponent(token)}/broadcast`,
      { method: "POST", body: JSON.stringify(req) },
    ),
  /** Password-vault flow: fetch the sealed heir xprv blob so the
   *  browser can unwrap it locally. Returns 404 for unknown tokens,
   *  409 if the token's already been used, 422 if this vault was
   *  not created with a password (legacy vault). */
  getSealedHeirXprv: (token: string) =>
    request<SealedHeirView>(`/claim/${encodeURIComponent(token)}/sealed-heir`),
  /** F2: fetch the parameters a server-derived heir's browser needs
   *  to recompute the heir BIP39 mnemonic + xprv. Returns 422 if the
   *  vault was not created with `heir_derivation`. */
  getHeirDerivationParams: (token: string) =>
    request<HeirDerivationParamsView>(
      `/claim/${encodeURIComponent(token)}/heir-derivation-params`,
    ),
  /** Password-vault flow: one-shot build + sign + broadcast. The
   *  server uses the supplied heir_xprv in memory only and discards
   *  it after the response is sent. */
  heirClaim: (token: string, req: HeirClaimRequest) =>
    request<BroadcastClaimResponse>(
      `/claim/${encodeURIComponent(token)}/heir-claim`,
      { method: "POST", body: JSON.stringify(req) },
    ),
  /** Guardian vault (#81): fetch one guardian's sealed xprv blob. The
   *  browser unwraps it locally with the guardian's claim token. */
  getSealedGuardianXprv: (token: string) =>
    request<SealedGuardianView>(
      `/claim/${encodeURIComponent(token)}/sealed-guardian`,
    ),
  /** Guardian vault (#81): two-key claim. `token` is the heir token (the
   *  vault's primary claim token, consumed here). Body carries both the
   *  unwrapped heir and guardian account xprvs; the server signs with
   *  both in memory and discards them. */
  guardianClaim: (token: string, req: GuardianClaimRequest) =>
    request<BroadcastClaimResponse>(
      `/claim/${encodeURIComponent(token)}/guardian-claim`,
      { method: "POST", body: JSON.stringify(req) },
    ),
  /**
   * Privacy-preserving landing-page analytics. Fire-and-forget — never
   * await this in a render path. The server returns 204 and tolerates
   * brief DB contention without surfacing an error, so a swallow on the
   * client side won't mask a real issue. See `analytics.rs` and
   * `DESIGN.md` § "What we measure and why".
   */
  trackEvent: (event: string, label?: string) =>
    fetch(`${BASE}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(label ? { event, label } : { event }),
      // Use keepalive so a navigation away from the page doesn't
      // cancel the beacon. Falls back to a regular fetch on browsers
      // without keepalive support; the request is still cheap.
      keepalive: true,
    }).catch(() => {
      /* analytics failures are silent on purpose */
    }),
  /** Cached BTC/USD spot price for fiat display. Resolves to the rate or
   *  throws (503) when unavailable; callers hide the fiat line on error. */
  getPrice: () => request<PriceView>("/price"),
  /**
   * Subscribe an email to product updates. Backed by the server's
   * sealed-at-rest email list (`/newsletter` in `newsletter.rs`). The
   * server always answers 200 on a well-formed address whether or not
   * it was already on the list, so we never leak membership; a
   * malformed address throws a 400 the form can surface.
   */
  subscribeNewsletter: (email: string, source?: string) =>
    request<void>("/newsletter", {
      method: "POST",
      body: JSON.stringify(source ? { email, source } : { email }),
    }),
};
