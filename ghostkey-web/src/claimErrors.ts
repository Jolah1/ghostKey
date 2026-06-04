/**
 * Plain-English copy for every error a heir can see on the claim flow.
 *
 * All copy for the failure paths in `ClaimPage.tsx` lives here so:
 *   - a reviewer can read it in one place,
 *   - a translation pass has a single file to localise,
 *   - the calling component never has to think about phrasing — it
 *     calls `classifyClaimError(e, context)` and renders the result.
 *
 * Each entry has a calm headline, a short body, and a concrete next
 * step. The tone follows the same rule as the rest of the heir flow
 * (see `DESIGN.md` "Why the heir flow is special"): no Bitcoin jargon,
 * no apologetic over-explanation, no exclamation marks. The reader
 * may be grieving; the page must feel steady.
 *
 * "Contact the person who set this up" is the standard escalation —
 * GhostKey has no support inbox today, and the owner who configured
 * the inheritance is the only person who can issue a new claim link.
 * Keep that phrasing consistent.
 */

import { ApiError } from "./api";

export type ClaimErrorKind =
  /** The heir can change something on this page and try again. */
  | "fixable"
  /** The heir must wait for an external condition (chain confirms,
   *  server recovers, etc.) — retry is fine, but no input to change. */
  | "wait"
  /** Beyond the heir's reach. Direct them to the person who set this
   *  up; no retry button. */
  | "contact";

export interface ClaimErrorCopy {
  headline: string;
  body: string;
  nextStep: string;
  kind: ClaimErrorKind;
}

/**
 * The point in the flow where the error fired. The same raw server
 * message can mean different things in different contexts — e.g. a
 * "no UTXOs" during `send` vs `broadcast` reads to a heir as the same
 * "the vault is empty" idea, but in `build` the right reading is
 * "we haven't seen any funds yet". Most matchers are context-free; a
 * few key on `ctx`.
 */
export type ClaimContext =
  | "resolve" // GET /claim/:token
  | "probe" // GET /claim/:token/{sealed-heir,heir-derivation-params}
  | "send" // POST /claim/:token/heir-claim (one-shot)
  | "build" // POST /claim/:token/build-psbt (legacy manual)
  | "broadcast"; // POST /claim/:token/broadcast (legacy manual)

interface Entry {
  matches: (status: number | null, raw: string, ctx: ClaimContext) => boolean;
  copy: ClaimErrorCopy;
}

const ENTRIES: Entry[] = [
  // Address rejection on send / build. The server prefixes
  // `validation: destination: <bdk parse error>`. In practice this is
  // almost always "you pasted a mainnet address into a testnet vault"
  // or vice versa — same wallet, wrong network toggle.
  {
    matches: (_s, raw, ctx) =>
      /destination:/i.test(raw) && (ctx === "send" || ctx === "build"),
    copy: {
      headline: "That address doesn't fit",
      body: "The address you pasted doesn't match the network this Bitcoin is on. They look similar but start with different letters.",
      nextStep:
        "Open your wallet, make sure it's on the right network, and copy a fresh address.",
      kind: "fixable",
    },
  },

  // Nothing at the vault addresses. Server: `validation: no UTXOs
  // found at vault addresses`. Happens when the vault was never
  // funded, or when funds were already moved out by someone else.
  {
    matches: (_s, raw) => /no utxos? found/i.test(raw),
    copy: {
      headline: "There's nothing to claim yet",
      body: "The vault is empty right now. Either it hasn't been funded, or someone has already moved the Bitcoin out.",
      nextStep:
        "Contact the person who set this up — they can tell you whether to wait or whether nothing was ever inside.",
      kind: "contact",
    },
  },

  // PSBT not fully signed. Manual-PSBT flow only. Reaches us as
  // `validation: build: PSBT not fully signed; cannot finalize. Sign
  // with the heir's wallet first.` (despite being a broadcast error,
  // the server wraps it in the `build:` prefix).
  {
    matches: (_s, raw, ctx) =>
      ctx === "broadcast" && /not fully signed/i.test(raw),
    copy: {
      headline: "Your signature isn't complete",
      body: "The pre-signed transaction came back without all the signatures it needs.",
      nextStep:
        "Open the transaction in your wallet again, finish signing, and paste the new result back here.",
      kind: "fixable",
    },
  },

  // Timelock not yet matured. The chain has not yet mined the block
  // height that releases the funds. Heir can only wait.
  {
    matches: (_s, raw) => /timelock|not.{0,3}matured/i.test(raw),
    copy: {
      headline: "The waiting period isn't over",
      body: "Bitcoin enforces a delay between when the alarm fired and when the funds can be moved. The clock runs on the chain, not on this server.",
      nextStep:
        "Come back to this page in a few hours. Your link is still valid.",
      kind: "wait",
    },
  },

  // Chain indexer (Esplora) is unreachable. Server: `validation:
  // esplora: <reason>`. Heir can't fix this; they can only retry.
  {
    matches: (_s, raw) => /esplora/i.test(raw),
    copy: {
      headline: "We can't reach the Bitcoin network right now",
      body: "Our connection to the public Bitcoin index is down. This is a temporary outage on our side.",
      nextStep: "Try again in a few minutes. Your link is still valid.",
      kind: "wait",
    },
  },

  // The two probe-only "this vault is the wrong shape for this
  // endpoint" signals. They should never reach the heir in normal
  // operation — they're how the web detects which sub-flow applies —
  // but if our detection logic slips, the calm contact copy is the
  // right fallback rather than leaking "validation: this vault was
  // not created with..." to the heir.
  {
    matches: (_s, raw, ctx) =>
      ctx === "probe" && /this vault was not created with/i.test(raw),
    copy: {
      headline: "This link uses an older format",
      body: "The way this vault was set up is supported, but our automatic detection got confused.",
      nextStep:
        "Contact the person who set this up so we can help finish the claim by hand.",
      kind: "contact",
    },
  },

  // Server-side internal error (500). The server hides the inner
  // reason from the response body; we mirror that to the heir rather
  // than guess.
  {
    matches: (status) => status === 500,
    copy: {
      headline: "Something went wrong on our end",
      body: "This isn't something you can fix from your side, and your link is still valid.",
      nextStep:
        "Try again in a few minutes. If it keeps happening, contact the person who set this up.",
      kind: "wait",
    },
  },

  // Client-side: Poly1305 / ChaCha20 tag mismatch when unwrapping the
  // heir xprv from the URL fragment. The cause is always the same —
  // the link got truncated when shared via SMS, WhatsApp, or copy/
  // paste — and the only recovery is asking the sender to share again.
  {
    matches: (_s, raw) => /poly1305|invalid tag|decryp/i.test(raw),
    copy: {
      headline: "Your link looks incomplete",
      body: "Part of this link carries the key needed to unlock the inheritance. The link we received isn't whole — usually because it got cut off when it was shared.",
      nextStep: "Ask the person who sent it to share the full link again.",
      kind: "contact",
    },
  },
];

