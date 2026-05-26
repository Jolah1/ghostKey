/**
 * Shared cadence + grace presets for both setup wizards.
 *
 * Two knobs the owner sets at vault creation:
 *
 *   1. checkinSecs  — how often we remind them to confirm they're alive.
 *                     Shorter = safer (less time for the heir to wait) but
 *                     more annoying. Longer = friendlier but a missed
 *                     reminder eats more of the budget before the alarm.
 *
 *   2. graceSecs   — how long after a missed reminder before the vault
 *                     moves from `ok` → `alarmed`. This is the buffer for
 *                     "I was on holiday and didn't check email." After the
 *                     vault enters `alarmed` we wait one more graceSecs
 *                     before issuing the heir's claim token (see
 *                     `claim_eligible_at` in routes.rs).
 *
 * Both are exposed as small enumerations rather than free-form numeric
 * inputs so a careless user can't pick e.g. graceSecs=60. The presets
 * cover the realistic spectrum: from "I want to be reminded weekly and
 * have a tight 3-day budget" to "I want a quarterly nudge and a full
 * month of slack before anyone gets contacted."
 */

const DAY = 86_400;

export interface CadencePreset {
  id: string;
  label: string;
  sub: string;
  seconds: number;
}

export interface GracePreset {
  id: string;
  label: string;
  sub: string;
  seconds: number;
}

/**
 * Check-in cadence presets. Ordered most-frequent → least-frequent.
 * The "recommended" one in the UI is `bi-weekly` to match the existing
 * default before this expansion.
 */
export const CADENCE_PRESETS: readonly CadencePreset[] = [
  {
    id: "weekly",
    label: "Every week",
    sub: "Tightest budget",
    seconds: 7 * DAY,
  },
  {
    id: "bi-weekly",
    label: "Every 2 weeks",
    sub: "Recommended",
    seconds: 14 * DAY,
  },
  {
    id: "monthly",
    label: "Every month",
    sub: "More relaxed",
    seconds: 30 * DAY,
  },
  {
    id: "quarterly",
    label: "Every 3 months",
    sub: "Set-and-forget",
    seconds: 90 * DAY,
  },
] as const;

/**
 * Grace-period presets — the extra slack on top of the check-in
 * cadence before the vault alarms. The default of 3 days matches what
 * the legacy code hard-coded; keeping it as the recommended option
 * preserves behaviour for users who don't touch the picker.
 */
export const GRACE_PRESETS: readonly GracePreset[] = [
  {
    id: "3d",
    label: "3 days",
    sub: "Recommended",
    seconds: 3 * DAY,
  },
  {
    id: "1w",
    label: "1 week",
    sub: "If you travel often",
    seconds: 7 * DAY,
  },
  {
    id: "2w",
    label: "2 weeks",
    sub: "Long trips",
    seconds: 14 * DAY,
  },
  {
    id: "1m",
    label: "1 month",
    sub: "Maximum slack",
    seconds: 30 * DAY,
  },
] as const;

export const DEFAULT_CADENCE_ID = "bi-weekly";
export const DEFAULT_GRACE_ID = "3d";

export function cadenceById(id: string): CadencePreset {
  return CADENCE_PRESETS.find((c) => c.id === id) ?? CADENCE_PRESETS[1];
}

export function graceById(id: string): GracePreset {
  return GRACE_PRESETS.find((g) => g.id === id) ?? GRACE_PRESETS[0];
}
