/**
 * Keep it protected (#94), one step per screen: each deposit and when
 * Bitcoin's lock on it ends; pick one; what a refresh does; your password
 * (the refresh is built and signed here, the key never leaves this
 * device); the exact fee; done. Each step is a history entry, so the
 * phone's back button steps back.
 */
import { useEffect, useState } from "react";
import { Transaction } from "@scure/btc-signer";
import { hexToBytes } from "@noble/hashes/utils.js";
import type { Route } from "./App";
import { ApiError, api } from "./api";
import {
  groupCoins,
  heightToDate,
  protectionApplies,
  refreshLeadBlocks,
  retryIfBusy,
  waitWords,
  type CoinGroup,
} from "./coinProtection";
import type { Network } from "./crypto/keygen";
import { unsealOwner } from "./crypto/sealing";
import { PageShell } from "./PageShell";
import { Button } from "./ui";
import { formatAmount, useUnit } from "./units";
import { unlockErrorMessage } from "./unlockErrors";
import { useActiveVault } from "./useActiveVault";
import { deriveVaultAddress } from "./vaultAddress";
import { getVaultMeta } from "./vaultStore";

type Step = "list" | "confirm" | "password" | "review" | "done";
const TITLES: Record<Step, string> = {
  list: "Keep it protected",
  confirm: "Refresh this deposit?",
  password: "Your password",
  review: "Check and refresh",
  done: "Refreshed",
};

type Coins = Awaited<ReturnType<typeof api.getSpendCoins>>;

