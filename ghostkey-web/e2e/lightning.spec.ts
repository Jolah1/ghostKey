/**
 * Lightning deposits in a real browser: a fake swap provider runs the
 * provider's side with boltz-core (script, lockup, its half of the joint
 * signature), and our own server is mocked. The vault is a real mainnet
 * fixture, so the browser's address check passes for real.
 *
 * Covers: the swap is saved before its invoice shows; nothing is claimed
 * until OUR server says the lockup confirmed; the claim pays only the
 * vault, with a valid signature, and goes out through both the provider
 * and our server; a reload picks the swap back up; a provider whose
 * invoice isn't locked to our secret is refused with nothing shown.
 *
 * Serves the built dist/ and intercepts the API. Prereq: `npm run build`.
 */
import { test, expect } from "@playwright/test";
import { settleAnimations } from "./settle";
import AxeBuilder from "@axe-core/playwright";
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

import { Musig, TaprootUtils, reverseSwapTree, SwapTreeSerializer } from "boltz-core";
import { Address, OutScript, SigHash, Transaction, NETWORK } from "@scure/btc-signer";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils.js";
import { bech32 } from "@scure/base";
import fixtures from "../src/fixtures/vault-addresses.json" with { type: "json" };

const VAULT_ID = "v-ln";
const FUTURE = new Date(Date.now() + 21 * 86400_000).toISOString();
const fx = (fixtures as { name: string; network: string; descriptor_external: string; descriptor_internal: string; external: string[] }[]).find(
  (f) => f.network === "bitcoin" && f.name === "standard",
)!;
const VAULT_ADDRESS = fx.external[0];
const PROVIDER = "https://api.satsrouting.exchange";

function invoice(hashHex: string, amountSat: number, currency = "bc"): string {
  const words: number[] = [];
  const ts = 1_800_000_000;
  for (let i = 6; i >= 0; i--) words.push(Math.floor(ts / 32 ** i) % 32);
  const p = bech32.toWords(hexToBytes(hashHex));
  words.push(1, Math.floor(p.length / 32), p.length % 32, ...p);
  for (let i = 0; i < 104; i++) words.push(0);
  return bech32.encode(`ln${currency}${amountSat * 10}n`, words, false);
}

class Fake {
  boltzKey = secp256k1.utils.randomSecretKey();
  refundPub = secp256k1.getPublicKey(this.boltzKey, true);
  status = "swap.created";
  confirmed = false;
  created: Record<string, unknown>[] = [];
  revealed: string | null = null;
  providerBroadcasts: string[] = [];
  relayed: string[] = [];
  wrongHash = false;
  tree!: ReturnType<typeof reverseSwapTree>;
  claimPub!: Uint8Array;
  hashHex!: string;
  onchain = 0;
  lockupScript!: Uint8Array;
  musig() {
    return TaprootUtils.tweakMusig(Musig.create(this.boltzKey, [this.refundPub, this.claimPub]), this.tree.tree);
  }
}

