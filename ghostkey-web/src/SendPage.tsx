/**
 * Send, as its own page with one step per screen: how much, to where,
 * check it, then the password. Each step is a browser history entry, so
 * the phone's back button steps back too.
 *
 * Signed in this browser (#442): the server sends the vault's history and
 * broadcasts the finished transaction, but never sees the key.
 */
import { SEND_FROM_KEY } from "./lockedGoals";
import { useEffect, useMemo, useState } from "react";

import type { Route } from "./App";
import { ApiError, api, type OwnerSendResponse, type SavingsView } from "./api";
import { addressMatchesNetwork, bech32PrefixFor, looksLikeBitcoinAddress } from "./address";
import { ConfirmSend } from "./ConfirmSend";
import { unsealOwner } from "./crypto/sealing";
import type { Network } from "./crypto/keygen";
import { usePrices } from "./fiat";
import { SpendFromGoal } from "./Goals";
import { PageShell } from "./PageShell";
import { amountInLabel, amountToSats, isFiat, pricePerBtc, type AmountIn } from "./sendAmount";
import { Button } from "./ui";
import { fiatAmount, formatAmount, useFiat, useUnit } from "./units";
import { unlockErrorMessage } from "./unlockErrors";
import { retryIfBusy } from "./coinProtection";
import { useActiveVault } from "./useActiveVault";
import { getVaultMeta } from "./vaultStore";
import { Address, NETWORK, OutScript, TEST_NETWORK, Transaction } from "@scure/btc-signer";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

type Step = "amount" | "address" | "password" | "review" | "done";

const TITLES: Record<Step, string> = {
  amount: "How much?",
  address: "Send to",
  review: "Check it",
  password: "Your password",
  done: "Sent ✓",
};

/** Sats the signed transaction pays to `address`. */
function paidTo(txHex: string, address: string, network: string): number {
  const net =
    network === "bitcoin"
      ? NETWORK
      : network === "regtest"
        ? { ...TEST_NETWORK, bech32: "bcrt" }
        : TEST_NETWORK;
  const want = bytesToHex(OutScript.encode(Address(net).decode(address)));
  const tx = Transaction.fromRaw(hexToBytes(txHex));
  let sats = 0n;
  for (let i = 0; i < tx.outputsLength; i++) {
    const o = tx.getOutput(i);
    if (o.script && bytesToHex(o.script) === want) sats += o.amount ?? 0n;
  }
  return Number(sats);
}


interface Coins {
  confirmed_sat: number;
  unconfirmed_sat: number;
}

/** The amount box's text for `sats` in another unit, so switching units
 *  keeps the same amount instead of clearing it. */
function amountText(sats: number, to: AmountIn, rate: number | null): string {
  if (to === "sats") return String(sats);
  if (to === "btc") return (sats / 1e8).toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
  return rate ? ((sats / 1e8) * rate).toFixed(2) : "";
}

