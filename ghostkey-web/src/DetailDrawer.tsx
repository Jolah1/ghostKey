/**
 * Slide-in detail drawer for a single vault.
 *
 * Two halves:
 *  - "Details" — friendly key/value list with the underlying technical
 *    fact in small mono below.
 *  - "History" — event log, rendered as a timeline.
 */
import { useEffect, useState } from "react";
import { X, Activity, Settings } from "lucide-react";
import {
  ApiError,
  api,
  type VaultView,
  type VaultEvent,
} from "./api";
import { StatusPill } from "./StatusPill";
import { statusCopy } from "./vocab";

interface Props {
  vault: VaultView;
  onClose: () => void;
}

export function DetailDrawer({ vault, onClose }: Props) {
  const [events, setEvents] = useState<VaultEvent[] | null>(null);
  const [eventsError, setEventsError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .listEvents(vault.id)
      .then((es) => {
        if (alive) setEvents(es);
      })
      .catch((e) => {
        if (alive) {
          setEventsError(e instanceof ApiError ? e.message : String(e));
        }
      });
    return () => {
      alive = false;
    };
  }, [vault.id]);

  // Close on ESC for keyboard-only users.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-20 bg-ink/40"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <aside
        className="absolute right-0 top-0 h-full w-full max-w-md overflow-y-auto border-l-4 border-ink bg-paper"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="sticky top-0 flex items-start justify-between gap-3 border-b-4 border-ink bg-paper px-6 py-4">
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
              Family savings
            </p>
            <h2 className="font-display text-xl font-bold leading-tight truncate">
              {vault.label ?? "Untitled"}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="neo-button !px-2 !py-2"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <section className="px-6 py-5">
          <h3 className="flex items-center gap-2 font-display text-sm font-bold uppercase tracking-widest text-muted-foreground">
            <Settings className="h-4 w-4" /> Details
          </h3>
          <dl className="mt-3 space-y-3 text-sm">
            <Row
              k="Current status"
              v={
                <div className="text-left">
                  <StatusPill status={vault.status} />
                  <p className="mt-1 text-xs text-muted-foreground">
                    {statusCopy(vault.status).longLabel}
                  </p>
                </div>
              }
            />
            <Row k="Bitcoin network" v={vault.network} />
            <Row
              k="Reminder every"
              v={prettyCadence(vault.checkin_period_secs)}
              hint={`${vault.checkin_period_secs} seconds`}
            />
            <Row
              k="Grace period"
              v={prettyCadence(vault.grace_period_secs)}
              hint={`${vault.grace_period_secs} seconds`}
            />
            <Row
              k="Family waiting period"
              v={`${vault.timelock_blocks} blocks`}
              hint="≈ 10 minutes per block"
            />
            <Row
              k="Last 'I'm OK'"
              v={vault.last_checkin_at ?? "—"}
            />
            <Row
              k="Next reminder"
              v={vault.next_deadline_at}
            />
            <Row
              k="Created"
              v={vault.created_at}
            />
            <Row
              k="ID"
              v={<span className="font-mono text-xs">{vault.id}</span>}
            />
          </dl>
        </section>

        <section className="border-t-4 border-ink px-6 py-5">
          <h3 className="flex items-center gap-2 font-display text-sm font-bold uppercase tracking-widest text-muted-foreground">
            <Activity className="h-4 w-4" /> History
          </h3>
          {eventsError && (
            <p className="mt-3 text-sm text-red">{eventsError}</p>
          )}
          {events === null && !eventsError && (
            <p className="mt-3 text-sm text-muted-foreground">Loading…</p>
          )}
          {events && events.length === 0 && (
            <p className="mt-3 text-sm text-muted-foreground">Nothing yet.</p>
          )}
          {events && events.length > 0 && (
            <ol className="mt-4 space-y-3">
              {events
                .slice()
                .reverse()
                .map((e) => (
                  <li
                    key={e.id}
                    className="flex items-start gap-3 border-l-4 border-ink pl-3"
                  >
                    <span className="neo-badge bg-paper text-[10px] !px-2 !py-0.5">
                      {friendlyKind(e.kind)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {e.created_at}
                    </span>
                  </li>
                ))}
            </ol>
          )}
        </section>
      </aside>
    </div>
  );
}

function Row({
  k,
  v,
  hint,
}: {
  k: string;
  v: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <dt className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
        {k}
      </dt>
      <dd className="text-right">
        <div className="font-medium">{v}</div>
        {hint && (
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
            {hint}
          </p>
        )}
      </dd>
    </div>
  );
}

function prettyCadence(secs: number): string {
  if (secs >= 86400) {
    const d = Math.round(secs / 86400);
    return `${d} day${d === 1 ? "" : "s"}`;
  }
  if (secs >= 3600) {
    const h = Math.round(secs / 3600);
    return `${h} hour${h === 1 ? "" : "s"}`;
  }
  if (secs >= 60) {
    const m = Math.round(secs / 60);
    return `${m} minute${m === 1 ? "" : "s"}`;
  }
  return `${secs} second${secs === 1 ? "" : "s"}`;
}

function friendlyKind(kind: string): string {
  switch (kind) {
    case "registered":
      return "Created";
    case "checkin":
      return "Said I'm OK";
    case "warning":
      return "Reminder soon";
    case "alarm":
      return "Missed reminder";
    case "resolved":
      return "Back to safe";
    default:
      return kind;
  }
}
