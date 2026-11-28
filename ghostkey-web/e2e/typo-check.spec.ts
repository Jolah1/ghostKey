/**
 * A mistyped email is questioned where it is first typed (#327): the
 * owner's own address and the heir's, in setup. "Did you mean ...?" shows
 * before Next, one tap fixes it, "No, it's right" dismisses it, and it
 * never blocks. The domain list lives on the server; this mocks its
 * answer. Serves the built dist/. Prereq: `npm run build`.
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
const PASSWORD = "Okra-lantern-harbour-quietly-92";
/** The server's misspellings, as far as this test needs them. */
const TYPOS: Record<string, string> = { "gmial.com": "gmail.com", "yaho.com": "yahoo.com" };

test("setup questions a mistyped email, for you and for your heir", async ({ page }) => {
  test.setTimeout(60_000);
  const checked: string[] = [];
  await page.route("**/api/**", (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname.replace(/^\/api/, "");
    if (p === "/health")
      return route.fulfill(json({ ok: true, version: "e2e", demo_mode: false, default_network: "signet", email_enabled: true }));
    if (p === "/contact/check" && req.method() === "POST") {
      const address: string = req.postDataJSON().address;
      checked.push(address);
      const domain = address.split("@")[1] ?? "";
      const suggestion = TYPOS[domain] ?? null;
      return route.fulfill(json({ ok: true, message: suggestion ? "maybe a typo" : "", suggestion }));
    }
    return route.fulfill(json({}, 404));
  });

  await page.goto(`${base}/#/setup`);
  await page.getByRole("button", { name: "School fees" }).click();
  await page.getByRole("button", { name: "Continue" }).click();

  // Your own email: a typo is questioned, one tap fixes it.
  const ownerEmail = page.getByLabel("Email address");
  await ownerEmail.fill("owner@gmial.com");
  const ask = page.getByTestId("did-you-mean");
  await expect(ask).toContainText("Did you mean owner@gmail.com?");
  await settleAnimations(page);
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  await ask.getByRole("button", { name: "Use that" }).click();
  await expect(ownerEmail).toHaveValue("owner@gmail.com");
  await expect(ask).toHaveCount(0);
  // A correct address asks nothing (give the check time to answer).
  await page.waitForTimeout(1_000);
  await expect(ask).toHaveCount(0);
  await page.getByRole("button", { name: "Continue" }).click();

  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Type it again").fill(PASSWORD);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Pass it on?" })).toBeVisible();

  // The heir's email: questioned too; "No, it's right" leaves it as typed
  // and never blocks going on.
  await page.getByLabel("Their name").fill("Ada");
  const heirEmail = page.getByLabel("Their email");
  await heirEmail.fill("ada@yaho.com");
  await expect(ask).toContainText("Did you mean ada@yahoo.com?");
  await ask.getByRole("button", { name: "No, it's right" }).click();
  await expect(ask).toHaveCount(0);
  await expect(heirEmail).toHaveValue("ada@yaho.com");
  expect(checked).toEqual(expect.arrayContaining(["owner@gmial.com", "owner@gmail.com", "ada@yaho.com"]));
});
