import { describe, expect, it } from "vitest";
import { guardianReachNotice } from "./Dashboard";

describe("guardianReachNotice", () => {
  it("counts guardians we can't reach on a live vault", () => {
    expect(guardianReachNotice({ status: "alarmed", guardians_unreachable: 2 })).toBe(2);
    expect(guardianReachNotice({ status: "ok", guardians_unreachable: 1 })).toBe(1);
  });

  it("stays quiet for standard vaults and fully reachable guardians", () => {
    expect(guardianReachNotice({ status: "ok", guardians_unreachable: null })).toBe(0);
    expect(guardianReachNotice({ status: "ok" })).toBe(0);
    expect(guardianReachNotice({ status: "ok", guardians_unreachable: 0 })).toBe(0);
    expect(guardianReachNotice(null)).toBe(0);
  });

  it("hides once a claim is underway and fixing can't resend the link", () => {
    for (const status of ["claimed", "claiming", "timelock_started"] as const) {
      expect(guardianReachNotice({ status, guardians_unreachable: 2 })).toBe(0);
    }
  });
});
