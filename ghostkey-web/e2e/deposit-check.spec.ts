/**
 * The dashboard checks a deposit address in the browser before showing it
 * (#378). The vault's descriptors and addresses come from the same Rust
 * golden file the unit tests use, so this is the real derivation running in
 * a real browser, end to end.
 *
 * Serves the built dist/ and intercepts /api/*. Prereq: `npm run build`.
 */
import { test, expect, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, normalize, resolve } from "node:path";
import fixtures from "../src/fixtures/vault-addresses.json" with { type: "json" };

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

type Case = { name: string; network: string; descriptor_external: string; descriptor_internal: string; external: string[] };
const mine = (fixtures as Case[]).find((c) => c.name === "standard" && c.network === "signet")!;
const someoneElses = (fixtures as Case[]).find((c) => c.name === "guardian" && c.network === "signet")!;
const VAULT_ID = "v-deposit";
const FUTURE = new Date(Date.now() + 21 * 86400_000).toISOString();

async function setup(page: Page, serverAddress: string) {
  const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/api/**", (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (p === "/health")
      return route.fulfill(json({ ok: true, version: "e2e", demo_mode: false, default_network: "signet", email_enabled: true, sms_enabled: false, whatsapp_enabled: false }));
    if (p === `/vaults/${VAULT_ID}`)
      return route.fulfill(
        json({
          id: VAULT_ID,
          label: "Savings",
          network: "signet",
          timelock_blocks: 4320,
          checkin_period_secs: 2_592_000,
          grace_period_secs: 604_800,
          status: "ok",
          created_at: FUTURE,
          last_checkin_at: null,
          next_deadline_at: FUTURE,
          claim_eligible_at: FUTURE,
          descriptor_external: mine.descriptor_external,
          descriptor_internal: mine.descriptor_internal,
        }),
      );
    if (p === `/vaults/${VAULT_ID}/address`)
      return route.fulfill(json({ vault_id: VAULT_ID, network: "signet", address: serverAddress }));
    if (p === `/vaults/${VAULT_ID}/events`) return route.fulfill(json([]));
    if (p === `/vaults/${VAULT_ID}/balance`)
      return route.fulfill(json({ vault_id: VAULT_ID, network: "signet", confirmed_sat: 0, unconfirmed_sat: 0, total_sat: 0 }));
    return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });
  await page.addInitScript((id) => {
    const meta = {
      id,
      label: "Savings",
      owner: { address: "owner@example.com" },
      heir: { name: "Ada", email: "ada@example.com", address: "" },
      createdAt: new Date().toISOString(),
      ownerToken: "e2e-owner-token",
      groupId: null,
    };
    window.localStorage.setItem("gk:vaults", JSON.stringify({ [id]: meta }));
    window.localStorage.setItem("gk:activeVaultId", id);
    window.localStorage.setItem("gk:lastActivityAt", String(Date.now()));
  }, VAULT_ID);
  await page.goto(`${base}/#/dashboard`);
  await page.getByRole("tab", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "Show vault address" }).click();
}

test("the vault's own address is checked in the browser and shown", async ({ page }) => {
  await setup(page, mine.external[0]);
  await expect(page.getByTestId("deposit-check")).toHaveText(/Checked on this device/);
  await expect(page.getByText(mine.external[0])).toBeVisible();
});

test("an address that isn't this vault's is refused, never shown", async ({ page }) => {
  await setup(page, someoneElses.external[0]);
  await expect(page.getByText("Don't send money to this vault right now.")).toBeVisible();
  await expect(page.getByText(someoneElses.external[0])).toHaveCount(0);
  await expect(page.getByRole("img", { name: /QR code/ })).toHaveCount(0);
});
