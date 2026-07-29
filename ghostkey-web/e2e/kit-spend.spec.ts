/**
 * In-browser e2e for the recovery kit's local-signing spend panel.
 *
 * Closes the "Phase 4" gap that the unit/Node tests couldn't reach: this
 * loads the actual built kit HTML in headless Chrome and walks the whole
 * path a user would — unlock with the password, find coins, sign in
 * wasm, broadcast — proving the DOM wiring + the wasm signer-in-a-real-
 * browser + the Esplora request/response shapes all line up.
 *
 * Hermetic: a local HTTP server serves the spliced kit page and stands in
 * for Esplora (canned UTXO / tx / tip, and it captures the broadcast).
 * Same origin as the page, so no CORS. No bitcoind required — the funded
 * UTXO comes from the deterministic fixture the wasm crate already uses.
 */
import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { sealUnderPassword } from "../src/crypto/sealing";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoWeb = resolve(__dirname, "..");

// The deterministic owner sweep fixture shared with the wasm crate: a
// funded regtest vault, one confirmed UTXO at external[0], chain tip 105.
const fixture = JSON.parse(
  readFileSync(
    resolve(repoWeb, "../crates/ghostkey-wasm/tests/fixture_owner.json"),
    "utf8",
  ),
) as {
  account_xprv: string;
  descriptor_external: string;
  descriptor_internal: string;
  network: string;
  timelock_blocks: number;
  recipient: string;
  chain_tip_height: number;
  funding: { tx_hex: string; confirmation_height: number }[];
};

// external[0] for the fixture descriptors (pinned: also asserts that the
// kit derives the same address the funds were sent to).
const FUNDED_ADDR =
  "bcrt1plud4ky4v9fgn558ltu5avdjx4sg3exmzdutjd6j9g283cgtxq6yqkdrwxt";
const PASSWORD = "correct horse battery staple 7";

/** Bitcoin txid = reverse(sha256(sha256(rawtx))), hex. The fixture's
 *  funding tx is non-segwit, so the whole serialization hashes. */
function txid(hex: string): string {
  const bytes = Buffer.from(hex, "hex");
  const h = createHash("sha256")
    .update(createHash("sha256").update(bytes).digest())
    .digest();
  return Buffer.from(h.reverse()).toString("hex");
}

let server: Server;
let baseUrl: string;
let kitHtml: string;
const broadcasts: string[] = [];

test.beforeAll(async () => {
  // Seal the fixture's account xprv under a known password, exactly as
  // the app's kit does, and splice it into the built template.
  const sealed = await sealUnderPassword(
    PASSWORD,
    new TextEncoder().encode(fixture.account_xprv),
  );
  const kitData = {
    v: 1 as const,
    role: "owner" as const,
    generated_at: new Date().toISOString(),
    label: "e2e",
    vault_id: "e2e-vault",
    network: fixture.network,
    timelock_blocks: fixture.timelock_blocks,
    descriptor_external: fixture.descriptor_external,
    descriptor_internal: fixture.descriptor_internal,
    password_salt_b64: sealed.password_salt_b64,
    password_kdf_mem_kib: sealed.password_kdf_mem_kib,
    password_kdf_iters: sealed.password_kdf_iters,
    owner_xprv_ct_b64: sealed.blob.ct,
    owner_xprv_nonce_b64: sealed.blob.nonce,
  };

  const template = readFileSync(
    resolve(repoWeb, "public/independence-proof.html"),
    "utf8",
  );
  const placeholder = "__GHOSTKEY_KIT_DATA__";
  if (!template.includes(placeholder)) {
    throw new Error("kit template not built — run `npm run build:kit` first");
  }
  const json = JSON.stringify(kitData).replace(/</g, "\\u003c");
  kitHtml = template.split(placeholder).join(json);

  const fundingTxid = txid(fixture.funding[0].tx_hex);

  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname;

    // Mocked Esplora.
    const utxoMatch = p.match(/^\/api\/address\/([^/]+)\/utxo$/);
    if (req.method === "GET" && utxoMatch) {
      const addr = decodeURIComponent(utxoMatch[1]);
      const body =
        addr === FUNDED_ADDR
          ? [
              {
                txid: fundingTxid,
                vout: 0,
                value: 106630,
                status: { confirmed: true, block_height: 100 },
              },
            ]
          : [];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    const txMatch = p.match(/^\/api\/tx\/([0-9a-f]+)\/hex$/);
    if (req.method === "GET" && txMatch) {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(txMatch[1] === fundingTxid ? fixture.funding[0].tx_hex : "");
      return;
    }
    if (req.method === "GET" && p === "/api/blocks/tip/height") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(String(fixture.chain_tip_height));
      return;
    }
    if (req.method === "POST" && p === "/api/tx") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        broadcasts.push(body.trim());
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(txid(body.trim()));
      });
      return;
    }

    // The kit page itself.
    if (req.method === "GET" && (p === "/" || p === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(kitHtml);
      return;
    }

    // Sibling build assets, which is how the Argon2 worker chunk gets
    // served. Over http the KDF prefers a worker; when that chunk 404s
    // the worker dies and `deriveOwnerKek` rejects, which the page
    // reports as "That password didn't work" — so this test failed with
    // a wrong-password message and a perfectly correct password. Only
    // the file:// build derives inline, which is why the kit itself is
    // unaffected and why the breakage sat here unnoticed.
    if (req.method === "GET" && /^\/[\w.-]+\.js$/.test(p)) {
      try {
        const asset = readFileSync(resolve(repoWeb, "public", p.slice(1)));
        res.writeHead(200, { "content-type": "text/javascript" });
        res.end(asset);
      } catch {
        res.writeHead(404);
        res.end("no such asset");
      }
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (typeof addr === "object" && addr) baseUrl = `http://127.0.0.1:${addr.port}`;
});

test.afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

test("owner kit: unlock, find coins, sign in wasm, broadcast", async ({
  page,
}) => {
  page.on("pageerror", (e) => console.error("[page error]", e.message));

  await page.goto(`${baseUrl}/`);

  // Unlock with the password (Argon2id runs in-browser; allow time).
  await page.fill('input[type="password"]', PASSWORD);
  await page.getByRole("button", { name: "Unlock" }).click();

  // The spend panel appears only after a successful unlock + xprv splice.
  const explorer = page.locator("[data-explorer]");
  await expect(explorer).toBeVisible({ timeout: 30_000 });

  await explorer.fill(`${baseUrl}/api`);
  await page.locator("[data-to]").fill(fixture.recipient);

  // Find coins -> scans the mocked Esplora, reveals the sign button.
  await page.locator("[data-find]").click();
  await expect(page.locator("[data-sign]")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("[data-status]")).toContainText("Found");

  // Sign locally in wasm, then broadcast.
  await page.locator("[data-do-sign]").click();
  const broadcastBtn = page.locator("[data-broadcast]");
  await expect(broadcastBtn).toBeVisible({ timeout: 30_000 });
  await broadcastBtn.click();

  // The mocked Esplora captured exactly one broadcast.
  await expect(page.locator("[data-bcout]")).toContainText("Sent", {
    timeout: 15_000,
  });
  expect(broadcasts).toHaveLength(1);

  const tx = broadcasts[0];
  // A signed segwit transaction: version (4 bytes) then the 00 01
  // marker+flag, i.e. a witness is present — proof the wasm signer ran.
  expect(tx).toMatch(/^0[12]000000[0-9a-f]*$/);
  expect(tx.slice(8, 12)).toBe("0001");
  // It must be a different tx than the unsigned funding input.
  expect(tx).not.toBe(fixture.funding[0].tx_hex);
});
