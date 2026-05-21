/**
 * User-facing vocabulary for the app.
 *
 * The product is for anyone who has someone they want to pass Bitcoin
 * onto — that includes families, but also partners, business
 * co-founders, charities, friends. We deliberately avoid the word
 * "family" as the *default* framing, but keep warmth in the tone.
 *
 * Underlying protocol vocabulary       → User-facing word
 *   vault                              → savings
 *   check-in                           → "I'm OK today" tap
 *   owner                              → you
 *   heir                               → who you've named
 *   timelock                           → waiting period
 *   deadline                           → reminder
 */

import type { VaultStatus } from "./api";

export const brand = {
  name: "GhostKey",
  tagline: "Bitcoin savings the people you've named can inherit.",
  longTagline:
    "Set aside Bitcoin so that someone you've named — a partner, child, co-founder, friend, charity — can inherit it if you ever can't. No lawyers, no shared passwords.",
};

/**
 * Animated cascading hero words. Order matters; each appears with a
 * 60ms delay.
 */
export const heroWords = [
  { text: "Bitcoin",       color: "bitcoin" as const },
  { text: "that outlives", color: "ink"     as const },
  { text: "you.",          color: "ink"     as const },
];

/** Plain-language explanation pieces, reused across landing + portals. */
export const explain = {
  whatIsThis:
    "Put aside Bitcoin you want someone else to inherit. Once a week (or however often you choose) you tap a button to say you're still around. If you ever stop tapping, the person you've named can claim the money on their own — no lawyers, no permission needed.",
  whyTrust:
    "The rules live on Bitcoin itself, not on our website. Even if this project disappeared tomorrow, the promise to whoever you named is still safe.",
  privacy:
    "Your password (the seed phrase) never leaves your computer. This website only sees the public part — enough to track reminders, never enough to spend.",
  notAWill:
    "GhostKey is not a legal will. It's a programmable way to leave Bitcoin to someone. Most people use it alongside a regular will.",
};

/** Title + blurb + CTA for each top-level portal. */
export const portals = {
  setup: {
    title: "Set up savings",
    blurb:
      "Create a new pot of Bitcoin savings and choose who would inherit it. Takes about 10 minutes.",
    cta: "Start setting up",
  },
  checkin: {
    title: "I'm OK today",
    blurb:
      "Tap below to reset the reminder timer and confirm you're still around.",
    cta: "Tap to say I'm OK",
  },
  inherit: {
    title: "Inherit savings",
    blurb:
      "If you've been named to inherit Bitcoin savings, look them up here. We'll tell you when you can claim.",
    cta: "Look up savings",
  },
};

/** Map server VaultStatus → friendly label + tone. */
export function statusCopy(status: VaultStatus): {
  label: string;
  tone: "ok" | "warning" | "alarmed" | "neutral";
  longLabel: string;
} {
  switch (status) {
    case "ok":
      return {
        label: "All good",
        longLabel: "The savings are safe and active.",
        tone: "ok",
      };
    case "warning":
      return {
        label: "Tap soon",
        longLabel: "Remember to tap I'm OK soon.",
        tone: "warning",
      };
    case "alarmed":
      return {
        label: "Reminder missed",
        longLabel:
          "A reminder was missed. Tap I'm OK now to reset everything.",
        tone: "alarmed",
      };
    case "timelock_started":
      return {
        label: "Waiting period running",
        longLabel:
          "The countdown to the inheritor receiving the money has started.",
        tone: "alarmed",
      };
    case "claimed":
      return {
        label: "Passed on",
        longLabel: "These savings have already been claimed.",
        tone: "neutral",
      };
  }
}
