/**
 * Moving a vault from the old format to the new one (#389), as the
 * browser sees it.
 *
 * The new format uses the same owner key, heir key and wait; only the
 * script's shape changes. So this device never takes the server's word
 * for the new descriptors: it builds them itself from the descriptors it
 * pinned (#378), and accepts the server's only when they produce the same
 * addresses.
 *
 *   tr(NUMS, or_d(pk(OWNER), and_v(v:pk(HEIR), older(N))))   old
 *   tr(OWNER, and_v(v:pk(HEIR), older(N)))                   new
 */
import { deriveVaultAddress } from "./vaultAddress";
import { getVaultMeta, repinVaultDescriptors } from "./vaultStore";

const NUMS = "50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0";

export interface DescriptorPair {
  external: string;
  internal: string;
}

/** The old format's parts, or null if `d` isn't in it. */
function readOld(d: string): { owner: string; heir: string; wait: number } | null {
  const m = new RegExp(
    `^tr\\(${NUMS},or_d\\(pk\\(([^()]+)\\),and_v\\(v:pk\\(([^()]+)\\),older\\((\\d+)\\)\\)\\)\\)$`,
  ).exec(d.replace(/#[a-z0-9]+$/, ""));
  return m ? { owner: m[1], heir: m[2], wait: Number(m[3]) } : null;
}

/** The new-format pair for an old-format one, built here; null when the
 *  pair isn't in the old format. */
export function upgradedPair(old: DescriptorPair): DescriptorPair | null {
  const e = readOld(old.external);
  const i = readOld(old.internal);
  if (!e || !i || e.wait !== i.wait) return null;
  const build = (p: { owner: string; heir: string; wait: number }) =>
    `tr(${p.owner},and_v(v:pk(${p.heir}),older(${p.wait})))`;
  return { external: build(e), internal: build(i) };
}

/** Do two pairs describe the same coins? Compared by the addresses they
 *  give, not by text, which can differ in harmless ways (checksums, how
 *  a hardened step is written). */
export function sameVault(a: DescriptorPair, b: DescriptorPair, network: string): boolean {
  try {
    for (let i = 0; i < 3; i++) {
      if (deriveVaultAddress(a.external, network, i) !== deriveVaultAddress(b.external, network, i)) return false;
      if (deriveVaultAddress(a.internal, network, i) !== deriveVaultAddress(b.internal, network, i)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Is `next` the upgrade of `pinned`: the same keys and wait in the new
 *  format? */
export function isUpgradeOf(pinned: DescriptorPair, next: DescriptorPair, network: string): boolean {
  const mine = upgradedPair(pinned);
  return mine != null && sameVault(mine, next, network);
}

/**
 * The descriptors to trust for `vaultId` on this device, given what the
 * server says now: the pinned pair, unless the server's pair is that
 * vault upgraded to the new format, in which case the pin moves to it.
 * A server pair that is neither keeps the old pin, so whatever checks the
 * pin still refuses it.
 */
export function trustedDescriptors(
  vaultId: string,
  server: { descriptor_external?: string | null; descriptor_internal?: string | null },
  network: string,
): DescriptorPair | null {
  const s = { external: server.descriptor_external ?? "", internal: server.descriptor_internal ?? "" };
  const pinned = getVaultMeta(vaultId)?.pinnedDescriptors ?? null;
  if (!pinned) return s.external && s.internal ? s : null;
  if (s.external && s.internal && pinned.external !== s.external && isUpgradeOf(pinned, s, network)) {
    repinVaultDescriptors(vaultId, s);
    return s;
  }
  return pinned;
}
