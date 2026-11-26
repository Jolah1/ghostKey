/**
 * Heir claims are signed in this browser (#390): the server hands over
 * the vault's history and broadcasts the finished claim, but no request
 * ever carries the heir's key. Real sealing under the claim link and the
 * real signer (ghostkey-core in wasm) on the recovery kit's regtest vault.
 * Serves the built dist/ and intercepts /api/*. Prereq: `npm run build`.
 */
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createServer, type Server } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { deriveClaimKek, sealWithKey } from "../src/crypto/sealing";
import { deriveHeirCodeKek, sealHeirCheck } from "../src/crypto/heirCode";
import { HDKey } from "@scure/bip32";
import { bip32Versions } from "../src/crypto/keygen";
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
const fixture = JSON.parse(
  readFileSync(resolve(__dirname, "../../crates/ghostkey-wasm/tests/fixture_owner.json"), "utf8"),
);
const REGTEST = { ...TEST_NETWORK, bech32: "bcrt" };
const PAST = new Date(Date.now() - 200 * 86400_000).toISOString();

// The fixture vault's heir: the same deterministic seed the Rust test
// builds it from, at the BIP86 account the descriptor uses.
const HEIR_XPRV = HDKey.fromMasterSeed(new Uint8Array(32).fill(0xb2), bip32Versions("regtest")).derive("m/86'/1'/0'")
  .privateExtendedKey;
const HEIR_CODE = "river-garden-mango-seven-lamp";
// Small Argon2 settings: the same maths as real vaults, a fast test.
const CODE_KDF = { salt_b64: "c2FsdHNhbHRzYWx0c2FsdA", kdf_mem_kib: 1024, kdf_iters: 1 };

/** Mock the claim API for a vault whose heir key is locked with the claim
 *  link (older vaults) or with an heir code (new vaults). */
async function mockClaim(page: Page, lockedWith: "link" | "code") {
  const rawToken = new Uint8Array(32).fill(7);
  const token = Buffer.from(rawToken).toString("base64");
  const kek = lockedWith === "link" ? deriveClaimKek(rawToken) : await deriveHeirCodeKek(HEIR_CODE, CODE_KDF);
  const sealed = sealWithKey(kek, new TextEncoder().encode(HEIR_XPRV));
  const heirCode = lockedWith === "code" ? { heir_code: CODE_KDF } : {};
  const seen = {
    bodies: [] as string[],
    signedBody: null as { tx_hex: string; destination: string } | null,
    oldClaimCalled: false,
  };
  const at = `/claim/${token}`;

  await page.route("**/api/**", (route) => {
    const req = route.request();
    const p = decodeURIComponent(new URL(req.url()).pathname.replace(/^\/api/, ""));
    const raw = req.postData();
    if (raw) seen.bodies.push(raw);
    if (p === "/health") return route.fulfill(json({ ok: true, version: "e2e", demo_mode: false, default_network: "regtest", email_enabled: true }));
    if (p === at)
      return route.fulfill(
        json({
          vault_id: "v-claim", label: "Savings", network: "regtest", status: "timelock_started",
          timelock_blocks: fixture.timelock_blocks, next_deadline_at: PAST, heir_channel: "email",
          heir_display_name: "Ada", ...heirCode,
        }),
      );
    if (p === `${at}/unlock-estimate`)
      return route.fulfill(json({ matured: true, tip_height: fixture.chain_tip_height, unlock_height: 105, blocks_remaining: 0, unlock_eta: null }));
    // Not a "derived heir" vault: the page moves on to the sealed key.
    if (p === `${at}/heir-derivation-params`)
      return route.fulfill(json({ error: "this vault was not created with heir derivation" }, 422));
    if (p === `${at}/sealed-heir`)
      return route.fulfill(
        json({
          vault_id: "v-claim", network: "regtest", timelock_blocks: fixture.timelock_blocks,
          heir_xprv_ct_b64: sealed.ct, heir_xprv_nonce_b64: sealed.nonce,
          descriptor_external: fixture.descriptor_external, descriptor_internal: fixture.descriptor_internal,
          ...heirCode,
        }),
      );
    if (p === `${at}/coins`)
      return route.fulfill(
        json({ network: "regtest", chain_tip_height: fixture.chain_tip_height, funding: fixture.funding, confirmed_sat: 100_000, unconfirmed_sat: 0, fee_rate_sat_per_vb: 2 }),
      );
    if (p === `${at}/heir-claim`) {
      seen.oldClaimCalled = true;
      return route.fulfill(json({ error: "gone" }, 410));
    }
    if (p === `${at}/claim-signed`) {
      seen.signedBody = req.postDataJSON();
      return route.fulfill(json({ txid: "cd".repeat(32), explorer_url: "https://example.com/tx" }));
    }
    return route.fulfill(json({ error: "not mocked" }, 404));
  });
  return { token, seen };
}

