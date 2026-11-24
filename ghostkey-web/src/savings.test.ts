import { describe, expect, it } from "vitest";
import { goalProgress, savePerPeriod } from "./savings";

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
