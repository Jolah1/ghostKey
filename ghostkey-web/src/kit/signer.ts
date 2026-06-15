/**
 * Local Taproot signing for the recovery kit (issue #93).
 *
 * Wraps the ghostkey-wasm bindings: instantiates the wasm from inlined
 * base64 bytes (never a network fetch, so it works from file:// offline)
 * and exposes a small typed `signSweep`. The heavy lifting — selecting the
 * owner/heir branch, CSV, signing — is the audited Rust in ghostkey-core,
 * proven on regtest and in the wasm runtime.
 */
import init, { sign_sweep, derive_vault_addresses } from "./wasm/ghostkey_wasm.js";
import { WASM_BASE64 } from "./wasm/wasmBase64";
import type { Network } from "../crypto/keygen";

export interface FundingInput {
  /** Raw transaction hex (e.g. Esplora `GET /tx/:txid/hex`). */
  tx_hex: string;
  /** Block height the transaction confirmed at. */
  confirmation_height: number;
}

export interface SweepRequest {
  role: "owner" | "heir";
  descriptor_external: string;
  descriptor_internal: string;
  timelock_blocks: number;
  network: Network;
  /** BIP86 account key (`m/86'/coin'/0'`) the kit unlocked. */
  account_xprv: string;
  funding: FundingInput[];
  chain_tip_height: number;
  recipient: string;
  /** Sats to send, or null/omitted to drain the whole balance. */
  amount_sat?: number | null;
  fee_rate_sat_vb: number;
}

export interface SweepResult {
  /** Signed transaction hex — broadcast anywhere. */
  tx_hex: string;
  txid: string;
  fee_sat: number;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let ready: Promise<void> | null = null;

/** Instantiate the wasm once, from inlined bytes. Safe to call repeatedly. */
export function initSigner(): Promise<void> {
  if (!ready) {
    ready = init({ module_or_path: base64ToBytes(WASM_BASE64) }).then(() => undefined);
  }
  return ready;
}

/** Build and fully sign a sweep locally. Throws with a readable message. */
export async function signSweep(req: SweepRequest): Promise<SweepResult> {
  await initSigner();
  const out = sign_sweep(JSON.stringify(req));
  return JSON.parse(out) as SweepResult;
}

/** Derive the vault's first `count` receive + change addresses to scan. */
export async function deriveAddresses(
  descriptorExternal: string,
  descriptorInternal: string,
  network: Network,
  count: number,
): Promise<{ external: string[]; internal: string[] }> {
  await initSigner();
  const out = derive_vault_addresses(descriptorExternal, descriptorInternal, network, count);
  return JSON.parse(out) as { external: string[]; internal: string[] };
}
