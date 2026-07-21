/**
 * Authenticated encryption for vault secrets.
 *
 * Two consumers, same primitives:
 *
 *   1. Owner key sealing — at setup time the browser derives a KEK
 *      from the user's chosen password (Argon2id, ~64MiB) and seals
 *      the owner's xprv + the server-issued owner_token with it.
 *      The owner ciphertext goes to the server. The server cannot open
 *      that owner blob without the password the user typed.
 *
 *   2. Heir key sealing — at setup time the browser derives a second
 *      KEK from the *raw claim token* (HKDF-SHA256), seals the heir's
 *      xprv with it, and ships that ciphertext to the server too.
 *      Door A also stores the claim token encrypted under the server's
 *      production master key so the scheduler can later deliver it.
 *      A DB-only leak cannot open this blob, but DB + master key can
 *      recover the token and therefore the heir xprv immediately.
 *      The CSV timelock still prevents spending until it matures.
 *
 *      When the heir clicks the link, their browser reads the token
 *      from the URL fragment, then uses it in token-authenticated API
 *      paths to fetch the sealed blob. It unwraps the heir xprv locally
 *      and POSTs both the destination address and xprv to the claim
 *      endpoint. The server uses the xprv only in memory to sign the
 *      BDK-built PSBT, broadcasts, and discards it. The xprv is never
 *      written to disk or application logs.
 *
 *      Why does the heir's xprv touch the server at all? Two reasons:
 *      (a) the server already has the Esplora connection, the BDK
 *      wallet, and the proven script-path PSBT builder — re-implementing
 *      Taproot script-path signing in the browser is a security
 *      footgun we don't need; (b) by the time this transit happens,
 *      the on-chain timelock has fully matured — meaning *only the
 *      heir's key* can spend, so even a hostile server can't redirect
 *      funds without leaving a public trail at a Bitcoin address
 *      nobody else can produce.
 *
 * Cipher: XChaCha20-Poly1305 (24-byte nonce, 16-byte tag). Same family
 * the server uses today for heir contacts (`crates/ghostkey-server/
 * src/crypto.rs`) so any future cross-validation is straightforward.
 *
 * KDF for password sealing: Argon2id, m=64MiB, t=3, p=1. Tuned for
 * ~2.5–3.5s on a 2020-era mid-range phone. We accept that latency as
 * the cost of pushing brute-force from "trivial" to "expensive on a
 * GPU farm." Anything stronger gets us into "user thinks the page
 * froze" territory. The sealed owner blob is retrievable by anyone
 * who knows the vault id (cross-device recovery is unauthenticated by
 * design; see threat-model R5), so this cost is the main thing
 * standing between a leaked email + weak password and the owner key —
 * we lean it as slow as the UX budget allows.
 *
 * Forward-compatible: every sealed blob stores its own
 * `password_kdf_iters`/`_mem_kib`, and unseal reads them back, so
 * raising this only affects newly-created (or re-sealed) vaults;
 * existing vaults keep opening with the parameters they were made
 * with. No migration.
 *
 * KDF for claim-token sealing: HKDF-SHA256. The token is already
 * 256 bits of CSPRNG output; we do not need a slow KDF — only domain
 * separation so the same token isn't reused as a key elsewhere.
 *
 * Versioning: every sealed blob carries an explicit `v: 1` so we can
 * migrate KDF parameters later without bricking existing vaults.
 */
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { argon2idAsync } from "@noble/hashes/argon2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";

/** Wire format for sealed bytes. Base64 everywhere so it round-trips
 *  through JSON without encoding gymnastics. */
export interface SealedBlob {
  v: 1;
  /** XChaCha20-Poly1305 ciphertext (includes 16-byte tag), base64. */
  ct: string;
  /** 24-byte nonce, base64. */
  nonce: string;
}

/** Encrypted blobs the browser ships to the server at setup time. */
export interface SealedVaultSecrets {
  /** Argon2id salt, base64. 16 bytes. */
  password_salt: string;
  /** Argon2id memory cost in KiB. Stored so we can change defaults
   *  later without breaking old vaults. */
  password_kdf_mem_kib: number;
  /** Argon2id iteration count. */
  password_kdf_iters: number;

  /** Owner's account xprv, sealed under password-derived KEK. */
  owner_xprv: SealedBlob;
  /** Server-issued owner_token, sealed under the same KEK. Lets the
   *  owner recover their bearer credential on any device from
   *  email+password. */
  owner_token: SealedBlob;
  /** Heir's account xprv, sealed under HKDF(claim_token). Door A stores
   *  that token reversibly under the server master key for later delivery;
   *  Door B sends no heir xprv or setup-time claim token to the server. */
  heir_xprv: SealedBlob;
}

const ARGON_MEM_KIB = 64 * 1024; // 64 MiB
const ARGON_ITERS = 3;
const ARGON_PARALLELISM = 1;
const KEK_LEN = 32;
const NONCE_LEN = 24;

/* ---------------------- base64 helpers ----------------------------- */

