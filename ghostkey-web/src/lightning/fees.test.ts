import { describe, expect, it } from "vitest";
import { lightningFee, percentWords, type ReversePair } from "./reverseSwap";

// SatsRouting's published terms when this was written.
const PAIR: ReversePair = { hash: "h", minimalSat: 2_000, maximalSat: 2_000_000, percentage: 0.6, lockupFeeSat: 154, claimFeeSat: 111 };

describe("lightningFee", () => {
  it("adds the swap service's cut and the network fees", () => {
    // 60 (0.6%) + 154 lockup + 111 claim
    expect(lightningFee(10_000, PAIR)).toEqual({ sat: 325, percent: 3.25 });
    expect(lightningFee(2_000, PAIR).sat).toBe(12 + 154 + 111);
    expect(lightningFee(200_000, PAIR).sat).toBe(1_200 + 154 + 111);
  });
  it("says the percent plainly", () => {
    expect(percentWords(3.25)).toBe("3.3%");
    expect(percentWords(0.7325)).toBe("0.7%");
    expect(percentWords(4)).toBe("4%");
    expect(percentWords(13.85)).toBe("14%");
  });
});
