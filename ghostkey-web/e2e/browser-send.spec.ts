/**
 * Owner sends are signed in this browser (#442): the server hands over
 * the vault's history and broadcasts the finished transaction, but no
 * request ever carries the owner's key. Real encryption and the real
 * signer (ghostkey-core in wasm), with the recovery kit's regtest fixture.
 * Serves the built dist/ and intercepts /api/*. Prereq: `npm run build`.
 */
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createServer, type Server } from "node:http";
import { prodHeaders } from "./prodHeaders";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { deriveOwnerKek, sealWithKey } from "../src/crypto/sealing";
import { Transaction, OutScript, Address, TEST_NETWORK } from "@scure/btc-signer";
import { hexToBytes, bytesToHex } from "@noble/hashes/utils.js";

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

/** Mocks the server for one funded vault. `seen` collects what the
 *  browser sent, so a test can check the key never left it. */
async function mockVault(page: Page, opts: { busyCoinsOnce?: boolean } = {}) {
  let busyLeft = opts.busyCoinsOnce ? 1 : 0;
  const seen: { bodies: string[]; signedBody: { tx_hex: string; destination: string } | null; oldSendCalled: boolean } = {
    bodies: [],
    signedBody: null,
    oldSendCalled: false,
  };
  const salt = new Uint8Array(16).fill(5);
  const kek = await deriveOwnerKek(PASSWORD, salt, { memKiB: 1024, iters: 1 });
  const xprv = sealWithKey(kek, new TextEncoder().encode(fixture.account_xprv));
  const tok = sealWithKey(kek, new TextEncoder().encode("e2e-owner-token"));

  await page.route("**/api/**", (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname.replace(/^\/api/, "");
    const body = req.postData();
    if (body) seen.bodies.push(body);
    if (p === "/price") return route.fulfill(json({ usd_per_btc: 100_000, ngn_per_btc: null }));
    if (p === "/health") return route.fulfill(json({ ok: true, version: "e2e", demo_mode: false, default_network: "regtest", email_enabled: true }));
    if (p === "/vaults/v-send")
      return route.fulfill(
        json({
          id: "v-send", label: "Savings", network: "regtest", timelock_blocks: fixture.timelock_blocks,
          checkin_period_secs: 7_776_000, grace_period_secs: 604_800, status: "ok", created_at: PAST,
          last_checkin_at: PAST, next_deadline_at: FUTURE, claim_eligible_at: FUTURE,
          descriptor_external: fixture.descriptor_external, descriptor_internal: fixture.descriptor_internal,
        }),
      );
    if (p === "/vaults/v-send/balance")
      return route.fulfill(json({ vault_id: "v-send", network: "regtest", confirmed_sat: 1_000_000, unconfirmed_sat: 0, total_sat: 1_000_000 }));
    if (p === "/vaults/v-send/sealed-blobs")
      return route.fulfill(
        json({
          vault_id: "v-send", password_salt_b64: Buffer.from(salt).toString("base64"), password_kdf_mem_kib: 1024,
          password_kdf_iters: 1, owner_xprv_ct_b64: xprv.ct, owner_xprv_nonce_b64: xprv.nonce,
          owner_token_ct_b64: tok.ct, owner_token_nonce_b64: tok.nonce, network: "regtest", timelock_blocks: fixture.timelock_blocks,
        }),
      );
    if (p === "/vaults/v-send/coins" && busyLeft > 0) {
      busyLeft--;
      return route.fulfill(
        json({ error: "validation: The Bitcoin network lookup is busy right now (HTTP 429 on full_scan). Try again in a minute." }, 400),
      );
    }
    if (p === "/vaults/v-send/coins")
      return route.fulfill(
        json({
          network: "regtest", chain_tip_height: fixture.chain_tip_height, funding: fixture.funding,
          confirmed_sat: 1_000_000, unconfirmed_sat: 0, fee_rate_sat_per_vb: 2,
        }),
      );
    if (p === "/vaults/v-send/send") {
      seen.oldSendCalled = true;
      return route.fulfill(json({ error: "gone" }, 410));
    }
    if (p === "/vaults/v-send/send/signed") {
      seen.signedBody = req.postDataJSON();
      return route.fulfill(json({ txid: "ab".repeat(32), explorer_url: "https://example.com/tx", sent_sat: 99_000, fee_sat: 300, remaining_sat: 0 }));
    }
    return route.fulfill(json({}, 404));
  });
  await page.addInitScript(() => {
    const meta = {
      id: "v-send", label: "Savings", owner: { address: "owner@example.com" },
      heir: { name: "Ada", email: "ada@example.com", address: "" }, createdAt: new Date().toISOString(),
      ownerToken: "e2e-owner-token", groupId: null,
    };
    window.localStorage.setItem("gk:vaults", JSON.stringify({ "v-send": meta }));
    window.localStorage.setItem("gk:activeVaultId", "v-send");
    window.localStorage.setItem("gk:lastActivityAt", String(Date.now()));
  });

  return seen;
}

