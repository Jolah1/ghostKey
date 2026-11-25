/**
 * Words for savings challenges. Pure, so every line is tested. The
 * server works out the numbers (see the server's challenges.rs); this
 * only says them.
 */
import type { ChallengeView } from "./api";
import { formatAmount, type Unit } from "./units";

const DAY_MS = 86_400_000;

/** Week-1 amounts offered for the 52-week challenge. */
export const WEEK1_PRESETS = [1_000, 2_000, 5_000] as const;
/** 1 + 2 + ... + 52. */
export const WEEK52_UNITS = 1378;
export const HOLD_MONTHS = [3, 6, 12] as const;

function shortDate(ymd: string): string {
  return new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** "Don't touch it for 6 months", "School fees by 31 Dec 2026", … */
export function challengeName(c: ChallengeView, goalTitle?: string | null): string {
  switch (c.kind) {
    case "hold":
      return `Don't touch it for ${c.hold_months} months`;
    case "goal_by_date":
      return `${goalTitle || "Your goal"}${c.target_date ? ` by ${shortDate(c.target_date)}` : ""}`;
    case "every_month":
      return `Save every month of ${c.year}`;
    case "week52":
      return "52-week challenge";
  }
}

/** The one line under a going challenge. */
export function challengeStatus(c: ChallengeView, unit: Unit, now: Date): string {
  const amt = (s: number) => formatAmount(s, unit);
  switch (c.kind) {
    case "hold": {
      const left = c.ends_at ? Math.ceil((new Date(c.ends_at).getTime() - now.getTime()) / DAY_MS) : 0;
      return left > 0 ? `${left} day${left === 1 ? "" : "s"} to go` : "Finishing at the next check";
    }
    case "goal_by_date": {
      const head = `${amt(c.saved_sat ?? 0)} of ${amt(c.target_sat ?? 0)}`;
      return c.on_track
        ? `${head} · on track`
        : `${head} · about ${amt(c.per_week_sat ?? 0)} a week gets you there`;
    }
    case "every_month": {
      const months = c.months ?? [];
      const from = (c.from_month ?? 1) - 1;
      const needed = months.slice(from);
      const done = needed.filter(Boolean).length;
      return `${done} of ${needed.length} month${needed.length === 1 ? "" : "s"} so far`;
    }
    case "week52": {
      const head = `Week ${c.week} · this week ${amt(c.this_week_sat ?? 0)}`;
      if (c.on_track) return `${head} · on track`;
      return `${head} · ${amt(Math.max(0, (c.due_so_far_sat ?? 0) - (c.saved_sat ?? 0)))} to catch up`;
    }
  }
}

/** The quiet Home line. Null when there's nothing worth a line. */
export function homeChallengeLine(challenges: ChallengeView[], hasSaved: boolean): string | null {
  const going = challenges.filter((c) => c.state === "going").length;
  if (going > 0) return `${going} challenge${going === 1 ? "" : "s"} going`;
  return hasSaved ? "Try a savings challenge" : null;
}

/** Finished in the last two weeks and not yet waved off on this device:
 *  the "You did it" moment on Home. */
export function freshWins(challenges: ChallengeView[], seen: string[], now: Date): ChallengeView[] {
  return challenges.filter(
    (c) =>
      c.state === "done" &&
      c.completed_at != null &&
      now.getTime() - new Date(c.completed_at).getTime() < 14 * DAY_MS &&
      !seen.includes(c.id),
  );
}

const SEEN_KEY = "gk:challengeWinsSeen";

export function seenWins(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function markWinSeen(id: string): void {
  try {
    const next = [...seenWins().filter((x) => x !== id), id].slice(-50);
    localStorage.setItem(SEEN_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}
