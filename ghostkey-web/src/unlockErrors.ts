import { ApiError } from "./api";

/**
 * Whether a thrown error is AEAD decryption failing, which is the only
 * thing that actually means "wrong password".
 *
 * unsealOwner surfaces the auth-tag check as an opaque error whose text
 * varies by browser, so we match the vocabulary rather than a type. Same
 * heuristic the sign-in portal uses.
 */
export function isUnsealFailure(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /poly1305|tag|invalid|decryp/i.test(msg);
}

/**
 * What to tell the owner when unlocking with their password failed.
 *
 * Only a failed unseal means the password is wrong. A dropped connection,
 * or a phone running out of memory while deriving the key, used to be
 * reported the same way, which told owners they had lost a password they
 * still had. For those we say so plainly and let them try again.
 */
export function unlockErrorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (isUnsealFailure(e)) {
    return "That password didn't unlock the vault. Check it and try again.";
  }
  return "Something went wrong unlocking your vault. Your password may be fine. Try again in a moment.";
}
