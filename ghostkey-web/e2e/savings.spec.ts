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
const deposits = [
  { amount_sat: 150_000, height: 200, seen_at: "2026-11-01T10:00:00Z", spent: false },
  { amount_sat: 100_000, height: 150, seen_at: "2026-10-01T10:00:00Z", spent: false },
];
const baseView = { total_saved_sat: 250_000, deposit_count: 2, deposits, goal: null };

test("savings card: totals, then a goal with progress and pace", async ({ page }) => {
  let putBody: Record<string, unknown> | null = null;
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
          next_deadline_at: FUTURE,
          claim_eligible_at: FUTURE,
        }),
      );
    if (p === `/vaults/${VAULT_ID}/balance`)
      return route.fulfill(json({ vault_id: VAULT_ID, network: "signet", confirmed_sat: 250_000, unconfirmed_sat: 0, total_sat: 250_000 }));
    if (p === `/vaults/${VAULT_ID}/events`) return route.fulfill(json([]));
    if (p === `/vaults/${VAULT_ID}/savings`) return route.fulfill(json(baseView));
    if (p === `/vaults/${VAULT_ID}/savings/goal` && req.method() === "PUT") {
      putBody = req.postDataJSON();
      return route.fulfill(json({ ...baseView, goal: putBody }));
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

  await page.goto(`${base}/#/dashboard`);
  const card = page.getByTestId("savings-card");
  await expect(card).toContainText("put aside so far, in 2 deposits");
  await expect(card).toContainText("+150,000 sats");

  await card.getByRole("button", { name: "What are you saving for?" }).click();
  await card.getByLabel("What are you saving for?").fill("School fees");
  await card.getByLabel(/Goal amount/).fill("1,000,000");
  const nextYear = new Date().getFullYear() + 1;
  await card.getByLabel(/By when/).fill(`${nextYear}-06-30`);
  await card.getByRole("button", { name: "Save goal" }).click();

  // The browser sent exactly what was typed, in sats.
  expect(putBody).toEqual({ title: "School fees", amount_sat: 1_000_000, target_date: `${nextYear}-06-30` });
  await expect(card).toContainText("School fees");
  await expect(card).toContainText("250,000 sats of 1,000,000 sats");
  await expect(card.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
  await expect(page.getByTestId("savings-pace")).toContainText(/Save about [\d,]+ sats a week/);

  const results = await new AxeBuilder({ page }).include('[data-testid="savings-card"]').analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => v.id)).toEqual([]);
});
