/**
 * The heir code (option a): five everyday words that lock the heir's key.
 *
 * The owner's browser makes the code at setup, locks the heir's key with
 * it (Argon2id, the same scheme as the heir file) and shows it once, on
 * the heir card. Only the owner and the heir ever know it. GhostKey keeps
 * the locked key and hands it over only after the owner has gone quiet,
 * so neither GhostKey alone nor the heir alone can open it early.
 *
 * The same code opens the offline heir file, so there is one thing for
 * the family to keep, not two.
 */
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import {
  b64decode,
  b64encode,
  deriveClaimKek,
  deriveOwnerKek,
  openWithKey,
  sealWithKey,
  type PasswordSealed,
  type SealedBlob,
} from "./sealing";
import type { HeirCodeSealBody, HeirCodeUpgradeBody, HeirCodeUpgradeKit } from "../api";

export const HEIR_CODE_WORDS = 5;
const WORDS = new Set(wordlist);

/**
 * A fresh code: five words from the BIP39 English list, hyphen-joined
 * (~55 bits, hardened by Argon2id). Rejection sampling keeps every word
 * equally likely.
 */
export function generateHeirCode(words = HEIR_CODE_WORDS): string {
  const n = wordlist.length; // 2048
  const max = Math.floor(0x100000000 / n) * n;
  const out: string[] = [];
  const buf = new Uint32Array(1);
  while (out.length < words) {
    crypto.getRandomValues(buf);
    if (buf[0] >= max) continue;
    out.push(wordlist[buf[0] % n]);
  }
  return out.join("-");
}

/**
 * What someone typed, in the one form the key was locked with: lower
 * case, words joined by hyphens. Spaces, commas, new lines and extra
 * hyphens all count as gaps, so "River  Candle, mango" works.
 */
export function normalizeHeirCode(input: string): string {
  return input
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean)
    .join("-");
}

/** True when the input is five words that are all on the list. */
export function looksLikeHeirCode(input: string): boolean {
  const words = normalizeHeirCode(input).split("-").filter(Boolean);
  return words.length === HEIR_CODE_WORDS && words.every((w) => WORDS.has(w));
}

/** The code for people to read and copy: words separated by spaces. */
export function heirCodeForDisplay(code: string): string {
  return normalizeHeirCode(code).split("-").join(" ");
}

/** How the server says the heir's key was locked. */
export interface HeirCodeKdf {
  salt_b64: string;
  kdf_mem_kib: number;
  kdf_iters: number;
  /** The check phrase sealed under the code's check key (see
   *  `checkHeirCode`). Absent only where the caller doesn't need it. */
  check_ct_b64?: string;
  check_nonce_b64?: string;
}

const CHECK_PHRASE = "ghostkey heir code check v1";

/** A key from the code key that can only open the check phrase. */
function heirCheckKey(codeKek: Uint8Array): Uint8Array {
  return hkdf(sha256, codeKek, new Uint8Array(0), new TextEncoder().encode("ghostkey/heir-code-check/v1"), 32);
}

/** Seal the check phrase, so a typed code can be tested later without
 *  touching the heir's key (the practice run). */
export function sealHeirCheck(codeKek: Uint8Array): SealedBlob {
  const key = heirCheckKey(codeKek);
  try {
    return sealWithKey(key, new TextEncoder().encode(CHECK_PHRASE));
  } finally {
    key.fill(0);
  }
}

/**
 * Is this the right code? Opens the check phrase with the code's key.
 * Throws when it's wrong. Never touches the heir's Bitcoin key.
 */
export function checkHeirCode(codeKek: Uint8Array, check: { ct_b64: string; nonce_b64: string }): void {
  const key = heirCheckKey(codeKek);
  try {
    const phrase = new TextDecoder().decode(
      openWithKey(key, { v: 1, ct: check.ct_b64, nonce: check.nonce_b64 }),
    );
    if (phrase !== CHECK_PHRASE) throw new Error("heir code check phrase mismatch");
  } finally {
    key.fill(0);
  }
}

const DEFAULT_KDF = { memKiB: 64 * 1024, iters: 3 };

/** The code's key: Argon2id(code, salt), the same KDF as the password. */
export function deriveHeirCodeKek(
  code: string,
  kdf: HeirCodeKdf,
  onProgress?: (pct: number) => void,
): Promise<Uint8Array> {
  return deriveOwnerKek(normalizeHeirCode(code), b64decode(kdf.salt_b64), {
    memKiB: kdf.kdf_mem_kib,
    iters: kdf.kdf_iters,
    onProgress,
  });
}

/**
 * The key that locks the owner's video message on an heir-code vault,
 * derived from the code's key (domain-separated, so it can't open the
 * heir's Bitcoin key). The heir can watch the video during the waiting
 * period with just the code; the Bitcoin key stays withheld until then.
 */
export function heirVideoKey(codeKek: Uint8Array): Uint8Array {
  return hkdf(sha256, codeKek, new Uint8Array(0), new TextEncoder().encode("ghostkey/heir-video/v1"), 32);
}

/** Lock the heir's key with the code (a fresh salt, one Argon2id pass). */
export async function sealHeirXprvUnderCode(
  code: string,
  heirXprv: string,
  onProgress?: (pct: number) => void,
): Promise<PasswordSealed> {
  const { sealed, codeKek } = await sealWithFreshCodeKek(code, heirXprv, onProgress);
  codeKek.fill(0);
  return sealed;
}

