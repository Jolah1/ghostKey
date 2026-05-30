/**
 * F2: heir key derivation in the browser.
 *
 * When a vault was created with `heir_derivation`, the server derived
 * the heir's BIP86 xpub deterministically from
 *
 *   vault_secret = HKDF-SHA256(salt = master_key,   IKM = vault_id,   info = "ghostkey-heir-v1-secret")
 *   heir_entropy = HKDF-SHA256(salt = vault_secret, IKM = email_norm, info = "ghostkey-heir-bip39")[..16]
 *   mnemonic     = BIP39(heir_entropy)
 *   seed         = PBKDF2(mnemonic, "mnemonic", 2048, SHA512)
 *   account_xpub = BIP32(seed).derive("m/86'/coin'/0'")
 *
 * The heir's browser knows `vault_secret` (fetched after email auth)
 * and the heir's own email — enough to recompute the entire chain and
 * recover the matching xprv. The server NEVER sees this xprv.
 *
 * This module is the JS counterpart to
 * `crates/ghostkey-core/src/keys.rs::derive_heir_seed`. The two
 * implementations must stay byte-for-byte identical; a covering unit
 * test on the Rust side pins the derivation contract.
 */
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { entropyToMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { HDKey } from "@scure/bip32";
import type { Network } from "./keygen";

const HEIR_BIP39_INFO = utf8("ghostkey-heir-bip39");

export interface DerivedHeirKey {
  /** 12-word BIP39 mnemonic. Show this to the heir so they can stash
   *  it; we won't show it again. */
  mnemonic: string;
  /** Account-level xprv at `m/86'/coin'/0'`, base58. Ship this to the
   *  server's heir-claim endpoint; the server uses it once, in memory
   *  only, then drops it. */
  xprvBase58: string;
}

/**
 * Recompute the heir's BIP86 account key.
 *
 * `vaultSecretHex` is the 32-byte HKDF output the server returns from
 * `GET /claim/:token/heir-derivation-params`; treat it as a transient
 * secret in scope for this call only.
 *
 * `heirEmail` MUST be the address the owner typed during setup — we
 * lower-case + trim it here to match `normalize_heir_email` on the
 * server side. The heir's browser already echoes the email back from
 * the server, so this is just defence in depth against the heir typing
 * their email differently at claim time.
 */
export function deriveHeirKey(
  vaultSecretHex: string,
  heirEmail: string,
  network: Network,
): DerivedHeirKey {
  const vaultSecret = hexToBytes(vaultSecretHex);
  if (vaultSecret.length !== 32) {
    throw new Error(
      `vault_secret must be 32 bytes, got ${vaultSecret.length}`,
    );
  }
  const normalized = heirEmail.trim().toLowerCase();
  if (!normalized) {
    throw new Error("heir email is empty");
  }

  // 32-byte HKDF output; we only consume the first 16 (128-bit entropy
  // → 12 words). The server discards the remaining 16 the same way.
  const okm = hkdf(
    sha256,
    utf8(normalized),
    vaultSecret,
    HEIR_BIP39_INFO,
    32,
  );
  const entropy = okm.slice(0, 16);
  const mnemonic = entropyToMnemonic(entropy, wordlist);
  const seed = mnemonicToSeedSync(mnemonic);

  const versions = bip32Versions(network);
  const master = HDKey.fromMasterSeed(seed, versions);
  const account = master.derive(`m/86'/${coinType(network)}'/0'`);
  if (!account.privateExtendedKey) {
    throw new Error("derivation produced no private key");
  }
  return {
    mnemonic,
    xprvBase58: account.privateExtendedKey,
  };
}

/* ------------------------------ helpers ------------------------------ */

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) {
    throw new Error(`vault_secret hex has odd length: ${clean.length}`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(clean.slice(2 * i, 2 * i + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error(`invalid hex at position ${i}`);
    }
    out[i] = byte;
  }
  return out;
}

function bip32Versions(network: Network) {
  if (network === "bitcoin") {
    return { private: 0x0488ade4, public: 0x0488b21e };
  }
  return { private: 0x04358394, public: 0x043587cf };
}

function coinType(network: Network): number {
  return network === "bitcoin" ? 0 : 1;
}
