/**
 * Nigerian Pidgin (PCM) — FIRST DRAFT, NOT YET REVIEWED.
 *
 * ⚠️  These strings were drafted by a non-native writer and MUST be
 * reviewed for tone and accuracy by a Pidgin speaker before this is
 * considered done (see #204 — human review is the gating step). Treat
 * every line here as a placeholder to correct, not a final translation.
 * Keep the same keys as `en.ts`; only the wording changes.
 */
import { makeStatus, type Vocab } from "./types";

export const pcm: Vocab = {
  langName: "Pidgin",
  tagline: "Make your Bitcoin reach your people, no lawyer wahala.",
  longTagline:
    "Set am once. Every month, tap to show say you dey. If you ever stop, the people wey you choose fit collect wetin be their own.",
  status: makeStatus({
    unfunded: {
      label: "Dey wait for money",
      long: "Send Bitcoin go your vault make e start. Check-in go begin once money enter.",
    },
    ok: {
      label: "E dey work",
      long: "Everything dey alright.",
    },
    warning: {
      label: "Tap soon",
      long: "Reminder dey come. Tap when you fit.",
    },
    alarmed: {
      label: "You miss reminder",
      long: "Tap now make the clock reset. Nothing never lost.",
    },
    timelock_started: {
      label: "We don send claim",
      long: "We don send the claim link give your heir.",
    },
    claiming: {
      label: "Dem dey claim",
      long: "Your heir dey broadcast the claim transaction.",
    },
    claimed: {
      label: "Don pass to dem",
      long: "Dem don claim this vault.",
    },
    frozen: {
      label: "Panic stop",
      long: "You trigger panic. The vault go freeze for 90 days.",
    },
  }),
};