async function sealWithFreshCodeKek(
  code: string,
  heirXprv: string,
  onProgress?: (pct: number) => void,
): Promise<{ sealed: PasswordSealed; codeKek: Uint8Array }> {
  const kdf: HeirCodeKdf = {
    salt_b64: b64encode(randomBytes(16)),
    kdf_mem_kib: DEFAULT_KDF.memKiB,
    kdf_iters: DEFAULT_KDF.iters,
  };
  const codeKek = await deriveHeirCodeKek(code, kdf, onProgress);
  return {
    codeKek,
    sealed: {
      password_salt_b64: kdf.salt_b64,
      password_kdf_mem_kib: kdf.kdf_mem_kib,
      password_kdf_iters: kdf.kdf_iters,
      blob: sealWithKey(codeKek, new TextEncoder().encode(heirXprv)),
    },
  };
}

/**
 * Open the heir's key with the code's key. Throws when the code was
 * wrong (the AEAD check fails), so the page can say so plainly.
 */
export function openHeirXprv(codeKek: Uint8Array, blob: SealedBlob): string {
  return new TextDecoder().decode(openWithKey(codeKek, blob));
}

/** A freshly locked heir key: the code to show on the heir card, the
 *  locked key (which also goes into the heir file), and the fields the
 *  server stores. */
export interface HeirKeyLock {
  code: string;
  sealed: PasswordSealed;
  /** For sealing a video message right away. The caller wipes it. */
  videoKey: Uint8Array;
  heir_xprv_ct_b64: string;
  heir_xprv_nonce_b64: string;
  heir_code: HeirCodeSealBody;
}

/**
 * Make an heir code and lock the heir's key with it. The code is also
 * sealed under the owner's password key (`ownerKek`, already derived for
 * the owner's own blobs), so the owner can show it again later. Nothing
 * returned for the server can open the heir key.
 */
export async function lockHeirKey(
  heirXprv: string,
  ownerKek: Uint8Array,
  onProgress?: (pct: number) => void,
): Promise<HeirKeyLock> {
  const code = generateHeirCode();
  const { sealed, codeKek } = await sealWithFreshCodeKek(code, heirXprv, onProgress);
  const videoKey = heirVideoKey(codeKek);
  const check = sealHeirCheck(codeKek);
  codeKek.fill(0);
  const ownerCopy = sealWithKey(ownerKek, new TextEncoder().encode(code));
  return {
    code,
    sealed,
    videoKey,
    heir_xprv_ct_b64: sealed.blob.ct,
    heir_xprv_nonce_b64: sealed.blob.nonce,
    heir_code: {
      salt_b64: sealed.password_salt_b64,
      kdf_mem_kib: sealed.password_kdf_mem_kib,
      kdf_iters: sealed.password_kdf_iters,
      owner_ct_b64: ownerCopy.ct,
      owner_nonce_b64: ownerCopy.nonce,
      check_ct_b64: check.ct,
      check_nonce_b64: check.nonce,
    },
  };
}

/** Open the owner's sealed copy of the code (Settings, "show the code"). */
export function openOwnerHeirCode(ownerKek: Uint8Array, blob: SealedBlob): string {
  return new TextDecoder().decode(openWithKey(ownerKek, blob));
}

/** The password didn't open this vault. */
export class WrongOwnerPasswordError extends Error {
  constructor() {
    super("That password doesn't match this vault.");
    this.name = "WrongOwnerPasswordError";
  }
}

/**
 * Move an older vault to an heir code, in this browser. Checks the
 * password (it must open the owner's own key), opens the heir key and the
 * video with the kept link secret, and locks both again with a fresh heir
 * code. Returns what the server stores, and the code for the heir card.
 */
export async function relockWithHeirCode(input: {
  password: string;
  owner: {
    password_salt_b64: string;
    password_kdf_mem_kib: number;
    password_kdf_iters: number;
    owner_xprv_ct_b64: string;
    owner_xprv_nonce_b64: string;
  };
  kit: HeirCodeUpgradeKit;
  onProgress?: (pct: number) => void;
}): Promise<{ body: HeirCodeUpgradeBody; code: string }> {
  const { owner, kit } = input;
  const ownerKek = await deriveOwnerKek(input.password, b64decode(owner.password_salt_b64), {
    memKiB: owner.password_kdf_mem_kib,
    iters: owner.password_kdf_iters,
    onProgress: input.onProgress ? (p) => input.onProgress!(p / 2) : undefined,
  });
  const linkKek = deriveClaimKek(b64decode(kit.claim_token_b64));
  let lock: HeirKeyLock | undefined;
  try {
    try {
      openWithKey(ownerKek, { v: 1, ct: owner.owner_xprv_ct_b64, nonce: owner.owner_xprv_nonce_b64 });
    } catch {
      throw new WrongOwnerPasswordError();
    }
    const heirXprv = new TextDecoder().decode(
      openWithKey(linkKek, { v: 1, ct: kit.heir_xprv_ct_b64, nonce: kit.heir_xprv_nonce_b64 }),
    );
    lock = await lockHeirKey(
      heirXprv,
      ownerKek,
      input.onProgress ? (p) => input.onProgress!(0.5 + p / 2) : undefined,
    );
    let video: { video_ct_b64: string; video_nonce_b64: string } | undefined;
    if (kit.video) {
      const clip = openWithKey(linkKek, { v: 1, ct: kit.video.video_ct_b64, nonce: kit.video.video_nonce_b64 });
      const relocked = sealWithKey(lock.videoKey, clip);
      video = { video_ct_b64: relocked.ct, video_nonce_b64: relocked.nonce };
    }
    return {
      body: {
        heir_xprv_ct_b64: lock.heir_xprv_ct_b64,
        heir_xprv_nonce_b64: lock.heir_xprv_nonce_b64,
        heir_code: lock.heir_code,
        ...(video ? { video } : {}),
      },
      code: lock.code,
    };
  } finally {
    ownerKek.fill(0);
    linkKek.fill(0);
    lock?.videoKey.fill(0);
  }
}
