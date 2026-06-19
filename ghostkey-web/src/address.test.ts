import { describe, it, expect } from "vitest";
import {
  addressMatchesNetwork,
  bech32PrefixFor,
  looksLikeBitcoinAddress,
} from "./address";

// Representative addresses per network. Not real funds — just the right
// human-readable prefixes and a plausible length so the shape check passes.
const MAINNET_BECH32 = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const TESTNET_BECH32 = "tb1qze398wypjxukmatykmd9wr59mqhc5d85p4wk0k";
const REGTEST_BECH32 = "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080";
const MAINNET_P2PKH = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2";
const TESTNET_P2PKH = "mzBc4XEFSdzCDcTxAgf6EZXgsZWpztRhef";

describe("looksLikeBitcoinAddress", () => {
  it("accepts bech32 and base58 across networks", () => {
    expect(looksLikeBitcoinAddress(MAINNET_BECH32)).toBe(true);
    expect(looksLikeBitcoinAddress(TESTNET_BECH32)).toBe(true);
    expect(looksLikeBitcoinAddress(REGTEST_BECH32)).toBe(true);
    expect(looksLikeBitcoinAddress(MAINNET_P2PKH)).toBe(true);
  });

  it("rejects junk, empties, and truncated strings", () => {
    expect(looksLikeBitcoinAddress("")).toBe(false);
    expect(looksLikeBitcoinAddress("   ")).toBe(false);
    expect(looksLikeBitcoinAddress("not an address")).toBe(false);
    expect(looksLikeBitcoinAddress("bc1")).toBe(false);
  });
});

describe("addressMatchesNetwork", () => {
  it("matches bech32 to its own network", () => {
    expect(addressMatchesNetwork(MAINNET_BECH32, "bitcoin")).toBe(true);
    expect(addressMatchesNetwork(TESTNET_BECH32, "signet")).toBe(true);
    expect(addressMatchesNetwork(TESTNET_BECH32, "testnet")).toBe(true);
    expect(addressMatchesNetwork(REGTEST_BECH32, "regtest")).toBe(true);
  });

  it("rejects the catastrophic cross-network paste", () => {
    // mainnet address into a signet vault
    expect(addressMatchesNetwork(MAINNET_BECH32, "signet")).toBe(false);
    // signet address into a mainnet vault
    expect(addressMatchesNetwork(TESTNET_BECH32, "bitcoin")).toBe(false);
    // regtest's "bcrt1" must not be read as mainnet "bc1"
    expect(addressMatchesNetwork(REGTEST_BECH32, "bitcoin")).toBe(false);
    // mainnet "bc1" must not be read as regtest
    expect(addressMatchesNetwork(MAINNET_BECH32, "regtest")).toBe(false);
  });

  it("handles base58 networks", () => {
    expect(addressMatchesNetwork(MAINNET_P2PKH, "bitcoin")).toBe(true);
    expect(addressMatchesNetwork(MAINNET_P2PKH, "signet")).toBe(false);
    expect(addressMatchesNetwork(TESTNET_P2PKH, "signet")).toBe(true);
    expect(addressMatchesNetwork(TESTNET_P2PKH, "bitcoin")).toBe(false);
  });

  it("is case-insensitive on the bech32 HRP", () => {
    expect(addressMatchesNetwork(MAINNET_BECH32.toUpperCase(), "bitcoin")).toBe(
      true,
    );
  });
});

describe("bech32PrefixFor", () => {
  it("returns the prefix the user sees", () => {
    expect(bech32PrefixFor("bitcoin")).toBe("bc1q");
    expect(bech32PrefixFor("regtest")).toBe("bcrt1q");
    expect(bech32PrefixFor("signet")).toBe("tb1q");
    expect(bech32PrefixFor("testnet")).toBe("tb1q");
  });
});
