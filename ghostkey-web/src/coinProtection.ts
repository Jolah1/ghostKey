/**
 * Coin protection (#94). Bitcoin's own lock on each deposit (`older(N)`)
 * counts from the block it confirmed in. Once it ends, only GhostKey's
 * check-in keeps that deposit from the person you chose. A refresh moves
 * the deposit back into the vault, so its lock starts again.
 */
import { ApiError } from "./api";

/** How many blocks before a lock ends to ask for a refresh: a quarter of
 *  the wait, at least a day, at most a month. Same rule as the server's
 *  reminder email (scheduler.rs refresh_lead_blocks). */
export function refreshLeadBlocks(timelockBlocks: number): number {
  return Math.min(4_320, Math.max(144, Math.floor(timelockBlocks / 4)));
}

/** "3 months", "12 days": a wait in blocks, in words. */
export function waitWords(blocks: number): string {
  const days = Math.round((blocks * 10) / 1440);
  if (days >= 30) {
    const m = Math.round(days / 30);
    return `${m} month${m === 1 ? "" : "s"}`;
  }
  return `${days} day${days === 1 ? "" : "s"}`;
}

/** Roughly when a block height arrives, at ten minutes a block. */
export function heightToDate(height: number, tip: number, now: number = Date.now()): Date {
  return new Date(now + (height - tip) * 600_000);
}

export interface CoinGroup {
  /** The deposit's transaction. A refresh spends every vault coin in it. */
  txid: string;
  valueSat: number;
  confirmationHeight: number | null;
  /** The height its lock ends at, or null while unconfirmed. */
  lockEndsAt: number | null;
}

/** The vault's coins, one entry per transaction, soonest lock end first. */
export function groupCoins(
  coins: { outpoint: string; value_sat: number; confirmation_height: number | null }[],
  timelockBlocks: number,
): CoinGroup[] {
  const by = new Map<string, CoinGroup>();
  for (const c of coins) {
    const txid = c.outpoint.split(":")[0];
    const g = by.get(txid) ?? { txid, valueSat: 0, confirmationHeight: c.confirmation_height, lockEndsAt: null };
    g.valueSat += c.value_sat;
    g.lockEndsAt = c.confirmation_height == null ? null : c.confirmation_height + timelockBlocks;
    by.set(txid, g);
  }
  return [...by.values()].sort((a, b) => (a.lockEndsAt ?? Infinity) - (b.lockEndsAt ?? Infinity));
}

/** Is this vault one where refreshing matters: someone chosen to inherit,
 *  a relative lock (not a locked goal), and still active? */
export function protectionApplies(v: {
  heir_pending?: boolean | null;
  locked_until?: number | null;
  status: string;
}): boolean {
  return !v.heir_pending && !v.locked_until && (v.status === "ok" || v.status === "warning");
}

/** The public explorers rate-limit. One quiet retry after a short wait
 *  saves people from an error that usually clears by itself. */
export async function retryIfBusy<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    const busy =
      e instanceof ApiError && /busy right now|temporarily unavailable|HTTP (429|5\d\d)/i.test(e.message);
    if (!busy) throw e;
    await new Promise((r) => setTimeout(r, 4000));
    return call();
  }
}
