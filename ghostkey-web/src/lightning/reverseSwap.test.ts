/**
 * A whole Lightning deposit against a fake provider that runs the real
 * provider side with boltz-core: it builds the swap script, locks the
 * bitcoin, and signs its half of the claim. No network.
 */
import { describe, expect, it } from "vitest";
import { Musig, TaprootUtils, reverseSwapTree, SwapTreeSerializer } from "boltz-core";
import { Address, OutScript, SigHash, Transaction, TEST_NETWORK } from "@scure/btc-signer";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils.js";
import { bech32 } from "@scure/base";
import {
  NotReadyError,
  SwapCheckError,
  broadcastClaim,
  claimReverseSwap,
  createReverseSwap,
  expectedLockup,
  type Deps,
  type ReversePair,
  type SavedSwap,
  type SwapProvider,
} from "./reverseSwap";

const REGTEST = { ...TEST_NETWORK, bech32: "bcrt" };
const PROVIDER: SwapProvider = { name: "Fake", api: "https://fake.example", network: "regtest" };
const PAIR: ReversePair = {
  hash: "pairhash",
  minimalSat: 2_000,
  maximalSat: 2_000_000,
  percentage: 0.6,
  lockupFeeSat: 154,
  claimFeeSat: 111,
};
const VAULT_ADDRESS = Address(REGTEST).encode({ type: "tr", pubkey: schnorr.getPublicKey(randomBytes(32)) });

/** A BOLT 11 invoice with the given hash and amount; the signature is
 *  junk, which our decoder doesn't check. */
function invoice(hashHex: string, amountSat: number, currency = "bcrt"): string {
  const words: number[] = [];
  const ts = 1_800_000_000;
  for (let i = 6; i >= 0; i--) words.push(Math.floor(ts / 32 ** i) % 32);
  const p = bech32.toWords(hexToBytes(hashHex)); // 52 words
  words.push(1, Math.floor(p.length / 32), p.length % 32, ...p);
  for (let i = 0; i < 104; i++) words.push(0);
  // amount in "n" (1 nBTC = 0.1 sat): sats * 10
  return bech32.encode(`ln${currency}${amountSat * 10}n`, words, false);
}

type Misbehave =
  | "wrong-hash"
  | "wrong-amount"
  | "wrong-network"
  | "wrong-claim-key"
  | "wrong-address"
  | "greedy"
  | "short-lockup"
  | "no-cosign";

class FakeProvider {
  boltzKey = secp256k1.utils.randomSecretKey();
  refundPub = secp256k1.getPublicKey(this.boltzKey, true);
  revealedPreimage: string | null = null;
  broadcasts: string[] = [];
  relayed: string[] = [];
  confirmed = false;
  failBroadcast = false;
  failRelay = false;
  tree!: ReturnType<typeof reverseSwapTree>;
  claimPub!: Uint8Array;
  hashHex!: string;
  onchain!: number;
  lockupScript!: Uint8Array;
  constructor(public bad: Misbehave | null = null) {}

  deps(): Deps {
    return {
      call: async (method, url, body) => this.handle(method, url.replace(PROVIDER.api, ""), body as never),
      isConfirmed: async () => this.confirmed,
      relay: async (hex) => {
        if (this.failRelay) throw new Error("relay down");
        this.relayed.push(hex);
      },
    };
  }

  private musig() {
    return TaprootUtils.tweakMusig(Musig.create(this.boltzKey, [this.refundPub, this.claimPub]), this.tree.tree);
  }

