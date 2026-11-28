/**
 * Check a deposit address before the owner pays into it (#378).
 *
 * The server's address is derived again in the browser, from the vault's
 * descriptors as this device pinned them the first time it saw the vault,
 * and the two must match. On a mismatch we refuse to show an address at
 * all: a wrong address doesn't steal from the vault, but the owner's
 * savings would never arrive in it.
 *
 * Trust on first use: the pin comes from our server too, the first time.
 * So this protects against the server being compromised AFTER that point,
 * which is the realistic case. Rebuilding the descriptor from keys only
 * the browser holds closes the rest, with the browser-signing work.
 */
import { trustedDescriptors } from "./vaultUpgrade";
import { api } from "./api";
import { getVaultMeta, getVaultOwnerToken, pinVaultDescriptors } from "./vaultStore";
import { deriveVaultAddress } from "./vaultAddress";

export type DepositCheck =
  /** Derived in the browser and identical to the server's address. */
  | { kind: "verified" }
  /** The server's address is not this vault's. Never show it. */
  | { kind: "mismatch" }
  /** We couldn't check (not signed in on this device, or a shape the
   *  browser doesn't know). Shown, but labelled as unchecked. */
  | { kind: "unchecked"; why: string };

/** Pure core: compare a server address with the pinned descriptor. */
export function compareDepositAddress(
  address: string,
  pinnedExternal: string,
  network: string,
): DepositCheck {
  let derived: string;
  try {
    derived = deriveVaultAddress(pinnedExternal, network, 0);
  } catch (e) {
    return { kind: "unchecked", why: e instanceof Error ? e.message : String(e) };
  }
  return derived === address.trim().toLowerCase() ? { kind: "verified" } : { kind: "mismatch" };
}

/** Pin on first use if needed, then compare. The server always hands out
 *  the vault's first receive address (index 0). */
export async function checkDepositAddress(
  vaultId: string,
  address: string,
  network: string,
): Promise<DepositCheck> {
  let pinned = getVaultMeta(vaultId)?.pinnedDescriptors;
  if (!pinned) {
    const token = getVaultOwnerToken(vaultId);
    if (!token) return { kind: "unchecked", why: "not signed in on this device" };
    try {
      const v = await api.getVault(vaultId, token);
      if (!v.descriptor_external || !v.descriptor_internal) {
        return { kind: "unchecked", why: "server did not return the vault's details" };
      }
      pinVaultDescriptors(vaultId, {
        external: v.descriptor_external,
        internal: v.descriptor_internal,
      });
      pinned = getVaultMeta(vaultId)?.pinnedDescriptors;
    } catch {
      return { kind: "unchecked", why: "couldn't load the vault's details" };
    }
    if (!pinned) return { kind: "unchecked", why: "this device has no record of the vault" };
  }
  const first = compareDepositAddress(address, pinned.external, network);
  if (first.kind !== "mismatch") return first;
  // The vault may have moved to the new format (#389): the same keys in
  // a new shape, so a new address. The pin moves only if this device can
  // see the server's new descriptors are exactly that.
  const token = getVaultOwnerToken(vaultId);
  if (!token) return first;
  try {
    const v = await api.getVault(vaultId, token);
    const trusted = trustedDescriptors(vaultId, v, network);
    if (trusted && trusted.external !== pinned.external) {
      return compareDepositAddress(address, trusted.external, network);
    }
  } catch {
    // Keep the refusal: a mismatch we can't explain stays a mismatch.
  }
  return first;
}
