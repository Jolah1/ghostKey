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
 * Password-vault owner tokens live only in sessionStorage while
 * unlocked; localStorage retains their password-encrypted blob. Legacy
 * wallet vaults have no password blob, so their irreplaceable token
 * remains local until that older flow gains another safe unlock
 * mechanism.
 *
 * Why localStorage and not sessionStorage?
 *   The dashboard must remember which encrypted vault belongs to the
 *   device across visits. A password vault locks on browser restart
 *   because the live token intentionally lives only in sessionStorage,
 *   which the browser drops when the tab closes.
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

export interface LockedOwnerToken {
  passwordSalt: string;
  memKiB: number;
  iters: number;
  ownerTokenBlob: { v: 1; ct: string; nonce: string };
  ownerEmailHash: string;
  /** True only after password decryption reproduced the live bearer token. */
  validated?: boolean;
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
  /** Password-encrypted replacement retained after inactivity locking. */
  ownerTokenLock?: LockedOwnerToken;
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
/**
 * Live bearer tokens for unlocked vaults, keyed by vault id.
 *
 * sessionStorage, deliberately: the dashboard's heir switcher (and the
 * user's own F5) reloads the page, and a plain in-memory map made every
 * reload a fresh password prompt. sessionStorage survives same-tab
 * reloads but is dropped when the tab or browser closes, and the
 * inactivity lock sweeps it explicitly — so the at-rest guarantee
 * stays: localStorage only ever holds the password-encrypted blob.
 */
const LIVE_KEY = "gk:liveOwnerTokens";

function readLiveTokens(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = sessionStorage.getItem(LIVE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeLiveTokens(map: Record<string, string>) {
  try {
    if (Object.keys(map).length === 0) sessionStorage.removeItem(LIVE_KEY);
    else sessionStorage.setItem(LIVE_KEY, JSON.stringify(map));
  } catch {
    // Storage unavailable (private mode): unlocks then last until the
    // next reload instead of the next restart. Nothing breaks.
  }
}

function setLiveToken(id: string, token: string) {
  const map = readLiveTokens();
  map[id] = token;
  writeLiveTokens(map);
}

function deleteLiveToken(id: string) {
  const map = readLiveTokens();
  if (id in map) {
    delete map[id];
    writeLiveTokens(map);
  }
}

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
  if (meta.ownerToken && meta.ownerTokenLock?.validated) {
    setLiveToken(meta.id, meta.ownerToken);
    map[meta.id] = { ...meta, ownerToken: undefined };
  } else {
    map[meta.id] = meta;
  }
  writeAll(map);
  setActiveVaultId(meta.id);
}

export function getVaultMeta(id: string): VaultMeta | null {
  return readAll()[id] ?? null;
}

/** Returns the stored owner token for a vault, or null. */
export function getVaultOwnerToken(id: string): string | null {
  return readLiveTokens()[id] ?? readAll()[id]?.ownerToken ?? null;
}

export function getAllVaultMetas(): VaultMeta[] {
  return Object.values(readAll());
}

export function hasLockedVaultCredential(id: string | null): boolean {
  if (!id) return false;
  const meta = readAll()[id];
  return Boolean(meta?.ownerTokenLock && !getVaultOwnerToken(id));
}

export function hasVaultCredentialLock(id: string | null): boolean {
  if (!id) return false;
  return Boolean(readAll()[id]?.ownerTokenLock);
}

/**
 * True when this browser can attempt a local password unlock for the vault:
 * it holds either a password-encrypted blob or a still-live owner token. A
 * pre-lock vault has only the token; the sign-in flow seeds the blob from the
 * server bundle on first unlock.
 */
export function canLocalUnlock(id: string | null): boolean {
  if (!id) return false;
  const meta = readAll()[id];
  if (!meta) return false;
  return (
    Boolean(meta.ownerTokenLock) ||
    (getVaultOwnerToken(id) != null && /^.+@.+\..+$/.test(meta.owner.address.trim()))
  );
}

/** Cache a candidate encrypted token without deleting the live credential. */
export function saveVaultCredentialLock(id: string, lock: LockedOwnerToken): boolean {
  const map = readAll();
  const meta = map[id];
  if (!meta?.ownerToken) return false;
  map[id] = { ...meta, ownerTokenLock: lock };
  writeAll(map);
  return true;
}

/** Replace one usable bearer token with its password-encrypted form. */
export function lockVaultCredential(id: string, lock: LockedOwnerToken): boolean {
  const map = readAll();
  const meta = map[id];
  if (!getVaultOwnerToken(id) || !lock.validated) return false;
  deleteLiveToken(id);
  map[id] = { ...meta, ownerToken: undefined, ownerTokenLock: lock };
  writeAll(map);
  return true;
}

/** Restore a group of locally decrypted tokens in one storage write. */
export function unlockVaultCredentials(tokens: Record<string, string>): boolean {
  const map = readAll();
  for (const [id, token] of Object.entries(tokens)) {
    if (!map[id]?.ownerTokenLock || !token) return false;
  }
  const live = readLiveTokens();
  for (const [id, token] of Object.entries(tokens)) {
    live[id] = token;
    map[id] = {
      ...map[id],
      ownerToken: undefined,
      ownerTokenLock: { ...map[id].ownerTokenLock!, validated: true },
    };
  }
  writeLiveTokens(live);
  writeAll(map);
  return true;
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

/* ----------------------- trusted-device inactivity lock ------------------ */

const ACTIVITY_KEY = "gk:lastActivityAt";

/** Lock the trusted-device UI after ten minutes without interaction. */
export const SESSION_TIMEOUT_MS = 10 * 60_000;

export function touchSession() {
  try {
    localStorage.setItem(ACTIVITY_KEY, String(Date.now()));
  } catch {
    /* Browser storage unavailable: the app cannot maintain a local lock. */
  }
}

/**
 * Return whether the trusted-device UI should lock. Locking replaces usable
 * password-vault tokens with their existing password-encrypted ciphertext.
 */
export function sessionExpired(): boolean {
  if (!getActiveVaultId()) return false;
  try {
    const raw = localStorage.getItem(ACTIVITY_KEY);
    if (!raw) {
      touchSession();
      return false;
    }
    const last = Number(raw);
    if (!Number.isFinite(last)) {
      touchSession();
      return false;
    }
    return Date.now() - last >= SESSION_TIMEOUT_MS;
  } catch {
    return false;
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
  deleteLiveToken(id);
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