async function finishClaim(page: Page, seen: Awaited<ReturnType<typeof mockClaim>>["seen"]) {
  await page.getByRole("button", { name: /Yes, I do/ }).click();
  await page.getByPlaceholder(/bcrt1/).first().fill(fixture.recipient);
  await page.getByRole("button", { name: "Review and send" }).click();
  await page.getByRole("button", { name: "Send the Bitcoin" }).click();
  await expect.poll(() => seen.signedBody, { timeout: 90_000 }).not.toBeNull();

  expect(seen.signedBody!.destination).toBe(fixture.recipient);
  const tx = Transaction.fromRaw(hexToBytes(seen.signedBody!.tx_hex));
  expect(tx.outputsLength).toBe(1);
  expect(bytesToHex(tx.getOutput(0).script!)).toBe(bytesToHex(OutScript.encode(Address(REGTEST).decode(fixture.recipient))));
  // The heir branch: each input waits out the vault's timelock.
  expect(tx.getInput(0).sequence).toBe(fixture.timelock_blocks);
  expect(seen.oldClaimCalled).toBe(false);
  for (const b of seen.bodies) {
    expect(b).not.toContain("prv");
    expect(b).not.toContain("heir_xprv");
    expect(b).not.toContain("river");
  }
}

test("an heir's claim is signed in the browser: the server never sees the heir's key", async ({ page }) => {
  test.setTimeout(120_000);
  const { token, seen } = await mockClaim(page, "link");
  await page.goto(`${base}/#/claim/${token}`);
  await finishClaim(page, seen);
});

test("an heir code opens the key in the browser; a wrong code doesn't", async ({ page }) => {
  test.setTimeout(120_000);
  const { token, seen } = await mockClaim(page, "code");
  await page.goto(`${base}/#/claim/${token}`);

  await expect(page.getByRole("heading", { name: "Enter your heir code" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Yes, I do/ })).toHaveCount(0);
  await expectNoSerious(page);

  await page.getByLabel("Your heir code").fill("river garden mango seven bird");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByText("That code doesn't match. Check each word and try again.")).toBeVisible();

  // As a person would type it: spaces and capitals.
  await page.getByLabel("Your heir code").fill("River Garden Mango Seven Lamp");
  await page.getByRole("button", { name: "Unlock" }).click();
  await finishClaim(page, seen);
});

async function expectNoSerious(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
}

/** A practice link on an heir-code vault. Records what the page sends. */
async function mockPractice(page: Page) {
  const token = Buffer.from(new Uint8Array(32).fill(8)).toString("base64");
  const kek = await deriveHeirCodeKek(HEIR_CODE, CODE_KDF);
  const check = sealHeirCheck(kek);
  const seen = { completeBody: undefined as unknown, completed: false };
  const at = `/claim/${token}`;
  await page.route("**/api/**", (route) => {
    const req = route.request();
    const p = decodeURIComponent(new URL(req.url()).pathname.replace(/^\/api/, ""));
    if (p === "/health") return route.fulfill(json({ ok: true, version: "e2e", demo_mode: false, default_network: "regtest", email_enabled: true }));
    if (p === at)
      return route.fulfill(
        json({
          vault_id: "v-drill", label: "Savings", network: "regtest", status: "ok",
          timelock_blocks: fixture.timelock_blocks, next_deadline_at: PAST, heir_channel: "email",
          heir_display_name: "Ada", drill: true,
          heir_code: { ...CODE_KDF, check_ct_b64: check.ct, check_nonce_b64: check.nonce },
        }),
      );
    if (p === `${at}/drill-complete`) {
      seen.completed = true;
      seen.completeBody = req.postData() ? req.postDataJSON() : null;
      return route.fulfill(json({ completed_at: new Date().toISOString() }));
    }
    return route.fulfill(json({ error: "not mocked" }, 404));
  });
  return { token, seen };
}

test("the practice run tests the heir code without unlocking anything", async ({ page }) => {
  test.setTimeout(120_000);
  const { token, seen } = await mockPractice(page);
  await page.goto(`${base}/#/claim/${token}`);
  await page.getByRole("button", { name: "Show me how it works" }).click();
  const box = page.getByTestId("drill-code");
  await expect(box.getByText("Try your heir code")).toBeVisible();
  await expect(page.getByRole("button", { name: "Finish the practice" })).toBeDisabled();
  await expectNoSerious(page);

  await box.getByLabel("Your heir code").fill("river garden mango seven bird");
  await box.getByRole("button", { name: "Check my code" }).click();
  await expect(box.getByText("That code doesn't match. Check each word and try again.")).toBeVisible();

  await box.getByLabel("Your heir code").fill("RIVER garden, mango seven lamp");
  await box.getByRole("button", { name: "Check my code" }).click();
  await expect(box.getByText("Your code works. Keep it safe and private.")).toBeVisible();
  await page.getByRole("button", { name: "Finish the practice" }).click();
  await expect.poll(() => seen.completed).toBe(true);
  expect(seen.completeBody).toEqual({ heir_code: "ok" });
  expect(JSON.stringify(seen.completeBody)).not.toContain("river");
});

test("the practice run tells the owner when the heir has no code", async ({ page }) => {
  test.setTimeout(60_000);
  const { token, seen } = await mockPractice(page);
  await page.goto(`${base}/#/claim/${token}`);
  await page.getByRole("button", { name: "Show me how it works" }).click();
  await page.getByRole("button", { name: "I don't have the code" }).click();
  await expect(page.getByText("That's okay. When you finish, we'll tell the person who set this up to give it to you again.")).toBeVisible();
  await page.getByRole("button", { name: "Finish the practice" }).click();
  await expect.poll(() => seen.completed).toBe(true);
  expect(seen.completeBody).toEqual({ heir_code: "missing" });
});
