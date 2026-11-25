/**
 * Moves Lightning deposits along while GhostKey is open: checks each
 * waiting swap with the provider, claims it into the vault once the
 * provider's bitcoin has confirmed, sends a saved claim again if it never
 * went out, and marks dead swaps as failed (the payer's Lightning wallet
 * gets the money back by itself).
 */
import { useEffect } from "react";
import { api } from "../api";
import {
  DEAD_STATUSES,
  NotReadyError,
  broadcastClaim,
  claimReverseSwap,
  swapStatus,
  type Deps,
  type SavedSwap,
} from "./reverseSwap";
import { saveSwap, swapsFor, useSwaps } from "./store";

/** Statuses after which the provider's bitcoin is (or was) locked. */
const LOCKED = new Set(["transaction.mempool", "transaction.confirmed", "invoice.settled"]);

export function liveDeps(vaultId: string): Deps {
  return {
    call: async (method, url, body) => {
      const ctrl = new AbortController();
      const timer = window.setTimeout(() => ctrl.abort(), 20_000);
      try {
        const res = await fetch(url, {
          method,
          headers: body === undefined ? undefined : { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: ctrl.signal,
        });
        const text = await res.text();
        const json = text ? (JSON.parse(text) as unknown) : null;
        if (!res.ok) {
          const msg = json && typeof json === "object" && "error" in json ? String((json as { error: unknown }).error) : res.statusText;
          throw new Error(msg || `HTTP ${res.status}`);
        }
        return json;
      } finally {
        window.clearTimeout(timer);
      }
    },
    isConfirmed: async (txid) => (await api.txConfirmed(vaultId, txid)).confirmed,
    relay: async (hex) => {
      await api.relayDeposit(vaultId, hex);
    },
  };
}

/** One step for one swap. Returns the swap as it now stands. */
export async function advance(swap: SavedSwap, deps: Deps): Promise<SavedSwap> {
  if (swap.state !== "waiting") return swap;
  // Signed already: the secret may be out, so the claim must get out.
  if (swap.claimHex) {
    await broadcastClaim(swap.provider, swap.claimHex, deps);
    return { ...swap, state: "claimed" };
  }
  const status = await swapStatus(swap, deps);
  if (DEAD_STATUSES.has(status)) return { ...swap, state: "failed", failure: status };
  if (!LOCKED.has(status)) return swap;
  const signed: { hex?: string; txid?: string } = {};
  try {
    await claimReverseSwap(swap, deps, (hex, txid) => {
      signed.hex = hex;
      signed.txid = txid;
      saveSwap({ ...swap, claimHex: hex, claimTxid: txid });
    });
    return { ...swap, claimHex: signed.hex, claimTxid: signed.txid, state: "claimed" };
  } catch (e) {
    if (e instanceof NotReadyError) return swap;
    // Signed but not sent: keep it, the next step sends it again.
    if (signed.hex) return { ...swap, claimHex: signed.hex, claimTxid: signed.txid };
    throw e;
  }
}

const busy = new Set<string>();

/** Step every waiting swap for this vault once. */
export async function advanceAll(vaultId: string): Promise<void> {
  const deps = liveDeps(vaultId);
  for (const swap of swapsFor(vaultId).filter((s) => s.state === "waiting")) {
    if (busy.has(swap.id)) continue;
    busy.add(swap.id);
    try {
      const next = await advance(swap, deps);
      if (next !== swap) saveSwap(next);
    } catch {
      // Network trouble or a provider hiccup: try again next time.
    } finally {
      busy.delete(swap.id);
    }
  }
}

/** Keep this vault's Lightning deposits moving while mounted. */
export function useLightningEngine(vaultId: string | null, everyMs = 10_000): void {
  // Re-runs when a swap is started or finishes, so a new one is picked up.
  const waiting = useSwaps(vaultId ?? "").filter((s) => s.state === "waiting").length;
  useEffect(() => {
    if (!vaultId || waiting === 0) return;
    void advanceAll(vaultId);
    const t = window.setInterval(() => void advanceAll(vaultId), everyMs);
    return () => window.clearInterval(t);
  }, [vaultId, everyMs, waiting]);
}