function dateWords(d: Date): string {
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

export function ProtectPage({ onNavigate }: { onNavigate: (r: Route) => void }) {
  const { activeId, ownerToken, vault, loading } = useActiveVault();
  const unit = useUnit();
  const [step, setStep] = useState<Step>("list");
  const [coins, setCoins] = useState<Coins | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [picked, setPicked] = useState<CoinGroup | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"unlocking" | "signing" | "sending" | null>(null);
  const [pct, setPct] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [signed, setSigned] = useState<{ txHex: string; feeSat: number } | null>(null);

  useEffect(() => {
    if (!activeId || !ownerToken) return;
    let live = true;
    retryIfBusy(() => api.getSpendCoins(activeId, ownerToken))
      .then((c) => live && setCoins(c))
      .catch((e) => live && setLoadError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [activeId, ownerToken]);

  useEffect(() => {
    window.history.replaceState({ gkProtect: "list" }, "", window.location.href);
    const onPop = (e: PopStateEvent) => {
      const s = (e.state as { gkProtect?: Step } | null)?.gkProtect;
      setError(null);
      setStep(s && s !== "done" ? s : "list");
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const go = (next: Step) => {
    setError(null);
    window.history.pushState({ gkProtect: next }, "", window.location.href);
    setStep(next);
    window.scrollTo(0, 0);
  };

  if (loading) {
    return (
      <PageShell title="Keep it protected" onNavigate={onNavigate}>
        <p className="text-sm text-muted">Loading…</p>
      </PageShell>
    );
  }
  if (!activeId || !ownerToken || !vault) {
    return (
      <PageShell title="Keep it protected" onNavigate={onNavigate}>
        <p className="text-sm text-muted">Sign in to see this.</p>
      </PageShell>
    );
  }
  if (!protectionApplies(vault)) {
    return (
      <PageShell title="Keep it protected" onNavigate={onNavigate}>
        <p className="text-base text-[var(--text-body)]">
          {vault.heir_pending
            ? "Nobody else can reach these savings yet, so there's nothing to refresh. This matters once you choose who inherits."
            : vault.locked_until
              ? "A locked goal is protected by its date, so there's nothing to refresh."
              : "There's nothing to refresh right now."}
        </p>
      </PageShell>
    );
  }

  const v = vault;
  const tip = coins?.chain_tip_height ?? 0;
  const groups = coins?.coins ? groupCoins(coins.coins, v.timelock_blocks) : [];
  const lead = refreshLeadBlocks(v.timelock_blocks);
  const wait = waitWords(v.timelock_blocks);
  const back = () => (step === "list" || step === "done" ? onNavigate("dashboard") : window.history.back());

  async function sign() {
    if (!activeId || !ownerToken || !picked) return;
    setError(null);
    setBusy("unlocking");
    setPct(0);
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
        onProgress: (p) => setPct(Math.round(p * 100)),
      });
      ownerXprv = unsealed.ownerXprv;
    } catch (e) {
      setBusy(null);
      setError(unlockErrorMessage(e));
      return;
    }

    setBusy("signing");
    try {
      const [fresh, signer] = await Promise.all([
        retryIfBusy(() => api.getSpendCoins(activeId, ownerToken)),
        import("./kit/signer"),
      ]);
      // The deposit, as this fresh scan sees it.
      const funding = fresh.funding.filter((f) => txidOfHex(f.tx_hex) === picked.txid);
      if (funding.length !== 1) throw new Error("That deposit isn't in your vault any more. Go back and look again.");
      // The descriptors this device pinned when it first saw the vault: the
      // refresh address must come from them, so a tampered server can't
      // send the deposit anywhere else.
      const pinned = getVaultMeta(activeId)?.pinnedDescriptors;
      const external = pinned?.external ?? v.descriptor_external;
      const internal = pinned?.internal ?? v.descriptor_internal;
      const target = fresh.refresh_address;
      if (!external || !internal || !target) throw new Error("Couldn't load your vault's details. Try again.");
      if (deriveVaultAddress(internal, v.network, target.index) !== target.address) {
        throw new Error("The refresh address doesn't match your vault. Nothing was sent. Please contact support.");
      }
      const tx = await signer.signSweep({
        role: "owner",
        descriptor_external: external,
        descriptor_internal: internal,
        timelock_blocks: v.timelock_blocks,
        network: v.network as Network,
        account_xprv: ownerXprv,
        funding,
        chain_tip_height: fresh.chain_tip_height,
        recipient: target.address,
        amount_sat: null,
        fee_rate_sat_vb: fresh.fee_rate_sat_per_vb,
      });
      setSigned({ txHex: tx.tx_hex, feeSat: tx.fee_sat });
      setPassword("");
      go("review");
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function refresh() {
    if (!activeId || !ownerToken || !signed) return;
    setError(null);
    setBusy("sending");
    try {
      await retryIfBusy(() => api.ownerRefreshSigned(activeId, ownerToken, { tx_hex: signed.txHex }));
      window.history.replaceState({ gkProtect: "done" }, "", window.location.href);
      setStep("done");
      window.scrollTo(0, 0);
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <PageShell
      title={TITLES[step]}
      onNavigate={onNavigate}
      onBack={back}
      backLabel={step === "list" || step === "done" ? "Back to home" : "Back"}
    >
      {step === "list" ? (
        <div className="flex flex-col gap-5">
          <p className="m-0 text-base text-[var(--text-body)]">
            Bitcoin locks each deposit for {wait} from the day it arrives. After that, only your check-ins keep it from the
            person you chose. Refresh a deposit to start its lock again.
          </p>
          {loadError ? (
            <p className="m-0 text-sm text-alarm" role="alert">
              {loadError}
            </p>
          ) : coins == null ? (
            <p className="m-0 text-sm text-muted">Looking at your deposits…</p>
          ) : groups.length === 0 ? (
            <p className="m-0 text-sm text-muted">No deposits yet.</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="coin-list">
              {groups.map((g) => {
                const left = g.lockEndsAt == null ? null : g.lockEndsAt - tip;
                const due = left != null && left <= lead;
                return (
                  <li key={g.txid} className="flex min-h-16 items-center gap-3 rounded-2xl border border-app bg-surface px-4 py-3">
                    <span className="min-w-0 flex-1">
                      <span className="block text-[17px] font-semibold text-[var(--text)]">
                        {formatAmount(g.valueSat, unit)}
                      </span>
                      <span className={`block text-sm ${due ? "text-[var(--warning)]" : "text-muted"}`}>
                        {left == null
                          ? "Waiting for its first confirmation"
                          : left <= 0
                            ? "Bitcoin's lock has ended"
                            : `Locked until about ${dateWords(heightToDate(g.lockEndsAt!, tip))}`}
                      </span>
                    </span>
                    {left != null ? (
                      <Button
                        variant={due ? "primary" : "ghost"}
                        size="sm"
                        className="min-h-11 px-4 text-sm"
                        onClick={() => {
                          setPicked(g);
                          go("confirm");
                        }}
                      >
                        Refresh
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}

      {step === "confirm" && picked ? (
        <div className="flex flex-col gap-5">
          <p className="m-0 font-display text-[32px] font-extrabold text-[var(--text)]">{formatAmount(picked.valueSat, unit)}</p>
          <ul className="m-0 flex list-none flex-col gap-3 p-0 text-base text-[var(--text-body)]">
            <li>It moves back into your savings. It never leaves your vault.</li>
            <li>
              Bitcoin locks it again for {wait}. The person you chose would wait {wait} from today for it.
            </li>
            <li>It costs a small network fee. You&apos;ll see it before anything moves.</li>
          </ul>
          <Button className="h-14 w-full text-[17px]" onClick={() => go("password")}>
            Continue
          </Button>
        </div>
      ) : null}

      {step === "password" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (password && !busy) void sign();
          }}
          className="flex flex-col gap-5"
        >
          <label className="flex flex-col gap-2">
            <span className="text-[15px] font-semibold text-[var(--text-body)]">Enter your password</span>
            <input
              type="password"
              className="setup-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              disabled={busy != null}
            />
          </label>
          {error ? (
            <p className="m-0 text-sm text-alarm" role="alert">
              {error}
            </p>
          ) : null}
          <Button type="submit" disabled={!password} loading={busy != null} className="h-14 w-full text-[17px]">
            {busy === "unlocking" ? `Unlocking… ${pct}%` : busy === "signing" ? "Preparing…" : "Continue"}
          </Button>
        </form>
      ) : null}

      {step === "review" && signed && picked ? (
        <div className="flex flex-col gap-5">
          <dl className="m-0 grid grid-cols-[1fr_auto] gap-y-3 rounded-[20px] border border-app bg-surface p-5 text-base">
            <dt className="text-muted">Deposit</dt>
            <dd className="m-0 text-right font-semibold text-[var(--text)]">{formatAmount(picked.valueSat, unit)}</dd>
            <dt className="text-muted">Network fee</dt>
            <dd className="m-0 text-right font-semibold text-[var(--text)]" data-testid="refresh-fee">
              {formatAmount(signed.feeSat, unit)}
            </dd>
            <dt className="text-muted">Stays saved</dt>
            <dd className="m-0 text-right font-semibold text-[var(--text)]">
              {formatAmount(Math.max(0, picked.valueSat - signed.feeSat), unit)}
            </dd>
          </dl>
          {error ? (
            <p className="m-0 text-sm text-alarm" role="alert">
              {error}
            </p>
          ) : null}
          <Button loading={busy === "sending"} className="h-14 w-full text-[17px]" onClick={() => void refresh()}>
            Refresh
          </Button>
        </div>
      ) : null}

      {step === "done" ? (
        <div className="flex flex-col gap-5">
          <p className="m-0 text-base text-[var(--text-body)]">
            Done. Once it confirms, in about 10 minutes, Bitcoin&apos;s lock on it starts again for {wait}.
          </p>
          <Button className="h-14 w-full text-[17px]" onClick={() => onNavigate("dashboard")}>
            Back to home
          </Button>
        </div>
      ) : null}
    </PageShell>
  );
}

/** The txid of a raw transaction, for matching a coin to its funding tx. */
function txidOfHex(hex: string): string {
  return Transaction.fromRaw(hexToBytes(hex), { allowUnknownOutputs: true }).id;
}
