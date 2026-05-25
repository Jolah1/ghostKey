/**
 * In-browser BIP32/BIP86 key generation for vault setup.
 *
 * We never expose seed phrases to the user. The owner authenticates
 * with a password they pick at setup; their generated keys are sealed
 * with a key derived from that password and stored server-side as
 * opaque ciphertext (see ./sealing.ts).
 *
 * Why not show the owner a 12-word backup like every other wallet?
 *
 *   The product brief is "seamless onboarding, heir knows nothing
 *   until the trigger." A 12-word recovery phrase is a second secret
 *   on top of the password, which users will (a) save to the wrong
 *   place, (b) lose, (c) ask us to "reset" — defeating the trade we
 *   made by going non-custodial.
 *
 *   We pick exactly one secret: the password. The password unlocks
 *   the vault on any device. Lose the password and the timer simply
 *   runs out — the heir inherits on the schedule the owner picked.
 *   That's the honest version of "no recovery email, no support
 *   contact, no backdoor."
 *
 * The functions here are pure: in → out, no globals, no side effects.
 * That makes them easy to test and easy to keep small.
 */
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync, generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

/** Networks we support. Mirrors the server's `network` validator. */
export type Network = "bitcoin" | "testnet" | "signet" | "regtest";

/**
 * BIP32 version bytes per network. We always speak the conservative
 * `xpub`/`tpub` flavour rather than `vpub`/`zpub` so the server-side
 * descriptor parser (`miniscript::DescriptorPublicKey`) accepts the
 * fragment without per-network special casing.
 */
function bip32Versions(network: Network) {
  // Mainnet xprv/xpub vs testnet (also used for signet+regtest).
  if (network === "bitcoin") {
    return { private: 0x0488ade4, public: 0x0488b21e };
  }
  return { private: 0x04358394, public: 0x043587cf };
}

/**
 * BIP86 (Taproot single-sig) coin type. Mainnet is 0, everything else
 * is 1 by convention.
 */
function coinType(network: Network): number {
  return network === "bitcoin" ? 0 : 1;
}

/**
 * One party's freshly minted key material. We hand the caller:
 *
 *   - `xprv`           — the private key fragment they need to seal
 *                        (with the password-derived KEK for the owner,
 *                        with the claim-token-derived KEK for the heir)
 *   - `xpub`           — what we send to the server to build the vault
 *                        descriptor; safe to be public
 *   - `fingerprint`    — the BIP32 master fingerprint of the root key,
 *                        lowercase hex (8 chars), needed for the
 *                        descriptor origin tag
 *   - `derivationPath` — for display / debugging only; not load-bearing
 */
export interface GeneratedParty {
  xprv: string;
  xpub: string;
  fingerprint: string;
  derivationPath: string;
}

/**
 * Generate a fresh BIP86 account key for the given network.
 *
 * We mint a brand-new BIP39 mnemonic per party (256-bit entropy),
 * derive the seed, then descend to `m/86'/coin'/0'`. We return the
 * *account-level* xprv/xpub so the server can derive `/0/*` (receive)
 * and `/1/*` (change) addresses with the same descriptor shape the CLI
 * uses today.
 *
 * The mnemonic itself is never returned. Once we have the account
 * keys, the mnemonic is dropped. The only way back to this account is
 * through the sealed xprv we hand the caller.
 */
export function generateParty(network: Network): GeneratedParty {
  // 256 bits = 24 words. We never show this to the user; it's just
  // entropy in transit. Could be replaced with crypto.getRandomValues
  // directly, but going through BIP39 keeps the derivation path
  // bit-for-bit identical to what a wallet would produce.
  const mnemonic = generateMnemonic(wordlist, 256);
  const seed = mnemonicToSeedSync(mnemonic);

  const versions = bip32Versions(network);
  const master = HDKey.fromMasterSeed(seed, versions);
  const fingerprint = bytesToHex(master.fingerprint).slice(0, 8); // already 4 bytes
  const account = master.derive(`m/86'/${coinType(network)}'/0'`);

  if (!account.privateExtendedKey) {
    throw new Error("derivation produced no private key");
  }

  return {
    xprv: account.privateExtendedKey,
    xpub: account.publicExtendedKey,
    fingerprint,
    derivationPath: `m/86'/${coinType(network)}'/0'`,
  };
}

/**
 * Re-derive an HDKey from a stored xprv string, ready to derive a
 * concrete child for signing. Used at check-in time (owner) and at
 * claim time (heir) once the xprv has been unsealed.
 */
export function hdKeyFromXprv(xprv: string, network: Network): HDKey {
  return HDKey.fromExtendedKey(xprv, bip32Versions(network));
}

/**
 * Derive a single child x-only pubkey + private key from an account
 * xprv, for the given chain index (0 = external/receive, 1 = internal/
 * change) and address index. Returns the 32-byte x-only pubkey and the
 * 32-byte private scalar — both the format @scure/btc-signer expects
 * for Taproot signing.
 */
export interface ChildKey {
  privKey: Uint8Array; // 32 bytes
  pubKeyXOnly: Uint8Array; // 32 bytes (x-only)
}

export function deriveChildKey(
  accountXprv: string,
  network: Network,
  chain: 0 | 1,
  index: number,
): ChildKey {
  const account = hdKeyFromXprv(accountXprv, network);
  const child = account.deriveChild(chain).deriveChild(index);
  if (!child.privateKey || !child.publicKey) {
    throw new Error("child derivation produced no key");
  }
  // @noble/curves x-only: drop the parity byte from the compressed pubkey.
  const xOnly = child.publicKey.slice(1);
  return { privKey: child.privateKey, pubKeyXOnly: xOnly };
}

/** Best-effort zero-fill of a Uint8Array. Not a security boundary —
 *  V8 may have copied it — but signals intent and clears the obvious
 *  in-memory residue. */
export function wipe(...arrays: Uint8Array[]) {
  for (const a of arrays) {
    if (a && a.fill) a.fill(0);
  }
}

/* ------------------------------ helpers ------------------------------ */

function bytesToHex(b: Uint8Array | number): string {
  if (typeof b === "number") {
    return b.toString(16).padStart(8, "0");
  }
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
