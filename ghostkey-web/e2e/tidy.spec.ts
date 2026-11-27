/**
 * The page tidy-up (savings first, nothing crowding the screen): no
 * "live network" banner on mainnet, the signed-in menu, the AI chat
 * opened from the menu instead of floating over pages, Activity led by
 * savings, heir contact showing only channels that work, and the website
 * with the technical sections folded away and a savings comparison.
 *
 * Serves the built dist/ and intercepts /api/*. Prereq: `npm run build`.
 */
import { test, expect } from "@playwright/test";
import { settleAnimations } from "./settle";
import AxeBuilder from "@axe-core/playwright";
import { createServer, type Server } from "node:http";
import { prodHeaders } from "./prodHeaders";
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
    res.writeHead(200, { ...prodHeaders, "content-type": MIME[extname(target)] ?? "application/octet-stream" });
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

const VAULT_ID = "v-tidy";
const FUTURE = new Date(Date.now() + 21 * 86400_000).toISOString();
const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });

async function mock(page: import("@playwright/test").Page, signedIn: boolean) {
  await page.route("**/api/**", (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (p === "/health")
      return route.fulfill(
        json({ ok: true, version: "e2e", demo_mode: false, default_network: "bitcoin", email_enabled: true, sms_enabled: false, whatsapp_enabled: false, assist_enabled: false }),
      );
    if (p === `/vaults/${VAULT_ID}`)
      return route.fulfill(
        json({ id: VAULT_ID, label: "Savings", network: "bitcoin", timelock_blocks: 4320, checkin_period_secs: 2_592_000, grace_period_secs: 604_800, status: "ok", created_at: FUTURE, last_checkin_at: null, next_deadline_at: FUTURE, claim_eligible_at: FUTURE }),
      );
    if (p === `/vaults/${VAULT_ID}/savings`)
      return route.fulfill(
        json({ total_saved_sat: 462_000, deposit_count: 2, deposits: [{ amount_sat: 62_000, height: 2, seen_at: new Date().toISOString(), spent: false }, { amount_sat: 400_000, height: 1, seen_at: "2026-01-05T10:00:00Z", spent: false }], goal: null, goals: [], unsorted: [], this_year: { year: 2026, total_sat: 462_000, deposit_count: 2, best_month: 1, best_month_sat: 400_000 }, reminder: null, owner_email_confirmed: true }),
      );
    if (p === `/vaults/${VAULT_ID}/events`) return route.fulfill(json([]));
    if (p === `/vaults/${VAULT_ID}/heir`)
      return route.fulfill(json({ name: "Ada", contact: "ada@example.com", channel: "email", note: null, contact_verified_at: null }));
    return route.fulfill(json({}, 404));
  });
  if (signedIn)
    await page.addInitScript((id) => {
      const meta = { id, label: "Savings", owner: { address: "owner@example.com" }, heir: { name: "Ada", email: "ada@example.com", address: "" }, createdAt: new Date().toISOString(), ownerToken: "e2e-owner-token", groupId: null };
      window.localStorage.setItem("gk:vaults", JSON.stringify({ [id]: meta }));
      window.localStorage.setItem("gk:activeVaultId", id);
      window.localStorage.setItem("gk:lastActivityAt", String(Date.now()));
    }, VAULT_ID);
}

test.use({ viewport: { width: 390, height: 844 } });

test("signed in: no mainnet banner, a tidy menu, and the AI chat opens from it", async ({ page }) => {
  await mock(page, true);
  await page.goto(`${base}/#/dashboard`);
  await expect(page.getByTestId("savings-balance")).toBeVisible();
  await expect(page.getByText("You're on the live Bitcoin network")).toHaveCount(0);
  // Nothing floats over the page.
  await expect(page.getByRole("button", { name: /GhostKey AI/ })).toHaveCount(0);

  await page.getByRole("button", { name: "Open menu" }).click();
  const menu = page.locator("#mobile-menu");
  for (const item of ["Home", "Activity", "Challenges", "Inheritance", "Recovery kit", "Ask GhostKey AI"]) {
    await expect(menu.getByRole("button", { name: item, exact: true })).toBeVisible();
  }
  // The heirs' own "Inherit" page stays off the signed-in menu.
  await expect(menu.getByRole("button", { name: "Inherit", exact: true })).toHaveCount(0);
  await expect(menu.getByRole("button", { name: "Open your savings" })).toHaveCount(0);
  await menu.getByRole("button", { name: "Ask GhostKey AI" }).click();
  await expect(page.getByRole("dialog", { name: "GhostKey AI chat" })).toBeVisible();
});

test("Activity leads with savings; heir contact shows only email", async ({ page }) => {
  await mock(page, true);
  await page.goto(`${base}/#/activity`);
  await expect(page.getByTestId("activity-savings")).toContainText("You've put aside 462,000 sats in total");
  await expect(page.getByTestId("activity-savings")).toContainText("62,000 sats this month");

  await page.goto(`${base}/#/heir-contact`);
  await expect(page.getByText("Their email")).toBeVisible();
  await expect(page.getByText("SMS", { exact: true })).toHaveCount(0);
  await expect(page.getByText("WhatsApp", { exact: true })).toHaveCount(0);
  // Opened from Inheritance, so back goes there.
  await expect(page.getByRole("button", { name: "← Back to inheritance" })).toBeVisible();
  await page.goto(`${base}/#/recovery`);
  await expect(page.getByRole("button", { name: "← Back to home" })).toBeVisible();
});

test("website: savings first, technical sections folded, savings comparison", async ({ page }) => {
  await mock(page, false);
  await page.goto(`${base}/#/`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Stack sats.");
  await expect(page.getByText("on-chain or by Lightning")).toBeVisible();
  const tech = page.getByTestId("tech-details");
  await expect(tech).not.toHaveAttribute("open", "");
  await expect(page.getByText("Liana", { exact: true }).first()).toBeHidden();
  await tech.locator("summary").click();
  await expect(page.getByText("An exchange app").first()).toBeVisible();
  await expect(page.getByText("Lightning deposits").first()).toBeVisible();
  await expect(page.getByText("Heartbeat-based")).toHaveCount(0);
  await expect(page.locator("footer")).toContainText("Build wealth that outlives you.");
  await expect(page.getByText("What does adding money by Lightning cost?")).toBeVisible();
  await expectNoSerious(page);
});

async function expectNoSerious(page: import("@playwright/test").Page) {
  await settleAnimations(page);
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
}

test.describe("on an iPhone, in Safari", () => {
  test.use({
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  });
  test("Home suggests adding GhostKey to the Home Screen, once", async ({ page }) => {
    await mock(page, true);
    await page.goto(`${base}/#/dashboard`);
    const nudge = page.getByTestId("install-nudge");
    await expect(nudge).toContainText("Add GhostKey to your Home Screen");
    await nudge.getByRole("button", { name: "Done" }).click();
    await expect(nudge).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("savings-balance")).toBeVisible();
    await expect(page.getByTestId("install-nudge")).toHaveCount(0);
  });
});

test("no Home Screen card on other phones and computers", async ({ page }) => {
  await mock(page, true);
  await page.goto(`${base}/#/dashboard`);
  await expect(page.getByTestId("savings-balance")).toBeVisible();
  await expect(page.getByTestId("install-nudge")).toHaveCount(0);
});
