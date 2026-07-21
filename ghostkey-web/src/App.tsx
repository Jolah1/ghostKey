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
import {
  Suspense,
  lazy,
  useEffect,
  useState,
  type ComponentType,
  type LazyExoticComponent,
} from "react";
import { NavBar } from "./NavBar";
import { Landing } from "./Landing";
import { ServerOfflineBanner } from "./ServerOfflineBanner";
import { Button } from "./ui";
import { api } from "./api";
import { hashEmailForLookup } from "./crypto/sealing";
import {
  canLocalUnlock,
  getAllVaultMetas,
  getActiveVaultId,
  getVaultOwnerToken,
  hasLockedVaultCredential,
  hasVaultCredentialLock,
  lockVaultCredential,
  saveVaultCredentialLock,
  sessionExpired,
  touchSession,
} from "./vaultStore";

/**
 * Session flag marking that we've already burned our one reload on a
 * stale-chunk failure in this tab.
 */
const CHUNK_RELOAD_KEY = "gk:chunk-reload";

/** Browsers word this differently; match all the common phrasings. */
function isStaleChunkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i.test(
    msg,
  );
}

/**
 * `lazy()`, but a stale bundle heals itself instead of crashing.
 *
 * Every deploy changes the chunks' content hashes. A tab (or an
 * installed PWA) still holding the previous index.html then asks for
 * filenames that no longer exist. The import 404s, and React.lazy
 * surfaces that as a *render* error — so the ErrorBoundary's crash
 * card appears the moment the user navigates. Real owners hit this
 * mid sign-in, and heirs hit it mid claim, which is the worst
 * possible moment to show someone an error they can't act on.
 *
 * One reload fixes it (fresh index.html, current chunk names), so do
 * it for them. The sessionStorage flag bounds it to a single retry per
 * tab: if the chunk is genuinely missing (a broken deploy) rather than
 * merely stale, the second failure falls through to the boundary
 * instead of reload-looping.
 */
// `any` mirrors React's own `lazy<T extends ComponentType<any>>` — a
// narrower bound (unknown/never) won't accept components with props.
function lazyRoute<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
): LazyExoticComponent<T> {
  return lazy(() =>
    factory().then(
      (m) => {
        // Loaded fine — clear the guard so a later deploy in this same
        // tab still gets its own retry.
        try {
          sessionStorage.removeItem(CHUNK_RELOAD_KEY);
        } catch {
          // Storage can throw in private modes. Not worth failing over.
        }
        return m;
      },
      (err: unknown) => {
        let alreadyTried = false;
        try {
          alreadyTried = sessionStorage.getItem(CHUNK_RELOAD_KEY) === "1";
        } catch {
          // See above; treat as "not tried" and let the reload guard
          // itself be best-effort.
        }
        if (!isStaleChunkError(err) || alreadyTried) throw err;
        try {
          sessionStorage.setItem(CHUNK_RELOAD_KEY, "1");
        } catch {
          // If we can't persist the guard we still reload once; a loop
          // would need storage to be broken *and* the deploy bad.
        }
        window.location.reload();
        // Never settles: the reload is tearing this document down, and
        // resolving here would only race it.
        return new Promise<{ default: T }>(() => {});
      },
    ),
  );
}

