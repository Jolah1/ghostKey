/**
 * Lightning deposits, without anyone but the owner ever holding the money.
 *
 * A Lightning deposit is a "reverse swap" with an independent swap
 * provider (Boltz software):
 *
 *  1. This browser makes a secret (the preimage) and a one-time claim key.
 *  2. The provider returns a Lightning invoice locked to the secret's hash,
 *     and promises to lock the same amount (minus its fee) on-chain in a
 *     script only the secret plus our claim key can spend.
 *  3. The owner pays the invoice from any Lightning wallet. The payment
 *     can't complete until the secret is revealed.
 *  4. Once the provider's bitcoin has a confirmation, this browser claims
 *     it straight to the vault's own address, revealing the secret, which
 *     completes the Lightning payment.
 *
 * GhostKey's server is never in the money's path. The provider can't take
 * it: before anything is paid we check the invoice really is locked to
 * OUR secret, the script is exactly the one we expect, the lockup address
 * comes from that script, and the fee is what the provider published.
 * We wait for a confirmation (checked by our server, not the provider's
 * word) before revealing the secret, because the operator is anonymous:
 * a provider that learned the secret from an unconfirmed lockup could
 * collect the payment and then cancel its bitcoin. If anything goes wrong
 * before the claim, the Lightning payment simply fails and the money goes
 * back to the wallet it came from.
 *
 * Everything that talks to the network goes through `Deps`, so the whole
 * flow (including the provider's half of the signature) runs in tests.
 */
import {
  Musig,
  OutputType,
  SwapTreeSerializer,
  TaprootUtils,
  compareTrees,
  constructClaimTransaction,
  detectSwap,
  reverseSwapTree,
  targetFee,
  type Types,
} from "boltz-core";
import { Address, OutScript, SigHash, Transaction, NETWORK, TEST_NETWORK } from "@scure/btc-signer";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils.js";
import { decodeInvoice } from "./bolt11";

type SwapTree = Types.SwapTree;

export type SwapNetwork = "bitcoin" | "regtest";

export interface SwapProvider {
  name: string;
  /** API base, without the trailing /v2. */
  api: string;
  network: SwapNetwork;
}

/** What the provider publishes for BTC (Lightning) to BTC (on-chain). */
export interface ReversePair {
  hash: string;
  minimalSat: number;
  maximalSat: number;
  /** Percent, e.g. 0.6. */
  percentage: number;
  lockupFeeSat: number;
  claimFeeSat: number;
}

/** One swap, as saved on this device before the invoice is shown, so a
 *  reload can still claim it. */
export interface SavedSwap {
  v: 1;
  id: string;
  provider: SwapProvider;
  vaultId: string;
  /** The vault's own address, verified in this browser. */
  address: string;
  amountSat: number;
  onchainAmountSat: number;
  invoice: string;
  preimageHex: string;
  claimPrivateKeyHex: string;
  refundPublicKeyHex: string;
  swapTree: ReturnType<typeof SwapTreeSerializer.serializeSwapTree>;
  timeoutBlockHeight: number;
  lockupAddress: string;
  createdAt: string;
  state: "waiting" | "claimed" | "failed";
  /** The signed claim, saved before it is broadcast so a reload can send
   *  it again: once the secret is out, the claim must get out too. */
  claimHex?: string;
  claimTxid?: string;
  failure?: string;
}

export interface Deps {
  /** JSON over HTTP to the provider. Throws on a non-2xx answer. */
  call: (method: "GET" | "POST", url: string, body?: unknown) => Promise<unknown>;
  /** Our own server's word on whether a transaction has a confirmation. */
  isConfirmed: (txid: string) => Promise<boolean>;
  /** Our own server also broadcasts the claim (it only relays
   *  transactions that pay the vault). */
  relay: (hex: string) => Promise<void>;
}

/** A provider answer that didn't pass our checks. Nothing was paid. */
export class SwapCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwapCheckError";
  }
}

const REGTEST = { ...TEST_NETWORK, bech32: "bcrt" };

function btcNetwork(n: SwapNetwork) {
  return n === "bitcoin" ? NETWORK : REGTEST;
}

function invoiceCurrency(n: SwapNetwork): string {
  return n === "bitcoin" ? "bc" : "bcrt";
}

