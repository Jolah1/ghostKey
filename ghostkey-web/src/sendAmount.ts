/**
 * The send amount, typed in bitcoin (sats or BTC) or in money people
 * think in ($ or ₦). Whatever is typed, the send itself is in sats: a
 * fiat amount is converted at the current price, and the review step
 * shows the exact sats before anything moves.
 */
import { parseAmount } from "./bip21";
import type { Prices } from "./fiat";
import type { Fiat, Unit } from "./units";

const SATS_PER_BTC = 100_000_000;

/** What the amount box is in right now. */
export type AmountIn = Unit | Fiat;

export function isFiat(a: AmountIn): a is Fiat {
  return a === "usd" || a === "ngn";
}

/** The price of one bitcoin in that money, or null while it isn't known. */
export function pricePerBtc(fiat: Fiat, prices: Prices | null): number | null {
  if (!prices) return null;
  return fiat === "ngn" ? prices.ngn : prices.usd;
}

/**
 * Sats for what was typed. Null for an empty box, "invalid" for anything
 * that isn't a positive amount (or a fiat amount with no price yet).
 */
export function amountToSats(
  input: string,
  amountIn: AmountIn,
  prices: Prices | null,
): number | null | "invalid" {
  if (!isFiat(amountIn)) return parseAmount(input, amountIn);
  const s = input.replace(/[\s,_$₦]/g, "");
  if (s === "") return null;
  if (!/^(\d+\.?\d{0,2}|\.\d{1,2})$/.test(s)) return "invalid";
  const rate = pricePerBtc(amountIn, prices);
  if (rate == null || rate <= 0) return "invalid";
  const sats = Math.round((Number(s) / rate) * SATS_PER_BTC);
  return Number.isSafeInteger(sats) && sats > 0 ? sats : "invalid";
}

/** The box's label and the symbol shown beside the number. */
export function amountInLabel(a: AmountIn): string {
  switch (a) {
    case "sats":
      return "sats";
    case "btc":
      return "BTC";
    case "usd":
      return "$";
    case "ngn":
      return "₦";
  }
}
