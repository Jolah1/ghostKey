/**
 * Move to the new vault format (#389), one step per screen.
 *
 * Same owner key, heir key and wait; the script is written the way other
 * wallets (Liana) read it, and owner sends cost less. Coins can't change
 * format where they sit, so each deposit moves, in its own transaction
 * (they're never merged on-chain), signed here with the owner key, to the
 * new format's change addresses. This device works out the new format
 * itself from the descriptors it pinned and only goes ahead if the
 * server's match.
 */
import { useEffect, useState } from "react";
import { Transaction } from "@scure/btc-signer";
import { hexToBytes } from "@noble/hashes/utils.js";
import type { Route } from "./App";
import { ApiError, api } from "./api";
import { groupCoins, retryIfBusy, waitWords } from "./coinProtection";
import type { Network } from "./crypto/keygen";
import { unsealOwner } from "./crypto/sealing";
import { PageShell } from "./PageShell";
import { Button } from "./ui";
import { formatAmount, useUnit } from "./units";
import { unlockErrorMessage } from "./unlockErrors";
import { useActiveVault } from "./useActiveVault";
import { deriveVaultAddress } from "./vaultAddress";
import { repinVaultDescriptors } from "./vaultStore";
import { sameVault, trustedDescriptors, upgradedPair, type DescriptorPair } from "./vaultUpgrade";

type Step = "intro" | "password" | "review" | "done";
const TITLES: Record<Step, string> = {
  intro: "Move to the new format",
  password: "Your password",
  review: "Check and move",
  done: "Moved",
};

function txidOfHex(hex: string): string {
  return Transaction.fromRaw(hexToBytes(hex), { allowUnknownOutputs: true }).id;
}

