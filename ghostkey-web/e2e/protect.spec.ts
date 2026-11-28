/**
 * Refreshing a deposit (#94), in a real browser with real encryption and
 * the real signer (ghostkey-core in wasm), with the recovery kit's regtest
 * fixture:
 *
 *  - Home asks for a refresh only when the server says one is due.
 *  - The page lists each deposit and when Bitcoin's lock on it ends.
 *  - The refresh is signed here and pays only the vault's own change
 *    address, checked against the descriptors this device pinned; the
 *    key never leaves the browser.
 *  - A refresh address that isn't the vault's is refused, and nothing is
 *    sent.
 *
 * Serves the built dist/ and intercepts /api/*. Prereq: `npm run build`.
 */
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createServer, type Server } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { Transaction, OutScript, Address, TEST_NETWORK } from "@scure/btc-signer";
import { hexToBytes, bytesToHex } from "@noble/hashes/utils.js";
import { deriveOwnerKek, sealWithKey } from "../src/crypto/sealing";
import { deriveVaultAddress } from "../src/vaultAddress";
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
const fixture = JSON.parse(
  readFileSync(resolve(__dirname, "../../crates/ghostkey-wasm/tests/fixture_owner.json"), "utf8"),
);
const PASSWORD = "Okra-lantern-harbour-quietly-92";
const FUTURE = new Date(Date.now() + 30 * 86400_000).toISOString();
const PAST = new Date(Date.now() - 30 * 86400_000).toISOString();
const REGTEST = { ...TEST_NETWORK, bech32: "bcrt" };

/** The fixture's vault coins, as the server's coin list reports them. */
function fixtureCoins() {
  const mine = new Set(
    Array.from({ length: 10 }, (_, i) =>
      bytesToHex(OutScript.encode(Address(REGTEST).decode(deriveVaultAddress(fixture.descriptor_external, "regtest", i)))),
    ),
  );
  const coins: { outpoint: string; value_sat: number; confirmation_height: number }[] = [];
  for (const f of fixture.funding) {
    const tx = Transaction.fromRaw(hexToBytes(f.tx_hex), { allowUnknownOutputs: true });
    for (let i = 0; i < tx.outputsLength; i++) {
      const o = tx.getOutput(i);
      if (o.script && mine.has(bytesToHex(o.script)))
        coins.push({ outpoint: `${tx.id}:${i}`, value_sat: Number(o.amount), confirmation_height: f.confirmation_height });
    }
  }
  return coins;
}

async function mockVault(page: Page, refreshAddress: { address: string; index: number }) {
  const seen: { bodies: string[]; refreshBody: { tx_hex: string } | null } = { bodies: [], refreshBody: null };
  const salt = new Uint8Array(16).fill(5);
  const kek = await deriveOwnerKek(PASSWORD, salt, { memKiB: 1024, iters: 1 });
  const xprv = sealWithKey(kek, new TextEncoder().encode(fixture.account_xprv));
  const tok = sealWithKey(kek, new TextEncoder().encode("e2e-owner-token"));
  const coins = fixtureCoins();

  await page.route("**/api/**", (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname.replace(/^\/api/, "");
    const body = req.postData();
    if (body) seen.bodies.push(body);
    if (p === "/price") return route.fulfill(json({ usd_per_btc: 100_000, ngn_per_btc: null }));
    if (p === "/health") return route.fulfill(json({ ok: true, version: "e2e", demo_mode: false, default_network: "regtest", email_enabled: true }));
    if (p === "/vaults/v-ref")
      return route.fulfill(
        json({
          id: "v-ref", label: "Savings", network: "regtest", timelock_blocks: fixture.timelock_blocks,
          checkin_period_secs: 7_776_000, grace_period_secs: 604_800, status: "ok", created_at: PAST,
          last_checkin_at: PAST, next_deadline_at: FUTURE, claim_eligible_at: FUTURE, heir_pending: false,
          refresh_due: true,
          descriptor_external: fixture.descriptor_external, descriptor_internal: fixture.descriptor_internal,
        }),
      );
    if (p === "/vaults/v-ref/balance")
      return route.fulfill(json({ vault_id: "v-ref", network: "regtest", confirmed_sat: 1_000_000, unconfirmed_sat: 0, total_sat: 1_000_000 }));
    if (p === "/vaults/v-ref/sealed-blobs")
      return route.fulfill(
        json({
          vault_id: "v-ref", password_salt_b64: Buffer.from(salt).toString("base64"), password_kdf_mem_kib: 1024,
          password_kdf_iters: 1, owner_xprv_ct_b64: xprv.ct, owner_xprv_nonce_b64: xprv.nonce,
          owner_token_ct_b64: tok.ct, owner_token_nonce_b64: tok.nonce, network: "regtest", timelock_blocks: fixture.timelock_blocks,
        }),
      );
    if (p === "/vaults/v-ref/coins")
      return route.fulfill(
        json({
          network: "regtest", chain_tip_height: fixture.chain_tip_height, funding: fixture.funding,
          confirmed_sat: 1_000_000, unconfirmed_sat: 0, fee_rate_sat_per_vb: 2, coins, refresh_address: refreshAddress,
        }),
      );
    if (p === "/vaults/v-ref/refresh/signed") {
      seen.refreshBody = req.postDataJSON();
      return route.fulfill(json({ txid: "ab".repeat(32), fee_sat: 300 }));
    }
    return route.fulfill(json({}, 404));
  });
  await page.addInitScript(() => {
    if (window.localStorage.getItem("gk:vaults")) return;
    const meta = {
      id: "v-ref", label: "Savings", owner: { address: "owner@example.com" },
      heir: { name: "Ada", email: "ada@example.com", address: "" }, createdAt: new Date().toISOString(),
      ownerToken: "e2e-owner-token", groupId: null,
    };
    window.localStorage.setItem("gk:vaults", JSON.stringify({ "v-ref": meta }));
    window.localStorage.setItem("gk:activeVaultId", "v-ref");
    window.localStorage.setItem("gk:lastActivityAt", String(Date.now()));
  });
  return seen;
}

