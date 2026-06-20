import { describe, it, expect } from "vitest";
import { unlockYearToHeight, minUnlockYear } from "./unlockHeight";

describe("unlockYearToHeight", () => {
  it("returns null for blank/past/non-future inputs", () => {
    expect(unlockYearToHeight(null)).toBeNull();
    expect(unlockYearToHeight(undefined)).toBeNull();
    expect(unlockYearToHeight(2020)).toBeNull(); // before the anchor
  });

  it("grows monotonically with the year and stays a block height", () => {
    const h2040 = unlockYearToHeight(2040)!;
    const h2050 = unlockYearToHeight(2050)!;
    expect(h2040).toBeGreaterThan(880_000);
    expect(h2050).toBeGreaterThan(h2040);
    expect(h2040).toBeLessThan(500_000_000);
  });

  it("is roughly ~52,560 blocks per year apart", () => {
    const a = unlockYearToHeight(2040)!;
    const b = unlockYearToHeight(2041)!;
    expect(b - a).toBeGreaterThan(50_000);
    expect(b - a).toBeLessThan(55_000);
  });

  it("minUnlockYear is next year", () => {
    expect(minUnlockYear(new Date("2030-06-01T00:00:00Z"))).toBe(2031);
  });
});
