/**
 * Add Heir reported every failure as a wrong password, including a
 * missing credential — telling owners they had lost a password they
 * still had. Only a failed unseal may claim that.
 */
import { describe, expect, it } from "vitest";

import { isUnsealFailure, MissingOwnerToken } from "./AddHeirPortal";

describe("isUnsealFailure", () => {
  it("recognises the AEAD failures browsers actually throw", () => {
    for (const msg of [
      "poly1305 tag mismatch",
      "invalid tag",
      "decryption failed",
      "OperationError: The operation failed for an operation-specific reason: decrypt",
    ]) {
      expect(isUnsealFailure(new Error(msg))).toBe(true);
    }
  });

  it("does not claim a missing credential is a wrong password", () => {
    expect(isUnsealFailure(new MissingOwnerToken())).toBe(false);
  });

  it("does not claim an unrelated failure is a wrong password", () => {
    expect(isUnsealFailure(new Error("Failed to fetch"))).toBe(false);
    expect(isUnsealFailure(new Error("network timeout"))).toBe(false);
  });
});
