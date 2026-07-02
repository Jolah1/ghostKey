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
  claim: {
    header: "A message for you",
    loading: "Opening your link…",
    notFound: {
      eyebrow: "This link doesn't work",
      title: "We couldn't find anything for this link",
      body: "The link may be incomplete, expired, or copied wrong. If someone gave you this by SMS or WhatsApp, ask them to send it again from the start.",
    },
    alreadyUsed: {
      eyebrow: "This link has already been opened",
      title: "Looks like someone has been here before",
      body: "A claim link works once. If you've already received what was left for you, you're done. If you haven't, contact the person who set this up. They can issue a new link.",
    },
    timelockWait: {
      eyebrow: "Your inheritance",
      title: "Your funds are on the way",
      etaBefore: "What was left for you unlocks on the Bitcoin network around ",
      etaAfter:
        ". There's nothing for you to do. We'll email you when it's ready, and you can come back using this same link.",
      noEta:
        "We're still confirming the funds on the Bitcoin network. There's nothing for you to do. Check back shortly using this same link.",
      note: "Bitcoin holds an inheritance for a set time before it can be collected.",
    },
    safetyWait: {
      eyebrow: "Almost there",
      title: "Your claim has started. There's a short safety wait",
      body1:
        "You've done everything right, and what was left for you is being prepared. For everyone's protection, every claim includes a short waiting period before anything can be collected.",
      body2Before:
        "We'll email you the moment everything's ready, so you don't have to remember or keep checking. You can also come back ",
      body2After: " using this same link.",
      note: "Why the wait? It gives the person who set this up one last chance to respond if this claim was started by mistake. If nothing changes, your claim continues automatically.",
    },
    notReady: {
      eyebrow: "Not yet",
      title: "It's not time yet",
      body: "The person who set this up is still active. There's nothing for you to do today. You'll receive a new message if anything changes.",
      nextCheckin: (friendly) => `Next check-in ${friendly}.`,
    },
    alreadyClaimed: {
      eyebrow: "Done",
      title: "This has already been passed on",
      body: (label) =>
        `${
          label ? `"${label}" was claimed earlier.` : "This inheritance was claimed earlier."
        } Nothing more to do here.`,
    },
  },
};
