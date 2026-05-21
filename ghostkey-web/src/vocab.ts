/**
 * User-facing copy.
 *
 * Tone: direct, emotional, plain. No "savings", no "vault" in body copy
 * (we keep "vault" in technical/internal labels). No em-dash overload,
 * no "simply", "delve", "robust" — none of the AI tells.
 */
import type { VaultStatus } from "./api";

export const brand = {
  name: "GhostKey",
  tagline: "Bitcoin inheritance, without the lawyers.",
  longTagline:
    "Set up once. Tap once a month to say you're here. If you ever stop, the people you chose can claim what's theirs.",
};

export const portals = {
  setup: {
    title: "Set up your vault",
    blurb: "Five minutes. No documents. No lawyers.",
  },
  checkin: {
    title: "I'm still here",
    blurb: "Tap to reset the clock and let your people know you're around.",
  },
  inherit: {
    title: "Someone left you something",
    blurb: "Look up the vault you were named in. We'll tell you what to do.",
  },
  dashboard: {
    title: "You're still here",
  },
};

export function statusCopy(status: VaultStatus): {
  label: string;
  long: string;
  tone: "ok" | "warning" | "alarm" | "neutral";
} {
  switch (status) {
    case "ok":
      return {
        label: "Active",
        long: "Everything is in order.",
        tone: "ok",
      };
    case "warning":
      return {
        label: "Tap soon",
        long: "A reminder is coming up. Tap when you can.",
        tone: "warning",
      };
    case "alarmed":
      return {
        label: "Reminder missed",
        long: "Tap now to reset the clock. Nothing is lost yet.",
        tone: "alarm",
      };
    case "timelock_started":
      return {
        label: "Countdown running",
        long: "The waiting period has started.",
        tone: "alarm",
      };
    case "claimed":
      return {
        label: "Passed on",
        long: "This vault has been claimed.",
        tone: "neutral",
      };
  }
}
