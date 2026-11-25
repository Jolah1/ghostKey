/**
 * Savings challenges, end to end in the browser against a mocked API:
 * Home invites one, the page starts the 52-week challenge with a typed
 * week 1 and "Don't touch it", stops one after asking, explains when no
 * goal can be a challenge, and a finished challenge shows "You did it"
 * on Home until it's waved off, and a badge on the page.
 *
 * Serves the built dist/ and intercepts /api/*. Prereq: `npm run build`.
 */
import { test, expect } from "@playwright/test";
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
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

let server: Server;
let base: string;

test.beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0].split("#")[0];
    if (path.startsWith("/api/")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    const rel = path === "/" ? "index.html" : path.slice(1);
    const file = normalize(join(dist, rel));
    const target = file.startsWith(dist) && existsSync(file) ? file : join(dist, "index.html");
    res.writeHead(200, { "content-type": MIME[extname(target)] ?? "application/octet-stream" });
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

const VAULT_ID = "v-ch";
const NOW = new Date().toISOString();
const FUTURE = new Date(Date.now() + 21 * 86400_000).toISOString();

type Ch = Record<string, unknown> & { id: string; kind: string; state: string };
const state: { challenges: Ch[]; joins: Record<string, unknown>[]; stops: string[]; goals: unknown[] } = {
  challenges: [],
  joins: [],
  stops: [],
  goals: [],
};

function challenge(over: Partial<Ch> & { kind: string }): Ch {
  return {
    id: `c${state.challenges.length + 1}`,
    state: "going",
    started_at: NOW,
    ended_at: null,
    completed_at: null,
    pct: 0,
    on_track: null,
    saved_sat: null,
    target_sat: null,
    hold_months: null,
    ends_at: null,
    goal_id: null,
    target_date: null,
    per_week_sat: null,
    year: null,
    from_month: null,
    months: null,
    week1_sat: null,
    week: null,
    due_so_far_sat: null,
    this_week_sat: null,
    ...over,
  };
}

async function mock(page: import("@playwright/test").Page, opts: { challenges?: Ch[]; goals?: unknown[] } = {}) {
  state.challenges = opts.challenges ?? [];
  state.goals = opts.goals ?? [];
  state.joins = [];
  state.stops = [];
  const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/api/**", (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname.replace(/^\/api/, "");
    if (p === "/health")
      return route.fulfill(json({ ok: true, version: "e2e", demo_mode: false, default_network: "signet", email_enabled: true, sms_enabled: false, whatsapp_enabled: false }));
    if (p === `/vaults/${VAULT_ID}`)
      return route.fulfill(
        json({
          id: VAULT_ID,
          label: "Savings",
          network: "signet",
          timelock_blocks: 4320,
          checkin_period_secs: 2_592_000,
          grace_period_secs: 604_800,
          status: "ok",
          created_at: FUTURE,
          last_checkin_at: null,
          next_deadline_at: FUTURE,
          claim_eligible_at: FUTURE,
        }),
      );
    if (p === `/vaults/${VAULT_ID}/balance`)
      return route.fulfill(json({ vault_id: VAULT_ID, network: "signet", confirmed_sat: 80_000, unconfirmed_sat: 0, total_sat: 80_000 }));
    if (p === `/vaults/${VAULT_ID}/events`) return route.fulfill(json([]));
    if (p === `/vaults/${VAULT_ID}/savings`)
      return route.fulfill(
        json({
          total_saved_sat: 80_000,
          deposit_count: 1,
          deposits: [{ amount_sat: 80_000, height: 1, seen_at: NOW, spent: false }],
          goal: state.goals[0] ?? null,
          goals: state.goals,
          unsorted: [],
          this_year: { year: 2026, total_sat: 80_000, deposit_count: 1, best_month: 11, best_month_sat: 80_000 },
          reminder: null,
          owner_email_confirmed: true,
        }),
      );
    if (p === `/vaults/${VAULT_ID}/savings/challenges` && req.method() === "GET")
      return route.fulfill(json({ challenges: state.challenges }));
    if (p === `/vaults/${VAULT_ID}/savings/challenges` && req.method() === "POST") {
      const b = req.postDataJSON();
      state.joins.push(b);
      const extra =
        b.kind === "week52"
          ? { week1_sat: b.week1_sat, week: 1, this_week_sat: b.week1_sat, due_so_far_sat: b.week1_sat, saved_sat: 0, target_sat: b.week1_sat * 1378, on_track: false }
          : b.kind === "hold"
            ? { hold_months: b.hold_months, ends_at: new Date(Date.now() + 90 * 86400_000 + 3600_000).toISOString() }
            : {};
      state.challenges = [challenge({ kind: b.kind, ...extra }), ...state.challenges];
      return route.fulfill(json({ challenges: state.challenges }));
    }
    if (p === `/vaults/${VAULT_ID}/savings/challenges/stop`) {
      const { id } = req.postDataJSON();
      state.stops.push(id);
      state.challenges = state.challenges.map((c) => (c.id === id ? { ...c, state: "stopped", ended_at: NOW } : c));
      return route.fulfill(json({ challenges: state.challenges }));
    }
    return route.fulfill(json({}, 404));
  });
  await page.addInitScript((id) => {
    const meta = {
      id,
      label: "Savings",
      owner: { address: "owner@example.com" },
      heir: { name: "Ada", email: "ada@example.com", address: "" },
      createdAt: new Date().toISOString(),
      ownerToken: "e2e-owner-token",
      groupId: null,
    };
    window.localStorage.setItem("gk:vaults", JSON.stringify({ [id]: meta }));
    window.localStorage.setItem("gk:activeVaultId", id);
    window.localStorage.setItem("gk:lastActivityAt", String(Date.now()));
  }, VAULT_ID);
}

test("start the 52-week challenge with your own week 1, and Don't touch it; stop one after asking", async ({ page }) => {
  await mock(page);
  await page.goto(`${base}/#/dashboard`);

  // Home invites one in a single quiet line.
  const line = page.getByTestId("challenge-line");
  await expect(line).toHaveText("Try a savings challenge · See");
  await line.getByRole("button", { name: "See" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Challenges" })).toBeVisible();
  await expectNoSerious(page);

  // 52 weeks, typed week 1; the plan is spelled out before starting.
  const w52 = page.getByTestId("offer-week52");
  await w52.getByRole("button", { name: "Start" }).click();
  await w52.getByLabel("Or type your own week 1").fill("1,500");
  await expect(w52.getByTestId("week52-plan")).toHaveText(
    "Week 1: 1,500 sats. Week 52: 78,000 sats. All year: 2,067,000 sats.",
  );
  await w52.getByRole("button", { name: "Start challenge" }).click();
  await expect.poll(() => state.joins[0]).toEqual({ kind: "week52", week1_sat: 1_500 });
  const going = page.getByTestId("challenge-going");
  await expect(going).toHaveCount(1);
  await expect(going.first()).toContainText("52-week challenge");
  await expect(going.first().getByTestId("challenge-status")).toHaveText(
    "Week 1 · this week 1,500 sats · 1,500 sats to catch up",
  );
  // It's going, so it isn't offered again.
  await expect(page.getByTestId("offer-week52")).toHaveCount(0);

  // Don't touch it: pick 3 months.
  const hold = page.getByTestId("offer-hold");
  await hold.getByRole("button", { name: "Start" }).click();
  await hold.getByRole("button", { name: "3 months" }).click();
  await hold.getByRole("button", { name: "Start challenge" }).click();
  await expect.poll(() => state.joins[1]).toEqual({ kind: "hold", hold_months: 3 });
  await expect(going).toHaveCount(2);
  await expect(going.first().getByTestId("challenge-status")).toHaveText("91 days to go");

  // Stopping asks once.
  await going.first().getByRole("button", { name: "Stop" }).click();
  await going.first().getByRole("button", { name: "Keep going" }).click();
  expect(state.stops).toHaveLength(0);
  await going.first().getByRole("button", { name: "Stop" }).click();
  await going.first().getByRole("button", { name: "Yes, stop" }).click();
  await expect.poll(() => state.stops).toEqual(["c2"]);
  await expect(going).toHaveCount(1);
  await expectNoSerious(page);

  // Back home, the line counts what's going.
  await page.getByRole("button", { name: "← Back to home" }).click();
  await expect(page.getByTestId("challenge-line")).toHaveText("1 challenge going · See");
});

test("a goal needs an amount and a date before it can be a challenge", async ({ page }) => {
  const nextYear = new Date().getFullYear() + 1;
  await mock(page, {
    goals: [
      { id: "g1", title: "Travel", amount_sat: null, target_date: null, saved_sat: 0, created_at: NOW },
    ],
  });
  await page.goto(`${base}/#/challenges`);
  const offer = page.getByTestId("offer-goal_by_date");
  await offer.getByRole("button", { name: "Start" }).click();
  await expect(offer).toContainText("First give a goal an amount and a date.");
  await expect(offer.getByRole("button", { name: "Start challenge" })).toHaveCount(0);

  await mock(page, {
    goals: [
      { id: "g2", title: "School fees", amount_sat: 1_000_000, target_date: `${nextYear}-09-01`, saved_sat: 0, created_at: NOW },
    ],
  });
  await page.reload();
  await page.getByTestId("offer-goal_by_date").getByRole("button", { name: "Start" }).click();
  await page.getByTestId("offer-goal_by_date").getByRole("button", { name: "Start challenge" }).click();
  await expect(page.getByTestId("offer-goal_by_date").getByRole("alert")).toHaveText("Pick a goal.");
  await page.getByRole("button", { name: "School fees" }).click();
  await page.getByTestId("offer-goal_by_date").getByRole("button", { name: "Start challenge" }).click();
  await expect.poll(() => state.joins[0]).toEqual({ kind: "goal_by_date", goal_id: "g2" });
});

test("a finished challenge: 'You did it' on Home until waved off, and a badge", async ({ page }) => {
  const done = challenge({
    kind: "hold",
    hold_months: 6,
    state: "done",
    pct: 100,
    completed_at: new Date(Date.now() - 86400_000).toISOString(),
  });
  await mock(page, { challenges: [done] });
  await page.goto(`${base}/#/dashboard`);
  const win = page.getByTestId("challenge-win");
  await expect(win).toContainText("You did it: Don't touch it for 6 months");
  await win.getByRole("button", { name: "See your badge" }).click();
  await expect(page.getByTestId("badge")).toContainText("Don't touch it for 6 months · finished");

  await page.getByRole("button", { name: "← Back to home" }).click();
  await page.getByTestId("challenge-win").getByRole("button", { name: "Nice" }).click();
  await expect(page.getByTestId("challenge-win")).toHaveCount(0);
  // Waved off for good on this device.
  await page.reload();
  await expect(page.getByTestId("savings-balance")).toHaveText("80,000 sats");
  await expect(page.getByTestId("challenge-win")).toHaveCount(0);
});

async function expectNoSerious(page: import("@playwright/test").Page) {
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
}