test("a send is signed in the browser: the server never sees the key", async ({ page }) => {
  test.setTimeout(120_000);
  const seen = await mockVault(page);

  await page.goto(`${base}/#/dashboard`);
  await page.getByTestId("savings-hero").getByRole("button", { name: "Send", exact: true }).click();
  // Send is its own page, one step per screen.
  await expect(page).toHaveURL(/#\/send$/);
  await expect(page.getByRole("heading", { name: "How much?" })).toBeVisible();
  await page.getByRole("button", { name: "Send all" }).click();
  await expect(page.getByRole("heading", { name: "Send to" })).toBeVisible();
  await page.getByLabel("Bitcoin address").fill(fixture.recipient);
  await page.getByRole("button", { name: "Next" }).click();
  // The password comes before the check, so the check shows the real fee.
  await page.getByLabel("Enter your password").fill(PASSWORD);
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("heading", { name: "Check it" })).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText(fixture.recipient)).toBeVisible();
  await expect(page.getByText("Network fee")).toBeVisible();
  await expect(page.getByText("Left in your savings")).toBeVisible();
  // Nothing has gone out yet.
  expect(seen.signedBody).toBeNull();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText(/Sent ✓/)).toBeVisible({ timeout: 90_000 });

  // The server got a finished transaction that pays the address typed...
  expect(seen.signedBody).not.toBeNull();
  expect(seen.signedBody!.destination).toBe(fixture.recipient);
  const tx = Transaction.fromRaw(hexToBytes(seen.signedBody!.tx_hex));
  const want = bytesToHex(OutScript.encode(Address(REGTEST).decode(fixture.recipient)));
  expect(tx.outputsLength).toBe(1);
  expect(bytesToHex(tx.getOutput(0).script!)).toBe(want);
  expect(tx.getInput(0).finalScriptWitness?.length ?? 0).toBeGreaterThan(0);
  // ...and never the key, by any route.
  expect(seen.oldSendCalled).toBe(false);
  for (const b of seen.bodies) {
    expect(b).not.toContain("prv");
    expect(b).not.toContain("owner_xprv");
  }
});

test("an amount can be typed in dollars, and back steps back without losing it", async ({ page }) => {
  test.setTimeout(120_000);
  const seen = await mockVault(page);
  await page.goto(`${base}/#/send`);
  await expect(page.getByText(/You can send/)).toBeVisible();
  await page.getByRole("button", { name: "$", exact: true }).click();
  // $1 at $100,000 per bitcoin is 1,000 sats.
  await page.getByLabel("Amount in $").fill("1");
  await expect(page.getByText("= 1,000 sats")).toBeVisible();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("heading", { name: "Send to" })).toBeVisible();

  // The phone's back button returns to the amount, still filled in.
  await page.goBack();
  await expect(page.getByRole("heading", { name: "How much?" })).toBeVisible();
  await expect(page.getByLabel("Amount in $")).toHaveValue("1");

  await page.getByRole("button", { name: "Next" }).click();
  await page.getByLabel("Bitcoin address").fill(fixture.recipient);
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByLabel("Enter your password").fill(PASSWORD);
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByText(/^1,000 sats/)).toBeVisible({ timeout: 90_000 });
  // Fee and what's left come from the signed transaction itself.
  const fee = await page.getByText("Network fee").locator("xpath=following-sibling::dd").textContent();
  const left = await page.getByText("Left in your savings").locator("xpath=following-sibling::dd").textContent();
  const n = (t: string | null) => Number((t ?? "").replace(/[^0-9]/g, ""));
  expect(n(fee)).toBeGreaterThan(0);
  expect(n(left)).toBe(1_000_000 - 1_000 - n(fee));
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText(/Sent ✓/)).toBeVisible({ timeout: 90_000 });

  // The transaction pays exactly 1,000 sats to the address typed.
  const tx = Transaction.fromRaw(hexToBytes(seen.signedBody!.tx_hex));
  const want = bytesToHex(OutScript.encode(Address(REGTEST).decode(fixture.recipient)));
  const paid = Array.from({ length: tx.outputsLength }, (_, i) => tx.getOutput(i)).find(
    (o) => bytesToHex(o.script!) === want,
  );
  expect(paid?.amount).toBe(1000n);
});

test("a busy network lookup is retried quietly, not shown as an error", async ({ page }) => {
  test.setTimeout(120_000);
  const seen = await mockVault(page, { busyCoinsOnce: true });
  await page.goto(`${base}/#/send`);
  await page.getByRole("button", { name: "Send all" }).click();
  await page.getByLabel("Bitcoin address").fill(fixture.recipient);
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByLabel("Enter your password").fill(PASSWORD);
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("heading", { name: "Check it" })).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText(/busy right now|validation:/)).toHaveCount(0);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText(/Sent ✓/)).toBeVisible({ timeout: 90_000 });
  expect(seen.signedBody).not.toBeNull();
});
