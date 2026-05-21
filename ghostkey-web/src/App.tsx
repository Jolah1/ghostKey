/**
 * Top-level orchestration.
 *
 * Views:
 *  - `landing`   — first-run hero. Shown when the server reports zero
 *                  vaults (or the user clicks "About").
 *  - `dashboard` — the main vault view. Shown as soon as there's ≥1
 *                  vault.
 *  - `wizard`    — the add-vault flow. Always reachable via the
 *                  "Add savings" / "Set up" buttons.
 *
 * Server polling lives here and pushes data down to the active view.
 * Each card is responsible for its own check-in side effects; this
 * shell only refreshes the list as a result.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, type VaultListItem } from "./api";
import { Landing } from "./Landing";
import { Dashboard } from "./Dashboard";
import { AddVaultWizard } from "./AddVaultWizard";
import { ServerOfflineBanner } from "./ServerOfflineBanner";

type View = "landing" | "dashboard" | "wizard";

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; vaults: VaultListItem[] }
  | { kind: "error"; message: string };

const POLL_MS = 5_000;

export default function App() {
  const [view, setView] = useState<View>("landing");
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  // After the first successful load we know whether to default to
  // landing or dashboard. Use a ref so the polling effect doesn't
  // override the user's explicit navigation.
  const userOverrode = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const list = await api.listVaults();
      setState({ kind: "loaded", vaults: list });
      if (!userOverrode.current) {
        setView(list.length === 0 ? "landing" : "dashboard");
      }
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : String(e);
      setState({ kind: "error", message: msg });
    }
  }, []);

  // Initial fetch + polling loop.
  useEffect(() => {
    let alive = true;
    let timer: number | null = null;

    async function tick() {
      if (!alive) return;
      await refresh();
      if (alive) timer = window.setTimeout(tick, POLL_MS);
    }
    void tick();
    return () => {
      alive = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [refresh]);

  function goTo(v: View) {
    userOverrode.current = true;
    setView(v);
  }

  // Stable callbacks for child views.
  const onAddVault = useCallback(() => goTo("wizard"), []);
  const onShowLanding = useCallback(() => goTo("landing"), []);
  const onShowDashboard = useCallback(() => goTo("dashboard"), []);

  const isOffline =
    state.kind === "error" &&
    /Failed to fetch|ECONNREFUSED|NetworkError/i.test(state.message);

  return (
    <div className="min-h-full">
      {isOffline && <ServerOfflineBanner message={state.message} />}

      {view === "wizard" && (
        <AddVaultWizard
          onCancel={() => {
            const hasVaults =
              state.kind === "loaded" && state.vaults.length > 0;
            goTo(hasVaults ? "dashboard" : "landing");
          }}
          onCreated={() => {
            void refresh();
            goTo("dashboard");
          }}
        />
      )}

      {view === "landing" && (
        <Landing onAddVault={onAddVault} />
      )}

      {view === "dashboard" && state.kind === "loading" && (
        <LoadingScreen />
      )}

      {view === "dashboard" &&
        state.kind === "loaded" &&
        state.vaults.length === 0 && (
          <EmptyDashboard
            onAddVault={onAddVault}
            onShowLanding={onShowLanding}
          />
        )}

      {view === "dashboard" &&
        state.kind === "loaded" &&
        state.vaults.length > 0 && (
          <Dashboard
            vaults={state.vaults}
            onAddVault={onAddVault}
            onShowLanding={onShowLanding}
            onRefresh={() => void refresh()}
          />
        )}

      {view === "dashboard" && state.kind === "error" && !isOffline && (
        <FatalErrorScreen
          message={state.message}
          onRetry={() => void refresh()}
          onShowLanding={onShowLanding}
        />
      )}

      {/* When the user clicks "About" from the dashboard header but
          there are no vaults yet, we fall through to landing above. */}
      {view === "landing" &&
        state.kind === "loaded" &&
        state.vaults.length > 0 && (
          <button
            onClick={onShowDashboard}
            className="fixed bottom-6 right-6 neo-button-lime z-10 !px-4 !py-3 text-sm"
          >
            ← Back to my savings
          </button>
        )}
    </div>
  );
}

function LoadingScreen() {
  return (
    <div className="flex h-screen items-center justify-center">
      <div className="text-center">
        <div className="mx-auto h-12 w-12 animate-pulse-glow rounded-2xl neo-border bg-lime" />
        <p className="mt-6 text-xs font-bold uppercase tracking-widest text-muted-foreground">
          Loading…
        </p>
      </div>
    </div>
  );
}

function EmptyDashboard({
  onAddVault,
  onShowLanding,
}: {
  onAddVault: () => void;
  onShowLanding: () => void;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="text-center">
        <h2 className="font-display text-3xl font-bold md:text-4xl">
          You don't have any savings yet.
        </h2>
        <p className="mt-3 text-muted-foreground">
          Set up your first one in about 10 minutes.
        </p>
        <div className="mt-8 flex justify-center gap-3">
          <button onClick={onAddVault} className="neo-button-lime text-sm">
            Set one up
          </button>
          <button onClick={onShowLanding} className="neo-button text-sm">
            How does it work?
          </button>
        </div>
      </div>
    </div>
  );
}

function FatalErrorScreen({
  message,
  onRetry,
  onShowLanding,
}: {
  message: string;
  onRetry: () => void;
  onShowLanding: () => void;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="max-w-md text-center">
        <h2 className="font-display text-3xl font-bold">Something went wrong</h2>
        <p className="mt-3 font-mono text-sm text-muted-foreground">{message}</p>
        <div className="mt-8 flex justify-center gap-3">
          <button onClick={onRetry} className="neo-button-lime text-sm">
            Try again
          </button>
          <button onClick={onShowLanding} className="neo-button text-sm">
            Back to start
          </button>
        </div>
      </div>
    </div>
  );
}