const GENERIC_BY_CONTEXT: Record<ClaimContext, ClaimErrorCopy> = {
  resolve: {
    headline: "We couldn't open your link",
    body: "Something went wrong loading the page. This isn't anything you did.",
    nextStep:
      "Try again in a moment. If it keeps happening, ask the sender to re-share the link.",
    kind: "wait",
  },
  probe: {
    headline: "We hit a snag opening your link",
    body: "We couldn't read the details for this inheritance.",
    nextStep:
      "Try again in a moment. If it keeps happening, contact the person who set this up.",
    kind: "wait",
  },
  send: {
    headline: "We couldn't complete the transfer",
    body: "Something went wrong sending the Bitcoin. The transfer didn't go through, and your link is still valid.",
    nextStep:
      "Try again in a few minutes. If it keeps happening, contact the person who set this up.",
    kind: "wait",
  },
  build: {
    headline: "We couldn't prepare the transaction",
    body: "Something went wrong putting the transaction together. Your link is still valid.",
    nextStep:
      "Try again in a few minutes. If it keeps happening, contact the person who set this up.",
    kind: "wait",
  },
  broadcast: {
    headline: "We couldn't send the transaction",
    body: "Something went wrong publishing the signed transaction. Your link is still valid — the funds haven't moved.",
    nextStep:
      "Open the transaction in your wallet again, sign it cleanly, and paste the result back here.",
    kind: "fixable",
  },
};

/**
 * Map any error thrown on the heir-claim path to plain-English copy.
 * Falls back to a generic message keyed on `context` when no specific
 * entry matches — we never want a raw server string ("validation:
 * stored vault: descriptor parse error") to land in front of a heir.
 *
 * The raw message remains available via `rawErrorMessage(e)` so the
 * caller can stash it behind a "Show technical details" toggle for
 * Bitcoin-literate helpers debugging from the heir's side.
 */
export function classifyClaimError(
  e: unknown,
  context: ClaimContext,
): ClaimErrorCopy {
  const status: number | null = e instanceof ApiError ? e.status : null;
  const raw = rawErrorMessage(e);
  for (const entry of ENTRIES) {
    if (entry.matches(status, raw, context)) return entry.copy;
  }
  return GENERIC_BY_CONTEXT[context];
}

/** Best-effort extraction of the raw error string for display in a
 *  collapsible "technical details" section. */
export function rawErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return String(e);
}

/** Used by the `?debug=claim-errors` review route in `App.tsx` to
 *  render every state without having to drive each one through the
 *  real backend. Order is the visual review order, not entry order. */
export function allClaimErrorCopies(): {
  context: ClaimContext;
  label: string;
  copy: ClaimErrorCopy;
}[] {
  const out: { context: ClaimContext; label: string; copy: ClaimErrorCopy }[] =
    [];
  for (const ctx of ["resolve", "probe", "send", "build", "broadcast"] as const) {
    out.push({
      context: ctx,
      label: `${ctx}: generic fallback`,
      copy: GENERIC_BY_CONTEXT[ctx],
    });
  }
  for (let i = 0; i < ENTRIES.length; i++) {
    out.push({
      context: "send",
      label: `entry #${i + 1}`,
      copy: ENTRIES[i].copy,
    });
  }
  return out;
}
