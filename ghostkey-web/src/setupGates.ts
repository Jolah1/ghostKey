/**
 * Pure validation gates for vault setup, extracted so they can be unit
 * tested and reused as both the "can I advance / create" predicate and
 * the button-disable condition (#116 L2).
 *
 * The owner's password is the only thing that can ever unlock the vault
 * key — GhostKey cannot reset it. So "Create vault" must be impossible to
 * trigger unless the password meets the bar, the confirmation matches,
 * and the owner has attested they saved it. Keeping this logic in one
 * pure function means the UI gate and the test assert exactly the same
 * thing, with no React in the way.
 */
import { MIN_LENGTH, type StrengthResult } from "./passwordStrength";

export interface PasswordStepInput {
  ownerEmail: string;
  password: string;
  passwordConfirm: string;
  /** The "I have saved my password" attestation checkbox. */
  savedPassword: boolean;
  /** Live zxcvbn verdict; `null` while it's still being computed. */
  strength: StrengthResult | null;
}

/**
 * Returns a human-readable reason the password step isn't ready, or
 * `null` when it is. The order matters: it surfaces the first thing the
 * owner should fix, top to bottom.
 */
export function passwordStepError(input: PasswordStepInput): string | null {
  const { ownerEmail, password, passwordConfirm, savedPassword, strength } =
    input;

  if (!ownerEmail.trim()) {
    return "Your email lets you recover this vault on any device. We never use it for marketing.";
  }
  if (!/^.+@.+\..+$/.test(ownerEmail.trim())) {
    return "That email looks off. Double-check it.";
  }
  if (password.length < MIN_LENGTH) {
    return `Pick a password that's at least ${MIN_LENGTH} characters. Longer is better.`;
  }
  // Gate on the live zxcvbn verdict. `strength` can lag the keystroke by
  // ~150 ms; if the user outraces it, hold them for a beat rather than
  // let an unchecked password through.
  if (strength === null) {
    return "One moment. Still checking that password.";
  }
  if (!strength.acceptable) {
    return (
      strength.advice ??
      "That password would be too easy to guess. Try three or four unrelated words."
    );
  }
  if (password !== passwordConfirm) {
    return "The two passwords don't match.";
  }
  if (!savedPassword) {
    return "Save your password first, then tick the box to confirm. We can never reset it for you.";
  }
  return null;
}

/** Convenience boolean for disabling the "Create vault" button. */
export function canCreateVault(input: PasswordStepInput): boolean {
  return passwordStepError(input) === null;
}

/* One check per setup screen. Each returns the reason that screen
 * can't move on, or null. `passwordStepError` above still gates the
 * final create, so a skipped screen can't slip through. */

export function emailError(ownerEmail: string): string | null {
  if (!ownerEmail.trim()) return "Add your email to sign in on other devices.";
  if (!/^.+@.+\..+$/.test(ownerEmail.trim())) return "That email looks off. Double-check it.";
  return null;
}

export function newPasswordError(password: string, strength: StrengthResult | null): string | null {
  if (password.length < MIN_LENGTH) {
    return `At least ${MIN_LENGTH} characters. Longer is better.`;
  }
  if (strength === null) return "One moment. Still checking it.";
  if (!strength.acceptable) {
    return strength.advice ?? "Too easy to guess. Try three or four unrelated words.";
  }
  return null;
}

export function confirmError(password: string, passwordConfirm: string): string | null {
  return password === passwordConfirm ? null : "The two passwords don't match.";
}