// Every route except the landing page is code-split. A visitor's
// first paint only pays for the marketing page + shell; the heavier
// flows (setup with its crypto stack, the dashboard, the claim page)
// download when — and only when — they're navigated to. AssistChat is
// shared by two lazy routes, so Vite hoists it into its own chunk.
const SetupPortal = lazyRoute(() =>
  import("./SetupPortal").then((m) => ({ default: m.SetupPortal })),
);
const PasswordSetupPortal = lazyRoute(() =>
  import("./PasswordSetupPortal").then((m) => ({ default: m.PasswordSetupPortal })),
);
const CheckinPortal = lazyRoute(() =>
  import("./CheckinPortal").then((m) => ({ default: m.CheckinPortal })),
);
const SignInPortal = lazyRoute(() =>
  import("./SignInPortal").then((m) => ({ default: m.SignInPortal })),
);
const InheritPortal = lazyRoute(() =>
  import("./InheritPortal").then((m) => ({ default: m.InheritPortal })),
);
const Dashboard = lazyRoute(() =>
  import("./Dashboard").then((m) => ({ default: m.Dashboard })),
);
const ActivityPage = lazyRoute(() =>
  import("./ActivityPage").then((m) => ({ default: m.ActivityPage })),
);
const HeirMessagePage = lazyRoute(() =>
  import("./VaultToolPages").then((m) => ({ default: m.HeirMessagePage })),
);
const PracticeRunPage = lazyRoute(() =>
  import("./VaultToolPages").then((m) => ({ default: m.PracticeRunPage })),
);
const EmergencyPage = lazyRoute(() =>
  import("./VaultToolPages").then((m) => ({ default: m.EmergencyPage })),
);
const RemindersPage = lazyRoute(() =>
  import("./VaultToolPages").then((m) => ({ default: m.RemindersPage })),
);
const HeirContactPage = lazyRoute(() =>
  import("./VaultToolPages").then((m) => ({ default: m.HeirContactPage })),
);
const ToolsPage = lazyRoute(() =>
  import("./VaultToolPages").then((m) => ({ default: m.ToolsPage })),
);
const RecoveryKitPage = lazyRoute(() =>
  import("./RecoveryKitPage").then((m) => ({ default: m.RecoveryKitPage })),
);
const RecoveryGuide = lazyRoute(() =>
  import("./RecoveryGuide").then((m) => ({ default: m.RecoveryGuide })),
);
const ClaimPage = lazyRoute(() =>
  import("./ClaimPage").then((m) => ({ default: m.ClaimPage })),
);
const OneTapCheckinPage = lazyRoute(() =>
  import("./OneTapCheckinPage").then((m) => ({ default: m.OneTapCheckinPage })),
);
const VerifyEmailPage = lazyRoute(() =>
  import("./VerifyEmailPage").then((m) => ({ default: m.VerifyEmailPage })),
);
const StatusPage = lazyRoute(() =>
  import("./StatusPage").then((m) => ({ default: m.StatusPage })),
);
// Terms + Privacy share one chunk (both static, same layout).
const TermsPage = lazyRoute(() =>
  import("./Legal").then((m) => ({ default: m.TermsPage })),
);
const PrivacyPage = lazyRoute(() =>
  import("./Legal").then((m) => ({ default: m.PrivacyPage })),
);

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
  | "activity"
  | "heir-message"
  | "heir-contact"
  | "practice"
  | "emergency"
  | "reminders"
  | "tools"
  | "recovery"
  | "recovery-guide"
  | "checkin"
  | "checkin-legacy"
  | "inherit"
  | "status"
  | "terms"
  | "privacy";

const VALID: Route[] = [
  "landing",
  "setup",
  "setup-legacy",
  "setup-password",
  "success",
  "dashboard",
  "activity",
  "heir-message",
  "heir-contact",
  "practice",
  "emergency",
  "reminders",
  "tools",
  "recovery",
  "recovery-guide",
  "checkin",
  "checkin-legacy",
  "inherit",
  "status",
  "terms",
  "privacy",
];

/**
 * Routes that operate the vault and need the owner credential. Only
 * these are replaced by the lock screen while the device is locked;
 * everything else (landing, FAQ, guides, inherit, legal) stays
 * browsable so a locked device is never a wall — an heir on the
 * owner's computer must still be able to reach the inherit page.
 */
const OWNER_ROUTES: Route[] = [
  "dashboard",
  "activity",
  "heir-message",
  "heir-contact",
  "practice",
  "emergency",
  "reminders",
  "tools",
  "recovery",
];

/**
 * Resolved hash → either a navigable Route, or a parameterised location
 * (today: `claim` with a token, and `checkin-link` with a vault id +
 * token). Kept as a discriminated union so the renderer can
 * pattern-match cleanly.
 */
type Location =
  | { kind: "route"; route: Route }
  | { kind: "claim"; token: string }
  | { kind: "owner-recovery"; token: string }
  | { kind: "one-tap-checkin"; vaultId: string; token: string }
  | { kind: "verify-email"; vaultId: string; token: string };

