import { describe, expect, it } from "vitest";
import type { ChallengeView } from "./api";
import { challengeName, challengeStatus, freshWins, homeChallengeLine } from "./challenges";

function c(over: Partial<ChallengeView>): ChallengeView {
  return {
    id: "c1",
    kind: "hold",
    state: "going",
    started_at: "2026-11-01T00:00:00Z",
    ended_at: null,
    completed_at: null,
    pct: 0,
    on_track: null,
    saved_sat: null,
    target_sat: null,
    hold_months: null,
    ends_at: null,
    goal_id: null,
    target_date: null,
    per_week_sat: null,
    year: null,
    from_month: null,
    months: null,
    week1_sat: null,
    week: null,
    due_so_far_sat: null,
    this_week_sat: null,
    ...over,
  };
}

const NOW = new Date("2026-11-25T12:00:00Z");

describe("challengeName", () => {
  it("names each kind", () => {
    expect(challengeName(c({ hold_months: 6 }))).toBe("Don't touch it for 6 months");
    expect(challengeName(c({ kind: "goal_by_date", target_date: "2026-12-31" }), "School fees")).toBe(
      "School fees by 31 Dec 2026",
    );
    expect(challengeName(c({ kind: "goal_by_date", target_date: "2026-12-31" }))).toBe("Your goal by 31 Dec 2026");
    expect(challengeName(c({ kind: "every_month", year: 2026 }))).toBe("Save every month of 2026");
    expect(challengeName(c({ kind: "week52" }))).toBe("52-week challenge");
  });
});

describe("challengeStatus", () => {
  it("counts down a hold", () => {
    expect(challengeStatus(c({ ends_at: "2026-11-27T00:00:00Z" }), "sats", NOW)).toBe("2 days to go");
    expect(challengeStatus(c({ ends_at: "2026-11-26T00:00:00Z" }), "sats", NOW)).toBe("1 day to go");
    expect(challengeStatus(c({ ends_at: "2026-11-25T00:00:00Z" }), "sats", NOW)).toBe("Finishing at the next check");
  });
  it("paces a goal", () => {
    const g = c({ kind: "goal_by_date", saved_sat: 250_000, target_sat: 1_000_000, per_week_sat: 50_000 });
    expect(challengeStatus({ ...g, on_track: true }, "sats", NOW)).toBe("250,000 sats of 1,000,000 sats · on track");
    expect(challengeStatus({ ...g, on_track: false }, "sats", NOW)).toBe(
      "250,000 sats of 1,000,000 sats · about 50,000 sats a week gets you there",
    );
  });
  it("counts only the months from joining", () => {
    const months = Array(12).fill(false);
    months[2] = true; // March, before joining: not counted
    months[10] = true;
    expect(challengeStatus(c({ kind: "every_month", from_month: 11, months }), "sats", NOW)).toBe(
      "1 of 2 months so far",
    );
  });
  it("tells the 52-week saver what's due", () => {
    const w = c({ kind: "week52", week: 3, this_week_sat: 3_000, due_so_far_sat: 6_000 });
    expect(challengeStatus({ ...w, saved_sat: 6_000, on_track: true }, "sats", NOW)).toBe(
      "Week 3 · this week 3,000 sats · on track",
    );
    expect(challengeStatus({ ...w, saved_sat: 2_500, on_track: false }, "sats", NOW)).toBe(
      "Week 3 · this week 3,000 sats · 3,500 sats to catch up",
    );
  });
});

describe("homeChallengeLine", () => {
  it("counts the going ones, or invites one once there's money in", () => {
    expect(homeChallengeLine([c({}), c({ id: "c2" }), c({ id: "c3", state: "stopped" })], true)).toBe(
      "2 challenges going",
    );
    expect(homeChallengeLine([c({})], true)).toBe("1 challenge going");
    expect(homeChallengeLine([], true)).toBe("Try a savings challenge");
    expect(homeChallengeLine([], false)).toBeNull();
  });
});

describe("freshWins", () => {
  it("shows a finish for two weeks, until it's waved off", () => {
    const won = c({ state: "done", completed_at: "2026-11-20T00:00:00Z" });
    expect(freshWins([won], [], NOW)).toHaveLength(1);
    expect(freshWins([won], ["c1"], NOW)).toHaveLength(0);
    expect(freshWins([{ ...won, completed_at: "2026-11-01T00:00:00Z" }], [], NOW)).toHaveLength(0);
    expect(freshWins([c({ state: "over" })], [], NOW)).toHaveLength(0);
  });
});
