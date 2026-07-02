import { describe, expect, it } from "vitest";
import { pickLang } from "./vocab";
import { en } from "./vocab/en";
import { pcm } from "./vocab/pcm";
import type { VaultStatus } from "./api";

describe("pickLang", () => {
  it("honours an explicit stored choice over the locale", () => {
    expect(pickLang("pcm", ["en-US"])).toBe("pcm");
    expect(pickLang("en", ["en-NG"])).toBe("en");
  });

  it("defaults Nigerian locales to Pidgin when nothing is stored", () => {
    expect(pickLang(null, ["en-NG"])).toBe("pcm");
    expect(pickLang(null, ["ha-NG", "en-US"])).toBe("pcm");
    expect(pickLang(null, ["EN-ng"])).toBe("pcm"); // case-insensitive
  });

  it("defaults non-Nigerian locales to English", () => {
    expect(pickLang(null, ["en-US"])).toBe("en");
    expect(pickLang(null, ["fr-FR", "en-GB"])).toBe("en");
    expect(pickLang(null, [])).toBe("en");
  });

  it("ignores a junk stored value and falls back to the locale", () => {
    expect(pickLang("klingon", ["en-NG"])).toBe("pcm");
    expect(pickLang("", ["en-US"])).toBe("en");
  });
});

describe("vocab tables", () => {
  const statuses: VaultStatus[] = [
    "unfunded",
    "ok",
    "warning",
    "alarmed",
    "timelock_started",
    "claiming",
    "claimed",
    "frozen",
  ];

  it("every language resolves copy for every status", () => {
    for (const s of statuses) {
      for (const v of [en, pcm]) {
        const c = v.status(s);
        expect(c.label.length).toBeGreaterThan(0);
        expect(c.long.length).toBeGreaterThan(0);
      }
    }
  });

  it("tone is shared (identical) across languages", () => {
    for (const s of statuses) {
      expect(en.status(s).tone).toBe(pcm.status(s).tone);
    }
  });
});
