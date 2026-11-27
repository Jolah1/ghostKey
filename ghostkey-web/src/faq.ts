/**
 * Common questions, shown on the website's front page and on the in-app
 * Help page. One list so the two can't drift. Every answer must match
 * what the app does today: when a flow changes, change its answer here.
 */
export interface FaqItem {
  q: string;
  a: string;
  /** Also shown on the website's front page (the full list is on Help). */
  home?: boolean;
  /** About locked goals: shown only once the server has them. */
  lockedOnly?: boolean;
}

export const FAQS: FaqItem[] = [
  {
    q: "Do I have to name someone to inherit?",
    a: "No. Saving is the main thing, and passing it on is optional. Add someone whenever you're ready, from the Inheritance page.",
    home: true,
  },
  {
    q: "What happens if I lose my phone or computer?",
    home: true,
    a: "Nothing is tied to one device. Sign in from any browser with your email and password and your savings are right there. For a deeper emergency, download your recovery file from the Recovery kit page: it reaches your money without GhostKey at all. Keep a copy somewhere safe.",
  },
  {
    q: "What if I forget my password?",
    home: true,
    a: "There is no reset, because GhostKey never receives your password. It is used only on your device to unlock your key. You lose time, not money: if you stop signing in, the person you chose can claim after the wait. If you kept their heir file and code, you can use them yourself once the wait passes. A password manager is the best protection.",
  },
  {
    q: "What does a check-in cost?",
    a: "Nothing. Signing in to GhostKey is your check-in. No transaction is sent and no bitcoin moves. If you don't sign in for the wait you chose (3 to 12 months), we email you first. If you still don't, the person you chose can claim.",
  },
  {
    q: "Are there fees?",
    home: true,
    a: "GhostKey takes no cut and has no subscription. You pay the normal Bitcoin network fee when you add money on-chain, when you send, and when your heir claims. When you send, you see the fee before anything moves. Adding money by Lightning goes through an independent swap service, which charges its own fee (see below).",
  },
  {
    q: "What does adding money by Lightning cost?",
    a: "GhostKey charges nothing. The swap service takes a small percentage plus the Bitcoin network fees, and the app shows the fee before you pay. The network part is fixed, so small deposits lose much more as a share: on a few thousand sats it can be close to half. The bitcoin lands after one confirmation, usually 10 to 20 minutes, while GhostKey is open on your device. If you close it, it finishes the next time you open GhostKey. If anything fails, your Lightning wallet gets the money back.",
  },
  {
    q: "Why does some money say “on the way”?",
    a: "New bitcoin needs one confirmation on the Bitcoin network, usually about 10 minutes, before it counts. Until then it shows as on the way and can't be sent yet.",
  },
  {
    q: "What is the heir code?",
    a: "Five words your heir needs to claim. Only you and they know it: GhostKey never sees it, so you give it to them yourself. You can see it again on the Inheritance page, under how your heir is reached.",
  },
  {
    q: "Can my heir claim early?",
    a: "No. The wait is locked into Bitcoin itself: your heir can claim only once your bitcoin has sat untouched for the whole wait. Adding or moving money starts that wait again for the money moved; signing in keeps your plan active but doesn't. Until the wait runs out, nobody can move the funds. Not your heir, not us.",
  },
  {
    q: "Can I change my heir after setting up?",
    a: "You can add another heir at any time, each with their own share. To change who inherits an existing share, or its wait, send that share to your own wallet and set up again with the new details. While you keep signing in, nothing moves without you.",
  },
  {
    q: "Can I take my bitcoin out?",
    home: true,
    a: "Always. Until your heir actually claims, you can send your savings anywhere with your own key, in one transaction.",
  },
  {
    q: "What kinds of Bitcoin can I deposit?",
    a: "Any bitcoin, from any wallet or exchange. Send it on-chain, or pay by Lightning. Your browser checks the address is really yours before showing it. We never hold your money, and your key never leaves your device.",
  },
  {
    q: "What if GhostKey shuts down?",
    home: true,
    a: "When you choose an heir, you can download a file for them that opens with their heir code. If GhostKey ever disappears, that file walks them through claiming straight from the Bitcoin network. Your own recovery file, from the Recovery kit page, does the same for you.",
  },
  {
    q: "Is this a legal will?",
    a: "No. GhostKey passes on bitcoin you hold yourself. Most people use it alongside a normal will, which still covers everything else.",
  },
];