export function b64encode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function b64decode(s: string): Uint8Array {
  // Tolerate base64url as well as standard base64. Our own seals use
  // standard base64 (b64encode → btoa), but a claim token can arrive in
  // either form: browser-minted tokens are standard base64, while a
  // server-minted token (mint_bearer_token) is base64url-no-pad. `atob`
  // only accepts standard base64, so normalise first — otherwise a
  // perfectly valid token crashes the claim with a cryptic atob error.
  let norm = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = norm.length % 4;
  if (pad === 2) norm += "==";
  else if (pad === 3) norm += "=";
  const bin = atob(norm);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ---------------------- core seal/open ----------------------------- */

/**
 * Seal arbitrary bytes under a 32-byte key, returning the standard
 * `SealedBlob` wire format. Exported so callers (e.g. the setup portal)
 * can keep a KEK in memory across multiple seals without having to
 * re-derive it.
 */
export function sealWithKey(key: Uint8Array, plaintext: Uint8Array): SealedBlob {
  if (key.length !== KEK_LEN) {
    throw new Error(`KEK must be ${KEK_LEN} bytes, got ${key.length}`);
  }
  const nonce = randomBytes(NONCE_LEN);
  const ct = xchacha20poly1305(key, nonce).encrypt(plaintext);
  return {
    v: 1,
    ct: b64encode(ct),
    nonce: b64encode(nonce),
  };
}

export function openWithKey(key: Uint8Array, blob: SealedBlob): Uint8Array {
  if (blob.v !== 1) {
    throw new Error(`unknown sealed blob version: ${blob.v}`);
  }
  if (key.length !== KEK_LEN) {
    throw new Error(`KEK must be ${KEK_LEN} bytes, got ${key.length}`);
  }
  const nonce = b64decode(blob.nonce);
  const ct = b64decode(blob.ct);
  return xchacha20poly1305(key, nonce).decrypt(ct);
}

/* ---------------------- password KDF ------------------------------- */

const PASSWORD_INFO = "ghostkey:owner-kek:v1";

/**
 * Derive the KEK that wraps the owner's xprv. Slow by design.
 *
 * Pass `onProgress` to drive a progress indicator — Argon2id is
 * partition-friendly so @noble/hashes can yield checkpoints.
 */
export async function deriveOwnerKek(
  password: string,
  salt: Uint8Array,
  opts: { memKiB?: number; iters?: number; onProgress?: (pct: number) => void } = {},
): Promise<Uint8Array> {
  const memKiB = opts.memKiB ?? ARGON_MEM_KIB;
  const iters = opts.iters ?? ARGON_ITERS;
  const pwBytes = new TextEncoder().encode(password.normalize("NFKC"));

  // argon2idAsync yields between mixing rounds via setTimeout, so the
  // calling component can render a spinner / progress bar while the
  // KDF runs. Synchronous argon2id would block the main thread for
  // the full 1-3s.

  const raw = await argon2idAsync(pwBytes, salt, {
    t: iters,
    m: memKiB,
    p: ARGON_PARALLELISM,
    dkLen: KEK_LEN,
    onProgress: opts.onProgress,
  });

  // Domain-separate one more time so the same Argon2 output can't be
  // re-purposed as a key elsewhere by accident.
  return hkdf(sha256, raw, salt, new TextEncoder().encode(PASSWORD_INFO), KEK_LEN);
}

/* ---------------------- claim-token KDF ---------------------------- */

const CLAIM_INFO = "ghostkey:heir-xprv-kek:v1";

/**
 * Derive the KEK that wraps the heir's xprv from the raw claim token.
 * The token is already 256 bits of CSPRNG output (see the server's
 * `issue_claim_token`); HKDF here is purely for domain separation.
 */
export function deriveClaimKek(claimTokenRaw: Uint8Array): Uint8Array {
  // Empty salt is fine for HKDF when the input is already uniform.
  return hkdf(
    sha256,
    claimTokenRaw,
    new Uint8Array(0),
    new TextEncoder().encode(CLAIM_INFO),
    KEK_LEN,
  );
}

/* ---------------------- public sealing API ------------------------- */

export interface SealAllInput {
  password: string;
  ownerXprv: string;
  heirXprv: string;
  ownerToken: string;
  claimTokenRaw: Uint8Array;
  onProgress?: (pct: number) => void;
  /**
   * When true, the returned object carries `_owner_kek` — a 32-byte
   * scratch copy of the password-derived KEK. Callers that need to
   * seal more data with the same key (e.g. re-sealing the real
   * owner_token after vault creation) should pass `true` and then
   * `wipe()` the field as soon as they're done with it.
   *
   * Default false. The internal KEK is wiped before return when this
   * is false so an accidental retention of the result object cannot
   * leak the key.
   */
  keepOwnerKek?: boolean;
}

export async function sealVaultSecrets(
  input: SealAllInput,
): Promise<SealedVaultSecrets & { _owner_kek?: Uint8Array }> {
  const enc = new TextEncoder();
  const salt = randomBytes(16);
  const kek = await deriveOwnerKek(input.password, salt, {
    onProgress: input.onProgress,
  });
  const claimKek = deriveClaimKek(input.claimTokenRaw);

  const owner_xprv = sealWithKey(kek, enc.encode(input.ownerXprv));
  const owner_token = sealWithKey(kek, enc.encode(input.ownerToken));
  const heir_xprv = sealWithKey(claimKek, enc.encode(input.heirXprv));

  // Always wipe the claim KEK — caller never needs it again.
  claimKek.fill(0);

  const out: SealedVaultSecrets & { _owner_kek?: Uint8Array } = {
    password_salt: b64encode(salt),
    password_kdf_mem_kib: ARGON_MEM_KIB,
    password_kdf_iters: ARGON_ITERS,
    owner_xprv,
    owner_token,
    heir_xprv,
  };

  if (input.keepOwnerKek) {
    // Hand the caller a fresh copy so they own the buffer and can
    // wipe it on their schedule.
    out._owner_kek = new Uint8Array(kek);
  }
  // Wipe our copy unconditionally.
  kek.fill(0);

  return out;
}

/** Result of sealing one secret under a password: the ciphertext plus
 *  the KDF parameters a reader needs to re-derive the same KEK. Shaped
 *  to drop straight into a recovery-kit data blob. */
export interface PasswordSealed {
  password_salt_b64: string;
  password_kdf_mem_kib: number;
  password_kdf_iters: number;
  blob: SealedBlob;
}

/**
 * Seal one secret under a fresh password-derived KEK (Argon2id), the
 * same primitives the owner kit uses. Used by the heir envelope, which
 * seals the heir's xprv under a one-off passphrase the owner keeps with
 * the file. The KEK is wiped before return.
 */
export async function sealUnderPassword(
  password: string,
  plaintext: Uint8Array,
  onProgress?: (pct: number) => void,
): Promise<PasswordSealed> {
  const salt = randomBytes(16);
  const kek = await deriveOwnerKek(password, salt, { onProgress });
  try {
    return {
      password_salt_b64: b64encode(salt),
      password_kdf_mem_kib: ARGON_MEM_KIB,
      password_kdf_iters: ARGON_ITERS,
      blob: sealWithKey(kek, plaintext),
    };
  } finally {
    kek.fill(0);
  }
}

export interface UnsealOwnerInput {
  password: string;
  passwordSalt: string;
  memKiB: number;
  iters: number;
  ownerXprvBlob: SealedBlob;
  ownerTokenBlob: SealedBlob;
  onProgress?: (pct: number) => void;
}

export interface UnsealedOwner {
  ownerXprv: string;
  ownerToken: string;
}

export async function unsealOwner(input: UnsealOwnerInput): Promise<UnsealedOwner> {
  const salt = b64decode(input.passwordSalt);
  const kek = await deriveOwnerKek(input.password, salt, {
    memKiB: input.memKiB,
    iters: input.iters,
    onProgress: input.onProgress,
  });

  try {
    const dec = new TextDecoder();
    const xprv = dec.decode(openWithKey(kek, input.ownerXprvBlob));
    const token = dec.decode(openWithKey(kek, input.ownerTokenBlob));
    return { ownerXprv: xprv, ownerToken: token };
  } finally {
    kek.fill(0);
  }
}

/** Unlock only the owner bearer token cached for a trusted-device session. */
export async function unsealOwnerToken(input: {
  password: string;
  passwordSalt: string;
  memKiB: number;
  iters: number;
  ownerTokenBlob: SealedBlob;
  onProgress?: (pct: number) => void;
}): Promise<string> {
  const salt = b64decode(input.passwordSalt);
  const kek = await deriveOwnerKek(input.password, salt, {
    memKiB: input.memKiB,
    iters: input.iters,
    onProgress: input.onProgress,
  });
  try {
    return new TextDecoder().decode(openWithKey(kek, input.ownerTokenBlob));
  } finally {
    kek.fill(0);
  }
}

/**
 * Unseal the heir's xprv from the raw claim token + the sealed blob
 * the server hands the heir's browser at claim time.
 */
export function unsealHeirXprv(claimTokenRaw: Uint8Array, blob: SealedBlob): string {
  const kek = deriveClaimKek(claimTokenRaw);
  try {
    return new TextDecoder().decode(openWithKey(kek, blob));
  } finally {
    kek.fill(0);
  }
}

/* ---------------------- email hashing ------------------------------ */

/**
 * Stable, lower-cased, hex SHA-256 of an email for `find-my-vault`
 * lookup. Hashing client-side means the server's `vaults_by_email`
 * index never sees a plaintext email, even in logs. Not a perfect
 * privacy story (it's a deterministic hash, so a dictionary attack
 * could enumerate common emails), but materially better than storing
 * the plaintext alongside the encrypted blobs.
 */
export function hashEmailForLookup(email: string): string {
  const normalised = email.trim().toLowerCase().normalize("NFKC");
  const digest = sha256(new TextEncoder().encode(normalised));
  return Array.from(digest)
    .map((b: number) => b.toString(16).padStart(2, "0"))
    .join("");
}
