/**
 * Fiat (USD) display helpers for sats amounts.
 *
 * Bitcoin amounts are always shown in sats first (the source of truth);
 * BTC and a USD estimate sit alongside as a convenience. The USD figure
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

/** "BTC · ≈ $USD" line to sit under a sats figure. Returns just the BTC
 *  part when no price is available. */
export function btcAndUsd(sats: number, usdPerBtc: number | null): string {
  const btc = formatBtc(sats);
  if (usdPerBtc == null) return btc;
  return `${btc} · ≈ ${formatUsd(satsToUsd(sats, usdPerBtc))}`;
}

// Module-level cache so multiple components share one fetched rate within
// a session without re-requesting on every mount.
let cachedUsdPerBtc: number | null = null;

/**
 * Fetch the BTC/USD rate once and return it (or null while loading / on
 * failure). Silent on error: the fiat line just doesn't render. Shared
 * across components via a module cache.
 */
export function usePrice(): number | null {
  const [usdPerBtc, setUsdPerBtc] = useState<number | null>(cachedUsdPerBtc);

  useEffect(() => {
    if (cachedUsdPerBtc != null) return;
    let cancelled = false;
    api
      .getPrice()
      .then((p) => {
        if (cancelled) return;
        cachedUsdPerBtc = p.usd_per_btc;
        setUsdPerBtc(p.usd_per_btc);
      })
      .catch(() => {
        /* no price → no fiat line, by design */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return usdPerBtc;
}
