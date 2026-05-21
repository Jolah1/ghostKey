/**
 * Time formatting helpers for the deadline countdown.
 *
 * Pure functions, no React. Parsed timestamps are RFC3339 strings as
 * produced by ghostkey-server (chrono `to_rfc3339()`).
 */

export function parseRfc(ts: string): Date {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`bad timestamp: ${ts}`);
  }
  return d;
}

export interface Countdown {
  /** Total ms remaining; negative if the deadline has passed. */
  ms: number;
  /** Human-readable representation, e.g. "2d 4h 13m" or "-1m 12s". */
  pretty: string;
}

export function countdown(target: Date, now: Date = new Date()): Countdown {
  const ms = target.getTime() - now.getTime();
  return { ms, pretty: prettyDuration(ms) };
}

function prettyDuration(ms: number): string {
  const sign = ms < 0 ? "-" : "";
  let s = Math.floor(Math.abs(ms) / 1000);
  const days = Math.floor(s / 86400);
  s -= days * 86400;
  const hours = Math.floor(s / 3600);
  s -= hours * 3600;
  const mins = Math.floor(s / 60);
  s -= mins * 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours || days) parts.push(`${hours}h`);
  if (mins || hours || days) parts.push(`${mins}m`);
  parts.push(`${s}s`);
  return sign + parts.join(" ");
}

/** Approximate threshold for "warning" vs "ok" before the alarm trips. */
export function severityFromDeadline(
  cd: Countdown,
  graceSecs: number,
): "ok" | "warning" | "alarmed" {
  if (cd.ms <= 0) return "alarmed";
  // Within the last 25% of the grace period? Show "warning".
  if (cd.ms < graceSecs * 250) return "warning";
  return "ok";
}
