import { describe, expect, it } from "vitest";
import { compareDepositAddress } from "./depositCheck";
import fixtures from "./fixtures/vault-addresses.json";

const std = (fixtures as { name: string; network: string; descriptor_external: string; external: string[] }[]).find(
  (c) => c.name === "standard" && c.network === "bitcoin",
)!;
const other = (fixtures as { name: string; network: string; external: string[] }[]).find(
  (c) => c.name === "standard-1-block" && c.network === "bitcoin",
)!;

describe("compareDepositAddress", () => {
  it("verifies the vault's own first address", () => {
    expect(compareDepositAddress(std.external[0], std.descriptor_external, "bitcoin")).toEqual({
      kind: "verified",
    });
  });

  it("refuses any other address, even a real one from a different vault", () => {
    // The attack: a compromised server swaps in an address it controls.
    expect(compareDepositAddress(other.external[0], std.descriptor_external, "bitcoin")).toEqual({
      kind: "mismatch",
    });
    // Index 1 belongs to this vault but isn't what the server hands out.
    expect(compareDepositAddress(std.external[1], std.descriptor_external, "bitcoin").kind).toBe(
      "mismatch",
    );
  });

  it("says unchecked, not verified, when it can't derive", () => {
    expect(compareDepositAddress(std.external[0], "wpkh(junk)", "bitcoin").kind).toBe("unchecked");
  });

  it("ignores case and stray whitespace in the server's address", () => {
    expect(
      compareDepositAddress(` ${std.external[0].toUpperCase()} `, std.descriptor_external, "bitcoin"),
    ).toEqual({ kind: "verified" });
  });
});
