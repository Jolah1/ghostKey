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
  claim: {
    header: "Message for you",
    loading: "We dey open your link…",
    notFound: {
      eyebrow: "This link no dey work",
      title: "We no fit find anything for this link",
      body: "The link fit no complete, don expire, or dem copy am wrong. If person send you am for SMS or WhatsApp, tell dem make dem send am again from start.",
    },
    alreadyUsed: {
      eyebrow: "Dem don open this link before",
      title: "E be like say person don reach here before",
      body: "Claim link dey work only once. If you don collect wetin dem leave for you, you don finish. If you never, talk to the person wey set am up. Dem fit send new link.",
    },
    timelockWait: {
      eyebrow: "Your inheritance",
      title: "Your money dey come",
      etaBefore: "Wetin dem leave for you go open for Bitcoin network around ",
      etaAfter:
        ". Nothing dey for you to do. We go email you when e ready, and you fit come back with this same link.",
      noEta:
        "We still dey confirm the money for Bitcoin network. Nothing dey for you to do. Check back small time with this same link.",
      note: "Bitcoin dey hold inheritance for some time before dem fit collect am.",
    },
    safetyWait: {
      eyebrow: "We don near",
      title: "Your claim don start. Small safety wait dey",
      body1:
        "You don do everything well, and dem dey prepare wetin dem leave for you. To protect everybody, every claim get small waiting time before dem fit collect anything.",
      body2Before:
        "We go email you once everything ready, so you no need to remember or dey check. You fit also come back ",
      body2After: " with this same link.",
      note: "Why the wait? E dey give the person wey set am up one last chance to respond if na mistake start this claim. If nothing change, your claim go continue by itself.",
    },
    notReady: {
      eyebrow: "Never yet",
      title: "Time never reach",
      body: "The person wey set am up still dey active. Nothing dey for you to do today. You go get new message if anything change.",
      nextCheckin: (friendly) => `Next check-in ${friendly}.`,
    },
    alreadyClaimed: {
      eyebrow: "Done",
      title: "Dem don pass this one already",
      body: (label) =>
        `${
          label ? `Dem don claim "${label}" before.` : "Dem don claim this inheritance before."
        } Nothing dey again to do here.`,
    },
  },
};
