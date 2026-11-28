/**
 * Use this vault in another wallet (#387): Liana's descriptor (with copy,
 * QR and file) and Bitcoin Core's commands for a new-format vault; a way
 * to move first for an old one; and nothing shown when the export isn't
 * the vault this device pinned. Prereq: `npm run build`.
 */
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createServer, type Server } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, normalize, resolve } from "node:path";
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
const FUTURE = new Date(Date.now() + 30 * 86400_000).toISOString();
const PAST = new Date(Date.now() - 30 * 86400_000).toISOString();


const LEGACY = { external: fixture.descriptor_external, internal: fixture.descriptor_internal };
const STANDARD = upgradedPair(LEGACY)!;
const multipath = (p: { external: string }) => p.external.replaceAll("/0/*", "/<0;1>/*") + "#abcdefgh";

async function mockVault(
  page: Page,
  pinned: { external: string; internal: string },
  exported: { format: string; external: string; internal: string; liana?: string },
) {
  await page.route("**/api/**", (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (p === "/health") return route.fulfill(json({ ok: true, version: "e2e", demo_mode: false, default_network: "regtest" }));
    if (p === "/vaults/v-x")
      return route.fulfill(
        json({
          id: "v-x", label: "Savings", network: "regtest", timelock_blocks: fixture.timelock_blocks,
          checkin_period_secs: 7_776_000, grace_period_secs: 604_800, status: "ok", created_at: PAST,
          last_checkin_at: PAST, next_deadline_at: FUTURE, claim_eligible_at: FUTURE,
          descriptor_external: pinned.external, descriptor_internal: pinned.internal,
        }),
      );
    if (p === "/vaults/v-x/export")
      return route.fulfill(
        json({
          format: exported.format, network: "regtest",
          descriptor_external: exported.external + "#aaaaaaaa", descriptor_internal: exported.internal + "#bbbbbbbb",
          liana_descriptor: exported.liana,
          core_import: JSON.stringify([{ desc: exported.external + "#aaaaaaaa", timestamp: 0, active: true, internal: false }]),
        }),
      );
    return route.fulfill(json({}, 404));
  });
  await page.addInitScript((pin) => {
    const meta = {
      id: "v-x", label: "Savings", owner: { address: "owner@example.com" },
      heir: { name: "", email: "", address: "" }, createdAt: new Date().toISOString(),
      ownerToken: "e2e-owner-token", groupId: null, pinnedDescriptors: pin,
    };
    window.localStorage.setItem("gk:vaults", JSON.stringify({ "v-x": meta }));
    window.localStorage.setItem("gk:activeVaultId", "v-x");
    window.localStorage.setItem("gk:lastActivityAt", String(Date.now()));
  }, pinned);
}

test("a new-format vault: Liana's descriptor with QR, and Core's commands", async ({ page }) => {
  await mockVault(page, STANDARD, { format: "standard", ...STANDARD, liana: multipath(STANDARD) });
  await page.goto(`${base}/#/recovery`);
  await page.getByTestId("export-link").click();
  await expect(page).toHaveURL(/#\/export$/);
  await expect(page.getByText("This lets another wallet see your savings, not spend them.")).toBeVisible();
  await expect(page.getByTestId("liana-descriptor")).toHaveText(multipath(STANDARD));
  await expect(page.getByRole("img", { name: "QR code of the wallet descriptor" })).toBeVisible();
  await expect(page.getByTestId("core-commands")).toContainText("importdescriptors '");
  await expect(page.getByRole("button", { name: "Download as a file" })).toBeVisible();
  await settleAnimations(page);
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
});

test("an old-format vault: Core works, Liana needs the move first", async ({ page }) => {
  await mockVault(page, LEGACY, { format: "legacy", ...LEGACY });
  await page.goto(`${base}/#/export`);
  await expect(page.getByText("Liana can't open this older vault format.")).toBeVisible();
  await expect(page.getByTestId("core-commands")).toBeVisible();
  await page.getByRole("button", { name: "Move to the new format" }).click();
  await expect(page).toHaveURL(/#\/upgrade$/);
});

test("an export that isn't this vault is not shown", async ({ page }) => {
  const other = {
    external: STANDARD.external.replace(/older\((\d+)\)/, (_, n) => `older(${Number(n) + 1})`),
    internal: STANDARD.internal.replace(/older\((\d+)\)/, (_, n) => `older(${Number(n) + 1})`),
  };
  await mockVault(page, STANDARD, { format: "standard", ...other, liana: multipath(other) });
  await page.goto(`${base}/#/export`);
  await expect(page.getByRole("alert")).toContainText("doesn't match your vault");
  await expect(page.getByTestId("liana-descriptor")).toHaveCount(0);
});
