/**
 * Top-level app shell.
 *
 * Routes (single-page, hash-driven):
 *   landing         — marketing + how-it-works
 *   setup           — 3-step PasswordSetupPortal (default)
 *   setup-legacy    — original bring-your-own-xpub wizard (advanced/CLI)
 *   setup-password  — alias of `setup` (preserved so Pass 3 preview
 *                     links don't 404; safe to retire once nobody
 *                     references it externally)
 *   success         — celebration screen shown right after activation
 *   dashboard       — active vault on this device
 *   checkin         — SignInPortal: email + password unlocks the
 *                     vault on any device
 *   checkin-legacy  — original lookup-by-vault-id portal, kept for
 *                     vaults created before the password flow
 *   inherit         — heir-side status lookup
 *   claim/<token>   — heir lands here from their one-time link; not
 *                     navigable from the nav, no localStorage state
 *
 * State that crosses routes lives in localStorage (active vault id and
 * heir metadata) via vaultStore.ts. There is no global store beyond
 * route + health.
 */
import { useEffect, useState } from "react";
import { NavBar } from "./NavBar";
import { Landing } from "./Landing";
import { SetupPortal } from "./SetupPortal";
import { PasswordSetupPortal } from "./PasswordSetupPortal";
import { CheckinPortal } from "./CheckinPortal";
import { SignInPortal } from "./SignInPortal";
import { InheritPortal } from "./InheritPortal";
import { Dashboard } from "./Dashboard";
import { ClaimPage } from "./ClaimPage";
import { ServerOfflineBanner } from "./ServerOfflineBanner";
import { Button } from "./ui";
import { api } from "./api";
import { getActiveVaultId } from "./vaultStore";

/**
 * Route slugs the app understands. Two routes are "legacy" — they
 * point at the pre-password-vault UI and are kept so users with
 * vaults created before the redesign can still operate them:
 *
 *   - setup-legacy  → bring-your-own-xpub wizard (advanced / CLI)
 *   - checkin-legacy → lookup-by-vault-id check-in
 *
 * The plain `setup` and `checkin` slugs now map to the password
 * flow (in-browser keygen + email+password sign-in).
 *
 * `setup-password` is kept as an alias for `setup` so the preview
 * URLs shared during Pass 3 don't 404 in tests/bookmarks.
 */
export type Route =
  | "landing"
  | "setup"
  | "setup-legacy"
  | "setup-password"
  | "success"
  | "dashboard"
  | "checkin"
  | "checkin-legacy"
  | "inherit";

const VALID: Route[] = [
  "landing",
  "setup",
  "setup-legacy",
  "setup-password",
  "success",
  "dashboard",
  "checkin",
  "checkin-legacy",
  "inherit",
];

/**
 * Resolved hash → either a navigable Route, or a parameterised location
 * (today: only `claim` with its token). Kept as a discriminated union so
 * the renderer can pattern-match cleanly.
 */
type Location =
  | { kind: "route"; route: Route }
  | { kind: "claim"; token: string };

function locationFromHash(): Location {
  if (typeof window === "undefined") return { kind: "route", route: "landing" };
  const raw = window.location.hash.replace(/^#\/?/, "");
  // claim/<token>
  if (raw.startsWith("claim/")) {
    const token = raw.slice("claim/".length).trim();
    if (token) return { kind: "claim", token };
  }
  const slug = raw as Route;
  return {
    kind: "route",
    route: VALID.includes(slug) ? slug : "landing",
  };
}

export default function App() {
  const [location, setLocation] = useState<Location>(locationFromHash);
  const [health, setHealth] = useState<"unknown" | "ok" | "offline">("unknown");

  // Sync the URL hash with the current location. Only writes back for
  // simple routes; the claim page's token-bearing URL is owned by the
  // initial navigation and we never rewrite it.
  useEffect(() => {
    if (location.kind === "route") {
      const wanted = `#/${location.route}`;
      if (window.location.hash !== wanted) {
        window.history.replaceState(null, "", wanted);
      }
    }
    window.scrollTo(0, 0);
  }, [location]);

  useEffect(() => {
    const onHash = () => setLocation(locationFromHash());
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

  const setRoute = (r: Route) => setLocation({ kind: "route", route: r });
  const isClaim = location.kind === "claim";

  return (
    <div className="min-h-screen bg-app">
      <AlphaBanner />
      {health === "offline" && <ServerOfflineBanner />}
      {/*
        The heir claim page renders without the standard nav. The heir
        has never seen GhostKey before; "Set up" / "Dashboard" in the
        nav are noise that confuses the one thing they're here for.
      */}
      {!isClaim && (
        <NavBar
          route={location.kind === "route" ? location.route : "landing"}
          onNavigate={setRoute}
        />
      )}

      {location.kind === "route" && location.route === "landing"   && <Landing  onNavigate={setRoute} />}
      {location.kind === "route" && (location.route === "setup" || location.route === "setup-password") && (
        <PasswordSetupPortal
          onCancel={() => setRoute("dashboard")}
          onCreated={() => {
            /* Stay on the funding screen — the user dismisses
             * manually from inside the portal once they've copied
             * the address. The onCancel above is what fires when
             * they finally tap Done. */
          }}
        />
      )}
      {location.kind === "route" && location.route === "setup-legacy" && (
        <SetupPortal
          onCancel={() => setRoute("landing")}
          onCreated={() => setRoute("success")}
        />
      )}
      {location.kind === "route" && location.route === "success"   && <Success onNavigate={setRoute} />}
      {location.kind === "route" && location.route === "dashboard" && <Dashboard onNavigate={setRoute} />}
      {location.kind === "route" && location.route === "checkin"   && <SignInPortal onNavigate={setRoute} />}
      {location.kind === "route" && location.route === "checkin-legacy" && (
        <CheckinPortal initialId={getActiveVaultId() ?? undefined} />
      )}
      {location.kind === "route" && location.route === "inherit"   && <InheritPortal />}
      {location.kind === "claim" && <ClaimPage token={location.token} />}
    </div>
  );
}

/* ------------------------------- AlphaBanner ------------------------------ */

/**
 * Top-of-page reminder that this is alpha software running against
 * Bitcoin testnet, not mainnet. Vaults created here use testnet keys
 * and testnet UTXOs; nothing here moves real money. The banner is
 * deliberately small but persistent — losing it on scroll would
 * encourage someone to forget what network they're on and paste a
 * mainnet xpub by accident.
 */
function AlphaBanner() {
  return (
    <div
      role="status"
      className="border-b border-app bg-surface-2"
      style={{ fontSize: 12 }}
    >
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-5 py-1.5 md:px-8">
        <span
          aria-hidden="true"
          className="inline-block h-1.5 w-1.5 rounded-full bg-warning"
        />
        <p className="leading-tight text-muted">
          <span className="font-medium text-[var(--text)]">Alpha:</span>{" "}
          GhostKey is running on Bitcoin <span className="font-mono">testnet</span>.
          Don&apos;t use real-money keys yet.
        </p>
      </div>
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
