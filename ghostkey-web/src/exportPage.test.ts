import { describe, expect, it } from "vitest";
import fixtures from "./fixtures/vault-addresses.json";
import { splitMultipath } from "./ExportPage";
import { sameVault } from "./vaultUpgrade";

type Case = { name: string; network: string; descriptor_external: string; descriptor_internal: string };

describe("the Liana descriptor is checked against the vault", () => {
  for (const c of (fixtures as Case[]).filter((x) => x.name === "liana")) {
    it(`splits back into the same vault, on ${c.network}`, () => {
      const multipath = c.descriptor_external.replaceAll("/0/*", "/<0;1>/*") + "#abcdefgh";
      const pair = { external: c.descriptor_external, internal: c.descriptor_internal };
      expect(sameVault(splitMultipath(multipath), pair, c.network)).toBe(true);
      // A different wait is a different vault.
      const other = multipath.replace(/older\((\d+)\)/, (_, n) => `older(${Number(n) + 1})`);
      expect(sameVault(splitMultipath(other), pair, c.network)).toBe(false);
    });
  }
});
