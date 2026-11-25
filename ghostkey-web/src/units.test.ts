import { describe, expect, it } from "vitest";
import { fiatAmount, fiatLine, formatAmount, usdLine } from "./units";
import { formatNgn } from "./fiat";

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

describe("fiat line ($ or ₦)", () => {
  const prices = { usd: 58_980, ngn: 85_238_089 };
  it("shows dollars by default and naira when chosen", () => {
    expect(fiatLine(2_629, prices, "usd")).toBe("≈ $1.55");
    expect(fiatLine(2_629, prices, "ngn")).toBe("≈ ₦2,241");
  });
  it("keeps kobo only for tiny amounts", () => {
    expect(formatNgn(42.5)).toBe("₦42.5");
    expect(formatNgn(1_234_567.89)).toBe("₦1,234,568");
  });
  it("hides the naira line when there's no naira price, rather than guess", () => {
    expect(fiatLine(2_629, { usd: 58_980, ngn: null }, "ngn")).toBeNull();
    expect(fiatLine(2_629, null, "usd")).toBeNull();
    expect(fiatAmount(100_000_000, prices, "ngn")).toBe("₦85,238,089");
  });
});
