import { describe, expect, it } from "vitest";
import { heirContactDue } from "./heirContact";

describe("heirContactDue", () => {
  const server = "2026-11-17T00:00:00Z";
  const later = "2026-12-10T00:00:00Z";
  const earlier = "2026-11-01T00:00:00Z";

  it("waits on the chain when the coins unlock after the server deadline", () => {
    // The bug this fixes: the banner said "0 days left" off the server
    // clock while the heir email was correctly held for the chain.
    const r = heirContactDue(server, later);
    expect(r.waitingOnChain).toBe(true);
    expect(r.due?.toISOString()).toBe(new Date(later).toISOString());
  });

  it("uses the server deadline when the coins are already close to unlocking", () => {
    const r = heirContactDue(server, earlier);
    expect(r.waitingOnChain).toBe(false);
    expect(r.due?.toISOString()).toBe(new Date(server).toISOString());
  });

  it("uses the server deadline when the chain has not been scanned or has matured", () => {
    expect(heirContactDue(server, null)).toEqual({
      due: new Date(server),
      waitingOnChain: false,
    });
  });

  it("uses the chain date when the server date is missing", () => {
    expect(heirContactDue(null, later).waitingOnChain).toBe(true);
  });

  it("returns nothing when neither date is known or parseable", () => {
    expect(heirContactDue(undefined, "not-a-date")).toEqual({
      due: null,
      waitingOnChain: false,
    });
  });
});
