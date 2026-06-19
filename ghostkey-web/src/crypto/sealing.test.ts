import { describe, it, expect } from "vitest";
import { b64decode, b64encode } from "./sealing";

describe("b64decode", () => {
  it("round-trips standard base64 (our own seals)", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(b64decode(b64encode(bytes))).toEqual(bytes);
  });

  it("decodes a base64url-no-pad token the same as its base64 form", () => {
    // 0xfb,0xff,0xbf encodes to "+/+/" in standard base64 and "-_-_"
    // in base64url — the two characters that differ between alphabets.
    const std = "+/+/";
    const url = "-_-_";
    expect(b64decode(url)).toEqual(b64decode(std));
  });

  it("tolerates missing padding (base64url-no-pad, 43 chars)", () => {
    // A server-minted claim token: 32 bytes, base64url, no '=' padding.
    const bytes = new Uint8Array(32).map((_, i) => i * 7);
    const urlNoPad = b64encode(bytes)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(b64decode(urlNoPad)).toEqual(bytes);
  });
});
