/**
 * Local-only metadata for vaults the user has created on this device.
 *
 * The server stores opaque `owner_contact` / `heir_contact` strings,
 * but the new UI wants structured heir data (name, email, BTC address)
 * to render the dashboard's heir card. Until the backend grows a
 * proper heir table, we mirror that here in localStorage. The data
 * never leaves the device; the server already has the cryptographic
 * proof of who can claim.
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
