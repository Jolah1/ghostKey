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

test("an heir's claim is signed in the browser: the server never sees the heir's key", async ({ page }) => {
  test.setTimeout(120_000);
  // The fixture vault's heir: the same deterministic seed the Rust test
  // builds it from, at the BIP86 account the descriptor uses.
  const heirXprv = HDKey.fromMasterSeed(new Uint8Array(32).fill(0xb2), bip32Versions("regtest")).derive("m/86'/1'/0'")
    .privateExtendedKey;
  const rawToken = new Uint8Array(32).fill(7);
  const token = Buffer.from(rawToken).toString("base64");
  const sealed = sealWithKey(deriveClaimKek(rawToken), new TextEncoder().encode(heirXprv));
  const bodies: string[] = [];
  let signedBody: { tx_hex: string; destination: string } | null = null;
  let oldClaimCalled = false;
  const T = `/claim/${encodeURIComponent(token)}`;

  await page.route("**/api/**", (route) => {
    const req = route.request();
    const p = decodeURIComponent(new URL(req.url()).pathname.replace(/^\/api/, ""));
    const raw = req.postData();
    if (raw) bodies.push(raw);
    const at = decodeURIComponent(T);
    if (p === "/health") return route.fulfill(json({ ok: true, version: "e2e", demo_mode: false, default_network: "regtest", email_enabled: true }));
    if (p === at)
      return route.fulfill(
        json({
          vault_id: "v-claim", label: "Savings", network: "regtest", status: "timelock_started",
          timelock_blocks: fixture.timelock_blocks, next_deadline_at: PAST, heir_channel: "email",
          heir_display_name: "Ada",
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
        }),
      );
    if (p === `${at}/coins`)
      return route.fulfill(
        json({ network: "regtest", chain_tip_height: fixture.chain_tip_height, funding: fixture.funding, confirmed_sat: 100_000, unconfirmed_sat: 0, fee_rate_sat_per_vb: 2 }),
      );
    if (p === `${at}/heir-claim`) {
      oldClaimCalled = true;
      return route.fulfill(json({ error: "gone" }, 410));
    }
    if (p === `${at}/claim-signed`) {
      signedBody = req.postDataJSON();
      return route.fulfill(json({ txid: "cd".repeat(32), explorer_url: "https://example.com/tx" }));
    }
    return route.fulfill(json({ error: "not mocked" }, 404));
  });

  await page.goto(`${base}/#/claim/${token}`);
  await page.getByRole("button", { name: /Yes, I do/ }).click();
  await page.getByPlaceholder(/bcrt1/).first().fill(fixture.recipient);
  await page.getByRole("button", { name: "Review and send" }).click();
  await page.getByRole("button", { name: "Send the Bitcoin" }).click();
  await expect.poll(() => signedBody, { timeout: 90_000 }).not.toBeNull();

  expect(signedBody!.destination).toBe(fixture.recipient);
  const tx = Transaction.fromRaw(hexToBytes(signedBody!.tx_hex));
  expect(tx.outputsLength).toBe(1);
  expect(bytesToHex(tx.getOutput(0).script!)).toBe(bytesToHex(OutScript.encode(Address(REGTEST).decode(fixture.recipient))));
  // The heir branch: each input waits out the vault's timelock.
  expect(tx.getInput(0).sequence).toBe(fixture.timelock_blocks);
  expect(oldClaimCalled).toBe(false);
  for (const b of bodies) {
    expect(b).not.toContain("prv");
    expect(b).not.toContain("heir_xprv");
  }
});