/** The output script an address pays to. */
export function addressScript(address: string, network: SwapNetwork): Uint8Array {
  return OutScript.encode(Address(btcNetwork(network)).decode(address));
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** The provider's published terms for Lightning to on-chain bitcoin. */
export async function getReversePair(provider: SwapProvider, deps: Deps): Promise<ReversePair> {
  const all = (await deps.call("GET", `${provider.api}/v2/swap/reverse`)) as Record<
    string,
    Record<string, {
      hash: string;
      limits: { minimal: number; maximal: number };
      fees: { percentage: number; minerFees: { lockup: number; claim: number } };
    }>
  >;
  const p = all?.BTC?.BTC;
  if (!p) throw new SwapCheckError("This provider doesn't offer Lightning to bitcoin right now.");
  return {
    hash: p.hash,
    minimalSat: p.limits.minimal,
    maximalSat: p.limits.maximal,
    percentage: p.fees.percentage,
    lockupFeeSat: p.fees.minerFees.lockup,
    claimFeeSat: p.fees.minerFees.claim,
  };
}

/** What the provider should lock for an invoice of `amountSat`: the amount
 *  less its percentage (rounded up) and its lockup miner fee. */
export function expectedLockup(amountSat: number, pair: ReversePair): number {
  return amountSat - Math.ceil((amountSat * pair.percentage) / 100) - pair.lockupFeeSat;
}

/** About what lands in the vault: the lockup less our claim's miner fee. */
export function expectedReceive(amountSat: number, pair: ReversePair): number {
  return Math.max(0, expectedLockup(amountSat, pair) - pair.claimFeeSat);
}

interface ReverseResponse {
  id: string;
  invoice: string;
  swapTree: unknown;
  lockupAddress: string;
  refundPublicKey: string;
  timeoutBlockHeight: number;
  onchainAmount: number;
}

/** The claim key's MuSig, tweaked with the swap tree: its key is the
 *  lockup output's key. The provider's key goes first, as Boltz does. */
function tweakedMusig(claimPrivateKey: Uint8Array, refundPublicKey: Uint8Array, tree: SwapTree) {
  const claimPublicKey = secp256k1.getPublicKey(claimPrivateKey, true);
  return TaprootUtils.tweakMusig(Musig.create(claimPrivateKey, [refundPublicKey, claimPublicKey]), tree.tree);
}

/**
 * Check a provider's answer before its invoice is shown. Throws
 * `SwapCheckError` naming what was wrong. Exported for tests.
 */
export function verifyReverseSwap(
  resp: ReverseResponse,
  want: {
    preimageHash: Uint8Array;
    claimPrivateKey: Uint8Array;
    amountSat: number;
    network: SwapNetwork;
    pair: ReversePair;
  },
): SwapTree {
  // 1. The invoice is locked to OUR secret, for the amount asked, on our
  //    network. This is the check that stops a provider being paid
  //    without ever locking bitcoin.
  let inv;
  try {
    inv = decodeInvoice(resp.invoice);
  } catch {
    throw new SwapCheckError("The provider's invoice couldn't be read.");
  }
  if (inv.currency !== invoiceCurrency(want.network)) {
    throw new SwapCheckError("The provider's invoice is for a different network.");
  }
  if (inv.paymentHash !== bytesToHex(want.preimageHash)) {
    throw new SwapCheckError("The provider's invoice isn't locked to our secret.");
  }
  if (inv.amountMsat !== BigInt(want.amountSat) * 1000n) {
    throw new SwapCheckError("The provider's invoice is for a different amount.");
  }

  // 2. The script is exactly a reverse swap to our claim key.
  let refundPublicKey: Uint8Array;
  let tree: SwapTree;
  try {
    refundPublicKey = hexToBytes(resp.refundPublicKey);
    tree = SwapTreeSerializer.deserializeSwapTree(resp.swapTree as never) as SwapTree;
  } catch {
    throw new SwapCheckError("The provider's swap details couldn't be read.");
  }
  if (!Number.isInteger(resp.timeoutBlockHeight) || resp.timeoutBlockHeight <= 0) {
    throw new SwapCheckError("The provider's swap has no valid timeout.");
  }
  const claimPublicKey = secp256k1.getPublicKey(want.claimPrivateKey, true);
  const expected = reverseSwapTree(false, want.preimageHash, claimPublicKey, refundPublicKey, resp.timeoutBlockHeight);
  if (!compareTrees(expected, tree)) {
    throw new SwapCheckError("The provider's swap script isn't the one we expect.");
  }

  // 3. The lockup address comes from that script and both keys.
  const musig = tweakedMusig(want.claimPrivateKey, refundPublicKey, expected);
  const lockupScript = OutScript.encode({ type: "tr", pubkey: musig.aggPubkey });
  let theirs: Uint8Array;
  try {
    theirs = addressScript(resp.lockupAddress, want.network);
  } catch {
    throw new SwapCheckError("The provider's lockup address couldn't be read.");
  }
  if (!sameBytes(lockupScript, theirs)) {
    throw new SwapCheckError("The provider's lockup address doesn't match the swap.");
  }

  // 4. It locks what its published fees say, and never more than paid.
  const floor = expectedLockup(want.amountSat, want.pair);
  if (!Number.isInteger(resp.onchainAmount) || resp.onchainAmount < floor || resp.onchainAmount > want.amountSat) {
    throw new SwapCheckError("The provider wants to keep more than its published fee.");
  }
  return expected;
}

/**
 * Start a Lightning deposit of `amountSat` into the vault `address`.
 * Returns the swap to SAVE before showing its invoice.
 */
export async function createReverseSwap(
  args: {
    provider: SwapProvider;
    pair: ReversePair;
    vaultId: string;
    address: string;
    amountSat: number;
  },
  deps: Deps,
): Promise<SavedSwap> {
  const { provider, pair, amountSat } = args;
  if (!Number.isInteger(amountSat) || amountSat < pair.minimalSat || amountSat > pair.maximalSat) {
    throw new SwapCheckError(`Choose between ${pair.minimalSat} and ${pair.maximalSat} sats.`);
  }
  // The vault address must parse for this network before anything starts.
  addressScript(args.address, provider.network);

  const preimage = randomBytes(32);
  const preimageHash = sha256(preimage);
  const claimPrivateKey = secp256k1.utils.randomSecretKey();
  const resp = (await deps.call("POST", `${provider.api}/v2/swap/reverse`, {
    from: "BTC",
    to: "BTC",
    invoiceAmount: amountSat,
    preimageHash: bytesToHex(preimageHash),
    claimPublicKey: bytesToHex(secp256k1.getPublicKey(claimPrivateKey, true)),
    pairHash: pair.hash,
    description: "GhostKey savings",
  })) as ReverseResponse;
  const tree = verifyReverseSwap(resp, { preimageHash, claimPrivateKey, amountSat, network: provider.network, pair });
  return {
    v: 1,
    id: resp.id,
    provider,
    vaultId: args.vaultId,
    address: args.address,
    amountSat,
    onchainAmountSat: resp.onchainAmount,
    invoice: resp.invoice,
    preimageHex: bytesToHex(preimage),
    claimPrivateKeyHex: bytesToHex(claimPrivateKey),
    refundPublicKeyHex: resp.refundPublicKey,
    swapTree: SwapTreeSerializer.serializeSwapTree(tree),
    timeoutBlockHeight: resp.timeoutBlockHeight,
    lockupAddress: resp.lockupAddress,
    createdAt: new Date().toISOString(),
    state: "waiting",
  };
}

/** Exactly what the claim pays the vault, once it's signed. */
export function claimedAmountSat(swap: SavedSwap): number | null {
  if (!swap.claimHex) return null;
  try {
    const amount = Transaction.fromRaw(hexToBytes(swap.claimHex)).getOutput(0).amount;
    return amount === undefined ? null : Number(amount);
  } catch {
    return null;
  }
}

/** The provider's status word for a swap, e.g. "swap.created",
 *  "transaction.mempool", "transaction.confirmed", "invoice.expired". */
export async function swapStatus(swap: SavedSwap, deps: Deps): Promise<string> {
  const s = (await deps.call("GET", `${swap.provider.api}/v2/swap/${swap.id}`)) as { status?: string };
  return s?.status ?? "unknown";
}

/** Statuses after which this swap can never be claimed. */
export const DEAD_STATUSES = new Set([
  "invoice.expired",
  "swap.expired",
  "transaction.failed",
  "transaction.refunded",
  "invoice.failedToPay",
]);

/** Highest fee rate we'll pay to claim, so a bad estimate can't eat the
 *  deposit. */
const MAX_FEE_RATE = 200;

/** Thrown when the claim can't happen yet (no lockup, or not confirmed). */
export class NotReadyError extends Error {}

/**
 * Claim a swap's bitcoin into the vault. Throws `NotReadyError` while the
 * lockup is missing or unconfirmed (try again later), `SwapCheckError` if
 * the lockup is wrong. Returns the claim transaction's id once broadcast.
 */
export async function claimReverseSwap(
  swap: SavedSwap,
  deps: Deps,
  /** Save the signed claim before it is broadcast. */
  onSigned: (hex: string, txid: string) => void,
): Promise<string> {
  const net = swap.provider.network;
  const preimage = hexToBytes(swap.preimageHex);
  const claimPrivateKey = hexToBytes(swap.claimPrivateKeyHex);
  const refundPublicKey = hexToBytes(swap.refundPublicKeyHex);
  const tree = SwapTreeSerializer.deserializeSwapTree(swap.swapTree as never) as SwapTree;
  const musig = tweakedMusig(claimPrivateKey, refundPublicKey, tree);

  let lockup: { id?: string; hex?: string };
  try {
    lockup = (await deps.call("GET", `${swap.provider.api}/v2/swap/reverse/${swap.id}/transaction`)) as typeof lockup;
  } catch {
    throw new NotReadyError("The provider hasn't locked the bitcoin yet.");
  }
  if (!lockup?.hex) throw new NotReadyError("The provider hasn't locked the bitcoin yet.");
  const lockupTx = Transaction.fromRaw(hexToBytes(lockup.hex), { allowUnknownOutputs: true });
  const out = detectSwap(musig.aggPubkey, lockupTx);
  if (!out || out.amount === undefined || out.script === undefined) {
    throw new SwapCheckError("The provider's lockup doesn't pay into this swap.");
  }
  if (out.amount < BigInt(swap.onchainAmountSat)) {
    throw new SwapCheckError("The provider locked less than it promised.");
  }
  // Our server, not the provider, says whether it's confirmed.
  if (!(await deps.isConfirmed(lockupTx.id))) {
    throw new NotReadyError("Waiting for the provider's bitcoin to confirm.");
  }

  const fees = (await deps.call("GET", `${swap.provider.api}/v2/chain/BTC/fee`).catch(() => null)) as {
    fee?: number;
  } | null;
  const rate = Math.min(MAX_FEE_RATE, Math.max(1, Math.ceil(fees?.fee ?? 2)));
  const destination = addressScript(swap.address, net);
  const utxo = {
    type: OutputType.Taproot as const,
    transactionId: lockupTx.id,
    vout: out.vout,
    script: out.script,
    amount: out.amount,
    privateKey: claimPrivateKey,
    preimage,
    swapTree: tree,
    internalKey: musig.internalKey,
  };
  const build = (cooperative: boolean) =>
    targetFee(rate, (fee) => constructClaimTransaction([{ ...utxo, cooperative }], destination, fee));

  let claim: Transaction;
  try {
    // The normal claim: one signature made with the provider. Cheaper and
    // looks like any other payment on-chain.
    claim = build(true);
    const sighash = claim.preimageWitnessV1(0, [out.script], SigHash.DEFAULT, [out.amount]);
    const signing = musig.message(sighash).generateNonce();
    const theirs = (await deps.call("POST", `${swap.provider.api}/v2/swap/reverse/${swap.id}/claim`, {
      index: 0,
      transaction: claim.hex,
      preimage: swap.preimageHex,
      pubNonce: bytesToHex(signing.publicNonce),
    })) as { pubNonce: string; partialSignature: string };
    const session = signing
      .aggregateNonces([[refundPublicKey, hexToBytes(theirs.pubNonce)]])
      .initializeSession();
    const partial = hexToBytes(theirs.partialSignature);
    if (!session.verifyPartial(refundPublicKey, partial)) throw new Error("bad partial signature");
    const signature = session.addPartial(refundPublicKey, partial).signPartial().aggregatePartials();
    claim.updateInput(0, { finalScriptWitness: [signature] }, true);
  } catch {
    // The provider wouldn't sign: claim on our own with the secret. Bigger
    // on-chain, but needs nothing from anyone.
    claim = build(false);
  }
  const outputs = claim.outputsLength;
  const paid = claim.getOutput(0);
  if (outputs !== 1 || !paid.script || !sameBytes(paid.script, destination)) {
    throw new SwapCheckError("The claim doesn't pay the vault."); // can't happen; belt and braces
  }
  if (out.amount - (paid.amount ?? 0n) > out.amount / 2n) {
    throw new SwapCheckError("Network fees are too high to claim this right now.");
  }
  onSigned(claim.hex, claim.id);
  await broadcastClaim(swap.provider, claim.hex, deps);
  return claim.id;
}

/**
 * Send a signed claim through the provider AND our own server; done if
 * either takes it. Used again after a reload for a claim that was signed
 * but maybe never sent.
 */
export async function broadcastClaim(provider: SwapProvider, hex: string, deps: Deps): Promise<void> {
  const results = await Promise.allSettled([
    deps.call("POST", `${provider.api}/v2/chain/BTC/transaction`, { hex }),
    deps.relay(hex),
  ]);
  if (results.every((r) => r.status === "rejected")) {
    throw new Error("Couldn't send the claim yet. It will be tried again.");
  }
}
