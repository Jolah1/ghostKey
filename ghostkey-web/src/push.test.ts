/**
 * iOS install-hint detection (#224). Wrong answers here either nag
 * Android/desktop users with an irrelevant "add to home screen" tip,
 * or leave iPhone owners with no path to reminders at all.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { isIosBrowserNeedingInstall } from "./push";

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const IPAD_OS13_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Mobile Safari/537.36";

function stubEnv(opts: {
  ua: string;
  maxTouchPoints?: number;
  standalone?: boolean;
  displayModeStandalone?: boolean;
}) {
  vi.stubGlobal("navigator", {
    userAgent: opts.ua,
    maxTouchPoints: opts.maxTouchPoints ?? 0,
    standalone: opts.standalone,
  });
  vi.stubGlobal("window", {
    matchMedia: (q: string) => ({
      matches: q === "(display-mode: standalone)"
        ? (opts.displayModeStandalone ?? false)
        : false,
    }),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isIosBrowserNeedingInstall", () => {
  it("true for iPhone Safari in the browser", () => {
    stubEnv({ ua: IPHONE_UA });
    expect(isIosBrowserNeedingInstall()).toBe(true);
  });

  it("true for iPadOS masquerading as macOS (touch gives it away)", () => {
    stubEnv({ ua: IPAD_OS13_UA, maxTouchPoints: 5 });
    expect(isIosBrowserNeedingInstall()).toBe(true);
  });

  it("false once installed (navigator.standalone)", () => {
    stubEnv({ ua: IPHONE_UA, standalone: true });
    expect(isIosBrowserNeedingInstall()).toBe(false);
  });

  it("false once installed (display-mode: standalone)", () => {
    stubEnv({ ua: IPHONE_UA, displayModeStandalone: true });
    expect(isIosBrowserNeedingInstall()).toBe(false);
  });

  it("false on Android — the offer card handles it there", () => {
    stubEnv({ ua: ANDROID_UA });
    expect(isIosBrowserNeedingInstall()).toBe(false);
  });

  it("false on real desktop macOS (no touch points)", () => {
    stubEnv({ ua: IPAD_OS13_UA, maxTouchPoints: 0 });
    expect(isIosBrowserNeedingInstall()).toBe(false);
  });
});