  handle(method: string, path: string, body: Record<string, string | number>): unknown {
    if (method === "POST" && path === "/v2/swap/reverse") {
      const amount = body.invoiceAmount as number;
      this.hashHex = body.preimageHash as string;
      const theirClaimKey = hexToBytes(body.claimPublicKey as string);
      this.claimPub = this.bad === "wrong-claim-key" ? secp256k1.getPublicKey(randomBytes(32), true) : theirClaimKey;
      this.tree = reverseSwapTree(false, hexToBytes(this.hashHex), this.claimPub, this.refundPub, 900);
      const agg = this.musig().aggPubkey;
      this.lockupScript = OutScript.encode({ type: "tr", pubkey: agg });
      const lockupAddress =
        this.bad === "wrong-address"
          ? Address(REGTEST).encode({ type: "tr", pubkey: schnorr.getPublicKey(randomBytes(32)) })
          : Address(REGTEST).encode({ type: "tr", pubkey: agg });
      this.onchain = expectedLockup(amount, PAIR) - (this.bad === "greedy" ? 500 : 0);
      return {
        id: "swap1",
        invoice: invoice(
          this.bad === "wrong-hash" ? bytesToHex(randomBytes(32)) : this.hashHex,
          this.bad === "wrong-amount" ? amount + 1 : amount,
          this.bad === "wrong-network" ? "bc" : "bcrt",
        ),
        swapTree: SwapTreeSerializer.serializeSwapTree(this.tree),
        lockupAddress,
        refundPublicKey: bytesToHex(this.refundPub),
        timeoutBlockHeight: 900,
        onchainAmount: this.onchain,
      };
    }
    if (method === "GET" && path === "/v2/swap/reverse/swap1/transaction") {
      // Outputs first: a finished input locks the outputs. The swap
      // output is not first, so the claim must find it.
      const tx = new Transaction({ allowUnknownOutputs: true });
      tx.addOutput({ script: new Uint8Array([0x6a]), amount: 0n });
      const locked = this.bad === "short-lockup" ? this.onchain - 1 : this.onchain;
      tx.addOutput({ script: this.lockupScript, amount: BigInt(locked) });
      tx.addInput({ txid: new Uint8Array(32).fill(7), index: 0, finalScriptWitness: [new Uint8Array(64)] });
      return { id: tx.id, hex: tx.hex, timeoutBlockHeight: 900 };
    }
    if (method === "POST" && path === "/v2/swap/reverse/swap1/claim") {
      this.revealedPreimage = body.preimage as string;
      if (bytesToHex(sha256(hexToBytes(this.revealedPreimage))) !== this.hashHex) throw new Error("bad preimage");
      if (this.bad === "no-cosign") throw new Error("not today");
      const tx = Transaction.fromRaw(hexToBytes(body.transaction as string), { allowUnknownOutputs: true });
      const sighash = tx.preimageWitnessV1(0, [this.lockupScript], SigHash.DEFAULT, [BigInt(this.onchain)]);
      const signed = this.musig()
        .message(sighash)
        .generateNonce()
        .aggregateNonces([[this.claimPub, hexToBytes(body.pubNonce as string)]])
        .initializeSession()
        .signPartial();
      return { pubNonce: bytesToHex(signed.publicNonce), partialSignature: bytesToHex(signed.ourPartialSignature) };
    }
    if (method === "GET" && path === "/v2/chain/BTC/fee") return { fee: 2 };
    if (method === "POST" && path === "/v2/chain/BTC/transaction") {
      if (this.failBroadcast) throw new Error("provider won't broadcast");
      this.broadcasts.push(body.hex as string);
      return { id: "x" };
    }
    throw new Error(`unexpected ${method} ${path}`);
  }
}

async function start(p: FakeProvider, amountSat = 50_000): Promise<SavedSwap> {
  return createReverseSwap({ provider: PROVIDER, pair: PAIR, vaultId: "v1", address: VAULT_ADDRESS, amountSat }, p.deps());
}

