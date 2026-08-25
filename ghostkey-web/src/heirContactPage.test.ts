/**
 * The heir-contact editor's two pieces of judgement (#315).
 *
 * Both exist because an owner tried to move a heir off a dead channel
 * before a claim link fired and couldn't: the page never said whose
 * contact it was editing, and when it refused it blamed a claim that
 * wasn't happening.
 */
import { describe, expect, it } from "vitest";

import {
  heirContactTitle,
  heirContactBlockedReason,
  swapDomain,
} from "./VaultToolPages";

describe("heirContactTitle", () => {
  it("names the heir, so a multi-heir owner can't rewrite the wrong one", () => {
    expect(heirContactTitle("Ara")).toBe("How Ara is reached");
  });

  it("falls back to the generic title when the name is missing or blank", () => {
    expect(heirContactTitle(undefined)).toBe("How your heir is reached");
    expect(heirContactTitle(null)).toBe("How your heir is reached");
    expect(heirContactTitle("")).toBe("How your heir is reached");
    expect(heirContactTitle("   ")).toBe("How your heir is reached");
  });

  it("trims stored whitespace rather than rendering it", () => {
    expect(heirContactTitle("  Fola  ")).toBe("How Fola is reached");
  });
});

describe("heirContactBlockedReason", () => {
  it("blames the missing credential, not a claim, when the browser has no owner token", () => {
    const reason = heirContactBlockedReason({
      hasOwnerToken: false,
      status: "ok",
    });
    expect(reason).toContain("isn't signed in as the owner");
    expect(reason).not.toContain("claim is underway");
  });

  it("says the share is claimed, not that the vault is closed", () => {
    const reason = heirContactBlockedReason({
      hasOwnerToken: true,
      status: "claimed",
    });
    expect(reason).toContain("share is claimed");
    // A claim ends one heir's share. The vault stays open, and saying
    // otherwise tells the owner their whole plan is over.
    expect(reason).not.toContain("vault is closed");
  });

  it("keeps the claim wording for a claim actually underway", () => {
    for (const status of ["timelock_started", "claiming"]) {
      expect(heirContactBlockedReason({ hasOwnerToken: true, status })).toContain(
        "claim is underway",
      );
    }
  });

  it("prefers the credential reason over the claim reason when both apply", () => {
    // A browser with no credential looking at a claiming vault should be
    // told the thing it can act on.
    expect(
      heirContactBlockedReason({ hasOwnerToken: false, status: "claiming" }),
    ).toContain("isn't signed in as the owner");
  });
});

/* ---------------- typo suggestions (#327) ---------------- */

describe("swapDomain", () => {
  it("keeps the local part exactly as typed", () => {
    expect(swapDomain("heir@gmial.com", "gmail.com")).toBe("heir@gmail.com");
    // Dots, plus-addressing and case in the local part must survive: the
    // owner already typed it correctly and we are only fixing the domain.
    expect(swapDomain("First.Last+vault@gmial.com", "gmail.com")).toBe(
      "First.Last+vault@gmail.com",
    );
    expect(swapDomain("  heir@gmial.com  ", "gmail.com")).toBe("heir@gmail.com");
  });

  it("uses the last @, so an odd local part isn't split wrongly", () => {
    expect(swapDomain("a@b@gmial.com", "gmail.com")).toBe("a@b@gmail.com");
  });

  it("leaves anything without a usable local part alone", () => {
    expect(swapDomain("nonsense", "gmail.com")).toBe("nonsense");
    expect(swapDomain("@gmial.com", "gmail.com")).toBe("@gmial.com");
    expect(swapDomain("", "gmail.com")).toBe("");
  });
});
