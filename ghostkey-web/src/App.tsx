import { useEffect, useState } from "react";
import {
  ApiError,
  api,
  type VaultListItem,
  type VaultStatus,
  type VaultView,
} from "./api";
import { VaultCard } from "./VaultCard";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; vaults: VaultListItem[] };

const POLL_MS = 5_000;

export default function App() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [selected, setSelected] = useState<VaultView | null>(null);
  const [health, setHealth] = useState<string | null>(null);

  // List polling.
  useEffect(() => {
    let alive = true;
    let timer: number | null = null;

    async function tick() {
      try {
        const list = await api.listVaults();
        if (!alive) return;
        setState({ kind: "loaded", vaults: list });
      } catch (e) {
        if (!alive) return;
        const msg = e instanceof Error ? e.message : String(e);
        setState({ kind: "error", message: msg });
      } finally {
        if (alive) timer = window.setTimeout(tick, POLL_MS);
      }
    }
    void tick();
    return () => {
      alive = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);

  // Cheap health badge.
  useEffect(() => {
    api
      .health()
      .then((h) => setHealth(`v${h.version}`))
      .catch(() => setHealth(null));
  }, []);

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <Header health={health} />
      <main className="mt-8">
        {state.kind === "loading" && <p className="text-zinc-400">Loading vaults…</p>}
        {state.kind === "error" && <ErrorPanel message={state.message} />}
        {state.kind === "loaded" && state.vaults.length === 0 && (
          <EmptyState />
        )}
        {state.kind === "loaded" && state.vaults.length > 0 && (
          <ul className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {state.vaults.map((v) => (
              <li key={v.id}>
                <VaultCard
                  summary={v}
                  onOpen={(detail) => setSelected(detail)}
                  onAfterCheckin={() => {
                    // Optimistically refresh the list.
                    api
                      .listVaults()
                      .then((vs) => setState({ kind: "loaded", vaults: vs }))
                      .catch(() => {
                        /* next poll will catch it */
                      });
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </main>
      {selected && (
        <DetailDrawer vault={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

function Header({ health }: { health: string | null }) {
  return (
    <header className="flex items-center justify-between border-b border-zinc-800 pb-4">
      <div className="flex items-center gap-3">
        <Logo />
        <div>
          <h1 className="text-xl font-semibold">GhostKey</h1>
          <p className="text-sm text-zinc-400">
            Bitcoin-native inheritance vaults
          </p>
        </div>
      </div>
      <div className="text-right text-xs text-zinc-500">
        {health ? (
          <span className="rounded bg-zinc-800 px-2 py-1 font-mono">
            server {health}
          </span>
        ) : (
          <span className="rounded bg-red-900/40 px-2 py-1 font-mono text-red-300">
            server unreachable
          </span>
        )}
      </div>
    </header>
  );
}

function Logo() {
  return (
    <svg
      viewBox="0 0 32 32"
      className="h-8 w-8"
      aria-hidden="true"
      role="img"
    >
      <path
        d="M16 6 L24 11 L24 21 L16 26 L8 21 L8 11 Z"
        fill="none"
        stroke="#a1a1aa"
        strokeWidth="2"
      />
      <circle cx="16" cy="16" r="3" fill="#10b981" />
    </svg>
  );
}

function EmptyState() {
  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/40 px-6 py-12 text-center">
      <h2 className="text-lg font-medium">No vaults registered</h2>
      <p className="mt-2 text-sm text-zinc-400">
        Register a vault with the CLI or via{" "}
        <code className="font-mono text-zinc-300">POST /vaults</code> and
        it will appear here.
      </p>
    </div>
  );
}

function ErrorPanel({ message }: { message: string }) {
  return (
    <div className="rounded border border-red-900 bg-red-950/40 px-4 py-3 text-sm text-red-200">
      <p className="font-medium">Failed to load vaults</p>
      <p className="mt-1 font-mono text-xs">{message}</p>
    </div>
  );
}

function DetailDrawer({
  vault,
  onClose,
}: {
  vault: VaultView;
  onClose: () => void;
}) {
  const [events, setEvents] = useState<
    { id: number; kind: string; created_at: string }[] | null
  >(null);
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

  return (
    <div
      className="fixed inset-0 z-10 bg-black/60"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <aside
        className="absolute right-0 top-0 h-full w-full max-w-md overflow-y-auto border-l border-zinc-800 bg-zinc-950 px-6 py-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold">
              {vault.label ?? "(no label)"}
            </h2>
            <p className="font-mono text-xs text-zinc-500">{vault.id}</p>
          </div>
          <button
            onClick={onClose}
            className="rounded px-2 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            aria-label="close"
          >
            ×
          </button>
        </div>
        <dl className="mt-6 grid grid-cols-2 gap-3 text-sm">
          <DescPair k="network" v={vault.network} />
          <DescPair k="status" v={<StatusPill status={vault.status} />} />
          <DescPair
            k="timelock"
            v={`${vault.timelock_blocks} blocks`}
          />
          <DescPair
            k="cadence"
            v={`${vault.checkin_period_secs}s + ${vault.grace_period_secs}s grace`}
          />
          <DescPair k="created" v={vault.created_at} />
          <DescPair
            k="last check-in"
            v={vault.last_checkin_at ?? "—"}
          />
          <DescPair
            k="next deadline"
            v={vault.next_deadline_at}
          />
        </dl>
        <h3 className="mt-8 text-sm font-medium uppercase tracking-wide text-zinc-400">
          Event log
        </h3>
        {eventsError && (
          <p className="mt-2 text-sm text-red-300">{eventsError}</p>
        )}
        {events === null && !eventsError ? (
          <p className="mt-2 text-sm text-zinc-500">Loading…</p>
        ) : (
          <ol className="mt-2 divide-y divide-zinc-800 border-y border-zinc-800">
            {(events ?? []).map((e) => (
              <li
                key={e.id}
                className="flex items-baseline justify-between py-2 text-sm"
              >
                <span className="font-mono">{e.kind}</span>
                <span className="text-xs text-zinc-500">{e.created_at}</span>
              </li>
            ))}
            {(events ?? []).length === 0 && !eventsError && (
              <li className="py-2 text-sm text-zinc-500">No events yet.</li>
            )}
          </ol>
        )}
      </aside>
    </div>
  );
}

function DescPair({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <>
      <dt className="text-xs uppercase tracking-wide text-zinc-500">{k}</dt>
      <dd className="text-right font-mono text-xs text-zinc-200">{v}</dd>
    </>
  );
}

function StatusPill({ status }: { status: VaultStatus }) {
  const palette: Record<VaultStatus, string> = {
    ok: "bg-ok/15 text-ok",
    warning: "bg-warning/15 text-warning",
    alarmed: "bg-alarmed/15 text-alarmed",
    timelock_started: "bg-alarmed/15 text-alarmed",
    claimed: "bg-zinc-700/40 text-zinc-300",
  };
  return (
    <span
      className={`inline-block rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${palette[status]}`}
    >
      {status}
    </span>
  );
}
