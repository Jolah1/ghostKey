import { describe, expect, it } from "vitest";
import { lastResortCheckinOpen } from "./checkin";

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
