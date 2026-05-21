/**
 * "I'm OK" portal.
 *
 * The user pastes (or pre-fills) the savings ID they want to check in
 * for, then sees:
 *
 *   - A giant friendly status sentence ("The savings are safe.")
 *   - A big tabular countdown to the next reminder.
 *   - A pulsing "I'm OK today" primary button.
 *   - A history strip (recent events).
 *
 * No browse-by-listing. The visitor has to know their savings id to
 * act — this is intentional. The dashboard concept is gone.
 *
 * Future: when the wallet is connected, auto-discover vaults
 * registered by the same Lightning pubkey. Today we just take the id
 * as input.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Heart,
  Sparkles,
  Search,
  Clock,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react";
import {
  ApiError,
  api,
  type VaultView,
  type VaultEvent,
} from "./api";
import { countdown, parseRfc } from "./time";
import { statusCopy } from "./vocab";

type State =
  | { kind: "empty" }
  | { kind: "looking" }
  | { kind: "loaded"; vault: VaultView; events: VaultEvent[] }
  | { kind: "not-found"; id: string }
  | { kind: "error"; message: string };

export function CheckinPortal({ initialId }: { initialId?: string }) {
  const [idInput, setIdInput] = useState(initialId ?? "");
  const [state, setState] = useState<State>({ kind: "empty" });
  const [now, setNow] = useState<Date>(new Date());
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [justCheckedIn, setJustCheckedIn] = useState(false);

  // Drive the live countdown.
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // Keep track of the active vault id so we can re-poll.
  const activeId = useRef<string | null>(null);
  if (state.kind === "loaded") activeId.current = state.vault.id;

  // Light polling: refetch the active vault every 5 s so the status
  // and countdown stay in sync with the server's scheduler.
  useEffect(() => {
    if (state.kind !== "loaded") return;
    let alive = true;
    const timer = window.setInterval(async () => {
      if (!activeId.current) return;
      try {
        const v = await api.getVault(activeId.current);
        const evs = await api.listEvents(activeId.current);
        if (alive) {
          setState({ kind: "loaded", vault: v, events: evs });
        }
      } catch {
        /* swallow; next tick will retry */
      }
    }, 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [state.kind]);

  async function lookup(id: string) {
    const trimmed = id.trim();
    if (!trimmed) return;
    setState({ kind: "looking" });
    setActionError(null);
    try {
      const v = await api.getVault(trimmed);
      const evs = await api.listEvents(trimmed);
      setState({ kind: "loaded", vault: v, events: evs });
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        setState({ kind: "not-found", id: trimmed });
      } else {
        setState({
          kind: "error",
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  async function checkin() {
    if (state.kind !== "loaded") return;
    setBusy(true);
    setActionError(null);
    try {
      await api.checkin(state.vault.id);
      const fresh = await api.getVault(state.vault.id);
      const evs = await api.listEvents(state.vault.id);
      setState({ kind: "loaded", vault: fresh, events: evs });
      setJustCheckedIn(true);
      window.setTimeout(() => setJustCheckedIn(false), 2400);
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="bg-cream py-12 md:py-16">
      <div className="mx-auto max-w-3xl px-5 md:px-8">
        <Header />

        <LookupForm
          value={idInput}
          onChange={setIdInput}
          onSubmit={() => lookup(idInput)}
          busy={state.kind === "looking"}
        />

        {state.kind === "not-found" && (
          <div className="mt-6 card p-5">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 text-bitcoin" />
              <div>
                <p className="font-semibold">
                  No savings with that ID.
                </p>
                <p className="mt-1 text-sm text-ink-500">
                  Double-check the ID and try again. The ID looks like{" "}
                  <code className="rounded bg-cream px-1.5 py-0.5 font-mono text-xs">
                    {state.id.slice(0, 8)}…
                  </code>
                  .
                </p>
              </div>
            </div>
          </div>
        )}

        {state.kind === "error" && (
          <div className="mt-6 card p-5">
            <p className="font-semibold text-bitcoin-900">Couldn't look that up.</p>
            <p className="mt-1 font-mono text-xs text-ink-500">{state.message}</p>
          </div>
        )}

        {state.kind === "loaded" && (
          <CheckinHero
            vault={state.vault}
            events={state.events}
            now={now}
            busy={busy}
            justCheckedIn={justCheckedIn}
            actionError={actionError}
            onCheckin={checkin}
          />
        )}
      </div>
    </main>
  );
}

/* --------------------------------- Header --------------------------------- */

function Header() {
  return (
    <header className="text-center">
      <p className="badge">I'm OK portal</p>
      <h1 className="mt-3 font-display text-3xl font-bold tracking-tight md:text-5xl">
        Tap to say you're still here.
      </h1>
      <p className="mx-auto mt-3 max-w-xl text-ink-500">
        Look up your savings by ID, then tap "I'm OK today" to reset
        the reminder timer.
      </p>
    </header>
  );
}

/* --------------------------------- Lookup --------------------------------- */

function LookupForm({
  value,
  onChange,
  onSubmit,
  busy,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  busy: boolean;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="mt-8 card p-4"
    >
      <label className="block">
        <span className="text-xs font-semibold uppercase tracking-widest text-ink-400">
          Savings ID
        </span>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="06e81655-6995-42e8-8613-d1231a8967a8"
            className="input font-mono text-sm"
          />
          <button
            type="submit"
            disabled={!value.trim() || busy}
            className="btn-primary shrink-0"
          >
            {busy ? (
              <>
                <Search className="h-4 w-4 animate-pulse" /> Looking…
              </>
            ) : (
              <>
                <Search className="h-4 w-4" /> Look up
              </>
            )}
          </button>
        </div>
      </label>
    </form>
  );
}

/* --------------------------------- Hero ----------------------------------- */

function CheckinHero({
  vault,
  events,
  now,
  busy,
  justCheckedIn,
  actionError,
  onCheckin,
}: {
  vault: VaultView;
  events: VaultEvent[];
  now: Date;
  busy: boolean;
  justCheckedIn: boolean;
  actionError: string | null;
  onCheckin: () => void;
}) {
  const deadline = useMemo(
    () => parseRfc(vault.next_deadline_at),
    [vault.next_deadline_at],
  );
  const cd = useMemo(() => countdown(deadline, now), [deadline, now]);
  const copy = statusCopy(vault.status);

  const isOverdue = cd.ms <= 0;
  const tone =
    copy.tone === "ok" && isOverdue ? "warning" : copy.tone;

  return (
    <section className="mt-8 card overflow-hidden p-0">
      {/* Top band, colored by tone */}
      <div
        className={`flex items-center justify-between gap-3 border-b border-ink/5 px-6 py-3 ${
          tone === "ok"
            ? "bg-emerald-50"
            : tone === "warning"
              ? "bg-amber-50"
              : tone === "alarmed"
                ? "bg-red-50"
                : "bg-cream"
        }`}
      >
        <p className="text-xs font-semibold uppercase tracking-widest text-ink-500">
          {vault.label ?? "Savings"}
        </p>
        <StatusDot tone={tone} label={copy.label} />
      </div>

      <div className="grid grid-cols-1 gap-8 px-6 py-8 md:grid-cols-2 md:px-10 md:py-12">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-ink-400">
            Status
          </p>
          <h2 className="mt-1 font-display text-3xl font-bold tracking-tight md:text-4xl">
            {copy.longLabel}
          </h2>
          <p className="mt-4 text-base leading-relaxed text-ink-500">
            {tone === "ok" && (
              <>
                Next reminder is{" "}
                <strong className="text-ink">{cd.friendly}</strong>.<br />
                You don't have to do anything today.
              </>
            )}
            {tone === "warning" && (
              <>
                Tap below to reset the timer and let the person you've named know you're
                still here.
              </>
            )}
            {tone === "alarmed" && (
              <>
                You missed a reminder. Tap below now to reset everything —
                nothing has been lost yet.
              </>
            )}
            {tone === "neutral" && (
              <>These savings have already been claimed.</>
            )}
          </p>
        </div>

        <div className="flex flex-col items-start gap-5 md:items-end">
          <div className="text-left md:text-right">
            <p className="text-xs font-semibold uppercase tracking-widest text-ink-400">
              Time until reminder
            </p>
            <p
              className={`mt-1 font-display tabular-nums font-bold ${
                cd.ms < 0 ? "text-alarmed" : "text-ink"
              } text-4xl md:text-5xl`}
              aria-live="polite"
            >
              {cd.pretty}
            </p>
          </div>
          {tone !== "neutral" && (
            <button
              onClick={onCheckin}
              disabled={busy}
              className={`btn-primary w-full !rounded-full !px-6 !py-4 text-base md:w-auto ${
                tone === "ok" ? "" : "animate-pulse-glow"
              }`}
            >
              {justCheckedIn ? (
                <>
                  <Sparkles className="h-5 w-5" /> Thanks — you're safe
                </>
              ) : busy ? (
                <>
                  <Heart className="h-5 w-5 animate-pulse" /> One sec…
                </>
              ) : (
                <>
                  <Heart className="h-5 w-5" fill="currentColor" /> I'm OK
                  today
                </>
              )}
            </button>
          )}
          {actionError && (
            <p className="text-sm font-medium text-alarmed">{actionError}</p>
          )}
        </div>
      </div>

      <Footer vault={vault} events={events} />
    </section>
  );
}

function StatusDot({
  tone,
  label,
}: {
  tone: "ok" | "warning" | "alarmed" | "neutral";
  label: string;
}) {
  const dot =
    tone === "ok"
      ? "bg-ok"
      : tone === "warning"
        ? "bg-warning"
        : tone === "alarmed"
          ? "bg-alarmed"
          : "bg-ink-300";
  return (
    <span className="inline-flex items-center gap-2 rounded-full bg-white px-3 py-1 text-xs font-semibold text-ink shadow-soft-sm">
      <span className={`h-2 w-2 rounded-full ${dot}`} />
      {label}
    </span>
  );
}

function Footer({
  vault,
  events,
}: {
  vault: VaultView;
  events: VaultEvent[];
}) {
  return (
    <div className="border-t border-ink/5 bg-cream/50 px-6 py-4 md:px-10">
      <div className="flex flex-wrap items-baseline justify-between gap-3 text-xs">
        <p className="font-mono text-ink-400">
          {vault.network} · every {prettyCadence(vault.checkin_period_secs)} +{" "}
          {prettyCadence(vault.grace_period_secs)} grace
        </p>
        <p className="font-mono text-ink-300">
          {events.length} event{events.length === 1 ? "" : "s"}
        </p>
      </div>
      {events.length > 0 && (
        <ol className="mt-3 space-y-2">
          {events
            .slice()
            .reverse()
            .slice(0, 5)
            .map((e) => (
              <li
                key={e.id}
                className="flex items-center gap-3 text-xs text-ink-500"
              >
                <EventIcon kind={e.kind} />
                <span className="font-medium text-ink">
                  {friendlyKind(e.kind)}
                </span>
                <span className="ml-auto font-mono text-ink-300">
                  {e.created_at.slice(0, 19).replace("T", " ")}
                </span>
              </li>
            ))}
        </ol>
      )}
    </div>
  );
}

function EventIcon({ kind }: { kind: string }) {
  if (kind === "checkin")
    return <CheckCircle2 className="h-4 w-4 text-ok" strokeWidth={2.25} />;
  if (kind === "alarm" || kind === "warning")
    return (
      <AlertTriangle className="h-4 w-4 text-alarmed" strokeWidth={2.25} />
    );
  return <Clock className="h-4 w-4 text-ink-400" strokeWidth={2.25} />;
}

function prettyCadence(secs: number): string {
  if (secs >= 86_400) {
    const d = Math.round(secs / 86_400);
    return `${d} day${d === 1 ? "" : "s"}`;
  }
  if (secs >= 3_600) {
    const h = Math.round(secs / 3_600);
    return `${h} hour${h === 1 ? "" : "s"}`;
  }
  if (secs >= 60) {
    const m = Math.round(secs / 60);
    return `${m} min`;
  }
  return `${secs} sec`;
}

function friendlyKind(kind: string): string {
  switch (kind) {
    case "registered": return "Created";
    case "checkin":    return "Said I'm OK";
    case "warning":    return "Reminder soon";
    case "alarm":      return "Missed reminder";
    case "resolved":   return "Back to safe";
    default:           return kind;
  }
}
