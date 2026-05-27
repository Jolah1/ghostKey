/**
 * One-tap check-in page.
 *
 * The owner gets here by tapping the link in a pre-deadline reminder
 * or an alarm-fired email. The URL carries a per-cycle bearer token
 * the server minted when it enqueued the email; we POST it to
 * `/vaults/:id/checkin-from-link/:token` and tell the owner the
 * deadline has been reset.
 *
 * Three states, in display order:
 *
 *   - "checking-in" — first paint, while the POST is in flight.
 *   - "ok"          — server accepted the tap; show "you're checked in"
 *                     plus the new next-deadline.
 *   - "expired"     — link doesn't match anything live (404), or has
 *                     already been tapped (409). Same user-visible
 *                     message: this link doesn't work, here's the
 *                     dashboard instead.
 *
 * We fire the POST exactly ONCE on mount. React 18 strict mode
 * double-mounts effects in development, which would naturally produce
 * a 409 on the second mount and confuse the user. The ref-based guard
 * below is the standard pattern for "this effect must run exactly once
 * even under strict mode."
 *
 * No GhostKey navbar on this page. The link arrived in an email; the
 * owner came here to do one thing. Nav clutter is the wrong move.
 */
import { useEffect, useRef, useState } from "react";
import { Button } from "./ui";
import { ApiError, api, type CheckinResponse } from "./api";
import type { Route } from "./App";
import { parseRfc } from "./time";

type State =
  | { kind: "checking-in" }
  | { kind: "ok"; resp: CheckinResponse }
  | { kind: "expired" };

interface Props {
  vaultId: string;
  token: string;
  onNavigate: (r: Route) => void;
}

export function OneTapCheckinPage({ vaultId, token, onNavigate }: Props) {
  const [state, setState] = useState<State>({ kind: "checking-in" });
  // React 18 strict mode double-mounts effects in dev. Without the
  // guard, the second mount POSTs the (now-used) token and we'd flash
  // "expired" right after a successful tap. The ref persists across
  // re-mounts; the value is checked AND set inside the effect.
  const firedRef = useRef(false);

  useEffect(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    let alive = true;
    (async () => {
      try {
        const resp = await api.checkinFromLink(vaultId, token);
        if (alive) setState({ kind: "ok", resp });
      } catch (e) {
        // 404 (link doesn't exist) and 409 (already used) both map
        // to "expired" from the user's perspective. Any other error
        // we surface as expired too: the safe default is "this link
        // doesn't work, go check your dashboard" rather than an
        // unhelpful error stack.
        if (e instanceof ApiError && (e.status === 404 || e.status === 409)) {
          if (alive) setState({ kind: "expired" });
        } else {
          // Network error / 5xx. Same UX — better than leaving the
          // owner staring at a spinner that never resolves.
          if (alive) setState({ kind: "expired" });
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [vaultId, token]);

  return (
    <main className="bg-app fade-in">
      <div className="mx-auto flex max-w-xl flex-col items-center px-5 py-24 text-center md:py-32">
        {state.kind === "checking-in" && <Checking />}
        {state.kind === "ok" && <Success resp={state.resp} onNavigate={onNavigate} />}
        {state.kind === "expired" && <Expired onNavigate={onNavigate} />}
      </div>
    </main>
  );
}

function Checking() {
  return (
    <>
      <div
        aria-hidden="true"
        className="flex h-20 w-20 items-center justify-center rounded-full bg-surface-2"
      >
        <span className="inline-block h-6 w-6 animate-spin rounded-full border-2 border-current border-r-transparent text-muted" />
      </div>
      <h1 className="mt-6 font-serif text-3xl md:text-4xl">Checking you in</h1>
      <p className="mt-3 text-muted">One moment.</p>
    </>
  );
}

function Success({
  resp,
  onNavigate,
}: {
  resp: CheckinResponse;
  onNavigate: (r: Route) => void;
}) {
  const next = parseRfc(resp.next_deadline_at);
  // RFC3339 next-deadline rendered as a calendar-friendly line. The
  // browser's locale formatter is good enough here; we deliberately
  // don't use the dashboard's countdown component because the owner
  // came from an email — they want a date, not a ticking clock.
  const dateLine = next.toLocaleString(undefined, {
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

function Expired({ onNavigate }: { onNavigate: (r: Route) => void }) {
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
      <h1 className="mt-6 font-serif text-3xl md:text-4xl">This link doesn&apos;t work anymore</h1>
      <p className="mt-3 max-w-md text-muted">
        Either it&apos;s already been used, or your next reminder cycle
        already started. Either way, your vault is fine. Open the
        dashboard to check in there.
      </p>
      <div className="mt-10 flex gap-3">
        <Button onClick={() => onNavigate("dashboard")} size="lg">
          Open dashboard
        </Button>
        <Button
          onClick={() => onNavigate("checkin")}
          variant="ghost"
          size="lg"
        >
          Sign in
        </Button>
      </div>
    </>
  );
}
