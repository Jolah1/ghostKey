import { describe, expect, it } from "vitest";
import { bip21Uri, parseAmount, satsToBip21Btc } from "./bip21";

const ADDR = "bc1qexampleexampleexampleexampleexampleexmpl";

describe("bip21Uri", () => {
  it("is a bare tappable link when no amount is set", () => {
    expect(bip21Uri(ADDR, null)).toBe(`bitcoin:${ADDR}`);
    expect(bip21Uri(ADDR, 0)).toBe(`bitcoin:${ADDR}`);
  });

  it("carries the amount in BTC, per BIP21", () => {
    expect(bip21Uri(ADDR, 50_000)).toBe(`bitcoin:${ADDR}?amount=0.0005`);
    expect(bip21Uri(ADDR, 100_000_000)).toBe(`bitcoin:${ADDR}?amount=1`);
    expect(bip21Uri(ADDR, 123_456_789)).toBe(`bitcoin:${ADDR}?amount=1.23456789`);
  });
});

describe("satsToBip21Btc", () => {
  it("never uses floating point or exponent notation", () => {
    expect(satsToBip21Btc(1)).toBe("0.00000001");
    expect(satsToBip21Btc(10_000_000)).toBe("0.1");
  });
});

describe("parseAmount", () => {
  it("treats blank as no amount, not an error", () => {
    expect(parseAmount("", "sats")).toBeNull();
    expect(parseAmount("   ", "btc")).toBeNull();
  });

  it("reads sats as whole numbers, ignoring thousands separators", () => {
    expect(parseAmount("50000", "sats")).toBe(50_000);
    expect(parseAmount("1,000,000", "sats")).toBe(1_000_000);
    expect(parseAmount("1.5", "sats")).toBe("invalid");
  });

  it("reads BTC exactly, down to one sat", () => {
    expect(parseAmount("0.1", "btc")).toBe(10_000_000);
    expect(parseAmount(".0005", "btc")).toBe(50_000);
    expect(parseAmount("0.00000001", "btc")).toBe(1);
    expect(parseAmount("0.000000001", "btc")).toBe("invalid");
  });

  it("refuses zero, negatives, junk and impossible amounts", () => {
    for (const bad of ["0", "-5", "abc", "1e5", "."]) {
      expect(parseAmount(bad, "sats")).toBe("invalid");
    }
    expect(parseAmount("0", "btc")).toBe("invalid");
    expect(parseAmount("21000001", "btc")).toBe("invalid");
  });
});
