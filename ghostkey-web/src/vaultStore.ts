/**
 * Local-only metadata for vaults the user has created on this device.
 *
 * The server stores opaque `owner_contact` / `heir_contact` strings,
 * but the new UI wants structured heir data (name, email, BTC address)
 * to render the dashboard's heir card. Until the backend grows a
 * proper heir table, we mirror that here in localStorage. The data
 * never leaves the device; the server already has the cryptographic
 * proof of who can claim.
 *
 * Per-vault `ownerToken` (the bearer credential issued at vault
 * creation) also lives here. The server returns it exactly once in
 * the `CreatedVault` response; if it's lost from this browser, the
 * owner can no longer check in or list events for that vault from
 * this device. The on-chain inheritance is still safe — the owner
 * could create a new vault and re-register their funds — but the
 * existing vault's notifier becomes unreachable.
 *
 * Why localStorage and not sessionStorage?
 *   The check-in flow expects the dashboard to "remember" your vault
 *   across visits. sessionStorage clears on tab close, which would
 *   make the dashboard amnesiac. The trade-off is that any script
 *   running on the same origin can read the token; we mitigate by
 *   keeping CORS strict and the dashboard's surface small.
 */

export interface HeirInfo {
  name: string;
  email: string;
  address: string;
}

export interface OwnerInfo {
  address: string;
  wallet: string | null; // "Sparrow" | "BlueWallet" | "Ledger" | null
}

export interface VaultMeta {
  id: string;
  label: string;
  owner: OwnerInfo;
  heir: HeirInfo;
  createdAt: string; // ISO
  /**
   * Bearer credential for `/vaults/:id/*` mutation routes.
   * Optional for legacy entries created before per-vault auth shipped.
   * New vaults always populate this.
   */
  ownerToken?: string;
}

const STORE_KEY = "gk:vaults";
const ACTIVE_KEY = "gk:activeVaultId";

function readAll(): Record<string, VaultMeta> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, VaultMeta>) : {};
  } catch {
    return {};
  }
}

function writeAll(map: Record<string, VaultMeta>) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(map)); } catch { /* ignore */ }
}

export function saveVaultMeta(meta: VaultMeta) {
  const map = readAll();
  map[meta.id] = meta;
  writeAll(map);
  setActiveVaultId(meta.id);
}

export function getVaultMeta(id: string): VaultMeta | null {
  return readAll()[id] ?? null;
}

/** Returns the stored owner token for a vault, or null. */
export function getVaultOwnerToken(id: string): string | null {
  return readAll()[id]?.ownerToken ?? null;
}

export function listVaultMeta(): VaultMeta[] {
  return Object.values(readAll()).sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : -1,
  );
}

export function setActiveVaultId(id: string | null) {
  try {
    if (id) localStorage.setItem(ACTIVE_KEY, id);
    else    localStorage.removeItem(ACTIVE_KEY);
  } catch { /* ignore */ }
}

export function getActiveVaultId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}
