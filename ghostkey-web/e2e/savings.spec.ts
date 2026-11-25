/**
 * The savings card on the dashboard (#367): totals and deposits with no
 * goal, then setting a goal through the form shows progress and the
 * "save about X a week" pace. Serves the built dist/ and intercepts
 * /api/*. Prereq: `npm run build`.
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

const VAULT_ID = "v-savings";
const FUTURE = new Date(Date.now() + 21 * 86400_000).toISOString();
// The newest deposit lands this month, whenever the test runs, so the
// "added this month" headline has something to say.
const deposits = [
  { amount_sat: 150_000, height: 200, seen_at: new Date().toISOString(), spent: false },
  { amount_sat: 100_000, height: 150, seen_at: "2026-10-01T10:00:00Z", spent: false },
];
const thisYear = new Date().getFullYear();
const baseView = {
  total_saved_sat: 250_000,
  deposit_count: 2,
  deposits,
  goal: null,
  this_year: { year: thisYear, total_sat: 250_000, deposit_count: 2, best_month: 11, best_month_sat: 150_000 },
  reminder: null,
  owner_email_confirmed: true,
};

test("savings card: totals, then a goal with progress and pace", async ({ page }) => {
  await mockVault(page, { overdue: false });
  await page.goto(`${base}/#/dashboard`);

  // Savings lead: the headline, the balance, and one quiet check-in row.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Stack sats. Build your future.");
  await expect(page.getByText("You've added 150,000 sats this month.")).toBeVisible();
  await expect(page.getByTestId("savings-balance")).toHaveText("250,000 sats");
  await expect(page.getByTestId("checkin-row")).toContainText("Still here?");
  await expect(page.getByRole("heading", { name: "Build wealth that outlives you" })).toBeVisible();

  const card = page.getByTestId("savings-card");

  await card.getByRole("button", { name: "What are you saving for?" }).click();
  await card.getByRole("button", { name: "School fees" }).click();
  await card.getByLabel(/Goal amount/).fill("1,000,000");
  const nextYear = new Date().getFullYear() + 1;
  await card.getByLabel(/By when/).fill(`${nextYear}-06-30`);
  await card.getByRole("button", { name: "Save goal" }).click();

  // The browser sent exactly what was picked and typed, in sats.
  await expect.poll(() => state.added[0]).toEqual({ title: "School fees", amount_sat: 1_000_000, target_date: `${nextYear}-06-30` });
  // A new goal starts empty; the money so far is offered to it.
  await expect(card.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
  await expect(card).toContainText("250,000 sats not in a goal");
  await card.getByRole("button", { name: "Put it in a goal" }).click();
  await card.getByLabel("How much").fill("250,000");
  await card.getByRole("button", { name: "Move" }).click();
  await expect.poll(() => state.moves[0]).toEqual({ from_goal_id: null, to_goal_id: "g1", amount_sat: 250_000 });
  await expect(card.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");

  // Tapping the goal opens its figures and the pace.
  await card.getByRole("button", { name: /School fees/ }).click();
  await expect(page.getByTestId("goal-details")).toContainText("250,000 sats of 1,000,000 sats");
  await expect(page.getByTestId("savings-pace")).toContainText(/Save about [\d,]+ sats a week/);

  // The year, reminders and deposits sit behind one link.
  await card.getByRole("button", { name: "Savings details" }).click();

  await expect(card).toContainText("put aside so far, in 2 deposits");
  await expect(card).toContainText("+150,000 sats");

  // Your year in savings.
  await expect(page.getByTestId("savings-year")).toContainText(
    `Your ${thisYear} in savings: 250,000 sats in 2 deposits. Best month: November.`,
  );

  // Remind me to save: weekly, 50,000 sats.
  await card.getByRole("button", { name: "Remind me to save" }).click();
  await card.getByLabel("Remind me to save").selectOption("weekly");
  await card.getByLabel(/How much each time/).fill("50,000");
  await card.getByRole("button", { name: "Save reminder" }).click();
  await expect.poll(() => state.reminderBody).toEqual({ cadence: "weekly", amount_sat: 50_000 });
  await expect(page.getByTestId("savings-reminder")).toContainText(
    "We'll remind you to save every week (about 50,000 sats). Next on",
  );

  const results = await new AxeBuilder({ page }).include('[data-testid="savings-hero"]').analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => v.id)).toEqual([]);
});

test("several goals: sort new money with a tap, type your own, and never show more than is there", async ({ page }) => {
  const now = new Date().toISOString();
  await mockVault(page, {
    overdue: false,
    balance: 300_000,
    goals: [{ id: "g1", title: "School fees", amount_sat: 1_000_000, target_date: null, saved_sat: 200_000, created_at: now }],
    unsorted: [{ outpoint: "new:0", amount_sat: 50_000, seen_at: now }],
  });
  await page.goto(`${base}/#/dashboard`);
  const card = page.getByTestId("savings-card");

  // A second goal, typed because it isn't in the quick picks.
  await card.getByRole("button", { name: "+ Add a goal" }).click();
  await card.getByLabel("Or type your own").fill("Okada for my brother");
  await card.getByRole("button", { name: "Save goal" }).click();
  await expect.poll(() => state.added[0]).toEqual({ title: "Okada for my brother", amount_sat: null, target_date: null });
  await expect(card.getByTestId("goal")).toHaveCount(2);

  // New money: one tap says which goal it's for.
  const prompt = page.getByTestId("sort-prompt");
  await expect(prompt).toContainText("+50,000 sats arrived");
  await prompt.getByRole("button", { name: "Okada for my brother" }).click();
  await expect.poll(() => state.sorted[0]).toEqual({ outpoint: "new:0", goal_id: "g2" });
  await expect(page.getByTestId("sort-prompt")).toHaveCount(0);
  await expect(card.getByTestId("goal").nth(1)).toContainText("50,000 sats");
  await expect(card).toContainText("50,000 sats not in a goal");

  // Move between goals; a goal can't give more than it holds.
  await card.getByRole("button", { name: /School fees/ }).click();
  await card.getByRole("button", { name: "Move money" }).click();
  await card.getByLabel("To").selectOption({ label: "Okada for my brother" });
  await card.getByLabel("How much").fill("999,999");
  await card.getByRole("button", { name: "Move" }).click();
  await expect(card.getByRole("alert")).toContainText("There's only 200,000 sats there.");
  expect(state.moves).toHaveLength(0);
  await card.getByLabel("How much").fill("20,000");
  await card.getByRole("button", { name: "Move" }).click();
  await expect.poll(() => state.moves[0]).toEqual({ from_goal_id: "g1", to_goal_id: "g2", amount_sat: 20_000 });
  await expect(card.getByTestId("goal").nth(1)).toContainText("70,000 sats");

  const results = await new AxeBuilder({ page }).include('[data-testid="savings-hero"]').analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => v.id)).toEqual([]);
});

test("goals never claim more than the balance", async ({ page }) => {
  const now = new Date().toISOString();
  // Money left through the recovery kit: goals still say 300k, 150k is there.
  await mockVault(page, {
    overdue: false,
    balance: 150_000,
    goals: [
      { id: "g1", title: "School fees", amount_sat: 1_000_000, target_date: null, saved_sat: 200_000, created_at: now },
      { id: "g2", title: "Rent", amount_sat: null, target_date: null, saved_sat: 100_000, created_at: now },
    ],
  });
  await page.goto(`${base}/#/dashboard`);
  const card = page.getByTestId("savings-card");
  await expect(card.getByTestId("goal").nth(0)).toContainText("10%");
  await expect(card.getByTestId("goal").nth(1)).toContainText("50,000 sats");
  await expect(card).not.toContainText("not in a goal");
});

test("an overdue check-in takes the top of the page back from savings", async ({ page }) => {
  await mockVault(page, { overdue: true });
  await page.goto(`${base}/#/dashboard`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Check-in overdue");
  const checkin = page.getByRole("button", { name: "I'm still here" });
  await expect(checkin).toBeVisible();
  await expect(page.getByTestId("checkin-row")).toHaveCount(0);
  // The full check-in card sits above the savings.
  const checkinBox = await checkin.boundingBox();
  const heroBox = await page.getByTestId("savings-hero").boundingBox();
  expect(checkinBox!.y).toBeLessThan(heroBox!.y);
});

test("the last known balance shows at once, then the live one takes over", async ({ page }) => {
  await mockVault(page, { overdue: false, balance: 2_629, saved: { sat: 2_000, minutesAgo: 7 }, live: "held" });
  await page.goto(`${base}/#/dashboard`);

  // The explorer hasn't answered, but there's already a number, with its age.
  await expect(page.getByTestId("savings-balance")).toHaveText("2,000 sats");
  await expect(page.getByTestId("balance-as-of")).toHaveText("Updated 7 minutes ago · checking now");

  release();
  await expect(page.getByTestId("savings-balance")).toHaveText("2,629 sats");
  await expect(page.getByTestId("balance-as-of")).toHaveCount(0);
});

test("when every explorer is slow, the last known balance stays up instead of an error", async ({ page }) => {
  await mockVault(page, { overdue: false, balance: 2_629, saved: { sat: 2_000, minutesAgo: 7 }, live: "fail" });
  await page.goto(`${base}/#/dashboard`);

  const asOf = page.getByTestId("balance-as-of");
  await expect(asOf).toHaveText("Updated 7 minutes ago · Refresh");
  await expect(page.getByTestId("savings-balance")).toHaveText("2,000 sats");
  await expect(page.getByText(/Couldn't load your balance/)).toHaveCount(0);

  // The explorer is back: Refresh gets the live number.
  state.live = "ok";
  await asOf.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByTestId("savings-balance")).toHaveText("2,629 sats");
  await expect(asOf).toHaveCount(0);
});

test("with no saved balance, a failed lookup still says so instead of showing zero", async ({ page }) => {
  await mockVault(page, { overdue: false, live: "fail" });
  await page.goto(`${base}/#/dashboard`);
  await expect(page.getByText("Couldn't load your balance right now. Tap Refresh to try again.")).toBeVisible();
  await expect(page.getByTestId("savings-balance")).toHaveText("—");
  await expect(page.getByTestId("balance-as-of")).toHaveCount(0);
});

test("Home shows the savings streak in one line, and the best one in the details", async ({ page }) => {
  await mockVault(page, {
    overdue: false,
    streak: {
      cadence: "weekly",
      current: 3,
      best: 6,
      saved_this_period: false,
      period_ends_at: "2026-11-30T00:00:00+00:00",
    },
  });
  await page.goto(`${base}/#/dashboard`);
  await expect(page.getByTestId("savings-streak")).toHaveText(
    "3 weeks in a row · add any amount by Sun 29 Nov to make it 4",
  );
  // The line sits in the hero, under the buttons, not in a card of its own.
  await expect(page.getByTestId("savings-hero").getByTestId("savings-streak")).toBeVisible();
  await expect(page.getByTestId("savings-best-streak")).toHaveCount(0);
  await page.getByRole("button", { name: "Savings details" }).click();
  await expect(page.getByTestId("savings-best-streak")).toHaveText("Best streak: 6 weeks in a row");
});

type Goal = { id: string; title: string; amount_sat: number | null; target_date: string | null; saved_sat: number; created_at: string };
const state: {
  reminderBody: Record<string, unknown> | null;
  added: Record<string, unknown>[];
  moves: Record<string, unknown>[];
  sorted: Record<string, unknown>[];
  goals: Goal[];
  unsorted: { outpoint: string; amount_sat: number; seen_at: string }[];
  balance: number;
  /** What `/balance/last` answers; null is "never scanned" (404). */
  saved: { sat: number; checked_at: string } | null;
  /** How the live `/balance` answers: at once, after `release()`, or 500. */
  live: "ok" | "held" | "fail";
  streak: Record<string, unknown> | undefined;
} = {
  reminderBody: null,
  added: [],
  moves: [],
  sorted: [],
  goals: [],
  unsorted: [],
  balance: 250_000,
  saved: null,
  live: "ok",
  streak: undefined,
};
let release: () => void = () => {};

