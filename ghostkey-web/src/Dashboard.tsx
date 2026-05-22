/**
 * Dashboard — the home of an active vault on this device.
 *
 * Reads the active vault id from localStorage, fetches the current
 * vault and event history, and renders:
 *
 *   - "You're still here" greeting + last check-in line
 *   - Heartbeat card with the tap-to-check-in CTA
 *   - Status grid (active / waiting period)
 *   - Heir card (from local store, since the API stores opaque text)
 *   - Recent activity
 *
 * If there is no active vault on this device, we offer the two paths
 * out: set one up, or look up by id (heir / cross-device case).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Avatar,
  Button,
  Heartbeat,
  StatusPill,
  friendlyEventKind,
  shortAddr,
  useTicker,
  usePolling,
  prettyDuration,
} from "./ui";
import {
  ApiError,
  api,
  type VaultView,
  type VaultEvent,
} from "./api";
import { countdown, parseRfc } from "./time";
import { statusCopy } from "./vocab";
import { getActiveVaultId, getVaultMeta, getVaultOwnerToken, type VaultMeta } from "./vaultStore";
import type { Route } from "./App";

interface Props {
  onNavigate: (r: Route) => void;
}

export function Dashboard({ onNavigate }: Props) {
  const activeId = useMemo(() => getActiveVaultId(), []);
  const meta = useMemo(
    () => (activeId ? getVaultMeta(activeId) : null),
    [activeId],
  );
  // Owner token persists in localStorage from setup. If it's missing
  // (e.g. the user cleared their site data, or the vault was created
  // before per-vault auth shipped), the server will reject mutations
  // with 401. We surface that as an inline error rather than a silent
  // failure.
  const ownerToken = useMemo(
    () => (activeId ? getVaultOwnerToken(activeId) : null),
    [activeId],
  );

  const [vault, setVault] = useState<VaultView | null>(null);
  const [events, setEvents] = useState<VaultEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justChecked, setJustChecked] = useState(false);

  const now = useTicker(1000);

  const refresh = useCallback(async () => {
    if (!activeId) return;
    try {
      const [v, evs] = await Promise.all([
        api.getVault(activeId, ownerToken),
        api.listEvents(activeId, ownerToken),
      ]);
      setVault(v);
      setEvents(evs);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setError(
          "This browser doesn't have the credentials for this vault. " +
            "If you set it up on another device, sign in there or create a new vault.",
        );
        return;
      }
      if (e instanceof ApiError && e.status === 404) {
        setError("This vault is no longer on the server.");
      }
      // Otherwise swallow; the next tick may succeed.
    }
  }, [activeId, ownerToken]);

  // Initial load.
  useEffect(() => {
    if (activeId) void refresh();
  }, [activeId, refresh]);

  // Live polling while visible.
  usePolling(refresh, 8000, [activeId]);

  async function onCheckin() {
    if (!vault) return;
    setBusy(true);
    setError(null);
    try {
      await api.checkin(vault.id, ownerToken);
      await refresh();
      setJustChecked(true);
      window.setTimeout(() => setJustChecked(false), 2400);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!activeId || !meta) {
    return <EmptyState onNavigate={onNavigate} />;
  }

  return (
    <main className="bg-app fade-in">
      <div className="mx-auto max-w-2xl px-5 py-10 md:py-14">
        <Greeting meta={meta} vault={vault} now={now} />

        <div className="mt-8">
          <HeartbeatCard
            meta={meta}
            vault={vault}
            now={now}
            busy={busy}
            justChecked={justChecked}
            error={error}
            onCheckin={onCheckin}
          />
        </div>

        {vault ? (
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <StatCard
              label="Vault status"
              value={
                <span className={statusValueColor(vault)}>
                  {statusCopy(vault.status).label}
                </span>
              }
              sub={statusCopy(vault.status).long}
            />
            <StatCard
              label="Waiting period"
              value={prettyBlocks(vault.timelock_blocks)}
              sub="After a missed check-in"
            />
          </div>
        ) : null}

        <div className="mt-4">
          <HeirCard meta={meta} vault={vault} />
        </div>

        <div className="mt-6">
          <ActivityList events={events} />
        </div>
      </div>
    </main>
  );
}

/* ----------------------------- Greeting ----------------------------------- */

function Greeting({
  meta,
  vault,
  now,
}: {
  meta: VaultMeta;
  vault: VaultView | null;
  now: Date;
}) {
  const last = vault?.last_checkin_at
    ? parseRfc(vault.last_checkin_at)
    : null;
  const ago = last ? humanAgo(last, now) : null;
  const next = vault?.next_deadline_at
    ? countdown(parseRfc(vault.next_deadline_at), now).friendly
    : null;
  return (
    <div>
      <h1 className="font-serif text-3xl md:text-4xl">You're still here</h1>
      <p className="mt-1 text-sm text-muted">
        {last ? `Last checked in ${ago}.` : `Vault for ${meta.heir.name} is active.`}
        {next ? ` Next reminder ${next}.` : ""}
      </p>
    </div>
  );
}

/* --------------------------- Heartbeat card ------------------------------- */

