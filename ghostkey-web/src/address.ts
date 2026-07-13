/**
 * Shared Bitcoin-address helpers.
 *
 * Used by both the heir claim flow (ClaimPage) and the owner Send flow
 * (Dashboard) so the two money-moving paths validate a destination the
 * same way before anything is signed or broadcast. Kept dependency-free
 * (no key libraries) — these are cheap shape and network checks, not a
 * full bech32 decode. The server validates properly before it spends;
 * this is the first, friendly line of defence in the browser.
 */

/** The bech32 address prefix we expect for a given network. Used in
 *  copy and as input placeholders, so it carries the witness-version
 *  `q` the user actually sees them start with. */
export function bech32PrefixFor(network: string): string {
  if (network === "bitcoin") return "bc1q";
  if (network === "regtest") return "bcrt1q";
  return "tb1q"; // testnet and signet share the tb1 prefix
}

/** Loose shape check: does this look like any Bitcoin address at all?
 *  Catches typos and truncation, not network mismatch (see
 *  `addressMatchesNetwork`). */
export function looksLikeBitcoinAddress(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  // Bech32 mainnet / testnet / signet / regtest.
  if (/^(bc1|tb1|bcrt1)[02-9ac-hj-np-z]{20,}$/i.test(t)) return true;
  // Base58 P2PKH / P2SH (mainnet starts with 1 or 3, testnet 2 / m / n).
  if (/^[13mn2][1-9A-HJ-NP-Za-km-z]{20,}$/.test(t)) return true;
  return false;
}

/**
 * True when the paste is a Lightning payment string rather than a
 * Bitcoin address: a Lightning address (name@domain — the email-looking
 * kind wallets like Blink hand out), a BOLT11 invoice, an LNURL, or a
 * lightning: URI. An on-chain spend can't pay any of these, and heirs
 * with Lightning-first wallets paste them in good faith. Callers show a
 * "get your wallet's Bitcoin address instead" hint rather than the
 * generic "doesn't look right".
 */
export function looksLikeLightningDestination(s: string): boolean {
  const t = s.trim().toLowerCase();
  if (!t) return false;
  if (t.startsWith("lightning:")) return true;
  // BOLT11 invoices: lnbc (mainnet), lntb (testnet), lntbs (signet),
  // lnbcrt (regtest). No Bitcoin address starts with "ln".
  if (/^ln(bc|tb|tbs|bcrt)[0-9a-z]+$/.test(t)) return true;
  if (/^lnurl1[0-9a-z]+$/.test(t)) return true;
  // Lightning address: one @, a dot in the domain, no spaces.
  if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(t)) return true;
  return false;
}

/**
 * True when `addr` belongs to `network`. Catches the realistic
 * cross-network paste — a mainnet `bc1…` address into a signet vault,
 * or a test `tb1…` into a mainnet vault — which would otherwise build a
 * transaction that can never confirm and silently strand the funds.
 *
 * Assumes the address already passed `looksLikeBitcoinAddress`; returns
 * false for anything it doesn't recognise so callers fail closed.
 */
export function addressMatchesNetwork(addr: string, network: string): boolean {
  const t = addr.trim();
  const lower = t.toLowerCase();
  // Bech32 / bech32m. Order matters: regtest's "bcrt1" must not be read
  // as mainnet's "bc1" (it isn't — "bcrt1".startsWith("bc1") is false —
  // but we spell each case out so the intent is obvious).
  if (/^(bc1|tb1|bcrt1)/.test(lower)) {
    if (network === "bitcoin") return lower.startsWith("bc1");
    if (network === "regtest") return lower.startsWith("bcrt1");
    // testnet and signet share the tb1 HRP
    return lower.startsWith("tb1");
  }
  // Base58: mainnet P2PKH/P2SH start 1 or 3; the test networks use
  // m, n, or 2.
  if (/^[13]/.test(t)) return network === "bitcoin";
  if (/^[mn2]/.test(t)) return network !== "bitcoin";
  return false;
}
