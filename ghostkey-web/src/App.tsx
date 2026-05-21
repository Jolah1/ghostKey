/**
 * Top-level orchestration for the v2 site.
 *
 * Routing is single-page state: the user picks a portal from the nav
 * and we render exactly one of {landing, setup, checkin, inherit}.
 *
 * No automatic dashboard; the user always lands on `landing` (unless
 * deep-linked via a hash, see `routeFromHash`).
 *
 * We deliberately don't fetch the vault list anywhere — the visitor
 * looks things up by ID. Future work: surface a "your vaults"
 * affordance once we have wallet-bound discovery.
 */
import { useEffect, useState } from "react";
import { NavBar } from "./NavBar";
import { Landing } from "./Landing";
import { SetupPortal } from "./SetupPortal";
import { CheckinPortal } from "./CheckinPortal";
import { InheritPortal } from "./InheritPortal";
import { ServerOfflineBanner } from "./ServerOfflineBanner";
import { api } from "./api";
import type { WalletIdentity } from "./wallet";

export type Route = "landing" | "setup" | "checkin" | "inherit";

const VALID_ROUTES: Route[] = ["landing", "setup", "checkin", "inherit"];

function routeFromHash(): Route {
  if (typeof window === "undefined") return "landing";
  const slug = window.location.hash.replace(/^#\/?/, "") as Route;
  return VALID_ROUTES.includes(slug) ? slug : "landing";
}

export default function App() {
  const [route, setRoute] = useState<Route>(routeFromHash);
  const [wallet, setWallet] = useState<WalletIdentity | null>(null);
  const [health, setHealth] = useState<"unknown" | "ok" | "offline">(
    "unknown",
  );

  // Sync URL hash with the current route, both directions.
  useEffect(() => {
    const wanted = `#/${route}`;
    if (window.location.hash !== wanted) {
      window.history.replaceState(null, "", wanted);
    }
  }, [route]);

  useEffect(() => {
    const onHash = () => setRoute(routeFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Health probe. We don't poll — once the user takes an action the
  // portals will surface any error themselves. This is just for the
  // "server offline" banner.
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
      if (alive) timer = window.setTimeout(probe, 15_000);
    }
    void probe();
    return () => {
      alive = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);

  return (
    <div className="min-h-full bg-cream">
      {health === "offline" && <ServerOfflineBanner />}
      <NavBar
        route={route}
        onNavigate={setRoute}
        wallet={wallet}
        onWalletChange={setWallet}
      />

      {route === "landing" && <Landing onNavigate={setRoute} />}

      {route === "setup" && (
        <SetupPortal
          onCancel={() => setRoute("landing")}
          onCreated={(v) => {
            // After creating, take the user to "I'm OK" pre-filled
            // with their new vault id, so they can verify the green
            // status sentence and see how a tap feels.
            if (typeof window !== "undefined") {
              window.sessionStorage.setItem("gk:lastVaultId", v.id);
            }
            setRoute("checkin");
          }}
        />
      )}

      {route === "checkin" && (
        <CheckinPortal initialId={readLastVaultId()} />
      )}

      {route === "inherit" && <InheritPortal />}
    </div>
  );
}

function readLastVaultId(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return window.sessionStorage.getItem("gk:lastVaultId") ?? undefined;
}
