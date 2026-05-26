/**
 * Typed client for the ghostkey-server REST API.
 *
 * The shapes mirror `crates/ghostkey-server/src/routes.rs`. If those
 * structs change, regenerate or update this file by hand — there is no
 * code generation in this project on purpose (the surface is tiny and
 * a hand-written client keeps the dependency footprint minimal).
 */

export type VaultStatus =
  | "ok"
  | "warning"
  | "alarmed"
  | "timelock_started"
  | "claimed";

export interface VaultListItem {
  id: string;
  label: string | null;
  status: VaultStatus;
  next_deadline_at: string; // RFC3339
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

  heir_xprv_ct_b64: string;
  heir_xprv_nonce_b64: string;

  owner_email_hash: string;
  claim_token_b64: string;
}

/** One vault entry returned by `POST /vaults/find`. */
export interface FoundVault {
  id: string;
  label: string | null;
  status: VaultStatus;
  created_at: string;
  next_deadline_at: string;
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
}

/** First external (receive) address derived from the vault descriptor.
 *  Public information; no auth required. */
export interface VaultAddressView {
  vault_id: string;
  network: string;
  address: string;
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
 * Returned by `GET /claim/:token/sealed-heir` for password-vault
 * claims. The browser unwraps `heir_xprv_ct_b64` locally using a KEK
 * derived from the raw claim token (HKDF-SHA256, same path the setup
 * browser used to seal it). The server cannot open this blob — only
 * the holder of the claim token can.
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
  const body = text ? (JSON.parse(text) as unknown) : null;
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
}

export const api = {
  health: () => request<{ ok: boolean; version: string }>("/health"),
  getVault: (id: string, ownerToken: string | null) =>
    request<VaultView>(`/vaults/${id}`, {}, ownerToken),
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
  /** Cross-device recovery: list vaults whose owner email SHA-256
   *  matches. The browser hashes the email locally first; we never
   *  POST the plaintext. */
  findVaultsByEmailHash: (owner_email_hash: string) =>
    request<FoundVault[]>("/vaults/find", {
      method: "POST",
      body: JSON.stringify({ owner_email_hash }),
    }),
  /** Fetch the sealed-blobs view so the browser can unwrap locally
   *  with the user's password. No auth — the blobs are useless
   *  without the password. */
  getSealedBlobs: (id: string) =>
    request<SealedBlobsView>(`/vaults/${id}/sealed-blobs`),
  /** Next external (receive) address from the vault descriptor.
   *  Public; used to fund a freshly-created vault. */
  getVaultAddress: (id: string) =>
    request<VaultAddressView>(`/vaults/${id}/address`),

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
  checkin: (id: string, ownerToken: string | null) =>
    request<CheckinResponse>(
      `/vaults/${id}/checkin`,
      { method: "POST" },
      ownerToken,
    ),
  listEvents: (id: string, ownerToken: string | null) =>
    request<VaultEvent[]>(`/vaults/${id}/events`, {}, ownerToken),
  resolveClaim: (token: string) =>
    request<ClaimView>(`/claim/${encodeURIComponent(token)}`),
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
  /** Password-vault flow: one-shot build + sign + broadcast. The
   *  server uses the supplied heir_xprv in memory only and discards
   *  it after the response is sent. */
  heirClaim: (token: string, req: HeirClaimRequest) =>
    request<BroadcastClaimResponse>(
      `/claim/${encodeURIComponent(token)}/heir-claim`,
      { method: "POST", body: JSON.stringify(req) },
    ),
};
