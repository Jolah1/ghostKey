import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { unlockErrorMessage } from "./unlockErrors";

const WRONG = "That password didn't unlock the vault. Check it and try again.";

describe("unlockErrorMessage", () => {
  it("blames the password only when decryption failed", () => {
    expect(unlockErrorMessage(new Error("invalid tag"))).toBe(WRONG);
    expect(unlockErrorMessage(new Error("poly1305 mismatch"))).toBe(WRONG);
  });

  it("doesn't blame the password for a dropped connection", () => {
    const msg = unlockErrorMessage(new TypeError("Failed to fetch"));
    expect(msg).not.toBe(WRONG);
    expect(msg).toContain("Your password may be fine");
  });

  it("doesn't blame the password when the phone runs out of memory", () => {
    const msg = unlockErrorMessage(new RangeError("Array buffer allocation failed"));
    expect(msg).not.toBe(WRONG);
    expect(msg).toContain("Try again");
  });

  it("passes the server's own message through", () => {
    expect(
      unlockErrorMessage(new ApiError(400, null, "this vault has no password")),
    ).toBe("this vault has no password");
  });
});
