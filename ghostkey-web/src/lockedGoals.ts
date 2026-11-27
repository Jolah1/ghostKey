/**
 * Locked goals: savings nobody can spend before a date, not even GhostKey.
 *
 * Each one is its own vault, made from the owner's existing key, with two
 * dated branches in its script: the owner can spend from the unlock date,
 * and the heir branch opens 3 to 12 months later. A new locked goal starts
 * savings-only: its heir branch holds a spare key sealed under the owner's
 * password, the same as a vault whose heir is chosen later, so the owner
 * can pass it on afterwards with the usual "choose who inherits" step.
 */
import { api } from "./api";
import type { Network } from "./crypto/keygen";
import { getVaultMeta, getVaultOwnerToken, saveVaultMeta } from "./vaultStore";

export const LOCK_MONTHS = [3, 6, 12] as const;

/** Session keys pages pass to each other: which plan to show, the name
 *  "Lock it again" starts with, and the goal Send sends from. */
export const PLAN_KEY = "gk:planId";
export const LOCK_TITLE_KEY = "gk:lockTitle";
export const SEND_FROM_KEY = "gk:sendFrom";

/** "27 May 2027". */
export function dateWords(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}
export type LockMonths = (typeof LOCK_MONTHS)[number];

const DAY = 86_400;

/** The unlock date `months` from `now`, and the heir's date after it: the
 *  parent vault's own wait, kept within the 3-12 months the server takes.
 *  Demo servers lock for minutes. */
export function lockDates(
  months: number,
  parentTimelockBlocks: number,
  demo: boolean,
  now: Date = new Date(),
): { owner_after: number; heir_after: number } {
  const nowS = Math.floor(now.getTime() / 1000);
  if (demo) return { owner_after: nowS + months * 120, heir_after: nowS + months * 120 + 300 };
  const d = new Date(now);
  d.setMonth(d.getMonth() + months);
  const owner = Math.floor(d.getTime() / 1000);
  const wait = Math.min(365 * DAY, Math.max(90 * DAY, parentTimelockBlocks * 600));
  return { owner_after: owner, heir_after: owner + wait };
}

/**
 * The network fee to unlock (or renew) a locked goal at `feeRate` sat/vB:
 * every deposit is its own coin, and spending them all costs about 54 vB
 * plus 84 vB per coin (measured on regtest for this script, #461).
 */
export function unlockFeeSats(deposits: number, feeRate: number): number {
  return Math.ceil((54 + 84 * Math.max(1, deposits)) * feeRate);
}

const PLACEHOLDER_OWNER_TOKEN = "ghostkey-placeholder-owner-token-v1";

/** Strip the `/0/*` chain step from a key fragment, leaving the
 *  origin-tagged account xpub the server takes. */
function accountXpub(fragment: string): string {
  return fragment.replace(/\/\d+\/\*$/, "");
}

export class WrongPassword extends Error {}

/**
 * Make a locked goal from `parentId`'s owner key. Unlocks the key with the
 * password (in this browser), seals a spare heir key, asks the server to
 * build the dated vault, and saves it on this device.
 */
export async function createLockedGoal(opts: {
  parentId: string;
  password: string;
  title: string;
  months: LockMonths;
  demo: boolean;
  onProgress?: (pct: number) => void;
}): Promise<{ id: string; until: number; heirAt: number }> {
  // Loaded here, not at the top: Home imports this file for its plan
  // list and shouldn't carry the key code.
  const [{ generateParty }, { hashEmailForLookup, sealVaultSecretsHeirLater, sealWithKey, unsealOwner }] =
    await Promise.all([import("./crypto/keygen"), import("./crypto/sealing")]);
  const parent = getVaultMeta(opts.parentId);
  const token = getVaultOwnerToken(opts.parentId);
  if (!parent || !token) throw new Error("Sign in again, then lock a goal.");
  const [blobs, vault] = await Promise.all([
    api.getSealedBlobs(opts.parentId, token),
    api.getVault(opts.parentId, token),
  ]);
  if (!blobs.owner_xpub_fragment_external) {
    throw new Error("This vault is too old to lock goals from. Set up a new one to use them.");
  }

  let ownerXprv: string;
  try {
    const unsealed = await unsealOwner({
      password: opts.password,
      passwordSalt: blobs.password_salt_b64,
      memKiB: blobs.password_kdf_mem_kib,
      iters: blobs.password_kdf_iters,
      ownerXprvBlob: { v: 1, ct: blobs.owner_xprv_ct_b64, nonce: blobs.owner_xprv_nonce_b64 },
      ownerTokenBlob: { v: 1, ct: blobs.owner_token_ct_b64, nonce: blobs.owner_token_nonce_b64 },
      onProgress: (p) => opts.onProgress?.(Math.round(p * 50)),
    });
    ownerXprv = unsealed.ownerXprv;
  } catch {
    throw new WrongPassword("That password didn't unlock your vault.");
  }

  const network = vault.network as Network;
  const spareHeir = generateParty(network);
  const sealed = await sealVaultSecretsHeirLater({
    password: opts.password,
    ownerXprv,
    heirXprv: spareHeir.xprv,
    ownerToken: PLACEHOLDER_OWNER_TOKEN,
    onProgress: (p) => opts.onProgress?.(50 + Math.round(p * 50)),
  });
  const dates = lockDates(opts.months, vault.timelock_blocks, opts.demo);
  const ownerEmail = parent.owner.address;
  const resp = await api.createVaultFromXpub({
    label: opts.title,
    network: vault.network,
    owner: { xpub: accountXpub(blobs.owner_xpub_fragment_external) },
    heir: { xpub: spareHeir.xpub, fingerprint: spareHeir.fingerprint },
    timelock_blocks: vault.timelock_blocks,
    checkin_period_secs: vault.checkin_period_secs,
    grace_period_secs: vault.grace_period_secs,
    owner_contact: ownerEmail,
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
      owner_email_hash: hashEmailForLookup(ownerEmail),
      heir_xprv_owner_ct_b64: sealed.heir_xprv_owner.ct,
      heir_xprv_owner_nonce_b64: sealed.heir_xprv_owner.nonce,
    },
    trusted_contact: null,
    trusted_contact_channel: null,
    from_name: null,
    heir_note: null,
    locked: dates,
  });

  // The real owner token, sealed under the password, so another device can
  // open this goal too. Best effort, as for every other vault.
  let tokenLock: { v: 1; ct: string; nonce: string } | undefined;
  try {
    tokenLock = sealWithKey(sealed._owner_kek, new TextEncoder().encode(resp.owner_token));
    await api.sealOwnerToken(resp.id, resp.owner_token, {
      owner_token_ct_b64: tokenLock.ct,
      owner_token_nonce_b64: tokenLock.nonce,
    });
  } catch {
    tokenLock = undefined;
  }

  saveVaultMeta({
    id: resp.id,
    label: opts.title,
    owner: { address: ownerEmail },
    heir: { name: "", email: "", address: "" },
    createdAt: new Date().toISOString(),
    ownerToken: resp.owner_token,
    ownerTokenLock: tokenLock
      ? {
          passwordSalt: sealed.password_salt,
          memKiB: sealed.password_kdf_mem_kib,
          iters: sealed.password_kdf_iters,
          ownerTokenBlob: tokenLock,
          ownerEmailHash: hashEmailForLookup(ownerEmail),
          validated: true,
        }
      : undefined,
    locked: { parentId: opts.parentId, title: opts.title, until: dates.owner_after, heirAt: dates.heir_after },
  });
  return { id: resp.id, until: dates.owner_after, heirAt: dates.heir_after };
}