function view() {
  return {
    ...baseView,
    goal: state.goals[0] ?? null,
    goals: state.goals,
    unsorted: state.unsorted,
    streak: state.streak,
    reminder: state.reminderBody ? { ...state.reminderBody, next_at: "2099-12-01T09:00:00Z" } : null,
  };
}

async function mockVault(
  page: import("@playwright/test").Page,
  opts: {
    overdue: boolean;
    goals?: Goal[];
    unsorted?: typeof state.unsorted;
    balance?: number;
    saved?: { sat: number; minutesAgo: number };
    live?: "ok" | "held" | "fail";
    streak?: Record<string, unknown>;
  },
) {
  state.reminderBody = null;
  state.added = [];
  state.moves = [];
  state.sorted = [];
  state.goals = opts.goals ?? [];
  state.unsorted = opts.unsorted ?? [];
  state.balance = opts.balance ?? 250_000;
  state.saved = opts.saved
    ? { sat: opts.saved.sat, checked_at: new Date(Date.now() - opts.saved.minutesAgo * 60_000).toISOString() }
    : null;
  state.live = opts.live ?? "ok";
  state.streak = opts.streak;
  const held = new Promise<void>((r) => (release = r));
  const deadline = opts.overdue ? new Date(Date.now() - 2 * 86400_000).toISOString() : FUTURE;
  const json = (body: unknown, status = 200) => ({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname.replace(/^\/api/, "");
    if (p === "/health")
      return route.fulfill(json({ ok: true, version: "e2e", demo_mode: false, default_network: "signet", email_enabled: true, sms_enabled: false, whatsapp_enabled: false }));
    if (p === `/vaults/${VAULT_ID}/balance/last`)
      return state.saved
        ? route.fulfill(
            json({
              vault_id: VAULT_ID,
              network: "signet",
              confirmed_sat: state.saved.sat,
              unconfirmed_sat: 0,
              total_sat: state.saved.sat,
              checked_at: state.saved.checked_at,
            }),
          )
        : route.fulfill(json({ error: "not found" }, 404));
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
          next_deadline_at: deadline,
          claim_eligible_at: FUTURE,
        }),
      );
    if (p === `/vaults/${VAULT_ID}/balance`) {
      if (state.live === "fail") return route.fulfill(json({ error: "explorer down" }, 500));
      if (state.live === "held") await held;
      return route.fulfill(json({ vault_id: VAULT_ID, network: "signet", confirmed_sat: state.balance, unconfirmed_sat: 0, total_sat: state.balance }));
    }
    if (p === `/vaults/${VAULT_ID}/events`) return route.fulfill(json([]));
    if (p === `/vaults/${VAULT_ID}/savings`) return route.fulfill(json(view()));
    if (p === `/vaults/${VAULT_ID}/savings/goals` && req.method() === "POST") {
      const b = req.postDataJSON();
      state.added.push(b);
      state.goals.push({ ...b, id: `g${state.goals.length + 1}`, saved_sat: 0, created_at: new Date().toISOString() });
      return route.fulfill(json(view()));
    }
    if (p === `/vaults/${VAULT_ID}/savings/move`) {
      const b = req.postDataJSON();
      state.moves.push(b);
      for (const g of state.goals) {
        if (g.id === b.from_goal_id) g.saved_sat -= b.amount_sat;
        if (g.id === b.to_goal_id) g.saved_sat += b.amount_sat;
      }
      return route.fulfill(json(view()));
    }
    if (p === `/vaults/${VAULT_ID}/savings/sort`) {
      const b = req.postDataJSON();
      state.sorted.push(b);
      const d = state.unsorted.find((u) => u.outpoint === b.outpoint)!;
      state.unsorted = state.unsorted.filter((u) => u.outpoint !== b.outpoint);
      const g = state.goals.find((x) => x.id === b.goal_id);
      if (g) g.saved_sat += d.amount_sat;
      return route.fulfill(json(view()));
    }
    if (p === `/vaults/${VAULT_ID}/savings/reminder` && req.method() === "PUT") {
      state.reminderBody = req.postDataJSON();
      return route.fulfill(json(view()));
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
