/**
 * Inheritance is optional (heir chosen later), end to end in a real
 * browser with real crypto against a mocked API:
 *
 *  1. Setup with "Do this later" sends no claim token and no heir
 *     contact, and the heir key it does send opens only with the
 *     owner's password and is the heir key in the request.
 *  2. Home on a vault with no heir shows savings and "Choose who
 *     inherits", never an overdue check-in. Choosing re-seals the heir
 *     key so the claim token really opens it; a wrong password sends
 *     nothing.
 *
 * Serves the built dist/ and intercepts /api/*. Prereq: `npm run build`.
 */
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createServer, type Server } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { HDKey } from "@scure/bip32";
import { bip32Versions, generateParty } from "../src/crypto/keygen";
import { b64decode, deriveOwnerKek, openWithKey, sealWithKey, unsealHeirXprv } from "../src/crypto/sealing";

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

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});
const HEALTH = {
  ok: true,
  version: "e2e",
  demo_mode: false,
  default_network: "signet",
  email_enabled: true,
  sms_enabled: false,
  whatsapp_enabled: false,
};
const PAST = new Date(Date.now() - 5 * 86400_000).toISOString();
const PASSWORD = "Okra-lantern-harbour-quietly-92";

test("setup: 'Do this later' creates savings with nothing that reaches an heir", async ({ page }) => {
  test.setTimeout(120_000);
  let created: Record<string, any> | null = null;
  await page.route("**/api/**", (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname.replace(/^\/api/, "");
    if (p === "/health") return route.fulfill(json(HEALTH));
    if (p === "/vaults/from-xpub" && req.method() === "POST") {
      created = req.postDataJSON();
      return route.fulfill(
        json({
          id: "v-new",
          owner_token: "e2e-owner-token",
          label: "Savings",
          network: "signet",
          status: "unfunded",
          created_at: new Date().toISOString(),
          next_deadline_at: new Date().toISOString(),
          timelock_blocks: created!.timelock_blocks,
          checkin_period_secs: created!.checkin_period_secs,
          grace_period_secs: created!.grace_period_secs,
          last_checkin_at: null,
          claim_eligible_at: null,
        }),
      );
    }
    if (p === "/vaults/v-new/seal-owner-token") return route.fulfill({ status: 204, body: "" });
    if (p === "/vaults/v-new/address")
      return route.fulfill(json({ vault_id: "v-new", network: "signet", address: "tb1qexample" }));
    if (p === "/vaults/v-new/savings/goal") return route.fulfill(json({}));
    return route.fulfill(json({}, 404));
  });

  await page.goto(`${base}/#/setup`);
  await page.getByRole("button", { name: "School fees" }).click();
  await page.getByRole("button", { name: "6 months" }).click();
  await page.getByRole("button", { name: "Continue" }).click();

  await page.locator('input[autocomplete="email"]').fill("owner@example.com");
  const pw = page.locator('input[autocomplete="new-password"]');
  await pw.nth(0).fill(PASSWORD);
  await pw.nth(1).fill(PASSWORD);
  await page.getByText("I have saved my password somewhere I can get it back.").click();
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("heading", { name: "Who inherits?" })).toBeVisible();
  await expectNoSerious(page);
  await page.getByRole("button", { name: "Do this later" }).click();
  await expect.poll(() => created, { timeout: 60_000 }).not.toBeNull();
  await expect(page.getByRole("heading", { name: "Fund your vault" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Only you can spend it. Choose who inherits any time from Home.")).toBeVisible();

  const body = created!;
  expect(body.heir_contact).toBeNull();
  expect(body.timelock_blocks).toBe(6 * 30 * 144);
  expect(body.sealed.claim_token_b64).toBeUndefined();
  expect(body.sealed.heir_xprv_ct_b64).toBeUndefined();
  expect(body.sealed.heir_xprv_owner_ct_b64).toBeTruthy();

  // The spare heir key opens with the owner's password, and it is the
  // key whose xpub went into the descriptor.
  const kek = await deriveOwnerKek(PASSWORD, b64decode(body.sealed.password_salt_b64), {
    memKiB: body.sealed.password_kdf_mem_kib,
    iters: body.sealed.password_kdf_iters,
  });
  const heirXprv = new TextDecoder().decode(
    openWithKey(kek, { v: 1, ct: body.sealed.heir_xprv_owner_ct_b64, nonce: body.sealed.heir_xprv_owner_nonce_b64 }),
  );
  const versions = bip32Versions("signet");
  expect(HDKey.fromExtendedKey(heirXprv, versions).publicExtendedKey).toBe(body.heir.xpub);
});

async function mockLaterVault(page: Page, sealedBlobs: Record<string, unknown>, onChoose: (b: any) => void) {
  await page.route("**/api/**", (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname.replace(/^\/api/, "");
    if (p === "/health") return route.fulfill(json(HEALTH));
    if (p === "/vaults/v-later")
      return route.fulfill(
        json({
          id: "v-later",
          label: "Savings",
          network: "signet",
          timelock_blocks: 12960,
          checkin_period_secs: 2_592_000,
          grace_period_secs: 604_800,
          status: "unfunded",
          heir_pending: true,
          created_at: PAST,
          last_checkin_at: null,
          // Long past: a vault with no heir must never read as overdue.
          next_deadline_at: PAST,
          claim_eligible_at: PAST,
          owner_contact_verified: true,
        }),
      );
    if (p === "/vaults/v-later/balance")
      return route.fulfill(json({ vault_id: "v-later", network: "signet", confirmed_sat: 50_000, unconfirmed_sat: 0, total_sat: 50_000 }));
    if (p === "/vaults/v-later/events") return route.fulfill(json([]));
    if (p === "/vaults/v-later/savings")
      return route.fulfill(
        json({
          total_saved_sat: 50_000,
          deposit_count: 1,
          deposits: [],
          goal: null,
          goals: [],
          unsorted: [],
          this_year: { year: 2026, total_sat: 0, deposit_count: 0, best_month: null, best_month_sat: 0 },
          reminder: null,
          owner_email_confirmed: true,
        }),
      );
    if (p === "/vaults/v-later/sealed-blobs") return route.fulfill(json(sealedBlobs));
    if (p === "/vaults/v-later/heir/choose" && req.method() === "POST") {
      onChoose(req.postDataJSON());
      return route.fulfill({ status: 204, body: "" });
    }
    return route.fulfill(json({}, 404));
  });
  await page.addInitScript(() => {
    const meta = {
      id: "v-later",
      label: "Savings",
      owner: { address: "owner@example.com" },
      heir: { name: "", email: "", address: "" },
      createdAt: new Date().toISOString(),
      ownerToken: "e2e-owner-token",
      groupId: null,
    };
    window.localStorage.setItem("gk:vaults", JSON.stringify({ "v-later": meta }));
    window.localStorage.setItem("gk:activeVaultId", "v-later");
    window.localStorage.setItem("gk:lastActivityAt", String(Date.now()));
  });
}

test("Home: choose who inherits later; the claim token really opens the key", async ({ page }) => {
  test.setTimeout(60_000);
  const heir = generateParty("signet");
  const salt = new Uint8Array(16).fill(9);
  // Small Argon2 parameters, recorded in the blobs, so the browser's
  // unlock stays quick; the maths is the same.
  const kek = await deriveOwnerKek(PASSWORD, salt, { memKiB: 1024, iters: 1 });
  const blob = sealWithKey(kek, new TextEncoder().encode(heir.xprv));
  const blobs = {
    vault_id: "v-later",
    password_salt_b64: Buffer.from(salt).toString("base64"),
    password_kdf_mem_kib: 1024,
    password_kdf_iters: 1,
    owner_xprv_ct_b64: "x",
    owner_xprv_nonce_b64: "x",
    owner_token_ct_b64: "x",
    owner_token_nonce_b64: "x",
    network: "signet",
    timelock_blocks: 12960,
    heir_xprv_owner_ct_b64: blob.ct,
    heir_xprv_owner_nonce_b64: blob.nonce,
    heir_xpub_fragment_external: `[${heir.fingerprint}/86'/1'/0']${heir.xpub}/0/*`,
  };
  const posts: any[] = [];
  await mockLaterVault(page, blobs, (b) => posts.push(b));

  await page.goto(`${base}/#/dashboard`);
  await expect(page.getByTestId("savings-balance")).toHaveText("50,000 sats");
  await expect(page.getByTestId("choose-heir")).toBeVisible();
  await expect(page.getByTestId("checkin-row")).toHaveCount(0);
  await expect(page.getByText("Check-in overdue")).toHaveCount(0);

  const card = page.getByTestId("choose-heir");
  await card.getByRole("button", { name: "Choose who inherits" }).click();
  await card.getByLabel("Their name").fill("Ada");
  await card.getByLabel("Their email").fill("ada@example.com");
  await expectNoSerious(page, '[data-testid="choose-heir"]');

  // A wrong password sends nothing.
  await card.getByLabel("Your password").fill("not-the-password");
  await card.getByRole("button", { name: "Save" }).click();
  await expect(card.getByText("That password doesn't match this vault.")).toBeVisible();
  expect(posts).toHaveLength(0);

  await card.getByLabel("Your password").fill(PASSWORD);
  await card.getByRole("button", { name: "Save" }).click();
  await expect.poll(() => posts.length).toBe(1);
  const body = posts[0];
  expect(body.name).toBe("Ada");
  expect(body.contact).toBe("ada@example.com");
  const opened = unsealHeirXprv(b64decode(body.claim_token_b64), {
    v: 1,
    ct: body.heir_xprv_ct_b64,
    nonce: body.heir_xprv_nonce_b64,
  });
  expect(opened).toBe(heir.xprv);
});

async function expectNoSerious(page: Page, include?: string) {
  let axe = new AxeBuilder({ page });
  if (include) axe = axe.include(include);
  const results = await axe.analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
}
