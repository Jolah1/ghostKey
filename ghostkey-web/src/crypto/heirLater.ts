/**
 * Choosing an heir later.
 *
 * A vault set up without an heir still has an heir key in its descriptor
 * (the waiting period and the heir branch are part of the address), but
 * that key is sealed under the OWNER's password, not under a claim token.
 * The server can't open it and holds no claim token, so nothing it stores
 * reaches the heir branch.
 *
 * When the owner chooses someone, this browser opens the key with the
 * password, checks it really is the key in this vault's descriptor, and
 * re-seals it under a fresh claim token, exactly as setup does for an
 * heir chosen up front (Door A). The check matters: sealing the wrong key
 * would leave an heir with a link that can never claim.
 */
import { HDKey } from "@scure/bip32";
import { randomBytes } from "@noble/hashes/utils.js";
import { bip32Versions, type Network } from "./keygen";
import {
  b64decode,
  b64encode,
  deriveClaimKek,
  deriveOwnerKek,
  openWithKey,
  sealWithKey,
  type SealedBlob,
} from "./sealing";

/** The password didn't open the sealed heir key. */
export class WrongPasswordError extends Error {
  constructor() {
    super("That password doesn't match this vault.");
    this.name = "WrongPasswordError";
  }
}

/** The key opened, but it isn't the heir key in this vault's descriptor. */
export class HeirKeyMismatchError extends Error {
  constructor() {
    super("The heir key doesn't match this vault, so nothing was changed.");
    this.name = "HeirKeyMismatchError";
  }
}

/** The extended public key inside a descriptor key fragment such as
 *  `[fp/86'/0'/0']xpub.../0/*`, or null if it isn't one. */
export function xpubFromFragment(fragment: string): string | null {
  const m = /^(?:\[[0-9a-f]{8}(?:\/\d+'?)*\])?((?:xpub|tpub)[1-9A-HJ-NP-Za-km-z]+)(?:\/\d+)*\/\*$/.exec(
    fragment.trim(),
  );
  return m ? m[1] : null;
}

/** Whether `heirXprv` is the account key behind `heirFragment`. Compares
 *  the public key and chain code, so a version-byte difference can't
 *  hide a different key. */
export function heirKeyMatches(heirXprv: string, heirFragment: string, network: Network): boolean {
  const xpub = xpubFromFragment(heirFragment);
  if (!xpub) return false;
  try {
    const versions = bip32Versions(network);
    const priv = HDKey.fromExtendedKey(heirXprv, versions);
    const pub = HDKey.fromExtendedKey(xpub, versions);
    if (!priv.publicKey || !pub.publicKey || !priv.chainCode || !pub.chainCode) return false;
    return equal(priv.publicKey, pub.publicKey) && equal(priv.chainCode, pub.chainCode);
  } catch {
    return false;
  }
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export interface OwnerSealedHeir {
  passwordSalt: string;
  memKiB: number;
  iters: number;
  blob: SealedBlob;
  /** The heir branch of the descriptor, to check the opened key against. */
  heirFragment: string;
  network: Network;
}

export interface ClaimSealedHeir {
  heir_xprv_ct_b64: string;
  heir_xprv_nonce_b64: string;
  claim_token_b64: string;
}

/**
 * Open the owner-sealed heir key with the password, check it against the
 * descriptor, and re-seal it under a fresh claim token. Throws
 * `WrongPasswordError` or `HeirKeyMismatchError`; never returns a seal of
 * a key that doesn't match.
 */
export async function resealHeirForClaim(
  password: string,
  sealed: OwnerSealedHeir,
  onProgress?: (pct: number) => void,
): Promise<ClaimSealedHeir> {
  const kek = await deriveOwnerKek(password, b64decode(sealed.passwordSalt), {
    memKiB: sealed.memKiB,
    iters: sealed.iters,
    onProgress,
  });
  let heirXprv: string;
  try {
    heirXprv = new TextDecoder().decode(openWithKey(kek, sealed.blob));
  } catch {
    throw new WrongPasswordError();
  } finally {
    kek.fill(0);
  }
  if (!heirKeyMatches(heirXprv, sealed.heirFragment, sealed.network)) {
    throw new HeirKeyMismatchError();
  }
  const token = randomBytes(32);
  const claimKek = deriveClaimKek(token);
  try {
    const blob = sealWithKey(claimKek, new TextEncoder().encode(heirXprv));
    return {
      heir_xprv_ct_b64: blob.ct,
      heir_xprv_nonce_b64: blob.nonce,
      claim_token_b64: b64encode(token),
    };
  } finally {
    claimKek.fill(0);
    token.fill(0);
  }
}
