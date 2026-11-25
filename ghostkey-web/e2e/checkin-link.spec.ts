/**
 * The email check-in link must never check in by itself.
 *
 * Mail security scanners (Outlook Safe Links, Gmail and others) open
 * links automatically. If loading #/checkin-link/... were enough to
 * check in, a dead owner's inbox would keep resetting the clock and the
 * heir would never be contacted. So the page asks first, and only a tap
 * on the button sends the check-in.
 *
 * Serves the built dist/ like a11y.spec.ts and intercepts /api/*.
 * Prereq: `npm run build`.
 */
import { test, expect } from "@playwright/test";
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
    if (path.startsWith("/api/")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unmocked API call in checkin-link e2e" }));
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

const VAULT_ID = "v-link";
const TOKEN = "tok-123";

test("opening the link does not check in; tapping the button does", async ({ page }) => {
  let checkinPosts = 0;
  const next = new Date(Date.now() + 30 * 86400_000).toISOString();

  await page.route("**/api/**", async (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (p === `/vaults/${VAULT_ID}/checkin-from-link/${TOKEN}`) {
      if (route.request().method() === "POST") checkinPosts += 1;
      return json({
        vault_id: VAULT_ID,
        last_checkin_at: new Date().toISOString(),
        next_deadline_at: next,
        status: "ok",
      });
    }
    if (p === "/health") {
      return json({ ok: true, version: "e2e", demo_mode: false });
    }
    // Anything else the shell asks for (analytics and so on) is harmless.
    return json({}, 404);
  });

  await page.goto(`${base}/#/checkin-link/${VAULT_ID}/${TOKEN}`);
  const button = page.getByRole("button", { name: /still here/i });
  await expect(button).toBeVisible();

  // Give any stray on-load effect time to fire before asserting none did.
  await page.waitForTimeout(1500);
  expect(checkinPosts).toBe(0);

  await button.click();
  await expect(page.getByRole("heading", { name: /checked in/i })).toBeVisible();
  expect(checkinPosts).toBe(1);
});
