/**
 * Swap providers for Lightning deposits. Independent services running
 * Boltz software; none of them can hold the owner's money (see
 * reverseSwap.ts). Only Bitcoin mainnet has one today. Boltz itself has
 * been offline since 2026-08-03; add it back here when it returns.
 *
 * `VITE_LN_SWAP_API` points a build at a local Boltz regtest setup, for
 * testing the whole flow without real money.
 */
import type { SwapProvider } from "./reverseSwap";

const MAINNET: SwapProvider[] = [
  { name: "SatsRouting", api: "https://api.satsrouting.exchange", network: "bitcoin" },
];

export function providerFor(network: string): SwapProvider | null {
  const env = (import.meta as unknown as { env?: { VITE_LN_SWAP_API?: string } }).env;
  if (network === "regtest" && env?.VITE_LN_SWAP_API) {
    return { name: "Boltz (regtest)", api: env.VITE_LN_SWAP_API, network: "regtest" };
  }
  if (network === "bitcoin") return MAINNET[0];
  return null;
}
