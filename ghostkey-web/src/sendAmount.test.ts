import { describe, expect, it } from "vitest";
import { amountToSats } from "./sendAmount";

const prices = { usd: 100_000, ngn: 150_000_000 };

describe("amountToSats", () => {
  it("reads sats and BTC as before", () => {
    expect(amountToSats("2,000", "sats", prices)).toBe(2000);
    expect(amountToSats("0.00002", "btc", prices)).toBe(2000);
    expect(amountToSats("", "sats", prices)).toBeNull();
  });

  it("converts dollars at the current price", () => {
    // $1 at $100,000 per bitcoin is 1,000 sats.
    expect(amountToSats("1", "usd", prices)).toBe(1000);
    expect(amountToSats("$2.50", "usd", prices)).toBe(2500);
    expect(amountToSats(".5", "usd", prices)).toBe(500);
  });

  it("converts naira at the naira price", () => {
    // ₦1,500 at ₦150m per bitcoin is 1,000 sats.
    expect(amountToSats("1,500", "ngn", prices)).toBe(1000);
    expect(amountToSats("₦1500", "ngn", prices)).toBe(1000);
  });

  it("refuses what it can't send", () => {
    expect(amountToSats("1.234", "usd", prices)).toBe("invalid");
    expect(amountToSats("abc", "usd", prices)).toBe("invalid");
    expect(amountToSats("0", "usd", prices)).toBe("invalid");
    // Less than one sat.
    expect(amountToSats("0.0001", "usd", { usd: 100_000_000, ngn: null })).toBe("invalid");
    // No price yet.
    expect(amountToSats("5", "usd", null)).toBe("invalid");
    expect(amountToSats("5", "ngn", { usd: 100_000, ngn: null })).toBe("invalid");
  });
});
