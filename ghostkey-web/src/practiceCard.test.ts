/**
 * Status line for the dashboard practice-claim card (#223). The line
 * is the owner's whole window into the rehearsal: it has to tell
 * "never sent" from "sent but unopened" from "opened but unfinished"
 * from "completed", and completion must win over the earlier stages.
 */
import { describe, expect, it } from "vitest";

import { drillStatusLine } from "./PracticeClaimCard";
import { en } from "./vocab/en";

describe("drillStatusLine", () => {
  it("invites a first practice when nothing was sent", () => {
    const line = drillStatusLine({}, "Fola", undefined, en.practiceCard);
    expect(line).toContain("Fola gets a clearly-marked practice message");
    expect(line).toContain("Nothing can move");
  });

  it("names the heir's real channel, never promising an email to a WhatsApp heir", () => {
    expect(drillStatusLine({}, "Fola", "email", en.practiceCard)).toContain(
      "clearly-marked practice email",
    );
    expect(drillStatusLine({}, "Fola", "sms", en.practiceCard)).toContain(
      "clearly-marked practice text message",
    );
    expect(drillStatusLine({}, "Fola", "whatsapp", en.practiceCard)).toContain(
      "clearly-marked practice WhatsApp message",
    );
    // Unknown channel stays honest and generic.
    expect(drillStatusLine({}, "Fola", null, en.practiceCard)).toContain(
      "clearly-marked practice message",
    );
  });

  it("reports sent-but-unopened", () => {
    const line = drillStatusLine(
      { drill_started_at: "2026-07-02T10:00:00Z" },
      "Fola",
      undefined,
      en.practiceCard,
    );
    expect(line).toMatch(/^Practice sent /);
    expect(line).toContain("Fola hasn't opened it yet.");
  });

  it("reports opened-but-unfinished", () => {
    const line = drillStatusLine(
      {
        drill_started_at: "2026-07-02T10:00:00Z",
        drill_opened_at: "2026-07-03T10:00:00Z",
      },
      "Fola",
      undefined,
      en.practiceCard,
    );
    expect(line).toContain("Fola opened the practice link");
    expect(line).toContain("hasn't finished it");
  });

  it("completion wins over every earlier stage", () => {
    const line = drillStatusLine(
      {
        drill_started_at: "2026-07-02T10:00:00Z",
        drill_opened_at: "2026-07-03T10:00:00Z",
        drill_completed_at: "2026-07-04T10:00:00Z",
      },
      "Fola",
      undefined,
      en.practiceCard,
    );
    expect(line).toContain("Fola completed a practice claim on ");
  });

  it("survives an unparsable date without inventing one", () => {
    const line = drillStatusLine(
      { drill_completed_at: "not-a-date" },
      "Fola",
      undefined,
      en.practiceCard,
    );
    expect(line).toBe("Fola completed a practice claim.");
  });
});
