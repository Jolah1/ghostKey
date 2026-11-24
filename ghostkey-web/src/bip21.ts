/**
 * BIP21 payment links for deposit addresses (#374).
 *
 * `bitcoin:ADDRESS` opens whatever wallet the owner already uses with the
 * destination filled in; `?amount=` (in BTC, per BIP21) fills the amount
 * too. The amount only ever comes from the owner typing it: a deposit
 * has no natural amount, so blank is a first-class case and we never
 * guess one.
 *
 * Amounts are converted with integer arithmetic on the digits, never
 * floating point, so "0.1 BTC" is exactly 10,000,000 sats and back.
 */
import type { Unit } from "./units";

const SATS_PER_BTC = 100_000_000;
/** All bitcoin that will ever exist; anything above is a typo. */
const MAX_SATS = 21_000_000 * SATS_PER_BTC;

/** Sats as a BIP21 BTC decimal: 50000 -> "0.0005", 100000000 -> "1". */
export function satsToBip21Btc(sats: number): string {
  const whole = Math.floor(sats / SATS_PER_BTC);
  const frac = String(sats % SATS_PER_BTC)
    .padStart(8, "0")
    .replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** `bitcoin:ADDRESS`, plus `?amount=` when there is one. */
export function bip21Uri(address: string, amountSats: number | null): string {
  const base = `bitcoin:${address}`;
  return amountSats && amountSats > 0
    ? `${base}?amount=${satsToBip21Btc(amountSats)}`
    : base;
}

/**
 * Parse what the owner typed into sats. Blank is `null` (no amount, a
 * valid choice); anything that isn't a positive amount in `unit` is
 * "invalid". Spaces and thousands commas are ignored.
 */
export function parseAmount(input: string, unit: Unit): number | null | "invalid" {
  const s = input.replace(/[\s,_]/g, "");
  if (s === "") return null;
  let sats: number;
  if (unit === "sats") {
    if (!/^\d+$/.test(s)) return "invalid";
    sats = Number(s);
  } else {
    const m = /^(\d*)(?:\.(\d{0,8}))?$/.exec(s);
    if (!m || (m[1] === "" && (m[2] ?? "") === "")) return "invalid";
    const whole = Number(m[1] || "0");
    const frac = Number((m[2] ?? "").padEnd(8, "0"));
    sats = whole * SATS_PER_BTC + frac;
  }
  if (!Number.isSafeInteger(sats) || sats <= 0 || sats > MAX_SATS) return "invalid";
  return sats;
}
