/**
 * Check-in helpers.
 *
 * Checking in is free and works any time: signing in with your password
 * counts, as do "I'm still here" on the dashboard and the one-tap link in
 * a reminder email. Each moves the deadline to a full waiting period from
 * now. There is no payment and no last-resort window.
 */
import { ApiError, api } from "./api";
import { getAllVaultMetas, getVaultOwnerToken } from "./vaultStore";

/** What one heir's check-in attempt did. */
export type CheckinAttempt =
  | "checked-in"
  /** Refused for a reason that is normal for this heir right now:
   *  not funded yet, no heir chosen yet, or already claimed. */
  | "skipped"
  | { error: string };

export type FanOutTally = {
  checkedIn: number;
  skipped: number;
  /** First unexpected failure, if any. */
  hardError: string | null;
};

/**
 * Check in every heir in a multi-heir group, one after another.
 *
 * The rule that matters here: a heir that refuses does NOT stop the
 * others. A group can hold a heir who can't be checked in right now
 * (not funded yet, or already claimed), and aborting on
 * the first refusal would leave every heir behind it in the list with a
 * clock nobody reset. The caller decides what the tally means; this
 * just guarantees each heir gets its attempt.
 */
export async function fanOutCheckin(
  vaultIds: string[],
  attempt: (id: string) => Promise<CheckinAttempt>,
): Promise<FanOutTally> {
  const tally: FanOutTally = { checkedIn: 0, skipped: 0, hardError: null };
  for (const id of vaultIds) {
    const outcome = await attempt(id);
    if (outcome === "checked-in") tally.checkedIn += 1;
    else if (outcome === "skipped") tally.skipped += 1;
    else if (!tally.hardError) tally.hardError = outcome.error;
  }
  return tally;
}

/** Check in these vaults with their owner tokens on this device. A 409
 *  (not funded, no heir yet, claimed) is a normal skip. */
export function checkInVaults(vaultIds: string[]): Promise<FanOutTally> {
  return fanOutCheckin(vaultIds, async (id) => {
    try {
      await api.checkin(id, getVaultOwnerToken(id));
      return "checked-in";
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) return "skipped";
      return { error: e instanceof ApiError ? e.message : String(e) };
    }
  });
}

/** Signing in with your password is proof of life: check in every vault
 *  this device holds an owner key for. Quiet: a failure here only means
 *  the reminder emails keep their schedule. */
export async function checkInAfterSignIn(): Promise<void> {
  const ids = getAllVaultMetas()
    .filter((m) => getVaultOwnerToken(m.id))
    .map((m) => m.id);
  if (ids.length === 0) return;
  await checkInVaults(ids).catch(() => undefined);
}
