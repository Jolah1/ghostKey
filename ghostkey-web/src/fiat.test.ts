import { describe, it, expect } from "vitest";
import { satsToBtc, satsToUsd, formatBtc, formatUsd, btcAndUsd } from "./fiat";

describe("fiat helpers", () => {
  it("converts sats to BTC and USD", () => {
    expect(satsToBtc(100_000_000)).toBe(1);
    expect(satsToBtc(12_345)).toBeCloseTo(0.00012345, 12);
    expect(satsToUsd(100_000_000, 60_000)).toBeCloseTo(60_000, 6);
    expect(satsToUsd(50_000, 60_000)).toBeCloseTo(30, 6);
  });

  it("formats BTC trimming trailing zeros", () => {
    expect(formatBtc(100_000_000)).toBe("1 BTC");
    expect(formatBtc(12_345)).toBe("0.00012345 BTC");
    expect(formatBtc(0)).toBe("0 BTC");
  });

  it("formats USD with extra precision under a dollar", () => {
    expect(formatUsd(1234.5)).toBe("$1,234.50");
    // sub-dollar keeps more digits so a tiny vault isn't "$0.00"
    expect(formatUsd(0.3)).toMatch(/^\$0\.30/);
    expect(formatUsd(0.0123)).toMatch(/0\.0123/);
  });

  it("btcAndUsd falls back to BTC-only without a price", () => {
    expect(btcAndUsd(12_345, null)).toBe("0.00012345 BTC");
    expect(btcAndUsd(50_000, 60_000)).toBe("0.0005 BTC · ≈ $30.00");
  });
});
