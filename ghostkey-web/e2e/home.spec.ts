/**
 * The website's front page: an example savings card that moves, steps
 * that play in turn, a savings calculator, and questions that open on
 * tap. Locking is never mentioned until the server says it's live.
 * Serves the built dist/ and intercepts /api/*. Prereq: `npm run build`.
 */
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { settleAnimations } from "./settle";
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
  ".wasm": "application/wasm",
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

const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });

async function mockServer(page: Page, lockedGoals: boolean) {
  await page.route("**/api/**", (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (p === "/health")
      return route.fulfill(
        json({ ok: true, version: "e2e", demo_mode: false, default_network: "bitcoin", email_enabled: true, ...(lockedGoals ? { locked_goals_enabled: true } : {}) }),
      );
    return route.fulfill(json({}, 204));
  });
}

const balanceOf = async (page: Page) =>
  Number(((await page.getByTestId("hero-balance").textContent()) ?? "").replace(/[^0-9]/g, ""));

test("the front page: savings first, a card you can play with, and no locking until it's live", async ({ page }) => {
  await mockServer(page, false);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${base}/#/`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Stack sats.Build your future.");
  await expect(page.getByText("Live on Bitcoin mainnet")).toBeVisible();
  await expect(page.getByText(/lock/i)).toHaveCount(0);

  // The example card: add by hand, and the heir appears only when asked.
  const card = page.getByTestId("hero-card");
  await expect(card).toContainText("An example");
  const before = await balanceOf(page);
  await card.getByRole("button", { name: "Add 5,000 sats" }).click();
  expect(await balanceOf(page)).toBe(before + 5_000);
  await expect(card.getByText(/Ada gets it/)).toHaveCount(0);
  await card.getByRole("switch", { name: "Pass it on" }).click();
  await expect(card.getByText("Ada gets it if you go quiet for 6 months.")).toBeVisible();

  // Steps can be clicked.
  await page.getByRole("button", { name: /Pass it on Optional/ }).click();
  await expect(page.getByText("If you ever stop showing up", { exact: true })).toBeVisible();

  // The calculator is plain arithmetic: monthly x 12 x years.
  await page.getByLabel("Each month").fill("50000");
  await page.getByRole("button", { name: "10 years" }).click();
  await expect(page.getByText("6,000,000 sats", { exact: true })).toBeVisible();

  // Questions open on tap, one at a time.
  const q = page.getByRole("button", { name: "Do I have to name someone to inherit?" });
  await expect(page.getByText("passing it on is optional")).toHaveCount(0);
  await q.click();
  await expect(page.getByText(/passing it on is optional/)).toBeVisible();
  await expect(page.locator("footer")).toContainText("Build wealth that outlives you.");

  await settleAnimations(page);
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
});

test("with reduced motion the example card stays still", async ({ page }) => {
  await mockServer(page, false);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${base}/#/`);
  const before = await balanceOf(page);
  await page.waitForTimeout(4_000);
  expect(await balanceOf(page)).toBe(before);
});

test("without reduced motion, sample deposits arrive by themselves", async ({ page }) => {
  await mockServer(page, false);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(`${base}/#/`);
  const before = await balanceOf(page);
  await expect.poll(() => balanceOf(page), { timeout: 8_000 }).toBeGreaterThan(before);
});

test("once locked goals are live, the page offers them", async ({ page }) => {
  await mockServer(page, true);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${base}/#/`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Stack sats.Lock them for big things.");
  await expect(page.getByRole("timer", { name: "Time until it unlocks" })).toBeVisible();
  const lengths = page.getByRole("group", { name: "Lock length" });
  await expect(lengths.getByRole("button")).toHaveText(["3 mo", "6 mo", "12 mo"]);
  await lengths.getByRole("button", { name: "12 mo" }).click();
  const inAYear = new Date();
  inAYear.setMonth(inAYear.getMonth() + 12);
  await expect(page.getByText(inAYear.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }))).toBeVisible();
  await expect(page.getByText("Not even us.", { exact: true })).toBeVisible();
});
