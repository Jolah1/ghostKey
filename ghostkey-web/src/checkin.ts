/**
 * Check-in policy helpers.
 *
 * Lightning is the check-in. The free "check in without paying" tap is a
 * last resort, not an everyday option, so it can never cannibalise
 * Lightning. It is only offered when BOTH of these hold:
 *
 *   1. a Lightning check-in has actually failed (the caller decides this,
 *      e.g. the Lightning modal is in its error state), and
 *   2. we are inside the final 24h before the heir would be contacted.
 *
 * The heir is contacted at `claim_eligible_at` (the server's
 * `alarmed -> claimable` transition). This computes the time half of the
 * gate; the caller pairs it with "Lightning failed".
 */
const LAST_RESORT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * True once we are within 24h of the heir being contacted (and after,
 * while a check-in can still stop the claim). Outside that window the
 * free fallback stays hidden so Lightning is the only way to check in.
 */
export function lastResortCheckinOpen(
  claimEligibleAt: string | null | undefined,
  now: Date,
): boolean {
  if (!claimEligibleAt) return false;
  const eligible = new Date(claimEligibleAt).getTime();
  if (Number.isNaN(eligible)) return false;
  return eligible - now.getTime() <= LAST_RESORT_WINDOW_MS;
}
