/**
 * One-tap check-in page.
 *
 * The owner gets here by tapping the link in a pre-deadline reminder or an
 * alarm email. The URL carries a per-cycle link token. Checking in is free:
 * one button, and the token is the only credential needed.
 *
 * The check-in happens on the button press, NEVER on page load. Mail
 * security scanners (Outlook Safe Links, Gmail and others) open links
 * automatically, and a dead owner's inbox would otherwise keep checking in
 * forever, so the heir would never be contacted. A person has to tap.
 *
 * States, in display order:
 *   - "ready"   - asks "Still here?" with one button (first paint).
 *   - "sending" - the button is busy.
 *   - "ok"      - checked in.
 *   - "error"   - refused (already used, already checked in this period,
 *                 claimed) or failed.
 *
 * No GhostKey navbar on this page (App hides it): the link arrived in an
 * email and the owner came here to do one thing.
 */
import { useState, type ReactNode } from "react";
import { Button } from "./ui";
import { ApiError, api, type CheckinResponse } from "./api";
import type { Route } from "./App";
import { parseRfc } from "./time";

type State =
  | { kind: "ready" }
  | { kind: "sending" }
  | { kind: "ok"; resp: CheckinResponse }
  | { kind: "error"; message: string };

interface Props {
  vaultId: string;
  token: string;
  onNavigate: (r: Route) => void;
}

export function OneTapCheckinPage({ vaultId, token, onNavigate }: Props) {
  const [state, setState] = useState<State>({ kind: "ready" });

  async function checkin() {
    setState({ kind: "sending" });
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

  return (
    <Shell>
      <h1 className="font-serif text-3xl md:text-4xl">Still here?</h1>
      <p className="mt-3 max-w-md text-muted">
        Tap the button to check in. It&apos;s free and resets your countdown.
      </p>
      <div className="mt-10 flex gap-3">
        <Button
          onClick={() => void checkin()}
          loading={state.kind === "sending"}
          size="lg"
        >
          Yes, I&apos;m still here
        </Button>
      </div>
    </Shell>
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
  resp: CheckinResponse;
  onNavigate: (r: Route) => void;
}) {
  const dateLine = parseRfc(resp.next_deadline_at).toLocaleString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
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
        Thanks. Your next reminder is on{" "}
        <span className="font-medium text-[var(--text)]">{dateLine}</span>.
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
