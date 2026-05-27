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
 * out: set one up, or sign in with email + password.
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
} from "./ui";
import {
  ApiError,
  api,
  type VaultView,
  type VaultEvent,
} from "./api";
import { countdown, parseRfc } from "./time";
import { statusCopy } from "./vocab";
import {
  getActiveVaultId,
  getVaultMeta,
  getVaultOwnerToken,
  getVaultsByGroup,
  type VaultMeta,
} from "./vaultStore";
import { LightningCheckin } from "./LightningCheckin";
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
  // Multi-heir groups: if this vault has a `groupId`, look up all
  // sibling vaults on this device. The dashboard renders the group
  // as one card (Heart-beat targets the active vault; the check-in
  // button fans out to all siblings client-side so one tap resets
  // every heir's countdown).
  //
  // For legacy single-heir vaults, `groupId` is null and `groupVaults`
  // is just `[meta]`. The rendering paths handle both.
  const groupVaults = useMemo(() => {
    if (!meta) return [];
    if (!meta.groupId) return [meta];
    return getVaultsByGroup(meta.groupId);
  }, [meta]);

  const [vault, setVault] = useState<VaultView | null>(null);
  const [events, setEvents] = useState<VaultEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justChecked, setJustChecked] = useState(false);
  // Whether this server has a Lightning provider wired up. We read
  // it once on mount via /health; if the server flips state we'll
  // pick it up on the next page load. Treating it as static-per-load
  // avoids re-rendering the dashboard every poll.
  const [lightningEnabled, setLightningEnabled] = useState(false);
  // Whether the Lightning check-in modal is open. The modal owns its
  // own invoice + polling state; we just toggle visibility here.
  const [lightningOpen, setLightningOpen] = useState(false);

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
            "Sign in with your email and password, or create a new vault.",
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

  // Probe the server once to learn whether Lightning check-ins are
  // available. Silent on failure — we just leave the button hidden.
  useEffect(() => {
    let alive = true;
    api
      .health()
      .then((h) => {
        if (alive) setLightningEnabled(Boolean(h.lightning_enabled));
      })
      .catch(() => {
        if (alive) setLightningEnabled(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Live polling while visible.
  usePolling(refresh, 8000, [activeId]);

  async function onCheckin() {
    if (!vault) return;
    setBusy(true);
    setError(null);
    try {
      // Fan out to every sibling in the group. For single-heir
      // vaults this is just one call against `vault.id`; for
      // multi-heir groups it loops through every sibling. Each
      // sibling has its own ownerToken (issued at vault creation),
      // so we read them from localStorage per vault.
      //
      // We don't parallelise: serial is friendlier to the server
      // (the worker has rate-limit headroom for parallel but the
      // optics of "5 simultaneous POSTs" surprise some operators
      // looking at logs). The whole loop is dominated by network
      // latency, not server work; sub-second total even for 5
      // heirs.
      //
      // If any sibling fails, we surface the FIRST error and stop —
      // partial fan-out leaves the group in mixed-state, which is
      // visible in the dashboard list as "Heir #3 is alarmed but
      // Heirs #1 and #2 are ok." Better than rolling back the
      // successful ones (which would require an admin route we
      // don't have).
      for (const sibling of groupVaults) {
        const token = getVaultOwnerToken(sibling.id);
        await api.checkin(sibling.id, token);
      }
      await refresh();
      setJustChecked(true);
      window.setTimeout(() => setJustChecked(false), 4000);
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
            lightningEnabled={lightningEnabled}
            onLightning={() => setLightningOpen(true)}
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
          {groupVaults.length > 1 ? (
            <HeirGroupList
              groupVaults={groupVaults}
              activeId={activeId}
              onSelect={(id) => {
                // Switch active vault. Reload so the dashboard
                // re-runs against the new active id. We could do
                // this purely via state instead but a reload also
                // refreshes the server state, which is what the
                // user wants ("show me Bob now").
                if (typeof window !== "undefined") {
                  window.localStorage.setItem("gk:activeVaultId", id);
                  window.location.reload();
                }
              }}
            />
          ) : (
            <HeirCard meta={meta} vault={vault} />
          )}
        </div>

        <div className="mt-6">
          <ActivityList events={events} />
        </div>
      </div>

      {lightningOpen && activeId ? (
        <LightningCheckin
          vaultId={activeId}
          ownerToken={ownerToken}
          onPaid={() => {
            setLightningOpen(false);
            setJustChecked(true);
            window.setTimeout(() => setJustChecked(false), 4000);
            void refresh();
          }}
          onClose={() => setLightningOpen(false)}
        />
      ) : null}
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
  lightningEnabled,
  onLightning,
}: {
  meta: VaultMeta;
  vault: VaultView | null;
  now: Date;
  busy: boolean;
  justChecked: boolean;
  error: string | null;
  onCheckin: () => void;
  lightningEnabled: boolean;
  onLightning: () => void;
}) {
  const cd = vault
    ? countdown(parseRfc(vault.next_deadline_at), now)
    : null;

  return (
    <section className="card relative overflow-hidden p-5 text-center md:p-8">
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

        <div className="mt-6 flex w-full max-w-xs flex-col items-stretch gap-3 md:max-w-none md:flex-row md:flex-wrap md:items-center md:justify-center">
          {/* Mobile: stacked full-width buttons (fat tap targets on
              a 360px phone). md+: side-by-side. After a successful
              check-in we disable the button for the duration of the
              `justChecked` state so the user can't tap five times in
              a panic; the server allows repeat check-ins (correct
              for cross-device safety) but the UI shouldn't invite
              that confusion. */}
          <Button
            onClick={onCheckin}
            loading={busy}
            disabled={justChecked}
            size="lg"
          >
            {justChecked ? "Checked in ✓" : "I'm still here"}
          </Button>
          {lightningEnabled ? (
            <Button variant="ghost" size="lg" onClick={onLightning}>
              ⚡ Pay 1 sat
            </Button>
          ) : null}
        </div>

        {lightningEnabled ? (
          <p className="mt-2 text-[11px] text-dim">
            Pay a 1-sat Lightning invoice for cryptographic proof of liveness.
          </p>
        ) : null}

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

/**
 * Multi-heir group card. Lists every heir in the group with their
 * name, contact, and a "this is the active one" indicator. Tapping
 * a heir's row switches the active vault to that sibling — the
 * heartbeat/check-in card above already drives the active vault, so
 * this lets the owner inspect each heir's individual state without
 * leaving the dashboard.
 *
 * The per-heir status pill is intentionally NOT shown here yet — we
 * only have the active vault's `VaultView` from the server; fetching
 * status for every sibling on every dashboard load would multiply
 * server calls. Acceptable for an MVP: the active vault's status is
 * the one in the big check-in card; switching active vault shows
 * that sibling's status. Phase 2 (server-side vault_groups + a
 * batch fetch endpoint) makes this less awkward.
 */
function HeirGroupList({
  groupVaults,
  activeId,
  onSelect,
}: {
  groupVaults: VaultMeta[];
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs uppercase tracking-wider text-dim">
        Heirs ({groupVaults.length})
      </p>
      {groupVaults.map((meta) => {
        const isActive = meta.id === activeId;
        return (
          <button
            key={meta.id}
            type="button"
            onClick={() => onSelect(meta.id)}
            disabled={isActive}
            className={`card-flat flex items-center gap-4 p-4 text-left transition-colors ${
              isActive
                ? "border-accent"
                : "hover:bg-[var(--surface-2)]"
            }`}
            style={isActive ? { background: "var(--accent-tint)" } : undefined}
            aria-current={isActive ? "true" : undefined}
          >
            <Avatar name={meta.heir.name} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold text-[var(--text)]">
                {meta.heir.name || "(unnamed)"}
              </p>
              <p className="truncate text-xs text-muted">
                {meta.heir.email || "—"}
              </p>
            </div>
            {isActive ? (
              <span className="text-xs text-accent font-medium">Active</span>
            ) : (
              <span className="text-xs text-muted">Tap to view</span>
            )}
          </button>
        );
      })}
      <p className="mt-1 text-[11px] text-dim">
        One tap on "I'm still here" checks in for all {groupVaults.length}{" "}
        heirs at once.
      </p>
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
          Set one up in a few minutes, or sign in with your email and password
          if you already have one.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Button onClick={() => onNavigate("setup")}>Set up a vault</Button>
          <Button variant="ghost" onClick={() => onNavigate("checkin")}>
            Sign in
          </Button>
        </div>
      </div>
    </main>
  );
}
