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
  /**
   * Heir's BTC xpub (legacy bring-your-own-wallet flow only). Empty
   * string for password vaults — the heir xprv is sealed server-side
   * and never surfaces in the UI.
   */
  address: string;
}

export interface OwnerInfo {
  address: string;
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
  /**
   * Client-side grouping for multi-heir vaults (variant 4 from the
   * design discussion: N parallel vaults that share the same owner
   * xpub but have different heirs). All vaults created in a single
   * setup-wizard run share the same `groupId`; the Dashboard groups
   * vaults by it so the owner sees one card per group rather than N
   * separate vaults.
   *
   * Optional — single-heir vaults (the historical case) omit it,
   * and the Dashboard treats `undefined` as "this vault is its own
   * group of one." A future server-side `vault_groups` table would
   * replace this localStorage-only field; until then, the group
   * concept exists only on the device that did the setup. Other
   * devices that recover the vaults via password sign-in see each
   * vault individually.
   */
  groupId?: string;
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

/**
 * Remove a vault's local metadata. If it was the active vault, the
 * caller is responsible for picking a new active id (e.g. switch to
 * a sibling in a multi-heir group). Returns `true` if a row was
 * removed.
 */
export function removeVaultMeta(id: string): boolean {
  const map = readAll();
  if (!(id in map)) return false;
  delete map[id];
  writeAll(map);
  if (getActiveVaultId() === id) setActiveVaultId(null);
  return true;
}

/**
 * Return every vault sharing the given `groupId`, in stable creation
 * order. Used by the Dashboard to render a multi-heir group as one
 * card. A `groupId` of `undefined` (or a group that no longer has
 * any members) returns an empty array.
 */
export function getVaultsByGroup(groupId: string | null | undefined): VaultMeta[] {
  if (!groupId) return [];
  const all = readAll();
  return Object.values(all)
    .filter((v) => v.groupId === groupId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Look up the groupId of a vault by its id. Returns null if the
 * vault doesn't exist on this device, or if it has no groupId (i.e.
 * a legacy single-heir vault).
 */
export function getGroupIdForVault(id: string): string | null {
  return readAll()[id]?.groupId ?? null;
}
