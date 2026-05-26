/**
 * Time formatting helpers for the deadline countdown.
 *
 * Pure functions, no React. Parsed timestamps are RFC3339 strings as
 * produced by ghostkey-server (chrono `to_rfc3339()`).
 *
 * Two flavors of pretty output:
 *
 * - `prettyDuration` — compact `1d 4h 13m 02s`, good for cards.
 * - `friendlyDuration` — plain English, e.g. "in 4 days", "5 minutes
 *   ago". Used in the dashboard hero so non-technical users can read
 *   it at a glance.
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
  /** Compact representation, e.g. "2d 4h 13m". */
  pretty: string;
  /** English representation, e.g. "in 4 days", "5 minutes ago". */
  friendly: string;
}

export function countdown(target: Date, now: Date = new Date()): Countdown {
  const ms = target.getTime() - now.getTime();
  return {
    ms,
    pretty: prettyDuration(ms),
    friendly: friendlyDuration(ms),
  };
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
  parts.push(`${s.toString().padStart(2, "0")}s`);
  return sign + parts.join(" ");
}

function friendlyDuration(ms: number): string {
  const abs = Math.abs(ms);
  const suffix = ms < 0 ? "ago" : "from now";
  const prefix = ms < 0 ? "" : "in ";
  const out = (n: number, unit: string) =>
    `${prefix}${n} ${unit}${n === 1 ? "" : "s"}${ms < 0 ? " " + suffix : ""}`.trim();

  if (abs < 60_000) return out(Math.max(1, Math.floor(abs / 1000)), "second");
  if (abs < 3_600_000) return out(Math.floor(abs / 60_000), "minute");
  if (abs < 86_400_000) return out(Math.floor(abs / 3_600_000), "hour");
  if (abs < 604_800_000) return out(Math.floor(abs / 86_400_000), "day");
  if (abs < 2_592_000_000) return out(Math.floor(abs / 604_800_000), "week");
  return out(Math.floor(abs / 2_592_000_000), "month");
}
