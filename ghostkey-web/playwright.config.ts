import { defineConfig } from "@playwright/test";

// In-browser e2e for the recovery kit (#93 / blocks A–B). We drive the
// REAL built kit page in headless Chrome — the same single-file HTML the
// app downloads — so this exercises the DOM wiring, the wasm signer
// running in a real browser engine, and the find/sign/broadcast flow.
//
// We use the system Google Chrome (channel: "chrome") so CI/dev don't
// need Playwright's ~150MB browser download. Esplora is mocked by the
// test's own HTTP server, so no bitcoind/esplora is required.
//
// Prereq: the kit template must be built first —
//   npm run build:kit
// The `e2e` npm script chains it.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    channel: "chrome",
    headless: true,
  },
});
