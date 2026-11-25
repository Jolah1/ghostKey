import { describe, expect, it } from "vitest";
import { addedThisMonth, goalProgress, goalShares, savePerPeriod, streakLine } from "./savings";

describe("goalProgress", () => {
  it("measures the balance against the goal", () => {
    expect(goalProgress(250_000, 1_000_000)).toEqual({ pct: 25, reached: false, remainingSat: 750_000 });
  });
  it("caps at 100% and is reached once the balance covers it", () => {
    expect(goalProgress(1_200_000, 1_000_000)).toEqual({ pct: 100, reached: true, remainingSat: 0 });
  });
  it("never shows 100% before it's actually reached", () => {
    expect(goalProgress(999_999, 1_000_000).pct).toBe(99);
  });
});

describe("savePerPeriod", () => {
  const now = new Date(2026, 10, 24, 12); // 24 Nov 2026, local noon

  it("splits what's left over the weeks until the date, rounding up", () => {
    // 12 Dec is 18.5 days away: 3 weeks.
    expect(savePerPeriod(100_000, now, "2026-12-12")).toEqual({ perWeek: 33_334, perMonth: null });
  });

  it("adds a monthly figure once there are at least two months", () => {
    const r = savePerPeriod(1_200_000, now, "2027-06-30")!;
    expect(r.perMonth).toBe(Math.ceil(1_200_000 / 7));
    expect(r.perWeek * 32).toBeGreaterThanOrEqual(1_200_000);
  });

  it("has nothing to say when the goal is met or the date has passed", () => {
    expect(savePerPeriod(0, now, "2027-06-30")).toBeNull();
    expect(savePerPeriod(5_000, now, "2026-11-01")).toBeNull();
    expect(savePerPeriod(5_000, now, "garbage")).toBeNull();
  });
});

describe("addedThisMonth", () => {
  const now = new Date(2026, 10, 24, 12); // 24 Nov 2026, local
  it("sums only this calendar month, moved-out deposits included", () => {
    expect(
      addedThisMonth(
        [
          { amount_sat: 50_000, seen_at: new Date(2026, 10, 3).toISOString() },
          { amount_sat: 20_000, seen_at: new Date(2026, 10, 20).toISOString() },
          { amount_sat: 99_000, seen_at: new Date(2026, 9, 31).toISOString() },
          { amount_sat: 7_000, seen_at: new Date(2025, 10, 10).toISOString() },
        ],
        now,
      ),
    ).toBe(70_000);
  });
  it("is zero with nothing this month", () => {
    expect(addedThisMonth([], now)).toBe(0);
  });
});

describe("goalShares", () => {
  it("shows the ledger and what's left over when the balance covers it", () => {
    expect(goalShares([100_000, 50_000], 200_000)).toEqual({ shown: [100_000, 50_000], notInGoalSat: 50_000 });
  });
  it("shares the balance out when goals claim more than is there", () => {
    // A send made outside GhostKey left 90k; goals still say 150k.
    expect(goalShares([100_000, 50_000], 90_000)).toEqual({ shown: [60_000, 30_000], notInGoalSat: 0 });
  });
  it("never shows a negative goal, and waits for a balance", () => {
    expect(goalShares([-5, 10], null)).toEqual({ shown: [0, 10], notInGoalSat: null });
    expect(goalShares([], 7)).toEqual({ shown: [], notInGoalSat: 7 });
  });
});

describe("streakLine", () => {
  // Week of Mon 23 Nov 2026 ends at midnight UTC going into Mon 30 Nov.
  const week = { cadence: "weekly" as const, period_ends_at: "2026-11-30T00:00:00+00:00" };
  it("says nothing before the first deposit", () => {
    expect(streakLine({ ...week, current: 0, saved_this_period: false }, 0)).toBeNull();
  });
  it("counts the run and the next one to aim for", () => {
    expect(streakLine({ ...week, current: 3, saved_this_period: true }, 5)).toEqual({
      main: "3 weeks in a row",
      sub: "saved this week",
    });
    expect(streakLine({ ...week, current: 3, saved_this_period: false }, 5)).toEqual({
      main: "3 weeks in a row",
      sub: "add any amount by Sun 29 Nov to make it 4",
    });
  });
  it("never says '1 weeks in a row'", () => {
    expect(streakLine({ ...week, current: 1, saved_this_period: true }, 1)?.main).toBe("Saved this week");
    expect(streakLine({ ...week, current: 1, saved_this_period: false }, 1)).toEqual({
      main: "Saved last week",
      sub: "add any amount by Sun 29 Nov for 2 in a row",
    });
  });
  it("invites a fresh start instead of scolding", () => {
    expect(streakLine({ ...week, current: 0, saved_this_period: false }, 4)).toEqual({
      main: "Start a streak",
      sub: "add any amount by Sun 29 Nov",
    });
  });
  it("speaks in months for a monthly saver", () => {
    expect(
      streakLine(
        { cadence: "monthly", current: 2, saved_this_period: false, period_ends_at: "2026-12-01T00:00:00+00:00" },
        2,
      ),
    ).toEqual({ main: "2 months in a row", sub: "add any amount by Mon 30 Nov to make it 3" });
  });
});