export function SendPage({ onNavigate }: { onNavigate: (r: Route) => void }) {
  // Sending from a locked goal: the plan page names it for this visit.
  const [fromId] = useState(() => sessionStorage.getItem(SEND_FROM_KEY));
  useEffect(() => () => sessionStorage.removeItem(SEND_FROM_KEY), []);
  const { activeId, ownerToken, vault, loading } = useActiveVault(fromId);
  const [openedAt] = useState(() => Date.now());
  const unit = useUnit();
  const fiat = useFiat();
  const prices = usePrices();

  const [step, setStep] = useState<Step>("amount");
  const [amountIn, setAmountIn] = useState<AmountIn>(unit);
  const [amountStr, setAmountStr] = useState("");
  const [sendAll, setSendAll] = useState(false);
  const [destination, setDestination] = useState("");
  const [password, setPassword] = useState("");
  const [phase, setPhase] = useState<"idle" | "unlocking" | "signing" | "sending">("idle");
  // Signed but not sent: what the check screen shows.
  const [signed, setSigned] = useState<{
    txHex: string;
    sentSat: number;
    feeSat: number;
    leftSat: number;
  } | null>(null);
  const [unlockPct, setUnlockPct] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<OwnerSendResponse | null>(null);
  const [coins, setCoins] = useState<Coins | null>(null);
  const [savings, setSavings] = useState<SavingsView | null>(null);

  // What's spendable, and the goals (for "take it from which goal?").
  useEffect(() => {
    if (!activeId || !ownerToken) return;
    let live = true;
    retryIfBusy(() => api.getSpendCoins(activeId, ownerToken))
      .then((c) => live && setCoins(c))
      .catch(() => {});
    api
      .getSavings(activeId, ownerToken)
      .then((s) => live && setSavings(s))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [activeId, ownerToken]);

  // The phone's back button walks back through the steps. After a send
  // there's nothing to go back to, so it leaves for home.
  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const s = (e.state as { gkSend?: Step } | null)?.gkSend;
      if (result) {
        onNavigate("dashboard");
        return;
      }
      setError(null);
      setStep(s && s !== "done" ? s : "amount");
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [result, onNavigate]);

  const go = (next: Step) => {
    setError(null);
    window.history.pushState({ gkSend: next }, "", window.location.href);
    setStep(next);
    window.scrollTo(0, 0);
  };
  const back = () => {
    if (step === "amount" || step === "done") onNavigate("dashboard");
    else window.history.back();
  };

  const network = vault?.network ?? "bitcoin";
  const parsed = amountToSats(amountStr, amountIn, prices);
  const amountSat = sendAll ? null : typeof parsed === "number" ? parsed : null;
  const available = coins?.confirmed_sat ?? null;
  const amountProblem = useMemo(() => {
    if (sendAll || amountStr.trim() === "") return null;
    if (parsed === "invalid") {
      return isFiat(amountIn) && pricePerBtc(amountIn, prices) == null
        ? "The price isn't in yet. Try sats for now."
        : "That doesn't look like an amount.";
    }
    if (typeof parsed === "number" && available != null && parsed >= available) {
      return "That's more than you can send. Tap Send all to send everything.";
    }
    return null;
  }, [sendAll, amountStr, parsed, amountIn, prices, available]);

  const addrShapeOk = looksLikeBitcoinAddress(destination);
  const addrNetworkOk = addressMatchesNetwork(destination, network);

  const amountLabel = (sats: number) => {
    const f = fiatAmount(sats, prices, fiat);
    return `${formatAmount(sats, unit)}${f ? ` (≈ ${f})` : ""}`;
  };

  function switchUnit(to: AmountIn) {
    if (typeof parsed === "number") {
      const rate = isFiat(to) ? pricePerBtc(to, prices) : null;
      setAmountStr(amountText(parsed, to, rate));
    }
    setAmountIn(to);
  }

  // Step 1 of the send, at the password: unlock, sign, and work out the
  // exact amounts. Nothing is broadcast yet, so the check screen can show
  // the real fee and what stays saved before anything moves.
  async function onSign() {
    if (!activeId || !ownerToken || !vault) return;
    setError(null);
    setPhase("unlocking");
    setUnlockPct(0);
    let ownerXprv: string;
    try {
      const blobs = await api.getSealedBlobs(activeId, ownerToken);
      const unsealed = await unsealOwner({
        password,
        passwordSalt: blobs.password_salt_b64,
        memKiB: blobs.password_kdf_mem_kib,
        iters: blobs.password_kdf_iters,
        ownerXprvBlob: { v: 1, ct: blobs.owner_xprv_ct_b64, nonce: blobs.owner_xprv_nonce_b64 },
        ownerTokenBlob: { v: 1, ct: blobs.owner_token_ct_b64, nonce: blobs.owner_token_nonce_b64 },
        onProgress: (pct) => setUnlockPct(Math.round(pct * 100)),
      });
      ownerXprv = unsealed.ownerXprv;
    } catch (e) {
      setPhase("idle");
      setError(unlockErrorMessage(e));
      return;
    }

    setPhase("signing");
    try {
      // The signer (ghostkey-core in wasm) is large, so it loads only now.
      const [fresh, signer] = await Promise.all([
        retryIfBusy(() => api.getSpendCoins(activeId, ownerToken)),
        import("./kit/signer"),
      ]);
      if (fresh.confirmed_sat === 0) {
        throw new Error(
          fresh.unconfirmed_sat > 0
            ? "Your bitcoin is still confirming. Try again in about 10 minutes."
            : "There's nothing to send yet.",
        );
      }
      // The descriptors this device pinned the first time it saw the
      // vault, so a tampered server can't redirect the change.
      const pinned = getVaultMeta(activeId)?.pinnedDescriptors;
      const descriptorExternal = pinned?.external ?? vault.descriptor_external;
      const descriptorInternal = pinned?.internal ?? vault.descriptor_internal;
      if (!descriptorExternal || !descriptorInternal) {
        throw new Error("Couldn't load your vault's details. Try again.");
      }
      const tx = await signer.signSweep({
        role: "owner",
        descriptor_external: descriptorExternal,
        descriptor_internal: descriptorInternal,
        timelock_blocks: vault.timelock_blocks,
        network: network as Network,
        account_xprv: ownerXprv,
        funding: fresh.funding,
        chain_tip_height: fresh.chain_tip_height,
        recipient: destination.trim(),
        amount_sat: amountSat,
        fee_rate_sat_vb: fresh.fee_rate_sat_per_vb,
      });
      const sent = paidTo(tx.tx_hex, destination.trim(), network);
      setSigned({
        txHex: tx.tx_hex,
        sentSat: sent,
        feeSat: tx.fee_sat,
        leftSat: Math.max(0, fresh.confirmed_sat + fresh.unconfirmed_sat - sent - tx.fee_sat),
      });
      setPassword("");
      go("review");
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : String(e));
    } finally {
      setPhase("idle");
    }
  }

  // Step 2, at the check screen: broadcast what was signed.
  async function onSend() {
    if (!activeId || !ownerToken || !signed) return;
    setError(null);
    setPhase("sending");
    try {
      const res = await retryIfBusy(() =>
        api.ownerSendSigned(activeId, ownerToken, {
          tx_hex: signed.txHex,
          destination: destination.trim(),
        }),
      );
      setResult(res);
      // Replace the check step, so back doesn't land on it.
      window.history.replaceState({ gkSend: "done" }, "", window.location.href);
      setStep("done");
      window.scrollTo(0, 0);
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : String(e));
    } finally {
      setPhase("idle");
    }
  }

  if (loading) {
    return (
      <PageShell title="Send" onNavigate={onNavigate}>
        <p className="text-sm text-muted">Loading…</p>
      </PageShell>
    );
  }
  if (!activeId || !ownerToken || !vault) {
    return (
      <PageShell title="Send" onNavigate={onNavigate}>
        <p className="text-sm text-muted">Sign in to send.</p>
      </PageShell>
    );
  }

  if (vault.locked_until && vault.locked_until * 1000 > openedAt) {
    return (
      <PageShell title="Send" onNavigate={onNavigate}>
        <p className="text-sm text-muted">
          This goal is locked until{" "}
          {new Date(vault.locked_until * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}
          . Nobody can send from it before then.
        </p>
      </PageShell>
    );
  }

  const busy = phase !== "idle";
  const stepBack = step === "done" ? "Close" : step === "amount" ? undefined : "Back";

  return (
    <PageShell
      title={TITLES[step]}
      onNavigate={onNavigate}
      onBack={back}
      backLabel={stepBack ?? "Back to home"}
    >
      {step === "amount" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (amountSat != null && !amountProblem) go("address");
          }}
        >
          <div className="flex gap-2" role="group" aria-label="Type the amount in">
            {[unit, fiat].map((a) => (
              <button
                key={a}
                type="button"
                onClick={() => switchUnit(a)}
                aria-pressed={amountIn === a}
                disabled={isFiat(a) && pricePerBtc(a, prices) == null}
                className={`rounded-full px-3 py-1 text-sm ${
                  amountIn === a
                    ? "bg-[var(--surface-2)] font-medium text-[var(--text)]"
                    : "text-muted"
                } disabled:opacity-40`}
              >
                {amountInLabel(a)}
              </button>
            ))}
          </div>
          <label className="mt-4 flex items-baseline gap-2">
            <span className="sr-only">Amount in {amountInLabel(amountIn)}</span>
            {isFiat(amountIn) ? (
              <span aria-hidden="true" className="text-4xl font-semibold text-muted">
                {amountInLabel(amountIn)}
              </span>
            ) : null}
            <input
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={amountStr}
              onChange={(e) => {
                setSendAll(false);
                setAmountStr(e.target.value);
              }}
              placeholder="0"
              className="w-full min-w-0 bg-transparent text-5xl font-semibold tracking-tight outline-none placeholder:text-[var(--text-dim)]"
            />
            {!isFiat(amountIn) ? (
              <span aria-hidden="true" className="text-xl text-muted">
                {amountInLabel(amountIn)}
              </span>
            ) : null}
          </label>
          <p className="mt-2 min-h-5 text-sm text-muted" aria-live="polite">
            {amountProblem ? (
              <span className="text-alarm">{amountProblem}</span>
            ) : typeof parsed === "number" ? (
              isFiat(amountIn) ? (
                `= ${formatAmount(parsed, unit)}`
              ) : (
                (fiatAmount(parsed, prices, fiat) && `≈ ${fiatAmount(parsed, prices, fiat)}`) || ""
              )
            ) : (
              ""
            )}
          </p>

          <div className="mt-6 flex items-center justify-between gap-3 text-sm">
            <span className="text-muted">
              {available == null
                ? "Checking what you can send…"
                : available > 0
                  ? `You can send ${formatAmount(available, unit)}`
                  : coins && coins.unconfirmed_sat > 0
                    ? "Your bitcoin is still confirming. About 10 minutes."
                    : "Nothing to send yet."}
            </span>
            {available != null && available > 0 ? (
              <button
                type="button"
                onClick={() => {
                  setSendAll(true);
                  setAmountStr("");
                  go("address");
                }}
                className="font-medium text-accent underline-offset-2 hover:underline"
              >
                Send all
              </button>
            ) : null}
          </div>

          <div className="mt-8">
            <Button type="submit" disabled={amountSat == null || Boolean(amountProblem)}>
              Next
            </Button>
          </div>
        </form>
      ) : null}

      {step === "address" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (addrShapeOk && addrNetworkOk) go("password");
          }}
        >
          <p className="text-sm text-muted">
            {sendAll ? "Everything" : amountSat != null ? amountLabel(amountSat) : ""}
          </p>
          <label className="mt-4 block">
            <span className="text-sm">Bitcoin address</span>
            <input
              type="text"
              value={destination}
              onChange={(e) => setDestination(e.target.value.trim())}
              placeholder={`${bech32PrefixFor(network)}…`}
              autoComplete="off"
              spellCheck={false}
              className="input mt-2 w-full font-mono text-sm"
            />
          </label>
          {destination && !addrShapeOk ? (
            <p className="mt-2 text-sm text-alarm">That doesn't look like a Bitcoin address.</p>
          ) : destination && !addrNetworkOk ? (
            <p className="mt-2 text-sm text-alarm">
              That address is for another network. It should start with {bech32PrefixFor(network)}.
            </p>
          ) : null}
          {typeof navigator !== "undefined" && navigator.clipboard?.readText ? (
            <button
              type="button"
              onClick={() => {
                navigator.clipboard
                  .readText()
                  .then((t) => setDestination(t.trim()))
                  .catch(() => {});
              }}
              className="mt-3 text-sm font-medium text-accent underline-offset-2 hover:underline"
            >
              Paste
            </button>
          ) : null}
          <div className="mt-8">
            <Button type="submit" disabled={!addrShapeOk || !addrNetworkOk}>
              Next
            </Button>
          </div>
        </form>
      ) : null}

      {step === "password" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (password && !busy) void onSign();
          }}
        >
          <label className="block">
            <span className="text-sm">Enter your password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              disabled={busy}
              className="input mt-2 w-full"
            />
          </label>
          {error ? (
            <p className="mt-3 text-sm text-alarm" role="alert">
              {error}
            </p>
          ) : null}
          <div className="mt-8">
            <Button type="submit" disabled={!password} loading={busy}>
              {phase === "unlocking"
                ? `Unlocking… ${unlockPct}%`
                : phase === "signing"
                  ? "Getting it ready…"
                  : "Next"}
            </Button>
          </div>
        </form>
      ) : null}

      {step === "review" ? (
        signed ? (
          <>
            <ConfirmSend
              destination={destination}
              amountLabel={amountLabel(signed.sentSat)}
              networkLabel={network === "bitcoin" ? "Bitcoin" : `${network} network`}
              rows={[
                { label: "Network fee", value: formatAmount(signed.feeSat, unit) },
                { label: "Left in your savings", value: formatAmount(signed.leftSat, unit) },
              ]}
              confirmLabel={phase === "sending" ? "Sending…" : "Send"}
              busy={busy}
              showHeading={false}
              onConfirm={() => void onSend()}
              onBack={back}
            />
            {signed.feeSat * 5 > signed.sentSat ? (
              <p className="mt-4 text-sm text-muted">
                The fee is {Math.round((signed.feeSat / signed.sentSat) * 100)}% of this send. It
                costs the same for a bigger send.
              </p>
            ) : null}
            {error ? (
              <p className="mt-3 text-sm text-alarm" role="alert">
                {error}
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-muted">Go back and enter your password again.</p>
        )
      ) : null}

      {step === "done" && result ? (
        <div>
          <p className="text-sm">
            {formatAmount(result.sent_sat, unit)} is on its way.
          </p>
          <p className="mt-1 text-sm text-muted">
            Network fee {formatAmount(result.fee_sat, unit)}.{" "}
            {(signed?.leftSat ?? result.remaining_sat) > 0
              ? `${formatAmount(signed?.leftSat ?? result.remaining_sat, unit)} stays in your savings.`
              : "Your savings are now empty."}
          </p>
          {savings?.goals?.length ? (
            <SpendFromGoal
              vaultId={activeId}
              ownerToken={ownerToken}
              goals={savings.goals}
              amountSat={result.sent_sat + result.fee_sat}
              onView={setSavings}
            />
          ) : null}
          <div className="mt-8 flex flex-wrap items-center gap-4">
            <Button onClick={() => onNavigate("dashboard")}>Done</Button>
            <a
              href={result.explorer_url}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-muted underline underline-offset-2"
            >
              See it on mempool.space
            </a>
          </div>
        </div>
      ) : null}
    </PageShell>
  );
}
