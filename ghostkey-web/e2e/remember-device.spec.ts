/**
 * A device you've signed in on remembers you: after a first sign-in by
 * email link, reopening the app (its start address, as an installed app
 * does) goes straight to "Welcome back" and the password. No email link,
 * no visitor front page. Real encryption against a mocked server.
 * Serves the built dist/ and intercepts /api/*. Prereq: `npm run build`.
 */
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createServer, type Server } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { generateParty } from "../src/crypto/keygen";
import { deriveOwnerKek, sealWithKey } from "../src/crypto/sealing";

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

const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const PASSWORD = "Okra-lantern-harbour-quietly-92";
const OWNER_TOKEN = "owner-token-abc123";
const PAST = new Date(Date.now() - 5 * 86400_000).toISOString();
const FUTURE = new Date(Date.now() + 30 * 86400_000).toISOString();

test("a device that signed in by email remembers you: next time it's just the password", async ({ browser }) => {
  test.setTimeout(120_000);
  // Sealed exactly as setup does it, with small Argon2 settings so the
  // test is quick (they're recorded in the blob; the maths is the same).
  const owner = generateParty("signet");
  const salt = new Uint8Array(16).fill(3);
  const kek = await deriveOwnerKek(PASSWORD, salt, { memKiB: 1024, iters: 1 });
  const xprv = sealWithKey(kek, new TextEncoder().encode(owner.xprv));
  const tok = sealWithKey(kek, new TextEncoder().encode(OWNER_TOKEN));
  const bundle = {
    owner_email: "owner@example.com",
    vaults: [
      {
        vault: { id: "v-dev", label: "Savings", status: "ok", created_at: PAST, next_deadline_at: FUTURE },
        sealed_blobs: {
          vault_id: "v-dev",
          password_salt_b64: Buffer.from(salt).toString("base64"),
          password_kdf_mem_kib: 1024,
          password_kdf_iters: 1,
          owner_xprv_ct_b64: xprv.ct,
          owner_xprv_nonce_b64: xprv.nonce,
          owner_token_ct_b64: tok.ct,
          owner_token_nonce_b64: tok.nonce,
          network: "signet",
          timelock_blocks: 12960,
        },
      },
    ],
  };
  let emailLinks = 0;
  const ctx = await browser.newContext();
  await ctx.route("**/api/**", (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname.replace(/^\/api/, "");
    if (p === "/health") return route.fulfill(json({ ok: true, version: "e2e", demo_mode: false, default_network: "signet", email_enabled: true }));
    if (p === "/recovery/request") {
      emailLinks += 1;
      return route.fulfill(json({ accepted: true }));
    }
    if (p === "/recovery/exchange") return route.fulfill(json(bundle));
    if (p === "/vaults/v-dev")
      return route.fulfill(json({ id: "v-dev", label: "Savings", network: "signet", timelock_blocks: 12960, checkin_period_secs: 7_776_000, grace_period_secs: 604_800, status: "ok", created_at: PAST, last_checkin_at: PAST, next_deadline_at: FUTURE, claim_eligible_at: FUTURE }));
    if (p === "/vaults/v-dev/sealed-blobs") return route.fulfill(json(bundle.vaults[0].sealed_blobs));
    if (p === "/vaults/v-dev/checkin") return route.fulfill(json({ vault_id: "v-dev", last_checkin_at: new Date().toISOString(), next_deadline_at: FUTURE, status: "ok" }));
    return route.fulfill(json({}, 404));
  });

  // 1. First time on this device: the email link, then the password.
  const first = await ctx.newPage();
  await first.goto(`${base}/#/recover/tok-from-email`);
  await first.locator('input[type="password"]').first().fill(PASSWORD);
  await first.getByRole("button", { name: "Unlock vault" }).click();
  await expect(first).toHaveURL(/#\/dashboard/, { timeout: 60_000 });
  const stored = await first.evaluate(() => JSON.parse(localStorage.getItem("gk:vaults") ?? "{}"));
  expect(stored["v-dev"].ownerTokenLock.validated).toBe(true);
  await first.close();

  // 2. Later: the app is opened again. The session is gone (sessionStorage
  //    is per page), the device's saved data is kept.
  const again = await ctx.newPage();
  await again.goto(`${base}/`);
  await expect(again.getByRole("heading", { level: 1 })).toHaveText(/Welcome back|Session timed out/);
  await expect(again.getByText(/@example\.com/).first()).toBeVisible();
  // Your password is the way in; the email link is only for another email.
  await expect(again.getByRole("button", { name: "Unlock vault" })).toBeVisible();
  await expect(again.getByRole("button", { name: "Email me a sign-in link" })).toHaveCount(0);
  await expect(again.getByRole("button", { name: "Use a different email" })).toBeVisible();
  await again.locator('input[type="password"]').first().fill(PASSWORD);
  await again.getByRole("button", { name: "Unlock vault" }).click();
  await expect(again.getByTestId("savings-hero")).toBeVisible({ timeout: 60_000 });
  expect(emailLinks).toBe(0);
  await ctx.close();
});