function locationFromHash(): Location {
  if (typeof window === "undefined") return { kind: "route", route: "landing" };
  const raw = window.location.hash.replace(/^#\/?/, "");
  // claim/<token>
  if (raw.startsWith("claim/")) {
    const token = raw.slice("claim/".length).trim();
    if (token) return { kind: "claim", token };
  }
  if (raw.startsWith("recover/")) {
    const token = raw.slice("recover/".length).trim();
    if (token) return { kind: "owner-recovery", token };
  }
  // checkin-link/<vaultId>/<token>
  // Emitted by the scheduler's pre-deadline reminder + alarm emails.
  // We split on the first `/` after the prefix; the token can contain
  // any URL-safe character and we don't validate its shape here (the
  // server is the source of truth on that).
  if (raw.startsWith("checkin-link/")) {
    const rest = raw.slice("checkin-link/".length);
    const slash = rest.indexOf("/");
    if (slash > 0) {
      const vaultId = rest.slice(0, slash).trim();
      const token = rest.slice(slash + 1).trim();
      if (vaultId && token) {
        return { kind: "one-tap-checkin", vaultId, token };
      }
    }
  }
  // verify-email/<vaultId>/<token>
  // Emitted by the owner-email confirmation mail sent at vault
  // creation (and on dashboard resend). Same parse shape as the
  // one-tap check-in link above.
  if (raw.startsWith("verify-email/")) {
    const rest = raw.slice("verify-email/".length);
    const slash = rest.indexOf("/");
    if (slash > 0) {
      const vaultId = rest.slice(0, slash).trim();
      const token = rest.slice(slash + 1).trim();
      if (vaultId && token) {
        return { kind: "verify-email", vaultId, token };
      }
    }
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
  // Demo-mode flag from /health. Surfaced as a sticky banner across
  // every page so the operator (and anyone watching the demo) can
  // never miss that this server is loose with cadence validation.
  // Defaults to false until the first probe completes, so we don't
  // flash a banner that turns out to be wrong on a normal server.
  const [demoMode, setDemoMode] = useState(false);
  // Bitcoin network this server is on. Read from /health on the same
  // probe as `demoMode`; falls back to "testnet" when unknown. The
  // alpha banner names this network so anyone landing on a signet
  // demo server sees "signet" instead of the historical "testnet"
  // literal. See `crates/ghostkey-server/src/config.rs`.
  const [network, setNetwork] = useState<"bitcoin" | "testnet" | "signet" | "regtest">("testnet");
  // Whether this device holds a vault credential. Drives the nav (no
  // "Sign in" while signed in). Trusted-device credentials persist
  // across visits; email recovery is only for a browser that has no
  // local credential.
  const [locked, setLocked] = useState(() => {
    const activeId = getActiveVaultId();
    return (
      hasLockedVaultCredential(activeId) ||
      (sessionExpired() && hasVaultCredentialLock(activeId))
    );
  });
  const [signedIn, setSignedIn] = useState(
    () =>
      Boolean(getActiveVaultId()) &&
      !hasLockedVaultCredential(getActiveVaultId()) &&
      !(sessionExpired() && hasVaultCredentialLock(getActiveVaultId())),
  );
  // True only when the lock fired during this visit (inactivity, or
  // another tab locking). A browser that simply reopens with a locked
  // credential is a normal return, not a timeout — the lock screen
  // greets it with "Welcome back" instead.
  const [timedOut, setTimedOut] = useState(false);
  // One-shot banner shown on public pages after an inactivity lock so
  // the next visit to the dashboard asking for a password doesn't feel
  // like a bug. Dismissable; clears on unlock.
  const [expiredNotice, setExpiredNotice] = useState(false);

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

  // Re-sync after sign-in or setup completion stores the credential.
  useEffect(() => {
    setSignedIn(Boolean(getActiveVaultId()) && !locked);
  }, [location, locked]);

  // localStorage is shared by tabs. When one tab marks the credential locked,
  // every other open tab must unmount its owner UI as well.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (
        event.key === "gk:vaults" &&
        hasLockedVaultCredential(getActiveVaultId())
      ) {
        setLocked(true);
        setSignedIn(false);
        setTimedOut(true);
        setExpiredNotice(true);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Before showing the timeout screen, replace each validated password-vault
  // bearer token with its encrypted blob. Existing sessions first cache the
  // blob without deleting the live token; password unlock validates the pair,
  // so later timeouts can remove the live token safely. Legacy wallet vaults
  // have no such blob and are deliberately left alone.
  useEffect(() => {
    let lastTouch = 0;
    let checking = false;
    const lockIfPasswordVault = async () => {
      if (locked || checking || !sessionExpired()) return;
      const activeId = getActiveVaultId();
      if (!activeId) return;
      checking = true;
      let lockedActive = false;
      try {
        for (const meta of getAllVaultMetas()) {
          const ownerToken = getVaultOwnerToken(meta.id);
          if (!ownerToken || !/^.+@.+\..+$/.test(meta.owner.address.trim())) {
            continue;
          }
          if (meta.ownerTokenLock) {
            lockVaultCredential(meta.id, meta.ownerTokenLock);
            continue;
          }
          try {
            const blobs = await api.getSealedBlobs(meta.id, ownerToken);
            saveVaultCredentialLock(meta.id, {
              passwordSalt: blobs.password_salt_b64,
              memKiB: blobs.password_kdf_mem_kib,
              iters: blobs.password_kdf_iters,
              ownerTokenBlob: {
                v: 1,
                ct: blobs.owner_token_ct_b64,
                nonce: blobs.owner_token_nonce_b64,
              },
              ownerEmailHash: hashEmailForLookup(meta.owner.address),
            });
          } catch {
            // A legacy/non-password vault cannot be locked this way. Its
            // irreplaceable local token must not be deleted.
          }
        }
        if (hasVaultCredentialLock(activeId)) {
          lockedActive = true;
          setLocked(true);
          setSignedIn(false);
          setTimedOut(true);
          setExpiredNotice(true);
        }
      } finally {
        // Defer another migration attempt for legacy/offline rows instead of
        // retrying on every click.
        if (!lockedActive) touchSession();
        checking = false;
      }
    };
    const onActivity = () => {
      if (locked || !getActiveVaultId()) return;
      // Do not let the first click after a long absence renew an already
      // expired session before the periodic/visibility check sees it.
      if (sessionExpired()) {
        void lockIfPasswordVault();
        return;
      }
      const now = Date.now();
      if (now - lastTouch >= 30_000) {
        lastTouch = now;
        touchSession();
      }
    };
    const check = () => void lockIfPasswordVault();
    const events = ["pointerdown", "keydown", "scroll"] as const;
    events.forEach((event) =>
      window.addEventListener(event, onActivity, { passive: true }),
    );
    const interval = window.setInterval(check, 30_000);
    const onVisible = () => {
      if (!document.hidden) check();
    };
    document.addEventListener("visibilitychange", onVisible);
    check();
    return () => {
      events.forEach((event) => window.removeEventListener(event, onActivity));
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [locked]);

  // Health probe — also captures the demo_mode flag so we can render
  // the sticky banner. Polls every 20s; if the operator toggles the
  // flag without restarting the page, we'll pick it up within one
  // poll cycle.
  useEffect(() => {
    let alive = true;
    let timer: number | null = null;
    async function probe() {
      try {
        const h = await api.health();
        if (alive) {
          setHealth("ok");
          setDemoMode(Boolean(h.demo_mode));
          if (h.default_network) setNetwork(h.default_network);
        }
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
  // Nav is also hidden for the one-tap check-in and email-confirm
  // pages. The owner arrived from an email link; "Set up" /
  // "Dashboard" / "Sign in" in the top bar would just be noise for
  // the one thing they came here to do. Same rationale as the claim
  // page.
  const isOneTap =
    location.kind === "one-tap-checkin" || location.kind === "verify-email";
  // The lock screen only replaces owner pages. Public pages render
  // normally while locked, with the slim timeout notice instead.
  const lockScreen =
    locked &&
    location.kind === "route" &&
    OWNER_ROUTES.includes(location.route);

  return (
    <div className="min-h-screen bg-app">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      {/* Only show the network banner once /health has SUCCEEDED.
          `network` defaults to "testnet", so rendering before the
          probe (or after a failed one) told a mainnet owner
          "Alpha: testnet, don't use real-money keys" — false and
          alarming at the exact moment the server was already down.
          When the probe fails, ServerOfflineBanner below covers it. */}
      {health === "ok" && <AlphaBanner network={network} />}
      {demoMode && <DemoBanner />}
      {health === "offline" && <ServerOfflineBanner />}
      {/*
        The heir claim page renders without the standard nav. The heir
        has never seen GhostKey before; "Set up" / "Dashboard" in the
        nav are noise that confuses the one thing they're here for.
      */}
      {!isClaim && !isOneTap && (
        <NavBar
          route={location.kind === "route" ? location.route : "landing"}
          onNavigate={setRoute}
          signedIn={signedIn}
        />
      )}
      {expiredNotice && !isClaim && !isOneTap && !lockScreen && (
        <SessionExpiredNotice onDismiss={() => setExpiredNotice(false)} />
      )}
      {/* Routes render their own <main>; this anchor is the skip-link
          target so keyboard users can jump past the nav/banners. */}
      <div id="main">
      <Suspense fallback={<RouteLoading />}>
      {lockScreen ? (
        <SignInPortal
          localUnlock
          timedOut={timedOut}
          onNavigate={setRoute}
          onUnlock={() => {
            touchSession();
            setLocked(false);
            setSignedIn(true);
            setTimedOut(false);
            setExpiredNotice(false);
          }}
        />
      ) : (
      <>
      {location.kind === "route" && location.route === "landing"   && <Landing  onNavigate={setRoute} />}
      {location.kind === "route" && (location.route === "setup" || location.route === "setup-password") && (
        <PasswordSetupPortal
          onCancel={() => setRoute("dashboard")}
          onSignIn={() => setRoute("checkin")}
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
      {location.kind === "route" && location.route === "activity"  && <ActivityPage onNavigate={setRoute} />}
      {location.kind === "route" && location.route === "heir-message" && <HeirMessagePage onNavigate={setRoute} />}
      {location.kind === "route" && location.route === "heir-contact" && <HeirContactPage onNavigate={setRoute} />}
      {location.kind === "route" && location.route === "practice"  && <PracticeRunPage onNavigate={setRoute} />}
      {location.kind === "route" && location.route === "emergency" && <EmergencyPage onNavigate={setRoute} />}
      {location.kind === "route" && location.route === "reminders" && <RemindersPage onNavigate={setRoute} />}
      {location.kind === "route" && location.route === "tools"     && <ToolsPage onNavigate={setRoute} />}
      {location.kind === "route" && location.route === "recovery"  && <RecoveryKitPage onNavigate={setRoute} />}
      {location.kind === "route" && location.route === "recovery-guide" && <RecoveryGuide onNavigate={setRoute} />}
      {location.kind === "route" && location.route === "checkin" && (
        <SignInPortal
          localUnlock={canLocalUnlock(getActiveVaultId())}
          onNavigate={setRoute}
          onUnlock={() => {
            touchSession();
            setLocked(false);
            setSignedIn(true);
            setTimedOut(false);
            setExpiredNotice(false);
            setRoute("dashboard");
          }}
        />
      )}
      {location.kind === "owner-recovery" && (
        <SignInPortal
          onNavigate={setRoute}
          recoveryToken={location.token}
          onUnlock={() => {
            touchSession();
            setLocked(false);
            setSignedIn(true);
            setTimedOut(false);
            setExpiredNotice(false);
          }}
        />
      )}
      {location.kind === "route" && location.route === "checkin-legacy" && (
        <CheckinPortal initialId={getActiveVaultId() ?? undefined} />
      )}
      {location.kind === "route" && location.route === "inherit"   && <InheritPortal />}
      {location.kind === "route" && location.route === "status"    && <StatusPage />}
      {location.kind === "route" && location.route === "terms"     && <TermsPage />}
      {location.kind === "route" && location.route === "privacy"   && <PrivacyPage />}
      {location.kind === "claim" && <ClaimPage token={location.token} />}
      {location.kind === "one-tap-checkin" && (
        <OneTapCheckinPage
          vaultId={location.vaultId}
          token={location.token}
          onNavigate={setRoute}
        />
      )}
      {location.kind === "verify-email" && (
        <VerifyEmailPage
          vaultId={location.vaultId}
          token={location.token}
          onNavigate={setRoute}
        />
      )}
      </>
      )}
      </Suspense>
      </div>
    </div>
  );
}

/** Minimal centered placeholder while a lazy route chunk downloads.
 *  Kept text-only: the chunks are tens of KB on a CDN, so this is
 *  visible for a blink on most connections — a spinner would flash. */
function RouteLoading() {
  return (
    <main className="bg-app">
      <div
        className="mx-auto max-w-xl px-5 py-24 text-center text-sm text-muted"
        role="status"
        aria-live="polite"
      >
        Getting things ready…
      </div>
    </main>
  );
}

/* -------------------------- SessionExpiredNotice -------------------------- */

/**
 * Shown once after the inactivity lock fires, so the password prompt
 * on the next dashboard visit doesn't feel like a bug. Dismissable;
 * also clears itself on the next successful unlock.
 */
function SessionExpiredNotice({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div role="status" className="border-b border-app bg-surface-2">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-5 py-2 md:px-8">
        <p className="text-xs text-muted">
          Session timed out. Sign in to continue.
        </p>
        <button
          type="button"
          onClick={onDismiss}
          className="text-xs text-dim underline hover:text-[var(--text)]"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

/* ------------------------------- AlphaBanner ------------------------------ */

/**
 * Top-of-page reminder about the network this server is on. Reads
 * the actual network from `/health.default_network` so a single web
 * bundle can correctly name testnet, signet, regtest, or (with the
 * appropriate operator consent) bitcoin mainnet. Vaults created
 * here use keys on that network; nothing crosses network boundaries.
 *
 * The banner is deliberately small but persistent — losing it on
 * scroll would encourage someone to forget what network they're on
 * and paste a mainnet xpub into a testnet vault by accident.
 *
 * Mainnet is allowed — the server's `GHOSTKEY_DEFAULT_NETWORK=bitcoin`
 * already logs a startup warning making the choice explicit — but
 * the banner copy here changes to something more cautious so the
 * user knows real money is in scope.
 */
function AlphaBanner({
  network,
}: {
  network: "bitcoin" | "testnet" | "signet" | "regtest";
}) {
  const isMainnet = network === "bitcoin";
  return (
    <div
      role="status"
      className="border-b border-app bg-surface-2"
      style={{ fontSize: 12 }}
    >
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-5 py-1.5 md:px-8">
        <span
          aria-hidden="true"
          className={`inline-block h-1.5 w-1.5 rounded-full ${
            isMainnet ? "bg-alarm" : "bg-warning"
          }`}
        />
        <p className="leading-tight text-muted">
          {isMainnet ? (
            <>
              You&apos;re on the live Bitcoin network. Your funds are real.
            </>
          ) : (
            <>
              <span className="font-medium text-[var(--text)]">Alpha:</span>{" "}
              GhostKey is running on Bitcoin{" "}
              <span className="font-mono">{network}</span>. Don&apos;t use
              real-money keys yet.
            </>
          )}
        </p>
      </div>
    </div>
  );
}

/* ------------------------------- DemoBanner ------------------------------- */

/**
 * Persistent banner shown when the server reports `demo_mode: true`
 * on /health. Demo mode loosens cadence validation to seconds-scale
 * so the entire alarm → claim flow can be shown live; anyone landing
 * on this server should be told immediately, on every page, that the
 * timings are not realistic and the server is unsuitable for real
 * funds. The banner sits directly under AlphaBanner so the two read
 * as one stack of warnings; styled in amber to be visually distinct
 * from the alpha warning (grey) and the offline warning (red).
 */
function DemoBanner() {
  return (
    <div
      role="status"
      className="border-b border-amber-400/40 bg-amber-400/10"
      style={{ fontSize: 12 }}
    >
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-5 py-1.5 md:px-8">
        <span
          aria-hidden="true"
          className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400"
        />
        <p className="leading-tight text-amber-200">
          <span className="font-semibold">Demo mode:</span> check-in
          cadences on this server are measured in seconds so the alarm
          and claim flow can be shown live. Do not store real funds
          here.
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
