/**
 * Plain-English copy for every error a heir can see on the claim flow.
 *
 * All copy for the failure paths in `ClaimPage.tsx` lives here so:
 *   - a reviewer can read it in one place,
 *   - a translation pass has a single file to localise,
 *   - the calling component never has to think about phrasing — it
 *     calls `classifyClaimError(e, context, errors)` and renders the result.
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
import { type ClaimErrorsCopy } from "./vocab/types";

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

function buildEntries(errors: ClaimErrorsCopy): Entry[] {
  return [
    {
      matches: (_s, raw, ctx) =>
        /destination:/i.test(raw) && (ctx === "send" || ctx === "build"),
      copy: { ...errors.destinationMismatch, kind: "fixable" },
    },
    {
      matches: (_s, raw) => /no utxos? found/i.test(raw),
      copy: { ...errors.noUtxos, kind: "contact" },
    },
    {
      matches: (_s, raw, ctx) =>
        ctx === "broadcast" && /not fully signed/i.test(raw),
      copy: { ...errors.psbtNotFullySigned, kind: "fixable" },
    },
    {
      matches: (_s, raw) => /timelock|not.{0,3}matured/i.test(raw),
      copy: { ...errors.timelockNotMatured, kind: "wait" },
    },
    {
      matches: (_s, raw) => /esplora/i.test(raw),
      copy: { ...errors.esploraDown, kind: "wait" },
    },
    {
      matches: (_s, raw, ctx) =>
        ctx === "probe" && /this vault was not created with/i.test(raw),
      copy: { ...errors.olderFormat, kind: "contact" },
    },
    {
      matches: (status) => status === 500,
      copy: { ...errors.serverError, kind: "wait" },
    },
    {
      matches: (_s, raw) => /poly1305|invalid tag|decryp/i.test(raw),
      copy: { ...errors.linkIncomplete, kind: "contact" },
    },
  ];
}

function buildGenericByContext(errors: ClaimErrorsCopy): Record<ClaimContext, ClaimErrorCopy> {
  return {
    resolve: { ...errors.genericResolve, kind: "wait" },
    probe: { ...errors.genericProbe, kind: "wait" },
    send: { ...errors.genericSend, kind: "wait" },
    build: { ...errors.genericBuild, kind: "wait" },
    broadcast: { ...errors.genericBroadcast, kind: "fixable" },
  };
}

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
  errors: ClaimErrorsCopy,
): ClaimErrorCopy {
  const status: number | null = e instanceof ApiError ? e.status : null;
  const raw = rawErrorMessage(e);
  for (const entry of buildEntries(errors)) {
    if (entry.matches(status, raw, context)) return entry.copy;
  }
  return buildGenericByContext(errors)[context];
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
export function allClaimErrorCopies(errors: ClaimErrorsCopy): {
  context: ClaimContext;
  label: string;
  copy: ClaimErrorCopy;
}[] {
  const out: { context: ClaimContext; label: string; copy: ClaimErrorCopy }[] =
    [];
  const generic = buildGenericByContext(errors);
  const entries = buildEntries(errors);
  for (const ctx of ["resolve", "probe", "send", "build", "broadcast"] as const) {
    out.push({
      context: ctx,
      label: `${ctx}: generic fallback`,
      copy: generic[ctx],
    });
  }
  for (let i = 0; i < entries.length; i++) {
    out.push({
      context: "send",
      label: `entry #${i + 1}`,
      copy: entries[i].copy,
    });
  }
  return out;
}
