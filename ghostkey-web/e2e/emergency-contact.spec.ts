/**
 * The emergency contact can be added, changed and removed from the
 * Emergency page (setup no longer asks for it). Serves the built dist/
 * and intercepts /api/*. Prereq: `npm run build`.
 */
import { test, expect } from "@playwright/test";
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
const FUTURE = new Date(Date.now() + 30 * 86400_000).toISOString();
const PAST = new Date(Date.now() - 30 * 86400_000).toISOString();

test("the emergency contact can be added, changed and removed", async ({ page }) => {
  const puts: { contact: string | null }[] = [];
  await page.route("**/api/**", (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname.replace(/^\/api/, "");
    if (p === "/health") return route.fulfill(json({ ok: true, version: "e2e", demo_mode: false, default_network: "regtest", email_enabled: true }));
    if (p === "/vaults/v-em")
      return route.fulfill(
        json({
          id: "v-em", label: "Savings", network: "regtest", timelock_blocks: 144,
          checkin_period_secs: 7_776_000, grace_period_secs: 604_800, status: "ok", created_at: PAST,
          last_checkin_at: PAST, next_deadline_at: FUTURE, claim_eligible_at: FUTURE, has_trusted_contact: false,
        }),
      );
    if (p === "/vaults/v-em/trusted-contact" && req.method() === "PUT") {
      const body = req.postDataJSON() as { contact: string | null };
      puts.push(body);
      return route.fulfill(json({ has_trusted_contact: body.contact !== null }));
    }
    return route.fulfill(json({}, 404));
  });
  await page.addInitScript(() => {
    const meta = {
      id: "v-em", label: "Savings", owner: { address: "owner@example.com" },
      heir: { name: "Ada", email: "ada@example.com", address: "" }, createdAt: new Date().toISOString(),
      ownerToken: "e2e-owner-token", groupId: null,
    };
    window.localStorage.setItem("gk:vaults", JSON.stringify({ "v-em": meta }));
    window.localStorage.setItem("gk:activeVaultId", "v-em");
    window.localStorage.setItem("gk:lastActivityAt", String(Date.now()));
  });

  await page.goto(`${base}/#/emergency`);
  const card = page.getByTestId("emergency-contact");
  await card.getByLabel("Their email").fill("friend@example.com");
  await card.getByRole("button", { name: "Save" }).click();
  await expect(card.getByText("Someone is on file.")).toBeVisible();

  await card.getByRole("button", { name: "Change" }).click();
  await card.getByLabel("Their email").fill("other@example.com");
  await card.getByRole("button", { name: "Save" }).click();
  await expect(card.getByText("Someone is on file.")).toBeVisible();

  await card.getByRole("button", { name: "Remove" }).click();
  await expect(card.getByLabel("Their email")).toBeVisible();

  expect(puts).toEqual([{ contact: "friend@example.com" }, { contact: "other@example.com" }, { contact: null }]);
});
