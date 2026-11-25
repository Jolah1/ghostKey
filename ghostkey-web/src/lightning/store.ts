/**
 * Lightning deposits in progress, kept on this device. A swap is saved
 * before its invoice is shown, so closing the tab or reloading can't lose
 * the secret needed to claim it. The secret and claim key are deleted once
 * the claim is out; only the record stays, for the owner's history.
 */
import { useSyncExternalStore } from "react";
import type { SavedSwap } from "./reverseSwap";

const KEY = "gk:lnSwaps";
const listeners = new Set<() => void>();
let cache: Record<string, SavedSwap> | null = null;

function read(): Record<string, SavedSwap> {
  if (cache) return cache;
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    cache = v && typeof v === "object" ? (v as Record<string, SavedSwap>) : {};
  } catch {
    cache = {};
  }
  return cache;
}

function write(all: Record<string, SavedSwap>): void {
  cache = { ...all };
  // If this throws (storage full or blocked), the caller must not show
  // the invoice: an unsaved swap could not be claimed after a reload.
  localStorage.setItem(KEY, JSON.stringify(cache));
  listeners.forEach((l) => l());
}

/** Save or update a swap. Throws if it can't be stored. */
export function saveSwap(swap: SavedSwap): void {
  const all = read();
  let next = swap;
  if (swap.state === "claimed") {
    // Nothing secret is needed once the claim is out.
    next = { ...swap, preimageHex: "", claimPrivateKeyHex: "" };
  }
  write({ ...all, [swap.id]: next });
}

export function swapsFor(vaultId: string): SavedSwap[] {
  return Object.values(read())
    .filter((s) => s.vaultId === vaultId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function useSwaps(vaultId: string): SavedSwap[] {
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    // Stable until the next write, as React requires.
    read,
    () => null,
  );
  return swapsFor(vaultId);
}

/** For tests. */
export function _resetSwapStore(): void {
  cache = null;
}
