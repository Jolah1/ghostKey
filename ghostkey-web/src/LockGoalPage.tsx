/**
 * Lock a goal, one step per screen: what for, how long, the promise
 * ("nobody can open it early, not even GhostKey") with the unlock fee,
 * your password, then add sats to it. Each step is a history entry, so the
 * phone's back button steps back.
 */
import { useEffect, useState } from "react";
import type { Route } from "./App";
import { api } from "./api";
import { PageShell } from "./PageShell";
import { ReceiveCard } from "./ReceiveCard";
import { GOAL_PRESETS } from "./savings";
import { Button } from "./ui";
import {
  LOCK_MONTHS,
  LOCK_TITLE_KEY,
  WrongPassword,
  createLockedGoal,
  dateWords,
  lockDates,
  unlockFeeSats,
  type LockMonths,
} from "./lockedGoals";
import { formatAmount, useUnit } from "./units";
import { useActiveVault } from "./useActiveVault";

type Step = "what" | "length" | "confirm" | "password" | "done";
const TITLES: Record<Step, string> = {
  what: "What are you locking for?",
  length: "For how long?",
  confirm: "Lock it?",
  password: "Your password",
  done: "Locked",
};

export function LockGoalPage({ onNavigate }: { onNavigate: (r: Route) => void }) {
  const { activeId, ownerToken, vault, loading } = useActiveVault();
  const unit = useUnit();
  const [step, setStep] = useState<Step>("what");
  const [title, setTitle] = useState(() => sessionStorage.getItem(LOCK_TITLE_KEY) ?? "");
  const [months, setMonths] = useState<LockMonths>(6);
  const [understood, setUnderstood] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [demo, setDemo] = useState(false);
  const [feeRate, setFeeRate] = useState<number | null>(null);
  const [made, setMade] = useState<{ id: string; until: number } | null>(null);

  useEffect(() => {
    sessionStorage.removeItem(LOCK_TITLE_KEY);
    api.health().then((h) => setDemo(Boolean(h.demo_mode))).catch(() => {});
  }, []);
  // Today's fee rate, for the unlock-fee line on the confirm step.
  useEffect(() => {
    if (step !== "confirm" || feeRate != null || !activeId || !ownerToken) return;
    api
      .getSpendCoins(activeId, ownerToken)
      .then((c) => setFeeRate(c.fee_rate_sat_per_vb))
      .catch(() => setFeeRate(2));
  }, [step, feeRate, activeId, ownerToken]);

  useEffect(() => {
    window.history.replaceState({ gkLock: "what" }, "", window.location.href);
    const onPop = (e: PopStateEvent) => {
      const s = (e.state as { gkLock?: Step } | null)?.gkLock;
      if (made) {
        onNavigate("dashboard");
        return;
      }
      setError(null);
      setStep(s && s !== "done" ? s : "what");
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [made, onNavigate]);

  const go = (next: Step) => {
    setError(null);
    window.history.pushState({ gkLock: next }, "", window.location.href);
    setStep(next);
    window.scrollTo(0, 0);
  };

  if (loading) {
    return (
      <PageShell title="Lock a goal" onNavigate={onNavigate}>
        <p className="text-sm text-muted">Loading…</p>
      </PageShell>
    );
  }
  if (!activeId || !vault) {
    return (
      <PageShell title="Lock a goal" onNavigate={onNavigate}>
        <p className="text-sm text-muted">Sign in to lock a goal.</p>
      </PageShell>
    );
  }

  const dates = lockDates(months, vault.timelock_blocks, demo);
  const back = () => (step === "what" || step === "done" ? onNavigate("dashboard") : window.history.back());

  async function lockIt() {
    if (!activeId) return;
    setBusy(true);
    setError(null);
    setPct(0);
    try {
      const r = await createLockedGoal({
        parentId: activeId,
        password,
        title: title.trim(),
        months,
        demo,
        onProgress: setPct,
      });
      setPassword("");
      setMade({ id: r.id, until: r.until });
      window.history.replaceState({ gkLock: "done" }, "", window.location.href);
      setStep("done");
      window.scrollTo(0, 0);
    } catch (e) {
      setError(e instanceof WrongPassword ? e.message : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageShell
      title={TITLES[step]}
      onNavigate={onNavigate}
      onBack={back}
      backLabel={step === "what" || step === "done" ? "Back to home" : "Back"}
    >
      {step === "what" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim()) go("length");
          }}
          className="flex flex-col gap-6"
        >
          <div className="flex flex-wrap gap-2" role="group" aria-label="Goal ideas">
            {GOAL_PRESETS.map((g) => (
              <button
                key={g}
                type="button"
                aria-pressed={title === g}
                onClick={() => setTitle(g)}
                className={`min-h-11 rounded-full border px-4 text-[15px] font-semibold ${
                  title === g
                    ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--text-on-accent)]"
                    : "border-[var(--border-hi)] bg-surface text-[var(--text)]"
                }`}
              >
                {g}
              </button>
            ))}
          </div>
          <label className="flex flex-col gap-2">
            <span className="text-[15px] font-semibold text-[var(--text-body)]">Or type your own</span>
            <input className="setup-input" maxLength={60} value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <Button type="submit" disabled={!title.trim()} className="h-14 w-full text-[17px]">
            Next
          </Button>
        </form>
      ) : null}

      {step === "length" ? (
        <div className="flex flex-col gap-6">
          <div role="group" aria-label="Lock length" className="grid grid-cols-3 gap-3">
            {LOCK_MONTHS.map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={months === m}
                onClick={() => setMonths(m)}
                className={`min-h-14 rounded-2xl border text-[17px] font-bold ${
                  months === m
                    ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-[var(--text)]"
                    : "border-[var(--border-hi)] bg-surface text-[var(--text)]"
                }`}
              >
                {m} months
              </button>
            ))}
          </div>
          <div className="rounded-[20px] border border-app bg-[var(--bg-elev)] p-5">
            <span className="text-sm text-muted">Unlocks on</span>
            <p className="m-0 mt-1 font-display text-[28px] font-extrabold text-[var(--text)]" data-testid="unlock-date">
              {dateWords(dates.owner_after)}
            </p>
          </div>
          <Button onClick={() => go("confirm")} className="h-14 w-full text-[17px]">
            Next
          </Button>
        </div>
      ) : null}

      {step === "confirm" ? (
        <div className="flex flex-col gap-5">
          <p className="m-0 text-lg font-semibold text-[var(--text)]">
            {title.trim()} · {months} months
          </p>
          <div className="flex items-start gap-3 rounded-2xl border border-[var(--card-outline)] bg-surface p-4">
            <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 shrink-0">
              <rect x="5" y="11" width="14" height="10" rx="2" />
              <path d="M8 11V7a4 4 0 0 1 8 0v4" />
            </svg>
            <p className="m-0 text-base text-[var(--text-body)]">
              <strong className="text-[var(--text)]">Nobody can open it early. Not even GhostKey.</strong> You can keep adding sats
              any time.
            </p>
          </div>
          <p className="m-0 text-[15px] text-muted" data-testid="unlock-fee">
            Each deposit is its own coin, so unlocking costs a network fee for each one.{" "}
            {feeRate != null
              ? `At today's fees, unlocking 12 deposits costs about ${formatAmount(unlockFeeSats(12, feeRate), unit)}.`
              : ""}
          </p>
          <label className="flex items-start gap-3 text-[15px] text-[var(--text-body)]">
            <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} className="mt-1 h-5 w-5" />
            <span>I understand it stays locked until {dateWords(dates.owner_after)}</span>
          </label>
          <Button disabled={!understood} onClick={() => go("password")} className="h-14 w-full text-[17px]">
            Continue
          </Button>
        </div>
      ) : null}

      {step === "password" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (password && !busy) void lockIt();
          }}
          className="flex flex-col gap-5"
        >
          <label className="flex flex-col gap-2">
            <span className="text-[15px] font-semibold text-[var(--text-body)]">Enter your password to lock it</span>
            <input
              type="password"
              className="setup-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              disabled={busy}
            />
          </label>
          {error ? (
            <p className="m-0 text-sm text-alarm" role="alert">
              {error}
            </p>
          ) : null}
          <Button type="submit" disabled={!password} loading={busy} className="h-14 w-full text-[17px]">
            {busy ? `Locking… ${pct}%` : "Lock it"}
          </Button>
        </form>
      ) : null}

      {step === "done" && made ? (
        <div className="flex flex-col gap-5">
          <p className="m-0 text-base text-[var(--text-body)]">
            {title.trim()} is locked until <strong className="text-[var(--text)]">{dateWords(made.until)}</strong>. Add sats to it
            any time.
          </p>
          <ReceiveCard vaultId={made.id} embedded autoShow />
          <Button onClick={() => onNavigate("dashboard")} className="h-14 w-full text-[17px]">
            Done
          </Button>
        </div>
      ) : null}
    </PageShell>
  );
}
