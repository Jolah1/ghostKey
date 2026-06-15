// Smoke-test the bundled kit signer through the exact glue + base64 path
// the kit ships (not the raw wasm-pack pkg). Proves inlined instantiation
// and signing work in a JS runtime. Run: node scripts/verify-kit-signer.mjs
//
// Uses the same fixture as the Rust wasm test
// (crates/ghostkey-wasm/tests/fixture_owner.json).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

// atob exists in Node 18+, but be explicit for older runners.
if (typeof globalThis.atob !== "function") {
  globalThis.atob = (b64) => Buffer.from(b64, "base64").toString("binary");
}
// The kit ships the --target web glue, whose getrandom backend reads
// `self.crypto.getRandomValues` (present in every browser). Node has
// `globalThis.crypto` but not `self`; bridge it so this smoke test mirrors
// the browser environment the kit actually runs in.
globalThis.self ??= globalThis;

const glue = await import(join(here, "..", "src", "kit", "wasm", "ghostkey_wasm.js"));
const init = glue.default;
const { sign_sweep, derive_vault_addresses } = glue;
// wasmBase64.ts is TypeScript; extract the literal rather than import it.
const b64Ts = readFileSync(join(here, "..", "src", "kit", "wasm", "wasmBase64.ts"), "utf8");
const WASM_BASE64 = b64Ts.match(/"([A-Za-z0-9+/=]+)"/)[1];

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

await init({ module_or_path: base64ToBytes(WASM_BASE64) });

const fixture = JSON.parse(
  readFileSync(join(root, "crates", "ghostkey-wasm", "tests", "fixture_owner.json"), "utf8"),
);

const out = JSON.parse(sign_sweep(JSON.stringify(fixture)));
if (!out.tx_hex || !out.txid) {
  console.error("[verify-kit-signer] FAIL: no tx_hex/txid in", out);
  process.exit(1);
}
// The signed tx must carry a Taproot witness; a rough check is that it is
// noticeably longer than the unsigned skeleton.
if (out.tx_hex.length < 200) {
  console.error("[verify-kit-signer] FAIL: tx_hex too short, likely unsigned:", out.tx_hex);
  process.exit(1);
}
console.log(`[verify-kit-signer] sign OK — txid ${out.txid}, fee ${out.fee_sat} sat`);

// Address derivation: external[1] must match the fixture recipient (which
// was derived as external index 1 when the fixture was generated).
const addrs = JSON.parse(
  derive_vault_addresses(
    fixture.descriptor_external,
    fixture.descriptor_internal,
    fixture.network,
    5,
  ),
);
if (addrs.external.length !== 5 || addrs.internal.length !== 5) {
  console.error("[verify-kit-signer] FAIL: expected 5 addresses each, got", addrs);
  process.exit(1);
}
if (addrs.external[1] !== fixture.recipient) {
  console.error(
    `[verify-kit-signer] FAIL: external[1] ${addrs.external[1]} != fixture recipient ${fixture.recipient}`,
  );
  process.exit(1);
}
console.log(`[verify-kit-signer] derive OK — external[0]=${addrs.external[0]}`);
