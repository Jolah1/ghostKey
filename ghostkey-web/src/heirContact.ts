/**
 * When will the heir actually be contacted?
 *
 * The server contacts the heir only when BOTH clocks have run out:
 *   1. the server's: `claim_eligible_at` (check-in deadline + grace), and
 *   2. the chain's: the coins have sat untouched for the waiting period
 *      (`unlock_eta`, from the server's maturity scan).
 * It holds the email until (2) is close, so whichever clock ends later
 * is the one to show the owner.
 */
export type HeirContactDue = {
  /** The later of the two clocks, or null if neither is known. */
  due: Date | null;
  /** True when the chain clock is the one holding things up. */
  waitingOnChain: boolean;
};

export function heirContactDue(
  claimEligibleAt: string | null | undefined,
  unlockEta: string | null | undefined,
): HeirContactDue {
  const parse = (s: string | null | undefined) => {
    if (!s) return null;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const server = parse(claimEligibleAt);
  const chain = parse(unlockEta);
  if (chain && (!server || chain > server)) {
    return { due: chain, waitingOnChain: true };
  }
  return { due: server, waitingOnChain: false };
}
