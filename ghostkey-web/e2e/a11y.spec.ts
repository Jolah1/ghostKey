/**
 * Accessibility gate for the four core pages (#225).
 *
 * Serves the built dist/ over a local HTTP server (hash routing means
 * every route is index.html) and mocks /api/* with fixtures, so the
 * dashboard renders a real signed-in vault and the claim page renders
 * the real timelock-wait state — not error shells. Then axe-core scans
 * each page and the suite fails on any serious or critical violation.
 *
 * Why these four: landing (first contact), setup (the funnel),
 * dashboard (the owner's monthly touchpoint), claim (used exactly once,
 * by a possibly non-technical heir under stress — the page that can
 * least afford to exclude anyone).
 *
 * Prereq: `npm run build` (the workflow builds before running this).
 */
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createServer, type Server } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, normalize, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = resolve(__dirname, "..", "dist");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

let server: Server;
let base: string;

test.beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0].split("#")[0];
    // Everything under /api is Playwright-intercepted per test; a
    // request landing here means a fixture is missing — 404 loudly.
    if (path.startsWith("/api/")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unmocked API call in a11y e2e" }));
      return;
    }
    const rel = path === "/" ? "index.html" : path.slice(1);
    const file = normalize(join(dist, rel));
    const target = file.startsWith(dist) && existsSync(file) ? file : join(dist, "index.html");
    res.writeHead(200, {
      "content-type": MIME[extname(target)] ?? "application/octet-stream",
    });
    res.end(readFileSync(target));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  base = `http://127.0.0.1:${addr.port}`;
});

test.afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

/* ----------------------------- fixtures ------------------------------ */

const VAULT_ID = "v-a11y";
const FUTURE = new Date(Date.now() + 21 * 86400_000).toISOString();
const PAST = new Date(Date.now() - 7 * 86400_000).toISOString();

const health = {
  ok: true,
  version: "e2e",
  lightning_enabled: false,
  demo_mode: false,
  default_network: "signet",
  assist_enabled: false,
  push_public_key: null,
};

const vaultView = {
  id: VAULT_ID,
  label: "Family vault",
  network: "signet",
  timelock_blocks: 4320,
  checkin_period_secs: 2_592_000,
  grace_period_secs: 604_800,
  status: "ok",
  created_at: PAST,
  last_checkin_at: PAST,
  next_deadline_at: FUTURE,
  claim_eligible_at: FUTURE,
  owner_contact_verified: true,
  has_trusted_contact: false,
  lnurl_checkin: null,
  lnurl_panic: null,
};

const claimView = {
  vault_id: VAULT_ID,
  label: "Family vault",
  network: "signet",
  status: "claimable",
  timelock_blocks: 4320,
  next_deadline_at: PAST,
  heir_channel: "email",
  heir_display_name: "Ada",
  claim_available_at: FUTURE,
  vault_kind: "standard",
  token_role: "heir",
  guardian_slot: null,
};

const unlockEstimate = {
  matured: false,
  tip_height: 200_000,
  unlock_height: 203_000,
  blocks_remaining: 3_000,
  unlock_eta: FUTURE,
};

/** Intercept every /api call the pages make with canned fixtures. */
async function mockApi(page: Page) {
  const json = (body: unknown, status = 200) => ({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname.replace(/^\/api/, "");
    const method = route.request().method();

    if (p === "/health") return route.fulfill(json(health));
    if (p === "/health/lightning")
      return route.fulfill(json({ enabled: false, ready: false }));
    if (p === "/price")
      return route.fulfill(
        json({ usd_per_btc: 100_000, fetched_at: PAST, stale: false }),
      );
    if (p === "/events" && method === "POST")
      return route.fulfill({ status: 204, body: "" });

    if (p === `/vaults/${VAULT_ID}`) return route.fulfill(json(vaultView));
    if (p === `/vaults/${VAULT_ID}/events`) return route.fulfill(json([]));
    if (p === `/vaults/${VAULT_ID}/video`)
      return route.fulfill(
        json({ has_video: false, mime: null, duration_ms: null, created_at: null }),
      );
    if (p === `/vaults/${VAULT_ID}/balance`)
      return route.fulfill(
        json({
          vault_id: VAULT_ID,
          network: "signet",
          confirmed_sat: 150_000,
          unconfirmed_sat: 0,
          total_sat: 150_000,
        }),
      );

    if (p.startsWith("/claim/")) {
      if (p.endsWith("/video")) return route.fulfill(json({ error: "none" }, 404));
      if (p.endsWith("/unlock-estimate"))
        return route.fulfill(json(unlockEstimate));
      return route.fulfill(json(claimView));
    }

    // Anything else: fail loudly so a new page fetch gets a fixture
    // instead of silently rendering an error state we then scan.
    return route.fulfill(json({ error: `unmocked in a11y e2e: ${p}` }, 404));
  });
}

/** Seed the signed-in state the dashboard route requires. */
async function seedSignedIn(page: Page) {
  await page.addInitScript(
    ({ id, future }) => {
      const meta = {
        id,
        label: "Family vault",
        owner: { address: "owner@example.com" },
        heir: { name: "Ada", email: "ada@example.com", address: "" },
        createdAt: new Date(Date.now() - 7 * 86400_000).toISOString(),
        ownerToken: "e2e-owner-token",
        groupId: null,
      };
      window.localStorage.setItem("gk:vaults", JSON.stringify({ [id]: meta }));
      window.localStorage.setItem("gk:activeVaultId", id);
      window.localStorage.setItem("gk:lastActivityAt", String(Date.now()));
      void future;
    },
    { id: VAULT_ID, future: FUTURE },
  );
}

/** Run axe and fail on serious/critical violations, with a readable dump. */
async function expectNoSeriousViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  const dump = serious
    .map(
      (v) =>
        `${v.id} (${v.impact}): ${v.help}\n` +
        v.nodes
          .slice(0, 5)
          .map((n) => `  ${n.target.join(" ")}`)
          .join("\n"),
    )
    .join("\n\n");
  expect(serious, `axe violations:\n${dump}`).toEqual([]);
}

/* ------------------------------- tests -------------------------------- */

test("landing page has no serious a11y violations", async ({ page }) => {
  await mockApi(page);
  await page.goto(`${base}/#/landing`);
  await page.waitForSelector("main");
  await page.waitForLoadState("networkidle");
  await expectNoSeriousViolations(page);
});

test("setup page has no serious a11y violations", async ({ page }) => {
  await mockApi(page);
  await page.goto(`${base}/#/setup`);
  await page.waitForSelector("main");
  await page.waitForLoadState("networkidle");
  await expectNoSeriousViolations(page);
});

test("dashboard has no serious a11y violations", async ({ page }) => {
  await mockApi(page);
  await seedSignedIn(page);
  await page.goto(`${base}/#/dashboard`);
  // "Add Heir" renders only once the vault view has landed — a real
  // signed-in dashboard, not a redirect or an error shell.
  await page.waitForSelector("text=Add Heir");
  await page.waitForLoadState("networkidle");
  await expectNoSeriousViolations(page);
});

test("claim page (timelock wait state) has no serious a11y violations", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto(`${base}/#/claim/e2e-a11y-token`);
  await page.waitForSelector("main");
  await page.waitForLoadState("networkidle");
  await expectNoSeriousViolations(page);
});
