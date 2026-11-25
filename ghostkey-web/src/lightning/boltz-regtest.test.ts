/**
 * Lightning deposits against the REAL Boltz server software, in Boltz's
 * local regtest setup (github.com/BoltzExchange/regtest): a real Bitcoin
 * node, real Lightning nodes, real boltz-backend. No real money.
 *
 * Skipped unless BOLTZ_REGTEST=1, because it needs that setup running:
 *   docker compose --profile default up -d boltz-backend-nginx scripts
 *   BOLTZ_REGTEST=1 npx vitest run src/lightning/boltz-regtest.test.ts
 *
 * The vault address is a fresh address from the regtest node's wallet,
 * and "our server" is played by that node (confirmations and relaying).
 */
import { execFileSync, spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  NotReadyError,
  claimReverseSwap,
  createReverseSwap,
  getReversePair,
  swapStatus,
  type Deps,
  type SwapProvider,
} from "./reverseSwap";

const RUN = process.env.BOLTZ_REGTEST === "1";
const PROVIDER: SwapProvider = { name: "Boltz regtest", api: "http://localhost:9001", network: "regtest" };

function sim(cmd: string): string {
  return execFileSync("docker", ["exec", "boltz-scripts", "bash", "-c", `source /etc/profile.d/utils.sh && ${cmd}`], {
    encoding: "utf8",
  }).trim();
}

const mine = () => sim("bitcoin-cli-sim-client -generate 1");

async function waitFor<T>(what: string, f: () => Promise<T | null>, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v != null) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

function deps(opts: { refuseCosign?: boolean } = {}): Deps & { relayed: string[] } {
  const relayed: string[] = [];
  return {
    relayed,
    call: async (method, url, body) => {
      if (opts.refuseCosign && url.endsWith("/claim")) throw new Error("refused for the test");
      const res = await fetch(url, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      const json = text ? JSON.parse(text) : null;
      if (!res.ok) throw new Error(`${res.status} ${text}`);
      return json;
    },
    isConfirmed: async (txid) => {
      try {
        const tx = JSON.parse(sim(`bitcoin-cli-sim-client getrawtransaction ${txid} true`));
        return (tx.confirmations ?? 0) > 0;
      } catch {
        return false;
      }
    },
    relay: async (hex) => {
      relayed.push(hex);
      sim(`bitcoin-cli-sim-client sendrawtransaction ${hex}`);
    },
  };
}

async function deposit(amountSat: number, d: ReturnType<typeof deps>) {
  const address = sim('bitcoin-cli-sim-client getnewaddress "" bech32m');
  const pair = await getReversePair(PROVIDER, d);
  const swap = await createReverseSwap({ provider: PROVIDER, pair, vaultId: "v", address, amountSat }, d);

  // Pay from the client Lightning node. A hold invoice: this only
  // finishes once our claim reveals the secret.
  const payer = spawn("docker", [
    "exec",
    "boltz-scripts",
    "bash",
    "-c",
    `source /etc/profile.d/utils.sh && lncli-sim 1 payinvoice --force ${swap.invoice}`,
  ]);
  let payOut = "";
  payer.stdout.on("data", (b) => (payOut += String(b)));
  const paid = new Promise<number>((r) => payer.on("close", (code) => r(code ?? -1)));

  await waitFor("the lockup", async () => {
    const s = await swapStatus(swap, d);
    return s === "transaction.mempool" || s === "transaction.confirmed" ? s : null;
  });
  return { swap, address, paid, payOut: () => payOut };
}

describe.skipIf(!RUN)("Lightning deposit against real boltz-backend (regtest)", () => {
  it(
    "waits for a confirmation, then claims with the joint signature; the Lightning payment completes",
    async () => {
      const d = deps();
      const { swap, address, paid } = await deposit(100_000, d);

      // Unconfirmed: refuse to claim, so the secret stays with us.
      await expect(claimReverseSwap(swap, d, () => {})).rejects.toBeInstanceOf(NotReadyError);
      expect(await swapStatus(swap, d)).not.toBe("invoice.settled");

      mine();
      let signed = "";
      const txid = await claimReverseSwap(swap, d, (hex) => (signed = hex));
      expect(d.relayed).toEqual([signed]);
      mine();

      // The node accepted it, and it pays the address.
      const tx = JSON.parse(sim(`bitcoin-cli-sim-client getrawtransaction ${txid} true`));
      expect(tx.confirmations).toBeGreaterThan(0);
      expect(tx.vout).toHaveLength(1);
      expect(tx.vout[0].scriptPubKey.address).toBe(address);
      // One 64-byte signature: the joint (key path) claim.
      expect(tx.vin[0].txinwitness).toHaveLength(1);
      const sats = Math.round(tx.vout[0].value * 1e8);
      expect(sats).toBeGreaterThan(swap.onchainAmountSat - 1_000);
      expect(sats).toBeLessThanOrEqual(swap.onchainAmountSat);

      // The Lightning payment completes once the secret is out.
      expect(await paid).toBe(0);
      await waitFor("invoice.settled", async () => ((await swapStatus(swap, d)) === "invoice.settled" ? true : null));
    },
    180_000,
  );

  it(
    "claims alone with the secret when the provider won't co-sign",
    async () => {
      const d = deps({ refuseCosign: true });
      const { swap, address, paid } = await deposit(50_000, d);
      mine();
      const txid = await claimReverseSwap(swap, d, () => {});
      mine();
      const tx = JSON.parse(sim(`bitcoin-cli-sim-client getrawtransaction ${txid} true`));
      expect(tx.confirmations).toBeGreaterThan(0);
      expect(tx.vout[0].scriptPubKey.address).toBe(address);
      // signature, secret, script, control block: the script path.
      expect(tx.vin[0].txinwitness).toHaveLength(4);
      expect(await paid).toBe(0);
    },
    180_000,
  );
});
