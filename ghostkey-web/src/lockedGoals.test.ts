import { describe, expect, it } from "vitest";
import { LOCK_MONTHS, lockDates, unlockFeeSats } from "./lockedGoals";

// The server's limits (routes.rs LOCK_MIN/MAX_SECS, HEIR_GAP_MIN/MAX_SECS).
const DAY = 86_400;
const MIN = 80 * DAY;
const MAX = 380 * DAY;

describe("lockDates", () => {
  const now = new Date("2026-11-27T12:00:00Z");
  const nowS = now.getTime() / 1000;

  it("always picks dates the server accepts", () => {
    // Waits from one block to far past a year: the heir gap is clamped.
    for (const months of LOCK_MONTHS) {
      for (const blocks of [1, 4320, 13_000, 52_560, 200_000]) {
        const d = lockDates(months, blocks, false, now);
        expect(d.owner_after - nowS).toBeGreaterThanOrEqual(MIN);
        expect(d.owner_after - nowS).toBeLessThanOrEqual(MAX);
        expect(d.heir_after - d.owner_after).toBeGreaterThanOrEqual(MIN);
        expect(d.heir_after - d.owner_after).toBeLessThanOrEqual(MAX);
      }
    }
  });

  it("unlocks on the same day of the month", () => {
    const d = lockDates(6, 4320, false, now);
    expect(new Date(d.owner_after * 1000).toISOString().slice(0, 10)).toBe("2027-05-27");
  });

  it("locks for minutes on a demo server", () => {
    const d = lockDates(3, 1, true, now);
    expect(d.owner_after - nowS).toBeLessThan(3600);
    expect(d.heir_after).toBeGreaterThan(d.owner_after);
  });
});

describe("unlockFeeSats", () => {
  it("grows with each deposit", () => {
    expect(unlockFeeSats(1, 2)).toBe(276);
    expect(unlockFeeSats(12, 2)).toBe(2124);
    expect(unlockFeeSats(0, 2)).toBe(unlockFeeSats(1, 2));
  });
});
