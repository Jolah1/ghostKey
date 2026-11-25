/**
 * Which unit amounts are shown in: sats (the default) or BTC (#375).
 *
 * People who earn in bitcoin think in sats, so sats is the default. Some
 * people genuinely think in BTC, so it's a preference rather than a
 * hardcoded flip. Every amount on screen goes through `formatAmount`, so
 * the unit never drifts (a vault used to read "50,000,000 sat" at 0.5 BTC
 * and "1.5 BTC" at 1.5 BTC), and the secondary line is only the USD
 * estimate, so the other unit doesn't reappear underneath.
 *
 * The choice lives on this device only (browser storage). Losing it just
 * means seeing sats again, so it never needs to be reliable.
 */
import { useSyncExternalStore } from "react";
import { formatBtc, formatNgn, formatUsd, satsToBtc, satsToUsd, usePrices, type Prices } from "./fiat";

export type Unit = "sats" | "btc";

const KEY = "gk:unit";
const listeners = new Set<() => void>();

function read(): Unit {
  try {
    return window.localStorage.getItem(KEY) === "btc" ? "btc" : "sats";
  } catch {
    return "sats";
  }
}

let current: Unit = typeof window === "undefined" ? "sats" : read();

export function getUnit(): Unit {
  return current;
}

export function setUnit(unit: Unit): void {
  current = unit;
  try {
    window.localStorage.setItem(KEY, unit);
  } catch {
    // Private mode or blocked storage: the choice lasts this page load.
  }
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The current unit; re-renders the caller when it changes. */
export function useUnit(): Unit {
  return useSyncExternalStore(subscribe, getUnit, () => "sats");
}

/** "1,234,567 sats" / "1 sat", or "0.01234567 BTC". */
export function formatAmount(sats: number, unit: Unit): string {
  if (unit === "btc") return formatBtc(sats);
  return `${sats.toLocaleString()} ${sats === 1 ? "sat" : "sats"}`;
}

/** "≈ $12.34" under an amount, or null while there's no price. */
export function usdLine(sats: number, usdPerBtc: number | null): string | null {
  if (usdPerBtc == null) return null;
  return `≈ ${formatUsd(satsToUsd(sats, usdPerBtc))}`;
}

/**
 * Which money the small line under an amount is in: US dollars (the
 * default) or naira. Separate from the sats/BTC choice: bitcoin stays the
 * main unit either way. Remembered on this device only.
 */
export type Fiat = "usd" | "ngn";

const FIAT_KEY = "gk:fiat";
const fiatListeners = new Set<() => void>();

function readFiat(): Fiat {
  try {
    return window.localStorage.getItem(FIAT_KEY) === "ngn" ? "ngn" : "usd";
  } catch {
    return "usd";
  }
}

let currentFiat: Fiat = typeof window === "undefined" ? "usd" : readFiat();

export function getFiat(): Fiat {
  return currentFiat;
}

export function setFiat(fiat: Fiat): void {
  currentFiat = fiat;
  try {
    window.localStorage.setItem(FIAT_KEY, fiat);
  } catch {
    // The choice lasts this page load.
  }
  fiatListeners.forEach((l) => l());
}

export function useFiat(): Fiat {
  return useSyncExternalStore(
    (l) => {
      fiatListeners.add(l);
      return () => fiatListeners.delete(l);
    },
    getFiat,
    () => "usd",
  );
}

/** "$1.55" or "₦2,234" for an amount, or null when that price isn't in. */
export function fiatAmount(sats: number, prices: Prices | null, fiat: Fiat): string | null {
  if (!prices) return null;
  if (fiat === "ngn") return prices.ngn != null ? formatNgn(satsToBtc(sats) * prices.ngn) : null;
  return formatUsd(satsToUsd(sats, prices.usd));
}

/** "≈ $1.55" / "≈ ₦2,234" under an amount, or null. */
export function fiatLine(sats: number, prices: Prices | null, fiat: Fiat): string | null {
  const a = fiatAmount(sats, prices, fiat);
  return a ? `≈ ${a}` : null;
}

/** The fiat line in the money this device chose. */
export function useFiatLine(): (sats: number) => string | null {
  const prices = usePrices();
  const fiat = useFiat();
  return (sats) => fiatLine(sats, prices, fiat);
}
