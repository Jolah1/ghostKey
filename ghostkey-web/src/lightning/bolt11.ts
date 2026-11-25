/**
 * Just enough of a BOLT 11 (Lightning invoice) decoder to check a swap
 * invoice before anyone pays it: its network, its amount, and above all
 * its payment hash.
 *
 * Why it matters: a Lightning deposit is a reverse swap. The provider
 * hands us an invoice and promises to lock bitcoin on-chain that only our
 * secret (the preimage) can claim. If the invoice's payment hash were not
 * the hash of OUR secret, the provider could settle the payment without
 * ever locking anything. So the browser checks it, and refuses to show an
 * invoice that doesn't match.
 *
 * The signature is not checked: we don't need to know which node signed
 * it, only that paying it can't complete without our secret.
 */
import { bech32 } from "@scure/base";

export interface DecodedInvoice {
  /** "bc" mainnet, "tb" testnet, "tbs" signet, "bcrt" regtest. */
  currency: string;
  /** Millisatoshis, or null for an invoice with no amount. */
  amountMsat: bigint | null;
  /** Hex, 32 bytes. */
  paymentHash: string;
  /** Unix seconds. */
  timestamp: number;
  /** Seconds after `timestamp` (3600 when the invoice doesn't say). */
  expirySecs: number;
}

const MULTIPLIER_MSAT: Record<string, bigint> = {
  // 1 BTC = 100,000,000,000 msat
  m: 100_000_000n,
  u: 100_000n,
  n: 100n,
};

function wordsToInt(words: number[]): number {
  return words.reduce((acc, w) => acc * 32 + w, 0);
}

function wordsToBytes(words: number[]): Uint8Array {
  // 5-bit groups to bytes, dropping the trailing padding bits.
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const w of words) {
    acc = (acc << 5) | w;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
    acc &= (1 << bits) - 1;
  }
  return new Uint8Array(out);
}

function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Throws on anything that isn't a well-formed invoice. */
export function decodeInvoice(invoice: string): DecodedInvoice {
  const body = invoice.trim().replace(/^lightning:/i, "");
  // All upper case is fine (QR codes use it); mixed case is invalid.
  if (body !== body.toLowerCase() && body !== body.toUpperCase()) {
    throw new Error("Invoice mixes upper and lower case.");
  }
  const raw = body.toLowerCase();
  const { prefix, words } = bech32.decode(raw as `${string}1${string}`, false);
  const m = /^ln(bcrt|tbs|bc|tb)(\d+)?([munp])?$/.exec(prefix);
  if (!m) throw new Error("Not a Lightning invoice.");
  const [, currency, digits, mult] = m;
  let amountMsat: bigint | null = null;
  if (digits) {
    const n = BigInt(digits);
    if (!mult) amountMsat = n * 100_000_000_000n;
    else if (mult === "p") {
      if (n % 10n !== 0n) throw new Error("Invoice amount isn't a whole millisatoshi.");
      amountMsat = n / 10n;
    } else amountMsat = n * MULTIPLIER_MSAT[mult];
  } else if (mult) {
    throw new Error("Invoice amount is malformed.");
  }

  // 104 words of signature at the end; 7 words of timestamp at the start.
  if (words.length < 7 + 104) throw new Error("Invoice is too short.");
  const data = words.slice(0, words.length - 104);
  const timestamp = wordsToInt(data.slice(0, 7));
  let paymentHash: string | null = null;
  let expirySecs = 3600;
  let i = 7;
  while (i + 3 <= data.length) {
    const type = data[i];
    const len = data[i + 1] * 32 + data[i + 2];
    const field = data.slice(i + 3, i + 3 + len);
    if (field.length !== len) throw new Error("Invoice field runs past the end.");
    if (type === 1 && len === 52) {
      // A second payment hash would make the invoice ambiguous.
      if (paymentHash !== null) throw new Error("Invoice has two payment hashes.");
      paymentHash = toHex(wordsToBytes(field));
    } else if (type === 6) {
      expirySecs = wordsToInt(field);
    }
    i += 3 + len;
  }
  if (paymentHash === null) throw new Error("Invoice has no payment hash.");
  return { currency, amountMsat, paymentHash, timestamp, expirySecs };
}
