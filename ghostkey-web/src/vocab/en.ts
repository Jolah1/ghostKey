/**
 * English baseline copy — the reference every other language mirrors.
 * Migrated verbatim from the old `vocab.ts` so behaviour is unchanged.
 */
import { makeStatus, type Vocab } from "./types";

export const en: Vocab = {
  langName: "English",
  tagline: "Bitcoin inheritance, without the lawyers.",
  longTagline:
    "Set up once. Tap once a month to say you're here. If you ever stop, the people you chose can claim what's theirs.",
  status: makeStatus({
    unfunded: {
      label: "Awaiting funding",
      long: "Send Bitcoin to your vault to activate it. Check-ins start once it's funded.",
    },
    ok: {
      label: "Active",
      long: "Everything is in order.",
    },
    warning: {
      label: "Tap soon",
      long: "A reminder is coming up. Tap when you can.",
    },
    alarmed: {
      label: "Reminder missed",
      long: "Tap now to reset the clock. Nothing is lost yet.",
    },
    timelock_started: {
      label: "Claim issued",
      long: "Your heir was sent the claim link.",
    },
    claiming: {
      label: "Claiming",
      long: "Your heir is broadcasting the claim transaction.",
    },
    claimed: {
      label: "Passed on",
      long: "This vault has been claimed.",
    },
    frozen: {
      label: "Panic stop",
      long: "You triggered a panic. The vault is frozen for 90 days.",
    },
  }),
};
