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

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
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

export const api = {
  health: () => request<{ ok: boolean; version: string }>("/health"),
  listVaults: () => request<VaultListItem[]>("/vaults"),
  getVault: (id: string) => request<VaultView>(`/vaults/${id}`),
  createVault: (req: CreateVaultRequest) =>
    request<VaultView>("/vaults", {
      method: "POST",
      body: JSON.stringify(req),
    }),
  createVaultFromXpub: (req: CreateVaultFromXpubRequest) =>
    request<VaultView>("/vaults/from-xpub", {
      method: "POST",
      body: JSON.stringify(req),
    }),
  checkin: (id: string) =>
    request<CheckinResponse>(`/vaults/${id}/checkin`, { method: "POST" }),
  listEvents: (id: string) => request<VaultEvent[]>(`/vaults/${id}/events`),
};
