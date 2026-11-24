/**
 * Check-in helpers.
 *
 * Checking in is free: "I'm still here" on the dashboard, or the link in
 * a reminder email followed by one tap. There is no payment and no
 * last-resort window.
 */

/** What one heir's check-in attempt did. */
export type CheckinAttempt =
  | "checked-in"
  /** Refused for a reason that is normal for this heir right now:
   *  already checked in this period, or already claimed. */
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
 * (already checked in this period, or already claimed), and aborting on
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
