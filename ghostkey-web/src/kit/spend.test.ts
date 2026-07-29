/**
 * The recovery kit's spend panel, for the two ways it misled a reader.
 *
 * This page is read by someone recovering an inheritance: usually
 * grieving, usually non-technical, usually alone, and holding the only
 * copy of a key. Ambiguity here is not a cosmetic bug.
 */
import { describe, expect, it } from "vitest";

import {
  RECIPIENT_HINT,
  RECIPIENT_LABEL,
  feedbackLines,
  type KitFeedback,
} from "./spend";

describe("the destination field label", () => {
  it("does not read as an instruction to deposit", () => {
    // It used to say "Send to this Bitcoin address", which describes
    // paying money IN. The field is where the vault's coins go OUT to.
    // Someone acting on the old wording sends funds to an address
    // instead of away from one.
    const both = `${RECIPIENT_LABEL} ${RECIPIENT_HINT}`.toLowerCase();
    expect(both).not.toContain("send to this");
    expect(RECIPIENT_LABEL.toLowerCase()).not.toMatch(/^send to/);
  });

  it("says whose wallet the address should belong to", () => {
    // "Paste an address" alone invites pasting the vault's own deposit
    // address back in, which is the mistake the old copy encouraged.
    expect(RECIPIENT_HINT.toLowerCase()).toContain("your own wallet");
  });

  it("stays plain: no jargon a non-technical reader would stall on", () => {
    const both = `${RECIPIENT_LABEL} ${RECIPIENT_HINT}`.toLowerCase();
    for (const jargon of ["utxo", "descriptor", "psbt", "recipient", "output"]) {
      expect(both).not.toContain(jargon);
    }
  });
});

describe("feedbackLines", () => {
  it("never shows an error and a status at the same time", () => {
    // The reported bug: a failed lookup rendered "Couldn't reach the
    // explorer" directly above "Looking up your addresses…", so the
    // page said the money was both unreachable and still being counted.
    const failed = feedbackLines({ kind: "error", error: "Couldn't reach the explorer." });
    expect(failed.error).toBe("Couldn't reach the explorer.");
    expect(failed.status).toBeNull();
  });

  it("stops the progress bar on failure", () => {
    // A spinner still turning under an error message reads as "it might
    // still work", so the reader waits instead of acting.
    expect(feedbackLines({ kind: "error", error: "boom" }).busy).toBe(false);
  });

  it("spins only while actually working", () => {
    expect(feedbackLines({ kind: "busy", status: "Looking up…" }).busy).toBe(true);
    expect(feedbackLines({ kind: "info", status: "Found 2 coins" }).busy).toBe(false);
    expect(feedbackLines({ kind: "idle" }).busy).toBe(false);
  });

  it("clears both lines when idle, so a retry starts clean", () => {
    const idle = feedbackLines({ kind: "idle" });
    expect(idle.error).toBeNull();
    expect(idle.status).toBeNull();
  });

  it("carries status through without an error attached", () => {
    for (const kind of ["busy", "info"] as const) {
      const f = feedbackLines({ kind, status: "working on it" } as KitFeedback);
      expect(f.status).toBe("working on it");
      expect(f.error).toBeNull();
    }
  });
});
