/**
 * Savings maths for the savings card (#367). Pure, so it's tested on
 * its own.
 *
 * Progress toward a goal uses the vault's balance (what will be there when
 * it's needed). The "save about X a week" line is PiggyVest's savings
 * calculator idea: how much each time, to reach the goal by the date.
 * Everything is in sats, the unit the money is actually in.
 */

const DAY_MS = 86_400_000;

export function goalProgress(
  balanceSat: number,
  goalSat: number,
): { pct: number; reached: boolean; remainingSat: number } {
  const remainingSat = Math.max(0, goalSat - balanceSat);
  const pct = goalSat > 0 ? Math.min(100, Math.floor((balanceSat / goalSat) * 100)) : 0;
  return { pct, reached: remainingSat === 0, remainingSat };
}

/**
 * How much to put aside each week (and month, when there's at least two)
 * to cover `remainingSat` by `targetDate` (YYYY-MM-DD, end of that day,
 * local). Null when nothing is left to save or the date has passed.
 * Rounds up, so following it always reaches the goal.
 */
export function savePerPeriod(
  remainingSat: number,
  now: Date,
  targetDate: string,
): { perWeek: number; perMonth: number | null } | null {
  if (remainingSat <= 0) return null;
  const [y, m, d] = targetDate.split("-").map(Number);
  if (!y || !m || !d) return null;
  const end = new Date(y, m - 1, d, 23, 59, 59).getTime();
  const msLeft = end - now.getTime();
  if (msLeft <= 0) return null;
  const weeks = Math.max(1, Math.ceil(msLeft / (7 * DAY_MS)));
  const months = Math.floor(msLeft / (30.44 * DAY_MS));
  return {
    perWeek: Math.ceil(remainingSat / weeks),
    perMonth: months >= 2 ? Math.ceil(remainingSat / months) : null,
  };
}

/**
 * What was put aside in the calendar month `now` falls in (local time),
 * for the dashboard headline. Counts every deposit that landed this
 * month, including ones since moved out: the saving still happened.
 */
export function addedThisMonth(
  deposits: { amount_sat: number; seen_at: string }[],
  now: Date,
): number {
  let total = 0;
  for (const d of deposits) {
    const t = new Date(d.seen_at);
    if (t.getFullYear() === now.getFullYear() && t.getMonth() === now.getMonth()) {
      total += d.amount_sat;
    }
  }
  return total;
}

/** Quick picks for "What are you saving for?". Anything else is typed. */
export const GOAL_PRESETS = [
  "School fees",
  "Rent",
  "Emergency fund",
  "House",
  "Business",
  "Wedding",
  "Travel",
  "Car",
] as const;

/**
 * What to show as saved in each goal, and what isn't in any goal.
 *
 * Goals are a ledger over one balance, so a send made outside GhostKey
 * (the recovery kit, Bitcoin Core) never reaches them and they can add up
 * to more than is there. Each goal shows at most the real balance, and
 * when together they claim more than the balance, they share it in
 * proportion, so the screen never promises money that isn't there.
 * With no balance known yet, the ledger figures are shown as they are.
 */
export function goalShares(
  savedSat: number[],
  balanceSat: number | null,
): { shown: number[]; notInGoalSat: number | null } {
  const saved = savedSat.map((s) => Math.max(0, s));
  if (balanceSat == null) return { shown: saved, notInGoalSat: null };
  const total = saved.reduce((a, b) => a + b, 0);
  if (total <= balanceSat) {
    return { shown: saved, notInGoalSat: balanceSat - total };
  }
  const shown = saved.map((s) => Math.floor((s * balanceSat) / total));
  return { shown, notInGoalSat: 0 };
}
