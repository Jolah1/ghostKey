import { describe, expect, it } from "vitest";
import { groupCoins, heightToDate, protectionApplies, refreshLeadBlocks, waitWords } from "./coinProtection";

describe("refreshLeadBlocks (same rule as the server's reminder)", () => {
  it("asks a quarter of the wait ahead, between a day and a month", () => {
    expect(refreshLeadBlocks(12_960)).toBe(3_240);
    expect(refreshLeadBlocks(52_560)).toBe(4_320);
    expect(refreshLeadBlocks(1)).toBe(144);
  });
});

describe("groupCoins", () => {
  it("groups by deposit and puts the soonest lock end first", () => {
    const g = groupCoins(
      [
        { outpoint: "bb:0", value_sat: 5_000, confirmation_height: 200 },
        { outpoint: "aa:0", value_sat: 1_000, confirmation_height: 100 },
        { outpoint: "aa:1", value_sat: 2_000, confirmation_height: 100 },
        { outpoint: "cc:0", value_sat: 7_000, confirmation_height: null },
      ],
      50,
    );
    expect(g.map((x) => [x.txid, x.valueSat, x.lockEndsAt])).toEqual([
      ["aa", 3_000, 150],
      ["bb", 5_000, 250],
      ["cc", 7_000, null],
    ]);
  });
});

describe("words and dates", () => {
  it("says waits plainly", () => {
    expect(waitWords(12_960)).toBe("3 months");
    expect(waitWords(1_440)).toBe("10 days");
  });
  it("puts a height ten minutes a block away", () => {
    expect(heightToDate(106, 100, 0).getTime()).toBe(3_600_000);
  });
  it("applies only with someone to inherit, no date lock, and an active vault", () => {
    expect(protectionApplies({ heir_pending: false, status: "ok" })).toBe(true);
    expect(protectionApplies({ heir_pending: true, status: "ok" })).toBe(false);
    expect(protectionApplies({ heir_pending: false, locked_until: 1, status: "ok" })).toBe(false);
    expect(protectionApplies({ heir_pending: false, status: "claimed" })).toBe(false);
  });
});
