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

  it("says so plainly when the vault is already claimed", () => {
    expect(
      heirContactBlockedReason({ hasOwnerToken: true, status: "claimed" }),
    ).toContain("vault is closed");
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
