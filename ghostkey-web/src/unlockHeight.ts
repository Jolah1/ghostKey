/**
 * Convert an owner-chosen "unlock year" into an approximate absolute
 * block height for the guardian-vault CLTV (#81 P5).
 *
 * Bitcoin has no calendar, only blocks. To "lock funds until ~year Y"
 * we translate Y into the block height the chain is expected to reach
 * around then, using a known recent anchor block and Bitcoin's ~10
 * minute target interval.
 *
 * This is deliberately approximate: real intervals drift, so a multi
 * year lock can land days or weeks off the calendar date. That is fine
 * for the use case (hold until a child is roughly a certain age) and
 * safe, because the owner branch is always spendable — the owner can
 * recover the funds early with their recovery file if the estimate is
 * off. The UI says "around" for exactly this reason.
 */

/** A recent mainnet anchor: block height at a known UTC time. */
const ANCHOR_HEIGHT = 880_000;
/** 2025-01-24T00:00:00Z, when block 880000 was mined (approx). */
const ANCHOR_UNIX = 1_737_676_800;
/** Bitcoin's target block interval, seconds. */
const SECONDS_PER_BLOCK = 600;
/** Absolute locktimes at or above this are timestamps, not heights
 *  (BIP65). We only build height-based unlocks, so stay under it. */
const MAX_CLTV_HEIGHT = 500_000_000;

/**
 * Approximate block height for 1 January of `year` (UTC). Returns null
 * when the year is not a usable future lock (past/blank, or the estimate
 * would overflow the block-height range).
 */
export function unlockYearToHeight(year: number | null | undefined): number | null {
  if (!year || !Number.isInteger(year)) return null;
  const targetUnix = Date.UTC(year, 0, 1) / 1000;
  const height = ANCHOR_HEIGHT + Math.round((targetUnix - ANCHOR_UNIX) / SECONDS_PER_BLOCK);
  if (height <= ANCHOR_HEIGHT || height >= MAX_CLTV_HEIGHT) return null;
  return height;
}

/** The earliest year the picker should offer: next calendar year. */
export function minUnlockYear(now: Date = new Date()): number {
  return now.getUTCFullYear() + 1;
}
