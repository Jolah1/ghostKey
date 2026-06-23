/**
 * One-tap check-in page (Lightning).
 *
 * The owner gets here by tapping the link in a pre-deadline reminder or an
 * alarm email. The URL carries a per-cycle link token. Lightning is the
 * check-in: this page shows a tiny BOLT11 invoice (minted with the link
 * token, no sign-in needed) and paying it resets the countdown.
 *
 * The free "check in without paying" fallback only appears inside the
 * Lightning modal's error state, and the server only honours it in the
 * final 24h before the heir would be contacted (see `checkin_from_link`).
 * So the free path is a true last resort, not a way around Lightning.
 *
 * States, in display order:
 *   - "paying"  — the Lightning modal is the whole page (first paint).
 *   - "ok"      — checked in, via a paid invoice or the last-resort tap.
 *   - "error"   — the last-resort tap was refused (e.g. outside the 24h
 *                 window) or otherwise failed.
 *
 * No GhostKey navbar on this page (App hides it): the link arrived in an
 * email and the owner came here to do one thing.
 */
import { useState, type ReactNode } from "react";
import { Button } from "./ui";
import { ApiError, api, type CheckinResponse } from "./api";
import type { Route } from "./App";
import { parseRfc } from "./time";
import { LightningCheckin } from "./LightningCheckin";

type State =
  | { kind: "paying" }
  | { kind: "ok"; resp: CheckinResponse | null }
  | { kind: "error"; message: string };

interface Props {
  vaultId: string;
  token: string;
  onNavigate: (r: Route) => void;
}

export function OneTapCheckinPage({ vaultId, token, onNavigate }: Props) {
  const [state, setState] = useState<State>({ kind: "paying" });

  // Last-resort free check-in, only offered inside the Lightning modal's
  // error state. The server refuses it outside the final 24h window, which
  // surfaces here as an error message.
  async function freeCheckin() {
    try {
      const resp = await api.checkinFromLink(vaultId, token);
      setState({ kind: "ok", resp });
    } catch (e) {
      const message =
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : String(e);
      setState({ kind: "error", message });
    }
  }

  if (state.kind === "ok") {
    return (
      <Shell>
        <Success resp={state.resp} onNavigate={onNavigate} />
      </Shell>
    );
  }

  if (state.kind === "error") {
    return (
      <Shell>
        <Failed message={state.message} onNavigate={onNavigate} />
      </Shell>
    );
  }

  // Paying: the Lightning modal renders as the whole page.
  return (
    <LightningCheckin
      vaultId={vaultId}
      ownerToken={null}
      linkToken={token}
      onPaid={() => setState({ kind: "ok", resp: null })}
      onClose={() => onNavigate("dashboard")}
      onFreeCheckin={freeCheckin}
    />
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="bg-app fade-in">
      <div className="mx-auto flex max-w-xl flex-col items-center px-5 py-24 text-center md:py-32">
        {children}
      </div>
    </main>
  );
}

function Success({
  resp,
  onNavigate,
}: {
  resp: CheckinResponse | null;
  onNavigate: (r: Route) => void;
}) {
  // When the check-in came from a paid invoice we don't have the new
  // deadline to hand (the poller did it), so fall back to generic copy.
  const dateLine = resp
    ? parseRfc(resp.next_deadline_at).toLocaleString(undefined, {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;
  return (
    <>
      <div
        aria-hidden="true"
        className="flex h-20 w-20 items-center justify-center rounded-full"
        style={{
          background: "var(--accent-tint)",
          border: "1px solid var(--accent)",
        }}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--accent-text)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-8 w-8"
        >
          <path d="M20 6L9 17l-5-5" />
        </svg>
      </div>
      <h1 className="mt-6 font-serif text-3xl md:text-4xl">You&apos;re checked in</h1>
      <p className="mt-3 max-w-md text-muted">
        Thanks.{" "}
        {dateLine ? (
          <>
            Your next reminder is on{" "}
            <span className="font-medium text-[var(--text)]">{dateLine}</span>.{" "}
          </>
        ) : (
          <>Your countdown is reset. </>
        )}
        Nothing else to do.
      </p>
      <div className="mt-10 flex gap-3">
        <Button onClick={() => onNavigate("dashboard")} size="lg">
          Open dashboard
        </Button>
      </div>
    </>
  );
}

function Failed({
  message,
  onNavigate,
}: {
  message: string;
  onNavigate: (r: Route) => void;
}) {
  return (
    <>
      <div
        aria-hidden="true"
        className="flex h-20 w-20 items-center justify-center rounded-full bg-surface-2"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--text)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-8 w-8 opacity-60"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M12 8v4M12 16h.01" />
        </svg>
      </div>
      <h1 className="mt-6 font-serif text-3xl md:text-4xl">Couldn&apos;t check in</h1>
      <p className="mt-3 max-w-md text-muted">{message}</p>
      <div className="mt-10 flex gap-3">
        <Button onClick={() => onNavigate("dashboard")} size="lg">
          Open dashboard
        </Button>
      </div>
    </>
  );
}
