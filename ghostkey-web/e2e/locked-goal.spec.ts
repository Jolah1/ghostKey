/**
 * Locking a goal, end to end in a real browser with real crypto against a
 * mocked API:
 *
 *  - Home shows "Your plans" with "+ Lock a goal" only while the server
 *    has locked goals switched on.
 *  - The flow is one step per screen (what for, how long, the promise
 *    with the unlock fee, password) and the phone's back button steps back.
 *  - The create request carries dates the server accepts, the owner's own
 *    key (from the password-sealed copy), a spare heir key that only the
 *    owner's password opens, and nothing that reaches an heir.
 *  - Home then lists the plan; its page counts down; Send refuses it.
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
import { b64decode, deriveOwnerKek, openWithKey, sealWithKey } from "../src/crypto/sealing";
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

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});
const PAST = new Date(Date.now() - 5 * 86400_000).toISOString();
const FUTURE = new Date(Date.now() + 25 * 86400_000).toISOString();
const PASSWORD = "Okra-lantern-harbour-quietly-92";
const DAY = 86_400;

function vaultView(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    label: "Savings",
    network: "signet",
    timelock_blocks: 12960,
    checkin_period_secs: 2_592_000,
    grace_period_secs: 604_800,
    status: "ok",
    heir_pending: true,
    created_at: PAST,
    last_checkin_at: PAST,
    next_deadline_at: FUTURE,
    claim_eligible_at: FUTURE,
    owner_contact_verified: true,
    ...extra,
  };
}

const SAVINGS = {
  total_saved_sat: 50_000,
  deposit_count: 1,
  deposits: [],
  goal: null,
  goals: [],
  unsorted: [],
  this_year: { year: 2026, total_sat: 0, deposit_count: 0, best_month: null, best_month_sat: 0 },
  reminder: null,
  owner_email_confirmed: true,
};

async function mockServer(page: Page, opts: { enabled: boolean; blobs?: Record<string, unknown>; onCreate?: (b: any) => void }) {
  let created: { until: number } | null = null;
  await page.route("**/api/**", (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname.replace(/^\/api/, "");
    if (p === "/health")
      return route.fulfill(
        json({ ok: true, version: "e2e", demo_mode: false, default_network: "signet", email_enabled: true, locked_goals_enabled: opts.enabled }),
      );
    if (p === "/vaults/v-main") return route.fulfill(json(vaultView("v-main")));
    if (p === "/vaults/v-main/balance")
      return route.fulfill(json({ vault_id: "v-main", network: "signet", confirmed_sat: 50_000, unconfirmed_sat: 0, total_sat: 50_000 }));
    if (p === "/vaults/v-main/events") return route.fulfill(json([]));
    if (p === "/vaults/v-main/savings") return route.fulfill(json(SAVINGS));
    if (p === "/vaults/v-main/sealed-blobs" && opts.blobs) return route.fulfill(json(opts.blobs));
    if (p === "/vaults/v-main/coins")
      return route.fulfill(
        json({ network: "signet", chain_tip_height: 1000, funding: [], confirmed_sat: 50_000, unconfirmed_sat: 0, fee_rate_sat_per_vb: 3 }),
      );
    if (p === "/vaults/from-xpub" && req.method() === "POST") {
      const body = req.postDataJSON();
      opts.onCreate?.(body);
      created = { until: body.locked.owner_after };
      return route.fulfill(
        json(
          {
            id: "v-lock",
            label: body.label,
            status: "unfunded",
            next_deadline_at: FUTURE,
            owner_token: "e2e-lock-token",
          },
          201,
        ),
      );
    }
    if (p === "/vaults/v-lock/seal-owner-token") return route.fulfill({ status: 204, body: "" });
    if (p === "/vaults/v-lock/address")
      return route.fulfill(json({ vault_id: "v-lock", network: "signet", address: "tb1pexamplelockedgoaladdress" }));
    if (p === "/vaults/v-lock")
      return route.fulfill(json(vaultView("v-lock", { label: "School fees", locked_until: created?.until ?? null })));
    if (p === "/vaults/v-lock/balance/last") return route.fulfill(json(null));
    if (p === "/vaults/v-lock/coins")
      return route.fulfill(
        json({ network: "signet", chain_tip_height: 1000, funding: [], confirmed_sat: 0, unconfirmed_sat: 0, fee_rate_sat_per_vb: 3 }),
      );
    return route.fulfill(json({}, 404));
  });
  await page.addInitScript(() => {
    if (window.localStorage.getItem("gk:vaults")) return; // keep what the test made
    const meta = {
      id: "v-main",
      label: "Savings",
      owner: { address: "owner@example.com" },
      heir: { name: "", email: "", address: "" },
      createdAt: new Date().toISOString(),
      ownerToken: "e2e-owner-token",
    };
    window.localStorage.setItem("gk:vaults", JSON.stringify({ "v-main": meta }));
    window.localStorage.setItem("gk:activeVaultId", "v-main");
    window.localStorage.setItem("gk:lastActivityAt", String(Date.now()));
  });
}

test("Home hides locking while the server has it switched off", async ({ page }) => {
  await mockServer(page, { enabled: false });
  await page.goto(`${base}/#/dashboard`);
  await expect(page.getByText("50,000", { exact: false }).first()).toBeVisible();
  await expect(page.getByTestId("your-plans")).toHaveCount(0);
});

test("lock a goal: one step per screen, the owner's key, a spare heir key only the password opens", async ({ page }) => {
  test.setTimeout(120_000);
  // The owner's key, sealed under the password with small Argon2
  // parameters (recorded in the blobs) so the unlock stays quick.
  const owner = generateParty("signet");
  const salt = new Uint8Array(16).fill(7);
  const kek = await deriveOwnerKek(PASSWORD, salt, { memKiB: 1024, iters: 1 });
  const xprvBlob = sealWithKey(kek, new TextEncoder().encode(owner.xprv));
  const tokenBlob = sealWithKey(kek, new TextEncoder().encode("e2e-owner-token"));
  const fragment = `[${owner.fingerprint}/86'/1'/0']${owner.xpub}/0/*`;
  const blobs = {
    vault_id: "v-main",
    password_salt_b64: Buffer.from(salt).toString("base64"),
    password_kdf_mem_kib: 1024,
    password_kdf_iters: 1,
    owner_xprv_ct_b64: xprvBlob.ct,
    owner_xprv_nonce_b64: xprvBlob.nonce,
    owner_token_ct_b64: tokenBlob.ct,
    owner_token_nonce_b64: tokenBlob.nonce,
    owner_xpub_fragment_external: fragment,
    network: "signet",
    timelock_blocks: 12960,
  };
  let body: any = null;
  await mockServer(page, { enabled: true, blobs, onCreate: (b) => (body = b) });

  await page.goto(`${base}/#/dashboard`);
  const plans = page.getByTestId("your-plans");
  await expect(plans).toBeVisible();
  await plans.getByRole("button", { name: "+ Lock a goal" }).click();

  await expect(page.getByRole("heading", { name: "What are you locking for?" })).toBeVisible();
  await page.getByRole("button", { name: "School fees" }).click();
  await page.getByRole("button", { name: "Next" }).click();

  await expect(page.getByRole("heading", { name: "For how long?" })).toBeVisible();
  await page.getByRole("button", { name: "12 months" }).click();
  await expect(page.getByTestId("unlock-date")).toContainText(String(new Date().getFullYear() + 1));
  // The phone's back button steps back, keeping the answer.
  await page.goBack();
  await expect(page.getByRole("heading", { name: "What are you locking for?" })).toBeVisible();
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "6 months" }).click();
  await page.getByRole("button", { name: "Next" }).click();

  await expect(page.getByRole("heading", { name: "Lock it?" })).toBeVisible();
  await expect(page.getByText("Nobody can open it early. Not even GhostKey.")).toBeVisible();
  // 12 deposits at 3 sat/vB: (54 + 84 * 12) * 3 = 3,186 sats.
  await expect(page.getByTestId("unlock-fee")).toContainText("unlocking 12 deposits costs about");
  const cont = page.getByRole("button", { name: "Continue" });
  await expect(cont).toBeDisabled();
  await page.getByLabel(/I understand it stays locked until/).check();
  await settleAnimations(page);
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  await cont.click();

  await page.getByLabel("Enter your password to lock it").fill("not-the-password");
  await page.getByRole("button", { name: "Lock it" }).click();
  await expect(page.getByRole("alert")).toContainText("didn't unlock");
  expect(body).toBeNull();

  await page.getByLabel("Enter your password to lock it").fill(PASSWORD);
  await page.getByRole("button", { name: "Lock it" }).click();
  await expect(page.getByRole("heading", { name: "Locked" })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("tb1pexamplelockedgoaladdress")).toBeVisible();

  // What the server was asked for.
  expect(body.label).toBe("School fees");
  expect(body.owner.xpub).toBe(fragment.replace(/\/0\/\*$/, ""));
  const now = Date.now() / 1000;
  expect(body.locked.owner_after - now).toBeGreaterThan(80 * DAY);
  expect(body.locked.owner_after - now).toBeLessThan(380 * DAY);
  const gap = body.locked.heir_after - body.locked.owner_after;
  expect(gap).toBeGreaterThanOrEqual(80 * DAY);
  expect(gap).toBeLessThanOrEqual(380 * DAY);
  // Nothing reaches an heir: no contact, no heir-code copy, no claim token.
  expect(body.heir_contact).toBeNull();
  expect(body.sealed.heir_code).toBeUndefined();
  expect(body.sealed.heir_xprv_ct_b64).toBeUndefined();
  expect(body.claim_token).toBeUndefined();
  // The spare heir key opens with the owner's password and is the heir
  // key in the request.
  const newKek = await deriveOwnerKek(PASSWORD, b64decode(body.sealed.password_salt_b64), {
    memKiB: body.sealed.password_kdf_mem_kib,
    iters: body.sealed.password_kdf_iters,
  });
  const heirXprv = new TextDecoder().decode(
    openWithKey(newKek, { v: 1, ct: body.sealed.heir_xprv_owner_ct_b64, nonce: body.sealed.heir_xprv_owner_nonce_b64 }),
  );
  expect(HDKey.fromExtendedKey(heirXprv, bip32Versions("signet")).publicExtendedKey).toBe(body.heir.xpub);

  // Home lists it; its page counts down.
  await page.getByRole("button", { name: "Done" }).click();
  const row = page.getByTestId("your-plans").getByRole("button", { name: /School fees/ });
  await expect(row).toContainText("days left");
  await row.click();
  await expect(page.getByTestId("plan-countdown")).toContainText("days left");
  await expect(page.getByRole("button", { name: "Add sats" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Use my savings" })).toHaveCount(0);

  // Send refuses a goal that's still locked.
  await page.evaluate(() => sessionStorage.setItem("gk:sendFrom", "v-lock"));
  await page.goto(`${base}/#/send`);
  await expect(page.getByText(/This goal is locked until/)).toBeVisible();
});
