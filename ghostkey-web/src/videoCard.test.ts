/**
 * Status line for the dashboard video card (#222). The card is the
 * owner's only window into whether a clip is attached; the wording has
 * to distinguish "none yet" from "saved" without inventing a date when
 * the server didn't send one.
 */
import { describe, expect, it } from "vitest";

import { videoStatusLine } from "./VideoMessageCard";

describe("videoStatusLine", () => {
  it("says none when there is no video", () => {
    expect(
      videoStatusLine({
        has_video: false,
        mime: null,
        duration_ms: null,
        created_at: null,
      }),
    ).toBe("No video message yet.");
  });

  it("includes the recorded date when present", () => {
    const line = videoStatusLine({
      has_video: true,
      mime: "video/webm",
      duration_ms: 12000,
      created_at: "2026-06-13T10:00:00Z",
    });
    expect(line).toMatch(/^Video message saved /);
    expect(line).toContain("2026");
  });

  it("still reports saved when the date is missing or unparseable", () => {
    expect(
      videoStatusLine({
        has_video: true,
        mime: "video/webm",
        duration_ms: null,
        created_at: null,
      }),
    ).toBe("A video message is saved.");
    expect(
      videoStatusLine({
        has_video: true,
        mime: "video/webm",
        duration_ms: null,
        created_at: "not-a-date",
      }),
    ).toBe("A video message is saved.");
  });
});
