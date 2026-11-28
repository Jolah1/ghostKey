/**
 * An heir claims without clicking anything in the message (#393): they go
 * to the site, tap "I was left something", and type the code. The code
 * opens the same claim the link opens; a wrong one gets a plain answer;
 * too many tries are refused. Serves the built dist/. Prereq: `npm run build`.
 */
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createServer, type Server } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { prodHeaders } from "./prodHeaders";
import { settleAnimations } from "./settle";

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

test("type the code from the message, land on the claim", async ({ page }) => {
  const tried: string[] = [];
  let calls = 0;
  await page.route("**/api/**", (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname.replace(/^\/api/, "");
    if (p === "/health")
      return route.fulfill(json({ ok: true, version: "e2e", demo_mode: false, default_network: "signet", email_enabled: true }));
    if (p === "/claim-code" && req.method() === "POST") {
      calls += 1;
      const code: string = req.postDataJSON().code;
      tried.push(code);
      if (calls >= 4) return route.fulfill(json({ error: "rate limited" }, 429));
      if (code.toUpperCase().replace(/[\s-]/g, "") === "ABCDEFGHJKMN") return route.fulfill(json({ token: "tok-from-code" }));
      return route.fulfill(json({ error: "not found" }, 404));
    }
    return route.fulfill(json({}, 404));
  });

  // From the front page, the way the message says.
  await page.goto(`${base}/#/landing`);
  await page.getByRole("button", { name: "I was left something" }).first().click();
  await expect(page.getByRole("heading", { name: "Got a message from GhostKey?" })).toBeVisible();
  await settleAnimations(page);
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);

  const box = page.getByTestId("claim-code");
  await box.fill("ZZZZ-ZZZZ-ZZZZ");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("That code didn't match.")).toBeVisible();

  // Typed loosely: lower case, spaces. The server reads it the same way.
  await box.fill("abcd efgh jkmn");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/#\/claim\/tok-from-code$/);
  expect(tried).toEqual(["ZZZZ-ZZZZ-ZZZZ", "abcd efgh jkmn"]);
});

test("too many tries are refused in plain words", async ({ page }) => {
  await page.route("**/api/**", (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (p === "/claim-code") return route.fulfill(json({ error: "rate limited" }, 429));
    return route.fulfill(json({ ok: true, demo_mode: false, default_network: "signet" }));
  });
  await page.goto(`${base}/#/inherit`);
  await page.getByTestId("claim-code").fill("ABCD-EFGH-JKMN");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("Too many tries. Wait a minute, then try again.")).toBeVisible();
  // The link still works for anyone who has it.
  await page.getByRole("button", { name: "Have a link instead?" }).click();
  await expect(page.getByPlaceholder("https://www.ghostkeyapp.com/#/claim/…")).toBeVisible();
});
