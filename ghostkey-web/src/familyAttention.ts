/**
 * Whether something on the Family page needs the owner (an heir who
 * can't be reached, an heir code to switch to or hand over). Home works
 * it out from the vault; the nav shows a dot on Family. Kept for this
 * page load only: Home sets it again on every visit.
 */
import { useSyncExternalStore } from "react";

let current = false;
const listeners = new Set<() => void>();

export function setFamilyAttention(v: boolean): void {
  if (v === current) return;
  current = v;
  listeners.forEach((l) => l());
}

export function useFamilyAttention(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => false,
  );
}