async function mock(page: import("@playwright/test").Page, fake: Fake) {
  const json = (body: unknown, status = 200) => ({
    status,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify(body),
  });
  await page.route(`${PROVIDER}/**`, (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.method() === "OPTIONS")
      return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" } });
    if (p === "/v2/swap/reverse" && req.method() === "GET")
      return route.fulfill(
        json({ BTC: { BTC: { hash: "ph", limits: { minimal: 2000, maximal: 2_000_000 }, fees: { percentage: 0.6, minerFees: { lockup: 154, claim: 111 } } } } }),
      );
    if (p === "/v2/swap/reverse" && req.method() === "POST") {
      const b = req.postDataJSON();
      fake.created.push(b);
      fake.hashHex = b.preimageHash;
      fake.claimPub = hexToBytes(b.claimPublicKey);
      fake.tree = reverseSwapTree(false, hexToBytes(fake.hashHex), fake.claimPub, fake.refundPub, 950_000);
      const agg = fake.musig().aggPubkey;
      fake.lockupScript = OutScript.encode({ type: "tr", pubkey: agg });
      fake.onchain = b.invoiceAmount - Math.ceil((b.invoiceAmount * 0.6) / 100) - 154;
      return route.fulfill(
        json({
          id: "swap1",
          invoice: invoice(fake.wrongHash ? bytesToHex(randomBytes(32)) : fake.hashHex, b.invoiceAmount),
          swapTree: SwapTreeSerializer.serializeSwapTree(fake.tree),
          lockupAddress: Address(NETWORK).encode({ type: "tr", pubkey: agg }),
          refundPublicKey: bytesToHex(fake.refundPub),
          timeoutBlockHeight: 950_000,
          onchainAmount: fake.onchain,
        }, 201),
      );
    }
    if (p === "/v2/swap/swap1") return route.fulfill(json({ status: fake.status }));
    if (p === "/v2/swap/reverse/swap1/transaction") {
      if (fake.status === "swap.created") return route.fulfill(json({ error: "no lockup yet" }, 404));
      const tx = new Transaction();
      tx.addOutput({ script: fake.lockupScript, amount: BigInt(fake.onchain) });
      tx.addInput({ txid: new Uint8Array(32).fill(9), index: 0, finalScriptWitness: [new Uint8Array(64)] });
      return route.fulfill(json({ id: tx.id, hex: tx.hex, timeoutBlockHeight: 950_000 }));
    }
    if (p === "/v2/swap/reverse/swap1/claim") {
      const b = req.postDataJSON();
      fake.revealed = b.preimage;
      const tx = Transaction.fromRaw(hexToBytes(b.transaction));
      const sighash = tx.preimageWitnessV1(0, [fake.lockupScript], SigHash.DEFAULT, [BigInt(fake.onchain)]);
      const signed = fake
        .musig()
        .message(sighash)
        .generateNonce()
        .aggregateNonces([[fake.claimPub, hexToBytes(b.pubNonce)]])
        .initializeSession()
        .signPartial();
      return route.fulfill(json({ pubNonce: bytesToHex(signed.publicNonce), partialSignature: bytesToHex(signed.ourPartialSignature) }));
    }
    if (p === "/v2/chain/BTC/fee") return route.fulfill(json({ fee: 2 }));
    if (p === "/v2/chain/BTC/transaction") {
      fake.providerBroadcasts.push(req.postDataJSON().hex);
      return route.fulfill(json({ id: "x" }, 201));
    }
    return route.fulfill(json({ error: "unexpected" }, 404));
  });

  await page.route("**/api/**", (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname.replace(/^\/api/, "");
    if (p === "/health")
      return route.fulfill(json({ ok: true, version: "e2e", demo_mode: false, default_network: "bitcoin", email_enabled: true, sms_enabled: false, whatsapp_enabled: false }));
    if (p === `/vaults/${VAULT_ID}`)
      return route.fulfill(
        json({
          id: VAULT_ID,
          label: "Savings",
          network: "bitcoin",
          timelock_blocks: 4320,
          checkin_period_secs: 2_592_000,
          grace_period_secs: 604_800,
          status: "ok",
          created_at: FUTURE,
          last_checkin_at: null,
          next_deadline_at: FUTURE,
          claim_eligible_at: FUTURE,
          descriptor_external: fx.descriptor_external,
          descriptor_internal: fx.descriptor_internal,
        }),
      );
    if (p === `/vaults/${VAULT_ID}/address`) return route.fulfill(json({ vault_id: VAULT_ID, network: "bitcoin", address: VAULT_ADDRESS }));
    if (p === `/vaults/${VAULT_ID}/balance`)
      return route.fulfill(json({ vault_id: VAULT_ID, network: "bitcoin", confirmed_sat: 10_000, unconfirmed_sat: 0, total_sat: 10_000 }));
    if (p.startsWith(`/vaults/${VAULT_ID}/tx/`)) return route.fulfill(json({ confirmed: fake.confirmed }));
    if (p === `/vaults/${VAULT_ID}/lightning/broadcast`) {
      fake.relayed.push(req.postDataJSON().hex);
      return route.fulfill(json({ txid: "y" }));
    }
    if (p === `/vaults/${VAULT_ID}/events`) return route.fulfill(json([]));
    return route.fulfill(json({}, 404));
  });

  await page.addInitScript(
    ({ id, ext, int }) => {
      const meta = {
        id,
        label: "Savings",
        owner: { address: "owner@example.com" },
        heir: { name: "Ada", email: "ada@example.com", address: "" },
        createdAt: new Date().toISOString(),
        ownerToken: "e2e-owner-token",
        groupId: null,
        pinnedDescriptors: { external: ext, internal: int },
      };
      window.localStorage.setItem("gk:vaults", JSON.stringify({ [id]: meta }));
      window.localStorage.setItem("gk:activeVaultId", id);
      window.localStorage.setItem("gk:lastActivityAt", String(Date.now()));
    },
    { id: VAULT_ID, ext: fx.descriptor_external, int: fx.descriptor_internal },
  );
}

async function openLightning(page: import("@playwright/test").Page) {
  await page.goto(`${base}/#/dashboard`);
  await page.getByTestId("savings-hero").getByRole("button", { name: "Add money" }).click();
  await page.getByRole("tab", { name: "Lightning" }).click();
}

