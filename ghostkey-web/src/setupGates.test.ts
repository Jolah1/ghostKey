import { describe, it, expect } from "vitest";
import { canCreateVault, passwordStepError } from "./setupGates";
import { MIN_LENGTH, type StrengthResult } from "./passwordStrength";

const strong: StrengthResult = {
  score: 4,
  acceptable: true,
  tone: "good",
  label: "Strong",
  advice: null,
};

// A fully valid step: long, strong password, matching confirm, box ticked.
const goodPw = "correct horse battery staple";
const valid = {
  ownerEmail: "owner@example.com",
  password: goodPw,
  passwordConfirm: goodPw,
  savedPassword: true,
  strength: strong,
};

describe("passwordStepError / canCreateVault", () => {
  it("accepts a complete, valid step", () => {
    expect(passwordStepError(valid)).toBeNull();
    expect(canCreateVault(valid)).toBe(true);
  });

  it("blocks an empty or malformed email", () => {
    expect(canCreateVault({ ...valid, ownerEmail: "  " })).toBe(false);
    expect(canCreateVault({ ...valid, ownerEmail: "not-an-email" })).toBe(
      false,
    );
  });

  it("blocks a too-short password", () => {
    const short = "a".repeat(MIN_LENGTH - 1);
    expect(
      canCreateVault({ ...valid, password: short, passwordConfirm: short }),
    ).toBe(false);
  });

  it("blocks while strength is still computing (null)", () => {
    expect(canCreateVault({ ...valid, strength: null })).toBe(false);
    expect(passwordStepError({ ...valid, strength: null })).toMatch(
      /still checking/i,
    );
  });

  it("blocks a weak password and surfaces its advice", () => {
    const weak: StrengthResult = {
      score: 1,
      acceptable: false,
      tone: "bad",
      label: "Weak",
      advice: "Try three or four unrelated words.",
    };
    expect(canCreateVault({ ...valid, strength: weak })).toBe(false);
    expect(passwordStepError({ ...valid, strength: weak })).toContain(
      "unrelated words",
    );
  });

  it("blocks when the confirmation doesn't match", () => {
    expect(
      canCreateVault({ ...valid, passwordConfirm: goodPw + "x" }),
    ).toBe(false);
    expect(
      passwordStepError({ ...valid, passwordConfirm: goodPw + "x" }),
    ).toMatch(/don't match/i);
  });

  it("blocks until the 'I saved my password' box is ticked", () => {
    expect(canCreateVault({ ...valid, savedPassword: false })).toBe(false);
    expect(passwordStepError({ ...valid, savedPassword: false })).toMatch(
      /save your password/i,
    );
  });
});
