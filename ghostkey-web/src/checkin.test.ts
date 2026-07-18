import { describe, expect, it } from "vitest";
import { fanOutCheckin, lastResortCheckinOpen } from "./checkin";

describe("lastResortCheckinOpen", () => {
  const now = new Date("2026-06-23T12:00:00Z");

  it("is closed with no claim-eligible time", () => {
    expect(lastResortCheckinOpen(null, now)).toBe(false);
    expect(lastResortCheckinOpen(undefined, now)).toBe(false);
  });

  it("is closed when the heir-contact moment is more than 24h away", () => {
    const eligible = new Date(now.getTime() + 25 * 3600 * 1000).toISOString();
    expect(lastResortCheckinOpen(eligible, now)).toBe(false);
  });

  it("opens within the final 24h before the heir is contacted", () => {
    const eligible = new Date(now.getTime() + 23 * 3600 * 1000).toISOString();
    expect(lastResortCheckinOpen(eligible, now)).toBe(true);
  });

  it("stays open once the heir-contact moment has passed", () => {
    const eligible = new Date(now.getTime() - 3600 * 1000).toISOString();
    expect(lastResortCheckinOpen(eligible, now)).toBe(true);
  });

  it("is closed on an unparseable timestamp", () => {
    expect(lastResortCheckinOpen("not-a-date", now)).toBe(false);
  });
});

describe("fanOutCheckin", () => {
  it("keeps going after a heir refuses, and reports the tally", async () => {
    // The claimed heir sits FIRST: the bug this guards against was a
    // fan-out that stopped on the first refusal, leaving the live heirs
    // behind it with a clock nobody reset.
    const tried: string[] = [];
    const tally = await fanOutCheckin(["claimed", "live-1", "live-2"], async (id) => {
      tried.push(id);
      return id === "claimed" ? "skipped" : "checked-in";
    });

    expect(tried).toEqual(["claimed", "live-1", "live-2"]);
    expect(tally).toEqual({ checkedIn: 2, skipped: 1, hardError: null });
  });

  it("reports only the first hard error, and still tries every heir", async () => {
    const tried: string[] = [];
    const tally = await fanOutCheckin(["a", "b", "c"], async (id) => {
      tried.push(id);
      if (id === "a") return { error: "first" };
      if (id === "b") return { error: "second" };
      return "checked-in";
    });

    expect(tried).toEqual(["a", "b", "c"]);
    expect(tally).toEqual({ checkedIn: 1, skipped: 0, hardError: "first" });
  });

  it("tallies a single-heir vault that had nothing to do", async () => {
    const tally = await fanOutCheckin(["only"], async () => "skipped");
    expect(tally).toEqual({ checkedIn: 0, skipped: 1, hardError: null });
  });
});
