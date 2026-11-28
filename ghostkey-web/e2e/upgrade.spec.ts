/**
 * Moving a vault to the new format (#389), in a real browser with real
 * encryption and the real signer, with the recovery kit's regtest fixture
 * (an old-format vault):
 *
 *  - Home offers it only when the server says the vault can move.
 *  - One transaction per deposit, signed here with the old format, paying
 *    the new format's change addresses that this device works out itself.
 *  - The pin moves to the new descriptors; the key never leaves.
 *  - A server "new format" that isn't this vault is refused, and nothing
 *    is sent.
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
import { upgradedPair } from "../src/vaultUpgrade";
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

async function mockVault(page: Page, next: { external: string; internal: string }) {
  const seen: { bodies: string[]; upgradeBody: { txs: string[] } | null } = { bodies: [], upgradeBody: null };
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
    if (p === "/vaults/v-up")
      return route.fulfill(
        json({
          id: "v-up", label: "Savings", network: "regtest", timelock_blocks: fixture.timelock_blocks,
          checkin_period_secs: 7_776_000, grace_period_secs: 604_800, status: "ok", created_at: PAST,
          last_checkin_at: PAST, next_deadline_at: FUTURE, claim_eligible_at: FUTURE, heir_pending: false,
          upgrade_available: true,
          descriptor_external: fixture.descriptor_external, descriptor_internal: fixture.descriptor_internal,
        }),
      );
    if (p === "/vaults/v-up/balance")
      return route.fulfill(json({ vault_id: "v-up", network: "regtest", confirmed_sat: 1_000_000, unconfirmed_sat: 0, total_sat: 1_000_000 }));
    if (p === "/vaults/v-up/sealed-blobs")
      return route.fulfill(
        json({
          vault_id: "v-up", password_salt_b64: Buffer.from(salt).toString("base64"), password_kdf_mem_kib: 1024,
          password_kdf_iters: 1, owner_xprv_ct_b64: xprv.ct, owner_xprv_nonce_b64: xprv.nonce,
          owner_token_ct_b64: tok.ct, owner_token_nonce_b64: tok.nonce, network: "regtest", timelock_blocks: fixture.timelock_blocks,
        }),
      );
    if (p === "/vaults/v-up/coins")
      return route.fulfill(
        json({
          network: "regtest", chain_tip_height: fixture.chain_tip_height, funding: fixture.funding,
          confirmed_sat: 1_000_000, unconfirmed_sat: 0, fee_rate_sat_per_vb: 2, coins,
        }),
      );
    if (p === "/vaults/v-up/upgrade")
      return route.fulfill(json({ available: true, descriptor_external: next.external, descriptor_internal: next.internal }));
    if (p === "/vaults/v-up/upgrade/signed") {
      seen.upgradeBody = req.postDataJSON();
      return route.fulfill(json({ moved: seen.upgradeBody!.txs.length, pending: 0, fee_sat: 300 }));
    }
    return route.fulfill(json({}, 404));
  });
  await page.addInitScript((pin) => {
    if (window.localStorage.getItem("gk:vaults")) return;
    const meta = {
      id: "v-up", label: "Savings", owner: { address: "owner@example.com" },
      heir: { name: "Ada", email: "ada@example.com", address: "" }, createdAt: new Date().toISOString(),
      ownerToken: "e2e-owner-token", groupId: null, pinnedDescriptors: pin,
    };
    window.localStorage.setItem("gk:vaults", JSON.stringify({ "v-up": meta }));
    window.localStorage.setItem("gk:activeVaultId", "v-up");
    window.localStorage.setItem("gk:lastActivityAt", String(Date.now()));
  }, { external: fixture.descriptor_external, internal: fixture.descriptor_internal });
  return seen;
}

const OLD = () => ({ external: fixture.descriptor_external, internal: fixture.descriptor_internal });

test("move to the new format: one signed transaction per deposit, to addresses worked out here", async ({ page }) => {
  test.setTimeout(120_000);
  const next = upgradedPair(OLD())!;
  const seen = await mockVault(page, next);

  await page.goto(`${base}/#/dashboard`);
  await page.getByTestId("upgrade-available").click();
  await expect(page).toHaveURL(/#\/upgrade$/);
  await expect(page.getByRole("heading", { name: "Move to the new format" })).toBeVisible();
  await expect(page.getByText(/would wait .* from today/)).toBeVisible();
  await settleAnimations(page);
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  await page.getByRole("button", { name: "Continue" }).click();

  await page.getByLabel("Enter your password").fill(PASSWORD);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Check and move" })).toBeVisible({ timeout: 90_000 });
  const deposits = fixtureCoins().length;
  await expect(page.getByTestId("upgrade-count")).toHaveText(String(deposits));
  expect(seen.upgradeBody).toBeNull(); // nothing has moved yet
  await page.getByRole("button", { name: "Move to the new format" }).click();
  await expect(page.getByRole("heading", { name: "Moved" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Download recovery files" })).toBeVisible();

  // One transaction per deposit, each paying the next new-format change
  // address and nothing else; signed; no key sent anywhere.
  const txs = seen.upgradeBody!.txs;
  expect(txs.length).toBe(deposits);
  txs.forEach((hex, i) => {
    const tx = Transaction.fromRaw(hexToBytes(hex));
    expect(tx.outputsLength).toBe(1);
    const want = OutScript.encode(Address(REGTEST).decode(deriveVaultAddress(next.internal, "regtest", i)));
    expect(bytesToHex(tx.getOutput(0).script!)).toBe(bytesToHex(want));
    expect(tx.getInput(0).finalScriptWitness?.length ?? 0).toBeGreaterThan(0);
  });
  for (const b of seen.bodies) expect(b).not.toContain("prv");
  // The pin moved to the new format.
  const pin = await page.evaluate(() => JSON.parse(localStorage.getItem("gk:vaults")!)["v-up"].pinnedDescriptors);
  expect(pin).toEqual(next);
});

test("a new format that isn't this vault is refused, and nothing is sent", async ({ page }) => {
  test.setTimeout(120_000);
  const real = upgradedPair(OLD())!;
  // Same shape, different wait: a different vault.
  const wrong = {
    external: real.external.replace(/older\((\d+)\)/, (_, n) => `older(${Number(n) + 1})`),
    internal: real.internal.replace(/older\((\d+)\)/, (_, n) => `older(${Number(n) + 1})`),
  };
  const seen = await mockVault(page, wrong);
  await page.goto(`${base}/#/upgrade`);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Enter your password").fill(PASSWORD);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("alert")).toContainText("doesn't match your vault", { timeout: 90_000 });
  expect(seen.upgradeBody).toBeNull();
});