test("a Lightning deposit is claimed into the vault only after our server sees it confirmed", async ({ page }) => {
  test.setTimeout(90_000);
  const fake = new Fake();
  await mock(page, fake);
  await openLightning(page);

  await expect(page.getByTestId("ln-terms")).toHaveText("2,000 sats to 2,000,000 sats.");
  await page.getByLabel("How much? (sats)").fill("50,000");
  await expect(page.getByTestId("ln-fee")).toContainText(
    "Fee about 565 sats (1.1%). About 49,435 sats lands in your vault.",
  );
  // A small deposit says plainly that it costs more as a share.
  await page.getByLabel("How much? (sats)").fill("2,000");
  await expect(page.getByTestId("ln-fee")).toContainText("Fee about 277 sats (14%).");
  await expect(page.getByTestId("ln-fee")).toContainText("small Lightning deposits cost more as a share");
  await page.getByLabel("How much? (sats)").fill("50,000");
  await expectNoSerious(page);
  await page.getByRole("button", { name: "Get Lightning invoice" }).click();

  // The invoice shows, and the swap (with its secret) is already saved.
  await expect(page.getByTestId("ln-invoice")).toContainText("lnbc500000n1");
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("gk:lnSwaps") ?? "{}"));
  expect(saved.swap1.preimageHex).toHaveLength(64);
  expect(saved.swap1.address).toBe(VAULT_ADDRESS);
  expect(fake.created[0]).toMatchObject({ from: "BTC", to: "BTC", invoiceAmount: 50_000 });
  await expect(page.getByTestId("ln-status")).toHaveText("Waiting for your payment…");

  // Paid; the provider says its bitcoin confirmed, but our server doesn't
  // see it yet: nothing is claimed and the secret stays here.
  fake.status = "transaction.confirmed";
  await expect(page.getByTestId("ln-status")).toHaveText("Moving it into your vault…");
  await page.waitForTimeout(6_000);
  expect(fake.revealed).toBeNull();
  expect(fake.relayed).toHaveLength(0);

  fake.confirmed = true;
  await expect(page.getByTestId("ln-status")).toHaveText(/^Done\. [\d,]+ sats is on its way to your vault\.$/, {
    timeout: 20_000,
  });

  // Sent both ways; it pays only the vault, with a valid joint signature.
  expect(fake.relayed).toHaveLength(1);
  expect(fake.providerBroadcasts).toEqual(fake.relayed);
  const claim = Transaction.fromRaw(hexToBytes(fake.relayed[0]));
  expect(claim.outputsLength).toBe(1);
  expect(bytesToHex(claim.getOutput(0).script!)).toBe(bytesToHex(OutScript.encode(Address(NETWORK).decode(VAULT_ADDRESS))));
  const w = claim.getInput(0).finalScriptWitness!;
  const sighash = claim.preimageWitnessV1(0, [fake.lockupScript], SigHash.DEFAULT, [BigInt(fake.onchain)]);
  expect(schnorr.verify(w[0], sighash, fake.lockupScript.slice(2))).toBe(true);
  expect(bytesToHex(sha256(hexToBytes(fake.revealed!)))).toBe(fake.hashHex);
  // The screen states exactly what the claim pays.
  const got = Number(claim.getOutput(0).amount!);
  expect(got).toBeGreaterThan(fake.onchain - 1_000);
  await expect(page.getByTestId("ln-status")).toHaveText(`Done. ${got.toLocaleString("en-US")} sats is on its way to your vault.`);

  // The secret is gone from this device once the claim is out.
  const after = await page.evaluate(() => JSON.parse(localStorage.getItem("gk:lnSwaps") ?? "{}"));
  expect(after.swap1.state).toBe("claimed");
  expect(after.swap1.preimageHex).toBe("");
});

test("a reload picks an unpaid Lightning deposit back up", async ({ page }) => {
  const fake = new Fake();
  await mock(page, fake);
  await openLightning(page);
  await page.getByLabel("How much? (sats)").fill("10,000");
  await page.getByRole("button", { name: "Get Lightning invoice" }).click();
  const shown = await page.getByTestId("ln-invoice").textContent();
  // Add money is its own page, so a reload comes back to it.
  await page.reload();
  await expect(page).toHaveURL(/#\/add-money$/);
  await page.getByRole("tab", { name: "Lightning" }).click();
  await expect(page.getByTestId("ln-invoice")).toHaveText(shown!);
  expect(fake.created).toHaveLength(1);
});

test("an invoice not locked to our secret is refused, and nothing is shown or saved", async ({ page }) => {
  const fake = new Fake();
  fake.wrongHash = true;
  await mock(page, fake);
  await openLightning(page);
  await page.getByLabel("How much? (sats)").fill("10,000");
  await page.getByRole("button", { name: "Get Lightning invoice" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "The provider's invoice isn't locked to our secret. Nothing was paid. Try again, or add bitcoin directly.",
  );
  await expect(page.getByTestId("ln-invoice")).toHaveCount(0);
  const saved = await page.evaluate(() => localStorage.getItem("gk:lnSwaps"));
  expect(saved).toBeNull();
});

async function expectNoSerious(page: import("@playwright/test").Page) {
  await settleAnimations(page);
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
}