function HeartbeatCard({
  meta,
  vault,
  now,
  busy,
  justChecked,
  error,
  onCheckin,
}: {
  meta: VaultMeta;
  vault: VaultView | null;
  now: Date;
  busy: boolean;
  justChecked: boolean;
  error: string | null;
  onCheckin: () => void;
}) {
  const cd = vault
    ? countdown(parseRfc(vault.next_deadline_at), now)
    : null;

  return (
    <section className="card relative overflow-hidden p-8 text-center">
      <div className="flex flex-col items-center">
        <Heartbeat onTap={busy ? undefined : onCheckin} disabled={busy} />

        <h2 className="mt-6 font-serif text-2xl">
          {justChecked ? "Thanks — you're safe" : "Tap to check in"}
        </h2>
        <p className="mt-1 text-sm text-muted">
          {justChecked
            ? `${meta.heir.name}'s countdown starts again.`
            : `Let ${meta.heir.name} know the clock is reset.`}
        </p>

        <div className="mt-6">
          <Button onClick={onCheckin} loading={busy} size="lg">
            {justChecked ? "Checked in" : "I'm still here"}
          </Button>
        </div>

        {cd ? (
          <p className="mt-5 text-xs text-muted" aria-live="polite">
            <span className="text-[var(--text)] font-medium">{cd.friendly}</span>
            {" "}before countdown begins
          </p>
        ) : null}

        {error ? (
          <p className="mt-4 text-sm text-alarm">{error}</p>
        ) : null}
      </div>
    </section>
  );
}

/* ----------------------------- Stat card ---------------------------------- */

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
}) {
  return (
    <div className="card-flat p-5">
      <p className="text-[11px] uppercase tracking-wider text-dim">{label}</p>
      <div className="mt-2 font-display text-2xl font-bold tracking-tight">{value}</div>
      {sub ? <p className="mt-1 text-xs text-muted">{sub}</p> : null}
    </div>
  );
}

function statusValueColor(v: VaultView): string {
  const tone = statusCopy(v.status).tone;
  if (tone === "ok") return "text-ok";
  if (tone === "warning") return "text-warning";
  if (tone === "alarm") return "text-alarm";
  return "";
}

function prettyBlocks(blocks: number): string {
  const days = Math.round((blocks * 10) / 1440); // 10 min/block → days
  if (days >= 30) {
    const m = Math.round(days / 30);
    return `${m} month${m === 1 ? "" : "s"}`;
  }
  return `${days} day${days === 1 ? "" : "s"}`;
}

/* ------------------------------ Heir card --------------------------------- */

function HeirCard({
  meta,
  vault,
}: {
  meta: VaultMeta;
  vault: VaultView | null;
}) {
  const status = vault?.status ?? "ok";
  const pill =
    status === "claimed"
      ? { tone: "neutral" as const, label: "Claimed" }
      : status === "timelock_started"
      ? { tone: "alarm" as const, label: "Claiming" }
      : { tone: "ok" as const, label: "Ready to claim" };

  return (
    <div className="card-flat flex items-center gap-4 p-5">
      <Avatar name={meta.heir.name} />
      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold text-[var(--text)]">{meta.heir.name}</p>
        <p className="truncate text-xs text-muted">
          {meta.heir.email ? `${meta.heir.email} · ` : ""}
          <span className="font-mono">{shortAddr(meta.heir.address)}</span>
        </p>
      </div>
      <StatusPill tone={pill.tone} label={pill.label} />
    </div>
  );
}

/* ----------------------------- Activity list ------------------------------ */

function ActivityList({ events }: { events: VaultEvent[] }) {
  // Newest first, cap to 6.
  const items = useMemo(
    () => events.slice().reverse().slice(0, 6),
    [events],
  );
  return (
    <section aria-label="Recent activity">
      <p className="text-[11px] uppercase tracking-wider text-dim">
        Recent activity
      </p>
      {items.length === 0 ? (
        <p className="mt-3 text-sm text-muted">Nothing yet.</p>
      ) : (
        <ul role="list" className="mt-3 divide-y divide-[var(--border)]">
          {items.map((e) => (
            <li key={e.id} className="flex items-center gap-3 py-3 text-sm">
              <span
                aria-hidden="true"
                className={`h-2 w-2 rounded-full ${
                  e.kind === "checkin" || e.kind === "resolved"
                    ? "bg-ok"
                    : e.kind === "alarm"
                    ? "bg-alarm"
                    : "bg-warning"
                }`}
              />
              <span className="flex-1 text-muted">
                <strong className="font-semibold text-[var(--text)]">
                  {friendlyEventKind(e.kind)}
                </strong>
              </span>
              <span className="font-mono text-[11px] text-dim">
                {formatWhen(e.created_at)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function humanAgo(then: Date, now: Date): string {
  const ms = now.getTime() - then.getTime();
  if (ms < 0) return "moments ago";
  if (ms < 60_000) return "moments ago";
  if (ms < 3_600_000) {
    const m = Math.floor(ms / 60_000);
    return `${m} minute${m === 1 ? "" : "s"} ago`;
  }
  if (ms < 86_400_000) {
    const h = Math.floor(ms / 3_600_000);
    return `${h} hour${h === 1 ? "" : "s"} ago`;
  }
  const d = Math.floor(ms / 86_400_000);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

// Note: prettyDuration is imported but only used by some debug paths. Keep
// the import so future iterations don't have to re-add it. (Linter is fine
// because we re-export from ui.tsx for other modules.)
void prettyDuration;

/* ----------------------------- Empty state -------------------------------- */

function EmptyState({ onNavigate }: { onNavigate: (r: Route) => void }) {
  return (
    <main className="bg-app fade-in">
      <div className="mx-auto max-w-xl px-5 py-20 text-center md:py-28">
        <p className="eyebrow-dim">Dashboard</p>
        <h1 className="mt-6 font-serif text-3xl md:text-4xl">
          No vault on this device yet
        </h1>
        <p className="mt-3 text-muted">
          Set one up in a few minutes, or look up an existing one by its ID.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Button onClick={() => onNavigate("setup")}>Set up a vault</Button>
          <Button variant="ghost" onClick={() => onNavigate("checkin")}>
            Look up by ID
          </Button>
        </div>
      </div>
    </main>
  );
}
