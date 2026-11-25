import { describe, expect, it } from "vitest";
import { shouldNudgeInstall } from "./InstallNudge";

const iphone = {
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1",
  platform: "iPhone",
  maxTouchPoints: 5,
  standalone: false,
};

describe("shouldNudgeInstall", () => {
  it("asks iPhone and iPad users who opened GhostKey in Safari", () => {
    expect(shouldNudgeInstall(iphone, false)).toBe(true);
    expect(shouldNudgeInstall({ userAgent: "Mozilla/5.0 (Macintosh)", platform: "MacIntel", maxTouchPoints: 5, standalone: false }, false)).toBe(true);
  });
  it("leaves alone the installed app, a dismissal, Android and desktops", () => {
    expect(shouldNudgeInstall({ ...iphone, standalone: true }, false)).toBe(false);
    expect(shouldNudgeInstall(iphone, true)).toBe(false);
    expect(shouldNudgeInstall({ userAgent: "Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile", platform: "Linux armv8l", maxTouchPoints: 5, standalone: false }, false)).toBe(false);
    expect(shouldNudgeInstall({ userAgent: "Mozilla/5.0 (Macintosh)", platform: "MacIntel", maxTouchPoints: 0, standalone: false }, false)).toBe(false);
  });
});