export function UpgradePage({ onNavigate }: { onNavigate: (r: Route) => void }) {
  const { activeId, ownerToken, vault, loading } = useActiveVault();
  const unit = useUnit();
  const [step, setStep] = useState<Step>("intro");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"unlocking" | "signing" | "sending" | null>(null);
  const [pct, setPct] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [signed, setSigned] = useState<{ txs: string[]; feeSat: number; totalSat: number; next: DescriptorPair } | null>(
    null,
  );
  const [result, setResult] = useState<{ moved: number; pending: number } | null>(null);

  useEffect(() => {
    window.history.replaceState({ gkUpgrade: "intro" }, "", window.location.href);
    const onPop = (e: PopStateEvent) => {
      const s = (e.state as { gkUpgrade?: Step } | null)?.gkUpgrade;
      setError(null);
      setStep(s && s !== "done" ? s : "intro");
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const go = (next: Step) => {
    setError(null);
    window.history.pushState({ gkUpgrade: next }, "", window.location.href);
    setStep(next);
    window.scrollTo(0, 0);
  };

  if (loading) {
    return (
      <PageShell title="Move to the new format" onNavigate={onNavigate}>
        <p className="text-sm text-muted">Loading…</p>
      </PageShell>
    );
  }
  if (!activeId || !ownerToken || !vault) {
    return (
      <PageShell title="Move to the new format" onNavigate={onNavigate}>
        <p className="text-sm text-muted">Sign in to see this.</p>
      </PageShell>
    );
  }
  if (!vault.upgrade_available && step !== "done") {
    return (
      <PageShell title="Move to the new format" onNavigate={onNavigate}>
        <p className="text-base text-[var(--text-body)]">Your vault is already in the new format.</p>
      </PageShell>
    );
  }

  const v = vault;
  const wait = waitWords(v.timelock_blocks);
  const back = () => (step === "intro" || step === "done" ? onNavigate("dashboard") : window.history.back());

  async function sign() {
    if (!activeId || !ownerToken) return;
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
      const [coins, upgrade, signer] = await Promise.all([
        retryIfBusy(() => api.getSpendCoins(activeId, ownerToken)),
        api.getUpgrade(activeId, ownerToken),
        import("./kit/signer"),
      ]);
      // The old format, as this device pinned it, and the new one worked
      // out here. The server's new pair must be the same vault.
      const old = trustedDescriptors(activeId, v, v.network);
      const mine = old ? upgradedPair(old) : null;
      const theirs =
        upgrade.descriptor_external && upgrade.descriptor_internal
          ? { external: upgrade.descriptor_external, internal: upgrade.descriptor_internal }
          : null;
      if (!old || !mine || !theirs || !upgrade.available) {
        throw new Error("Couldn't load your vault's details. Try again.");
      }
      if (!sameVault(mine, theirs, v.network)) {
        throw new Error("The new format doesn't match your vault. Nothing was moved. Please contact support.");
      }
      const groups = groupCoins(coins.coins ?? [], v.timelock_blocks);
      if (groups.some((g) => g.confirmationHeight == null) || coins.unconfirmed_sat > 0) {
        throw new Error("A deposit is still confirming. Wait about 10 minutes, then try again.");
      }
      const txs: string[] = [];
      let feeSat = 0;
      for (let i = 0; i < groups.length; i++) {
        const funding = coins.funding.filter((f) => txidOfHex(f.tx_hex) === groups[i].txid);
        if (funding.length !== 1) throw new Error("Your deposits changed. Go back and try again.");
        const tx = await signer.signSweep({
          role: "owner",
          descriptor_external: old.external,
          descriptor_internal: old.internal,
          timelock_blocks: v.timelock_blocks,
          network: v.network as Network,
          account_xprv: ownerXprv,
          funding,
          chain_tip_height: coins.chain_tip_height,
          // Each deposit to its own new change address, worked out here.
          recipient: deriveVaultAddress(mine.internal, v.network, i),
          amount_sat: null,
          fee_rate_sat_vb: coins.fee_rate_sat_per_vb,
        });
        txs.push(tx.tx_hex);
        feeSat += tx.fee_sat;
      }
      setSigned({ txs, feeSat, totalSat: groups.reduce((n, g) => n + g.valueSat, 0), next: theirs });
      setPassword("");
      go("review");
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function move() {
    if (!activeId || !ownerToken || !signed) return;
    setError(null);
    setBusy("sending");
    try {
      const r = await retryIfBusy(() => api.ownerUpgradeSigned(activeId, ownerToken, { txs: signed.txs }));
      // This device checked the new pair above: pin it.
      repinVaultDescriptors(activeId, signed.next);
      setResult({ moved: r.moved, pending: r.pending });
      window.history.replaceState({ gkUpgrade: "done" }, "", window.location.href);
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
      backLabel={step === "intro" || step === "done" ? "Back to home" : "Back"}
    >
      {step === "intro" ? (
        <div className="flex flex-col gap-5">
          <ul className="m-0 flex list-none flex-col gap-3 p-0 text-base text-[var(--text-body)]">
            <li>Other wallets, like Liana, can open the new format. Your savings never depend on GhostKey.</li>
            <li>Sending from it costs less.</li>
            <li>Each deposit moves on its own, inside your vault, for a small network fee.</li>
            <li>The person you chose would wait {wait} from today for each deposit.</li>
            <li>Afterwards, download your recovery files again. The old ones are for the old format.</li>
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

      {step === "review" && signed ? (
        <div className="flex flex-col gap-5">
          <dl className="m-0 grid grid-cols-[1fr_auto] gap-y-3 rounded-[20px] border border-app bg-surface p-5 text-base">
            <dt className="text-muted">Deposits</dt>
            <dd className="m-0 text-right font-semibold text-[var(--text)]" data-testid="upgrade-count">
              {signed.txs.length}
            </dd>
            <dt className="text-muted">Network fees</dt>
            <dd className="m-0 text-right font-semibold text-[var(--text)]" data-testid="upgrade-fee">
              {formatAmount(signed.feeSat, unit)}
            </dd>
            <dt className="text-muted">Stays saved</dt>
            <dd className="m-0 text-right font-semibold text-[var(--text)]">
              {formatAmount(Math.max(0, signed.totalSat - signed.feeSat), unit)}
            </dd>
          </dl>
          {error ? (
            <p className="m-0 text-sm text-alarm" role="alert">
              {error}
            </p>
          ) : null}
          <Button loading={busy === "sending"} className="h-14 w-full text-[17px]" onClick={() => void move()}>
            Move to the new format
          </Button>
        </div>
      ) : null}

      {step === "done" ? (
        <div className="flex flex-col gap-5">
          <p className="m-0 text-base text-[var(--text-body)]">
            Your vault is in the new format.
            {result && result.pending > 0
              ? ` ${result.pending} ${result.pending === 1 ? "deposit is" : "deposits are"} still on the way. We keep sending ${result.pending === 1 ? "it" : "them"}, so you don't need to do anything.`
              : ""}
          </p>
          <p className="m-0 text-base font-semibold text-[var(--text)]">Now download your recovery files again.</p>
          <Button className="h-14 w-full text-[17px]" onClick={() => onNavigate("recovery")}>
            Download recovery files
          </Button>
          <Button variant="ghost" className="h-14 w-full text-[17px]" onClick={() => onNavigate("dashboard")}>
            Back to home
          </Button>
        </div>
      ) : null}
    </PageShell>
  );
}
