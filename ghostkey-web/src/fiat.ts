/**
 * Fiat (USD) display helpers for sats amounts.
 *
 * Which unit an amount is shown in (sats or BTC) is decided in units.ts;
 * the USD estimate sits underneath as a convenience. The USD figure
 * comes from the server's cached `/price` endpoint, so it is an estimate
 * and can be briefly stale; never treat it as exact.
 */
import { useEffect, useState } from "react";
import { api } from "./api";

const SATS_PER_BTC = 100_000_000;

export function satsToBtc(sats: number): number {
  return sats / SATS_PER_BTC;
}

export function satsToUsd(sats: number, usdPerBtc: number): number {
  return satsToBtc(sats) * usdPerBtc;
}

/** Format a USD amount. Shows more precision for sub-dollar values so a
 *  tiny vault doesn't read as "$0.00". */
export function formatUsd(usd: number): string {
  const maximumFractionDigits = usd !== 0 && Math.abs(usd) < 1 ? 4 : 2;
  return usd.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits,
  });
}

/** Format sats as BTC, trimming trailing zeros (e.g. "0.00012345 BTC"). */
export function formatBtc(sats: number): string {
  const btc = satsToBtc(sats);
  const trimmed = btc.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
  return `${trimmed} BTC`;
}

/** Format naira: whole naira for everyday amounts, kobo below ₦100 so a
 *  tiny balance doesn't read as "₦0". */
export function formatNgn(ngn: number): string {
  const maximumFractionDigits = ngn !== 0 && Math.abs(ngn) < 100 ? 2 : 0;
  return `₦${ngn.toLocaleString("en-NG", { maximumFractionDigits })}`;
}

export interface Prices {
  usd: number;
  /** Null when the server has no naira price. */
  ngn: number | null;
}

// Module-level cache so multiple components share one fetched rate within
// a session without re-requesting on every mount.
let cachedPrices: Prices | null = null;
let inflight: Promise<Prices> | null = null;

/**
 * Fetch the BTC/USD and BTC/NGN rates once and return them (or null while
 * loading / on failure). Silent on error: the fiat line just doesn't
 * render. Shared across components via a module cache.
 */
export function usePrices(): Prices | null {
  const [prices, setPrices] = useState<Prices | null>(cachedPrices);

  useEffect(() => {
    if (cachedPrices != null) return;
    let cancelled = false;
    inflight ??= api.getPrice().then((p) => {
      cachedPrices = { usd: p.usd_per_btc, ngn: p.ngn_per_btc ?? null };
      return cachedPrices;
    });
    inflight
      .then((p) => {
        if (!cancelled) setPrices(p);
      })
      .catch(() => {
        inflight = null;
        /* no price → no fiat line, by design */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return prices;
}

/** US dollars per BTC, or null. */
export function usePrice(): number | null {
  return usePrices()?.usd ?? null;
}
