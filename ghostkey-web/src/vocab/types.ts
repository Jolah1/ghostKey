/**
 * i18n shell — string tables and shared shape (#204).
 *
 * One `Vocab` object per language (see `en.ts`, `pcm.ts`). Only
 * translatable copy lives here; the brand name is a constant and the
 * status *tone* is semantic (not language-specific), so both are shared
 * rather than duplicated per language.
 *
 * Tone rules carry over from the old vocab module: direct, emotional,
 * plain. No "savings", no "vault" in body copy, no AI tells.
 */
import type { VaultStatus } from "../api";

export type Lang = "en" | "pcm";

/** The brand name is never translated. */
export const brandName = "GhostKey";

export type Tone = "ok" | "warning" | "alarm" | "neutral";

export interface StatusCopy {
  label: string;
  long: string;
  tone: Tone;
}

/**
 * Status tone is semantic, not language-specific, so it's defined once
 * and composed with each language's text by {@link makeStatus}.
 */
export const STATUS_TONE: Record<VaultStatus, Tone> = {
  unfunded: "neutral",
  ok: "ok",
  warning: "warning",
  alarmed: "alarm",
  timelock_started: "alarm",
  claiming: "alarm",
  claimed: "neutral",
  frozen: "alarm",
};

/** Per-status label + long text, supplied by each language. */
export type StatusText = Record<VaultStatus, { label: string; long: string }>;

/** Compose a language's status text with the shared tone map. */
export function makeStatus(text: StatusText): (s: VaultStatus) => StatusCopy {
  return (s) => ({ ...text[s], tone: STATUS_TONE[s] });
}

export interface Vocab {
  /** Human name of this language, for the toggle (e.g. "English"). */
  langName: string;
  tagline: string;
  longTagline: string;
  status: (s: VaultStatus) => StatusCopy;
}
