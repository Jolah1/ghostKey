import { describe, expect, it } from "vitest";
import { deriveVaultAddress, UnsupportedDescriptor } from "./vaultAddress";
import fixtures from "./fixtures/vault-addresses.json";

type Case = {
  name: string;
  network: string;
  descriptor_external: string;
  descriptor_internal: string;
  external: string[];
  internal: string[];
};

describe("deriveVaultAddress matches the Rust that builds vaults", () => {
  // The fixture is written by crates/ghostkey-wasm/tests/address_fixtures.rs
  // from the same code that creates real vaults. Byte-for-byte agreement on
  // every vault shape, both chains and several indexes, on two networks.
  for (const c of fixtures as Case[]) {
    it(`${c.name} on ${c.network}`, () => {
      c.external.forEach((addr, i) => {
        expect(deriveVaultAddress(c.descriptor_external, c.network, i)).toBe(addr);
      });
      c.internal.forEach((addr, i) => {
        expect(deriveVaultAddress(c.descriptor_internal, c.network, i)).toBe(addr);
      });
    });
  }

  it("covers every vault shape GhostKey builds", () => {
    const names = new Set((fixtures as Case[]).map((c) => c.name));
    expect([...names].sort()).toEqual(
      ["guardian", "guardian-dated", "standard", "standard-1-block"].sort(),
    );
  });
});

describe("deriveVaultAddress refuses what it doesn't understand", () => {
  it("throws instead of guessing", () => {
    for (const bad of [
      "wpkh(xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKrhko4egpiMZbpiaQL2jkwSB1icqYh2cfDfVxdx4df189oLKnC5fSwqPfgyP3hooxujYzAu3fDVmz/0/*)",
      "tr(50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0,multi_a(1,a,b))",
      "tr(50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0)",
    ]) {
      expect(() => deriveVaultAddress(bad, "bitcoin", 0)).toThrow(UnsupportedDescriptor);
    }
  });
});
