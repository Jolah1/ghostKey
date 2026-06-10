/**
 * Email verification landing page.
 *
 * The owner gets here by tapping the confirmation link in the email
 * we send at vault creation (or after "send it again" on the
 * dashboard). The URL carries a bearer token the server minted when
 * it enqueued the email; we POST it to
 * `/vaults/:id/verify-contact/:token` and tell the owner reminders
 * will reach them.
 *
 * Mirrors OneTapCheckinPage's structure, including the strict-mode
 * single-fire guard: the POST is idempotent server-side (a second
 * tap of an already-verified link still 204s), but the guard keeps
 * dev behaviour identical to prod anyway.
 *
 * No navbar — the owner came from an email to do exactly one thing.
 */
import { useEffect, useRef, useState } from "react";
import { Button } from "./ui";
import { api } from "./api";
import type { Route } from "./App";

type State =
  | { kind: "confirming" }
  | { kind: "ok" }
  | { kind: "stale" };

interface Props {
  vaultId: string;
  token: string;
  onNavigate: (r: Route) => void;
}

export function VerifyEmailPage({ vaultId, token, onNavigate }: Props) {
  const [state, setState] = useState<State>({ kind: "confirming" });
  const firedRef = useRef(false);

  useEffect(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    let alive = true;
    (async () => {
      try {
        await api.verifyContact(vaultId, token);
        if (alive) setState({ kind: "ok" });
      } catch {
        // 404 (stale/replaced token) and any network/5xx failure get
        // the same calm copy: this link didn't work, ask for a fresh
        // one from the dashboard. No error stacks for email-clickers.
        if (alive) setState({ kind: "stale" });
      }
    })();
    return () => {
      alive = false;
    };
  }, [vaultId, token]);

  return (
    <main className="bg-app fade-in">
      <div className="mx-auto flex max-w-xl flex-col items-center px-5 py-24 text-center md:py-32">
        {state.kind === "confirming" && <Confirming />}
        {state.kind === "ok" && <Confirmed onNavigate={onNavigate} />}
        {state.kind === "stale" && <Stale onNavigate={onNavigate} />}
      </div>
    </main>
  );
}

function Confirming() {
  return (
    <>
      <div
        aria-hidden="true"
        className="flex h-20 w-20 items-center justify-center rounded-full bg-surface-2"
      >
        <span className="inline-block h-6 w-6 animate-spin rounded-full border-2 border-current border-r-transparent text-muted" />
      </div>
      <h1 className="mt-6 font-serif text-3xl md:text-4xl">Confirming your email</h1>
      <p className="mt-3 text-muted">One moment.</p>
    </>
  );
}

function Confirmed({ onNavigate }: { onNavigate: (r: Route) => void }) {
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
      <h1 className="mt-6 font-serif text-3xl md:text-4xl">Your email is confirmed</h1>
      <p className="mt-3 max-w-md text-muted">
        Reminders will reach you here before every check-in is due.
        Nothing else to do.
      </p>
      <div className="mt-10">
        <Button onClick={() => onNavigate("dashboard")} size="lg">
          Open dashboard
        </Button>
      </div>
    </>
  );
}

function Stale({ onNavigate }: { onNavigate: (r: Route) => void }) {
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
        It may have been replaced by a newer email. Open your dashboard
        and tap &quot;Send it again&quot; to get a fresh one — the newest
        link always wins.
      </p>
      <div className="mt-10 flex gap-3">
        <Button onClick={() => onNavigate("dashboard")} size="lg">
          Open dashboard
        </Button>
        <Button onClick={() => onNavigate("checkin")} variant="ghost" size="lg">
          Sign in
        </Button>
      </div>
    </>
  );
}