describe("Lightning deposit (reverse swap)", () => {
  it("claims into the vault with one joint signature, only after a confirmation", async () => {
    const p = new FakeProvider();
    const swap = await start(p);
    expect(swap.onchainAmountSat).toBe(50_000 - 300 - 154);

    // Not confirmed: wait, and never reveal the secret.
    await expect(claimReverseSwap(swap, p.deps(), () => {})).rejects.toBeInstanceOf(NotReadyError);
    expect(p.revealedPreimage).toBeNull();

    p.confirmed = true;
    let saved: string | null = null;
    const txid = await claimReverseSwap(swap, p.deps(), (hex) => {
      saved = hex;
      // Saved before anything is broadcast.
      expect(p.broadcasts).toHaveLength(0);
    });
    expect(saved).not.toBeNull();
    // Sent both ways.
    expect(p.broadcasts).toEqual([saved]);
    expect(p.relayed).toEqual([saved]);

    const claim = Transaction.fromRaw(hexToBytes(saved!));
    expect(claim.id).toBe(txid);
    expect(claim.outputsLength).toBe(1);
    const out = claim.getOutput(0);
    expect(bytesToHex(out.script!)).toBe(bytesToHex(OutScript.encode(Address(REGTEST).decode(VAULT_ADDRESS))));
    const fee = BigInt(swap.onchainAmountSat) - out.amount!;
    expect(fee > 0n && fee < 1_000n).toBe(true);

    // The witness is one valid Schnorr signature for the lockup output's key.
    const w = claim.getInput(0).finalScriptWitness!;
    expect(w).toHaveLength(1);
    const sighash = claim.preimageWitnessV1(0, [p.lockupScript], SigHash.DEFAULT, [BigInt(swap.onchainAmountSat)]);
    expect(schnorr.verify(w[0], sighash, p.lockupScript.slice(2))).toBe(true);
  });

  it("claims alone with the secret when the provider won't co-sign", async () => {
    const p = new FakeProvider("no-cosign");
    const swap = await start(p);
    p.confirmed = true;
    let saved = "";
    await claimReverseSwap(swap, p.deps(), (hex) => (saved = hex));
    const claim = Transaction.fromRaw(hexToBytes(saved));
    const w = claim.getInput(0).finalScriptWitness!;
    // signature, preimage, claim script, control block
    expect(w).toHaveLength(4);
    expect(bytesToHex(w[1])).toBe(swap.preimageHex);
    const sighash = claim.preimageWitnessV1(
      0,
      [p.lockupScript],
      SigHash.DEFAULT,
      [BigInt(swap.onchainAmountSat)],
      undefined,
      p.tree.claimLeaf.output,
      p.tree.claimLeaf.version,
    );
    const claimXOnly = secp256k1.getPublicKey(hexToBytes(swap.claimPrivateKeyHex), true).slice(1);
    expect(schnorr.verify(w[0], sighash, claimXOnly)).toBe(true);
    expect(bytesToHex(claim.getOutput(0).script!)).toBe(bytesToHex(OutScript.encode(Address(REGTEST).decode(VAULT_ADDRESS))));
  });

  it.each([
    ["wrong-hash", "isn't locked to our secret"],
    ["wrong-amount", "different amount"],
    ["wrong-network", "different network"],
    ["wrong-claim-key", "swap script"],
    ["wrong-address", "lockup address"],
    ["greedy", "more than its published fee"],
  ] as const)("refuses a provider answer with %s, before anything is paid", async (bad, why) => {
    const p = new FakeProvider(bad);
    const err = await start(p).catch((e) => e);
    expect(err).toBeInstanceOf(SwapCheckError);
    expect(String(err.message)).toContain(why);
  });

  it("won't claim a lockup smaller than promised, and keeps the secret", async () => {
    const p = new FakeProvider("short-lockup");
    const swap = await start(p);
    p.confirmed = true;
    await expect(claimReverseSwap(swap, p.deps(), () => {})).rejects.toBeInstanceOf(SwapCheckError);
    expect(p.revealedPreimage).toBeNull();
  });

  it("refuses amounts outside the provider's limits", async () => {
    const p = new FakeProvider();
    await expect(start(p, 1_999)).rejects.toBeInstanceOf(SwapCheckError);
    await expect(start(p, 2_000_001)).rejects.toBeInstanceOf(SwapCheckError);
  });

  it("broadcast succeeds if either the provider or our server takes it", async () => {
    const p = new FakeProvider();
    p.failBroadcast = true;
    await expect(broadcastClaim(PROVIDER, "00", p.deps())).resolves.toBeUndefined();
    expect(p.relayed).toEqual(["00"]);
    p.failRelay = true;
    await expect(broadcastClaim(PROVIDER, "00", p.deps())).rejects.toThrow();
  });
});
