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
  await card.getByLabel("What are you saving for?").fill("School fees");
  await card.getByLabel(/Goal amount/).fill("1,000,000");
  const nextYear = new Date().getFullYear() + 1;
  await card.getByLabel(/By when/).fill(`${nextYear}-06-30`);
  await card.getByRole("button", { name: "Save goal" }).click();

  // The browser sent exactly what was typed, in sats.
  expect(state.putBody).toEqual({ title: "School fees", amount_sat: 1_000_000, target_date: `${nextYear}-06-30` });
  await expect(card).toContainText("School fees");
  await expect(card).toContainText("250,000 sats of 1,000,000 sats");
  await expect(card.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
  // Pace, the year, reminders and deposits sit behind one link.
  await expect(page.getByTestId("savings-pace")).toHaveCount(0);
  await card.getByRole("button", { name: "Savings details" }).click();
  await expect(page.getByTestId("savings-pace")).toContainText(/Save about [\d,]+ sats a week/);

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
  expect(state.reminderBody).toEqual({ cadence: "weekly", amount_sat: 50_000 });
  await expect(page.getByTestId("savings-reminder")).toContainText(
    "We'll remind you to save every week (about 50,000 sats). Next on",
  );

  const results = await new AxeBuilder({ page }).include('[data-testid="savings-hero"]').analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => v.id)).toEqual([]);
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

const state: { putBody: Record<string, unknown> | null; reminderBody: Record<string, unknown> | null } = {
  putBody: null,
  reminderBody: null,
};

async function mockVault(page: import("@playwright/test").Page, opts: { overdue: boolean }) {
  state.putBody = null;
  state.reminderBody = null;
  const deadline = opts.overdue ? new Date(Date.now() - 2 * 86400_000).toISOString() : FUTURE;
  const json = (body: unknown, status = 200) => ({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
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
          next_deadline_at: deadline,
          claim_eligible_at: FUTURE,
        }),
      );
    if (p === `/vaults/${VAULT_ID}/balance`)
      return route.fulfill(json({ vault_id: VAULT_ID, network: "signet", confirmed_sat: 250_000, unconfirmed_sat: 0, total_sat: 250_000 }));
    if (p === `/vaults/${VAULT_ID}/events`) return route.fulfill(json([]));
    if (p === `/vaults/${VAULT_ID}/savings`) return route.fulfill(json(baseView));
    if (p === `/vaults/${VAULT_ID}/savings/goal` && req.method() === "PUT") {
      state.putBody = req.postDataJSON();
      return route.fulfill(json({ ...baseView, goal: state.putBody }));
    }
    if (p === `/vaults/${VAULT_ID}/savings/reminder` && req.method() === "PUT") {
      state.reminderBody = req.postDataJSON();
      return route.fulfill(
        json({
          ...baseView,
          goal: state.putBody,
          reminder: { ...state.reminderBody, next_at: "2099-12-01T09:00:00Z" },
        }),
      );
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
