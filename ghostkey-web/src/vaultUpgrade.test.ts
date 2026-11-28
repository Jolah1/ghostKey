import { describe, expect, it } from "vitest";
import fixtures from "./fixtures/vault-addresses.json";
import { isUpgradeOf, sameVault, upgradedPair } from "./vaultUpgrade";

type Case = { name: string; network: string; descriptor_external: string; descriptor_internal: string };
const pair = (c: Case) => ({ external: c.descriptor_external, internal: c.descriptor_internal });
const find = (name: string, network: string) =>
  (fixtures as Case[]).find((c) => c.name === name && c.network === network)!;

describe("upgrading a vault, checked in the browser", () => {
  for (const network of ["bitcoin", "signet"]) {
    // The fixture's "standard" (old format) and "liana" (new) are built in
    // Rust from the same keys and wait.
    const old = pair(find("standard", network));
    const next = pair(find("liana", network));

    it(`builds the same new-format vault Rust does, on ${network}`, () => {
      const mine = upgradedPair(old)!;
      expect(mine).not.toBeNull();
      expect(sameVault(mine, next, network)).toBe(true);
      expect(isUpgradeOf(old, next, network)).toBe(true);
    });

    it(`refuses anything that isn't that vault upgraded, on ${network}`, () => {
      // Different keys or wait.
      expect(isUpgradeOf(old, pair(find("liana-1-block", network)), network)).toBe(false);
      // Not in the old format to begin with.
      expect(upgradedPair(next)).toBeNull();
      expect(upgradedPair(pair(find("locked", network)))).toBeNull();
      // The old format itself is not an upgrade.
      expect(isUpgradeOf(old, old, network)).toBe(false);
    });
  }
});
