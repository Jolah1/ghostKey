import { describe, expect, it } from "vitest";
import { formatAmount, usdLine } from "./units";

describe("formatAmount", () => {
  it("shows sats in sats at every size, never switching units", () => {
    // The old formatter flipped to BTC at 1 BTC, exactly where amounts
    // matter most (#375).
    expect(formatAmount(50_000_000, "sats")).toBe(`${(50_000_000).toLocaleString()} sats`);
    expect(formatAmount(150_000_000, "sats")).toBe(`${(150_000_000).toLocaleString()} sats`);
    expect(formatAmount(1, "sats")).toBe("1 sat");
    expect(formatAmount(0, "sats")).toBe("0 sats");
  });

  it("shows BTC in BTC at every size", () => {
    expect(formatAmount(50_000_000, "btc")).toBe("0.5 BTC");
    expect(formatAmount(150_000_000, "btc")).toBe("1.5 BTC");
    expect(formatAmount(12_345, "btc")).toBe("0.00012345 BTC");
  });
});

describe("usdLine", () => {
  it("is only the USD estimate, so the other unit doesn't reappear", () => {
    const line = usdLine(100_000_000, 50_000);
    expect(line).not.toBeNull();
    expect(line).toMatch(/^≈ /);
    expect(line).not.toMatch(/BTC|sat/);
  });

  it("is absent without a price", () => {
    expect(usdLine(1_000, null)).toBeNull();
  });
});
