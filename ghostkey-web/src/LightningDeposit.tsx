/**
 * Add money with Lightning: the owner picks an amount, pays an invoice
 * from any Lightning wallet, and the bitcoin arrives in the vault.
 *
 * Fully non-custodial: an independent swap provider locks the bitcoin on
 * chain, and THIS browser claims it straight to the vault's own address
 * (checked on this device first). GhostKey's server never touches the
 * money, and the provider can't keep it: see lightning/reverseSwap.ts.
 */
import { useEffect, useId, useMemo, useState } from "react";
import qrcode from "qrcode-generator";
import { Button } from "./ui";
import { formatAmount, useUnit } from "./units";
import { parseAmount } from "./bip21";
import { checkDepositAddress } from "./depositCheck";
import { providerFor } from "./lightning/providers";
import {
  SwapCheckError,
  claimedAmountSat,
  createReverseSwap,
  expectedReceive,
  getReversePair,
  lightningFee,
  percentWords,
  swapStatus,
  type ReversePair,
  type SavedSwap,
} from "./lightning/reverseSwap";
import { liveDeps, useLightningEngine } from "./lightning/engine";
import { saveSwap, useSwaps } from "./lightning/store";

export function LightningDeposit({
  vaultId,
  address,
  network,
}: {
  vaultId: string;
  address: string;
  network: string;
}) {
  const provider = useMemo(() => providerFor(network), [network]);
  const unit = useUnit();
  const amountId = useId();
  const [checked, setChecked] = useState<"checking" | "verified" | "no">("checking");
  const [pair, setPair] = useState<ReversePair | null>(null);
  const [pairError, setPairError] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const swaps = useSwaps(vaultId);
  useLightningEngine(vaultId, 5_000);

  // Lightning only pays into an address this device has checked itself.
  useEffect(() => {
    let alive = true;
    void checkDepositAddress(vaultId, address, network).then((c) => {
      if (alive) setChecked(c.kind === "verified" ? "verified" : "no");
    });
    return () => {
      alive = false;
    };
  }, [vaultId, address, network]);

  useEffect(() => {
    if (!provider) return;
    let alive = true;
    getReversePair(provider, liveDeps(vaultId))
      .then((p) => alive && setPair(p))
      .catch(() => alive && setPairError("Lightning isn't available right now. Try again later, or add bitcoin directly."));
    return () => {
      alive = false;
    };
  }, [provider, vaultId]);

  // Show the newest unfinished swap if there is one (e.g. after a reload).
  const shown = swaps.find((s) => s.id === current) ?? swaps.find((s) => s.state === "waiting") ?? null;

  if (!provider) {
    return <p className="text-sm text-muted">Lightning isn&apos;t available for this vault&apos;s network.</p>;
  }
  if (shown) return <SwapProgress swap={shown} onNew={() => setCurrent("none")} />;
  if (checked === "checking") return <p className="text-sm text-muted">Checking your vault address…</p>;
  if (checked === "no") {
    return (
      <p className="text-sm text-muted">
        Lightning needs this device to check your vault address first, and it couldn&apos;t. Add bitcoin directly for
        now.
      </p>
    );
  }
  if (pairError) return <p className="text-sm text-alarm">{pairError}</p>;
  if (!pair) return <p className="text-sm text-muted">Loading Lightning…</p>;

  const parsed = parseAmount(amount, unit);
  const sats = typeof parsed === "number" ? parsed : null;
  const inRange = sats != null && sats >= pair.minimalSat && sats <= pair.maximalSat;

  async function start() {
    if (!inRange || sats == null || !provider || !pair) {
      setError(`Choose between ${formatAmount(pair!.minimalSat, unit)} and ${formatAmount(pair!.maximalSat, unit)}.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const swap = await createReverseSwap({ provider, pair, vaultId, address, amountSat: sats }, liveDeps(vaultId));
      // Saved before the invoice is shown; if it can't be saved, no invoice.
      saveSwap(swap);
      setCurrent(swap.id);
    } catch (e) {
      setError(
        e instanceof SwapCheckError
          ? `${e.message} Nothing was paid. Try again, or add bitcoin directly.`
          : "Couldn't start a Lightning deposit. Nothing was paid. Try again in a moment.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <label htmlFor={amountId} className="block text-sm font-medium">
          How much? ({unit === "btc" ? "BTC" : "sats"})
        </label>
        <input
          id={amountId}
          className="input mt-1 w-full"
          inputMode="decimal"
          autoComplete="off"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <p className="mt-1 text-xs text-dim" data-testid="ln-terms">
          {formatAmount(pair.minimalSat, unit)} to {formatAmount(pair.maximalSat, unit)}.
        </p>
        {inRange && sats != null ? (
          <p className="mt-1 text-sm" data-testid="ln-fee">
            Fee about {formatAmount(lightningFee(sats, pair).sat, unit)} ({percentWords(lightningFee(sats, pair).percent)}).
            {" "}About {formatAmount(expectedReceive(sats, pair), unit)} lands in your vault.
            {lightningFee(sats, pair).percent >= 4 ? (
              <span className="mt-1 block text-xs text-muted">
                Part of the fee is fixed, so small Lightning deposits cost more as a share. Adding bitcoin directly can be
                cheaper for small amounts.
              </span>
            ) : null}
          </p>
        ) : null}
      </div>
      <p className="text-xs text-muted">
        Swapped by {provider.name}, an independent service. GhostKey never holds your money, and neither can they: if
        anything fails, your Lightning wallet gets it back.
      </p>
      {error ? (
        <p className="text-sm text-alarm" role="alert">
          {error}
        </p>
      ) : null}
      <Button onClick={() => void start()} loading={busy} disabled={!inRange}>
        Get Lightning invoice
      </Button>
    </div>
  );
}

function statusLine(swap: SavedSwap, status: string | null, unit: "sats" | "btc"): string {
  if (swap.state === "claimed") {
    const got = claimedAmountSat(swap);
    return got != null
      ? `Done. ${formatAmount(got, unit)} is on its way to your vault.`
      : "Done. It's on its way to your vault.";
  }
  if (swap.state === "failed") {
    return "This didn't go through. If you paid, your Lightning wallet gets the money back by itself.";
  }
  if (status === "transaction.mempool") {
    return "Paid. Waiting for the bitcoin to confirm, usually about 10 minutes. Keep GhostKey open, or come back within a few hours to finish.";
  }
  if (status === "transaction.confirmed" || status === "invoice.settled" || swap.claimHex) {
    return "Moving it into your vault…";
  }
  return "Waiting for your payment…";
}

function SwapProgress({ swap, onNew }: { swap: SavedSwap; onNew: () => void }) {
  const unit = useUnit();
  const [status, setStatus] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (swap.state !== "waiting") return;
    let alive = true;
    const tick = () =>
      swapStatus(swap, liveDeps(swap.vaultId))
        .then((s) => alive && setStatus(s))
        .catch(() => {});
    void tick();
    const t = window.setInterval(tick, 5_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [swap]);

  const paid = status != null && status !== "swap.created";
  const qr = useMemo(() => {
    const q = qrcode(0, "L");
    // Upper case fits QR's compact alphanumeric mode (wallets accept it).
    q.addData(`LIGHTNING:${swap.invoice.toUpperCase()}`, "Alphanumeric");
    q.make();
    return q.createDataURL(4, 8);
  }, [swap.invoice]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(swap.invoice);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* still visible to select */
    }
  }

  return (
    <div className="space-y-3" data-testid="ln-swap">
      <p className="text-sm">
        <span className="font-medium">{formatAmount(swap.amountSat, unit)} by Lightning</span>
      </p>
      {swap.state === "waiting" && !paid ? (
        <>
          <div className="flex justify-center">
            <img src={qr} alt="QR code of the Lightning invoice" className="h-48 w-48 rounded-lg bg-white p-1" />
          </div>
          <div className="card flex items-center gap-3 px-4 py-3">
            <code className="flex-1 truncate font-mono text-xs" data-testid="ln-invoice">
              {swap.invoice}
            </code>
            <Button variant="quiet" onClick={() => void copy()}>
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <a
            href={`lightning:${swap.invoice}`}
            className="inline-block text-sm text-[var(--accent-text)] underline-offset-2 hover:underline"
          >
            Open in my Lightning wallet
          </a>
        </>
      ) : null}
      <p className="text-sm text-muted" role="status" data-testid="ln-status">
        {statusLine(swap, status, unit)}
      </p>
      {swap.state !== "waiting" ? (
        <button type="button" onClick={onNew} className="text-sm text-muted underline-offset-2 hover:underline">
          Add more by Lightning
        </button>
      ) : null}
    </div>
  );
}
