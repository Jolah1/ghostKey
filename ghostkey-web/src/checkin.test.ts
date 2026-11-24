import { describe, expect, it } from "vitest";
import { fanOutCheckin } from "./checkin";

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