test("refresh a deposit: signed here, back into the vault's own change address", async ({ page }) => {
  test.setTimeout(120_000);
  const change = deriveVaultAddress(fixture.descriptor_internal, "regtest", 0);
  const seen = await mockVault(page, { address: change, index: 0 });

  await page.goto(`${base}/#/dashboard`);
  await page.getByTestId("refresh-due").click();
  await expect(page).toHaveURL(/#\/protect$/);
  await expect(page.getByRole("heading", { name: "Keep it protected" })).toBeVisible();
  const list = page.getByTestId("coin-list");
  // The fixture's coin confirmed at 100 with a 5-block lock; the tip is 105.
  await expect(list).toContainText("Bitcoin's lock has ended");
  await settleAnimations(page);
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  await list.getByRole("button", { name: "Refresh" }).first().click();

  await expect(page.getByRole("heading", { name: "Refresh this deposit?" })).toBeVisible();
  await expect(page.getByText(/never leaves your vault/)).toBeVisible();
  // The phone's back button steps back.
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Keep it protected" })).toBeVisible();
  await page.goForward();
  await page.getByRole("button", { name: "Continue" }).click();

  await page.getByLabel("Enter your password").fill(PASSWORD);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Check and refresh" })).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("refresh-fee")).toBeVisible();
  expect(seen.refreshBody).toBeNull(); // nothing has moved yet
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Refreshed" })).toBeVisible();

  // One output, to the vault's own change address; signed; and the key
  // never left the browser.
  const tx = Transaction.fromRaw(hexToBytes(seen.refreshBody!.tx_hex));
  expect(tx.outputsLength).toBe(1);
  expect(bytesToHex(tx.getOutput(0).script!)).toBe(bytesToHex(OutScript.encode(Address(REGTEST).decode(change))));
  expect(tx.getInput(0).finalScriptWitness?.length ?? 0).toBeGreaterThan(0);
  for (const b of seen.bodies) {
    expect(b).not.toContain("prv");
  }
});

test("a refresh address that isn't the vault's is refused, and nothing is sent", async ({ page }) => {
  test.setTimeout(120_000);
  // A real address, but a receive one at another index: not what the
  // server claims (change, index 0).
  const wrong = deriveVaultAddress(fixture.descriptor_external, "regtest", 3);
  const seen = await mockVault(page, { address: wrong, index: 0 });

  await page.goto(`${base}/#/protect`);
  await page.getByTestId("coin-list").getByRole("button", { name: "Refresh" }).first().click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Enter your password").fill(PASSWORD);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("alert")).toContainText("doesn't match your vault", { timeout: 90_000 });
  expect(seen.refreshBody).toBeNull();
});
