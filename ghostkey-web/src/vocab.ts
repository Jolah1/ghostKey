/**
 * Family-friendly vocabulary mapping.
 *
 * Single source of truth for every user-facing string in the app. The
 * underlying protocol uses words like "vault", "check-in", "heir",
 * "timelock", and "descriptor" — all accurate, all opaque to a
 * non-technical user. This file translates each of those concepts into
 * plain language a 12-year-old can follow.
 *
 * Anywhere in the UI that needs to talk about the protocol must import
 * from here instead of inlining a string, so a single change ripples
 * out cleanly.
 */

import type { VaultStatus } from "./api";

/** App-wide identity. */
export const brand = {
  name: "GhostKey",
  tagline: "Bitcoin savings your family can inherit.",
  longTagline:
    "Set aside money in a way that your family can claim if you ever can't — without lawyers, without giving anyone your password.",
};

/** Protocol concept ↔ family-friendly word. */
export const term = {
  /** "Vault" → a pot of family savings. */
  vault: "family savings",
  vaults: "family savings",
  /** "Check-in" → tapping the "I'm OK" button. */
  checkin: "I'm OK today",
  checkinShort: "I'm OK",
  checkinVerb: "say I'm OK",
  /** "Owner" → the parent / saver. */
  owner: "you",
  /** "Heir" → who you've named. */
  heir: "who inherits",
  /** "Timelock" → wait period. */
  timelock: "waiting period",
  /** "Deadline" → reminder day. */
  deadline: "reminder",
  /** "Status" levels. */
  ok: "all good",
  warning: "remember to tap soon",
  alarmed: "reminder missed",
  timelockStarted: "waiting period started",
  claimed: "passed to family",
};

/** Map a server VaultStatus to its friendly label + tone. */
export function statusCopy(status: VaultStatus): {
  label: string;
  tone: "ok" | "warning" | "alarmed" | "neutral";
  longLabel: string;
} {
  switch (status) {
    case "ok":
      return {
        label: "All good",
        longLabel: "Your family is safe.",
        tone: "ok",
      };
    case "warning":
      return {
        label: "Tap soon",
        longLabel: "Remember to tap \"I'm OK\" soon.",
        tone: "warning",
      };
    case "alarmed":
      return {
        label: "Reminder missed",
        longLabel:
          "You missed a reminder. Tap \"I'm OK\" now to reset everything.",
        tone: "alarmed",
      };
    case "timelock_started":
      return {
        label: "Waiting period running",
        longLabel:
          "The countdown to your family receiving the money has started.",
        tone: "alarmed",
      };
    case "claimed":
      return {
        label: "Passed to family",
        longLabel: "These savings have been claimed by your family.",
        tone: "neutral",
      };
  }
}

/**
 * Short, declarative explanations used in tooltips, empty states, and
 * the landing page. Each is one or two plain sentences.
 */
export const explain = {
  whatIsThis:
    "Put aside Bitcoin you want your family to inherit. Once a week, you tap a button to say you're still here. If you ever stop tapping, your family can claim the money on their own — no lawyers, no permission needed.",
  whyTrust:
    "The rules live on Bitcoin itself, not on our website. Even if this site disappeared tomorrow, your family's promise is still safe.",
  howCheckin:
    "Tapping \"I'm OK\" is just like waving hello. It tells the system you're still around. Do it on a schedule you pick — daily, weekly, monthly.",
  howInherit:
    "Pick someone you trust to inherit the money — usually a partner, child, or sibling. They get nothing while you're tapping. The day you stop, a countdown starts. When it ends, the money is theirs to claim.",
  privacy:
    "Your password (we call it a seed phrase) never leaves your computer. This website only sees the public part — enough to track reminders, never enough to spend.",
};
