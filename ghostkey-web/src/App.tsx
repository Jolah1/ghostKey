/**
 * Top-level app shell.
 *
 * Routes (single-page, hash-driven):
 *   landing       — marketing + how-it-works
 *   setup         — 4-step wizard
 *   success       — celebration screen shown right after activation
 *   dashboard     — active vault on this device
 *   checkin       — lookup-by-ID check-in (heir/cross-device)
 *   inherit       — heir-side status lookup
 *
 * State that crosses routes lives in localStorage (active vault id and
 * heir metadata) via vaultStore.ts. There is no global store beyond
 * route + health.
 */
import { useEffect, useState } from "react";
import { NavBar } from "./NavBar";
import { Landing } from "./Landing";
import { SetupPortal } from "./SetupPortal";
import { CheckinPortal } from "./CheckinPortal";
import { InheritPortal } from "./InheritPortal";
import { Dashboard } from "./Dashboard";
import { ServerOfflineBanner } from "./ServerOfflineBanner";
import { Button } from "./ui";
import { api } from "./api";
import { getActiveVaultId } from "./vaultStore";

export type Route =
  | "landing"
  | "setup"
  | "success"
  | "dashboard"
  | "checkin"
  | "inherit";

const VALID: Route[] = [
  "landing",
  "setup",
  "success",
  "dashboard",
  "checkin",
  "inherit",
];

function routeFromHash(): Route {
  if (typeof window === "undefined") return "landing";
  const slug = window.location.hash.replace(/^#\/?/, "") as Route;
  return VALID.includes(slug) ? slug : "landing";
}

export default function App() {
  const [route, setRoute] = useState<Route>(routeFromHash);
  const [health, setHealth] = useState<"unknown" | "ok" | "offline">("unknown");

  // Reflect route in the URL hash and sync back the other way.
  useEffect(() => {
    const wanted = `#/${route}`;
    if (window.location.hash !== wanted) {
      window.history.replaceState(null, "", wanted);
    }
    // Reset scroll on route changes so the next screen starts at the top.
    window.scrollTo(0, 0);
  }, [route]);

  useEffect(() => {
    const onHash = () => setRoute(routeFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Health probe — only used to surface the offline banner.
  useEffect(() => {
    let alive = true;
    let timer: number | null = null;
    async function probe() {
      try {
        await api.health();
        if (alive) setHealth("ok");
      } catch {
        if (alive) setHealth("offline");
      }
      if (alive) timer = window.setTimeout(probe, 20_000);
    }
    void probe();
    return () => {
      alive = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);

  return (
    <div className="min-h-screen bg-app">
      {health === "offline" && <ServerOfflineBanner />}
      <NavBar route={route} onNavigate={setRoute} />

      {route === "landing"   && <Landing  onNavigate={setRoute} />}
      {route === "setup"     && (
        <SetupPortal
          onCancel={() => setRoute("landing")}
          onCreated={() => setRoute("success")}
        />
      )}
      {route === "success"   && <Success onNavigate={setRoute} />}
      {route === "dashboard" && <Dashboard onNavigate={setRoute} />}
      {route === "checkin"   && (
        <CheckinPortal initialId={getActiveVaultId() ?? undefined} />
      )}
      {route === "inherit"   && <InheritPortal />}
    </div>
  );
}

/* --------------------------------- Success -------------------------------- */

function Success({ onNavigate }: { onNavigate: (r: Route) => void }) {
  return (
    <main className="bg-app fade-in">
      <div className="mx-auto flex max-w-xl flex-col items-center px-5 py-24 text-center md:py-32">
        <div
          aria-hidden="true"
          className="flex h-20 w-20 items-center justify-center rounded-full"
          style={{
            background: "var(--accent-tint)",
            border: "1px solid var(--accent)",
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="var(--accent-text)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-8 w-8">
            <path d="M20 6L9 17l-5-5" />
          </svg>
        </div>
        <h1 className="mt-6 font-serif text-4xl md:text-5xl">Your vault is live</h1>
        <p className="mt-3 max-w-md text-muted">
          The person you named will receive your Bitcoin when the time comes.
          Tap once a month. Nothing changes until you stop.
        </p>
        <div className="mt-10">
          <Button onClick={() => onNavigate("dashboard")} size="lg">
            Go to dashboard
          </Button>
        </div>
      </div>
    </main>
  );
}
