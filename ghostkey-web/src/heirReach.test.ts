import { describe, expect, it } from "vitest";
import type { VaultView } from "./api";
import { heirReachNotice } from "./Dashboard";

const base: Pick<VaultView, "status" | "heir_reachability" | "drill_started_at"> = {
  status: "ok",
  heir_reachability: null,
  drill_started_at: null,
};

describe("heirReachNotice", () => {
  it("warns when the heir can't be reached", () => {
    expect(heirReachNotice({ ...base, heir_reachability: "unreachable" })).toBe(
      "unreachable",
    );
  });

  it("nudges toward a practice when nothing has been confirmed", () => {
    expect(heirReachNotice({ ...base, heir_reachability: "unconfirmed" })).toBe(
      "unconfirmed",
    );
  });

  it("stops nudging once a practice is out", () => {
    expect(
      heirReachNotice({
        ...base,
        heir_reachability: "unconfirmed",
        drill_started_at: "2026-09-01T00:00:00Z",
      }),
    ).toBe(null);
  });

  it("still warns about a failure after a practice was sent", () => {
    expect(
      heirReachNotice({
        ...base,
        heir_reachability: "unreachable",
        drill_started_at: "2026-09-01T00:00:00Z",
      }),
    ).toBe("unreachable");
  });

  it("says nothing once confirmed, or when we can't tell", () => {
    expect(heirReachNotice({ ...base, heir_reachability: "confirmed" })).toBe(null);
    expect(heirReachNotice({ ...base, heir_reachability: null })).toBe(null);
    expect(heirReachNotice(null)).toBe(null);
  });

  it("stays quiet once a claim is underway", () => {
    for (const status of ["timelock_started", "claiming", "claimed"] as const) {
      expect(
        heirReachNotice({ ...base, status, heir_reachability: "unreachable" }),
      ).toBe(null);
    }
  });
});
