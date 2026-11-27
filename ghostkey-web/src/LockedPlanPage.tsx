/**
 * One locked goal: a ring counting down to its unlock date, what's in it,
 * the unlock fee at today's rates, and Add sats. Once it's unlocked: send
 * it, or lock it again.
 */
import { useEffect, useState } from "react";
import type { Route } from "./App";
import { api } from "./api";
import { dateWords, LOCK_TITLE_KEY, PLAN_KEY, SEND_FROM_KEY, unlockFeeSats } from "./lockedGoals";
import { PageShell } from "./PageShell";
import { ReceiveCard } from "./ReceiveCard";
import { Button } from "./ui";
import { formatAmount, useUnit } from "./units";
import { getVaultMeta, getVaultOwnerToken } from "./vaultStore";

export function LockedPlanPage({ onNavigate }: { onNavigate: (r: Route) => void }) {
  const unit = useUnit();
  const [id] = useState(() => sessionStorage.getItem(PLAN_KEY));
  const meta = id ? getVaultMeta(id) : null;
  const token = id ? getVaultOwnerToken(id) : null;
  const [balance, setBalance] = useState<number | null>(null);
  const [fee, setFee] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!id) return;
    let live = true;
    api
      .getLastVaultBalance(id)
      .then((b) => live && b && setBalance(b.confirmed_sat + b.unconfirmed_sat))
      .catch(() => {});
    if (token) {
      api
        .getSpendCoins(id, token)
        .then((c) => {
          if (!live) return;
          setBalance(c.confirmed_sat + c.unconfirmed_sat);
          setFee(unlockFeeSats(c.funding.length, c.fee_rate_sat_per_vb));
        })
        .catch(() => {});
    }
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, [id, token]);

  if (!id || !meta?.locked) {
    return (
      <PageShell title="Your plan" onNavigate={onNavigate}>
        <p className="text-sm text-muted">Open it from Home.</p>
      </PageShell>
    );
  }

  const { title, until } = meta.locked;
  const createdAt = new Date(meta.createdAt).getTime();
  const total = Math.max(1, until * 1000 - createdAt);
  const left = Math.max(0, until * 1000 - now);
  const unlocked = left === 0;
  const days = Math.ceil(left / 86_400_000);
  const ringC = 2 * Math.PI * 54;
  const done = Math.min(1, 1 - left / total);

  return (
    <PageShell title={title} onNavigate={onNavigate}>
      <div className="flex flex-col items-center gap-3 text-center">
        <svg width="140" height="140" viewBox="0 0 140 140" aria-hidden="true" className="-rotate-90">
          <circle cx="70" cy="70" r="54" fill="none" stroke="var(--surface-2)" strokeWidth="12" />
          <circle
            cx="70"
            cy="70"
            r="54"
            fill="none"
            stroke="var(--accent)"
            strokeWidth="12"
            strokeLinecap="round"
            strokeDasharray={ringC}
            strokeDashoffset={ringC * (1 - done)}
          />
        </svg>
        <p className="m-0 font-display text-[28px] font-extrabold text-[var(--text)]" data-testid="plan-countdown">
          {unlocked ? "Unlocked" : `${days} ${days === 1 ? "day" : "days"} left`}
        </p>
        <p className="m-0 text-[15px] text-muted">
          {unlocked ? `Unlocked on ${dateWords(until)}` : `Unlocks on ${dateWords(until)}`}
        </p>
      </div>

      <div className="mt-8 rounded-[20px] border border-app bg-surface p-5">
        <span className="text-sm text-muted">In this goal</span>
        <p className="m-0 mt-1 font-display text-[32px] font-extrabold text-[var(--text)]" data-testid="plan-balance">
          {balance == null ? "…" : formatAmount(balance, unit)}
        </p>
        {fee != null ? (
          <p className="m-0 mt-2 text-sm text-muted" data-testid="plan-fee">
            Fee to unlock at today&apos;s rates: about {formatAmount(fee, unit)}
          </p>
        ) : null}
      </div>

      <div className="mt-6 flex flex-col gap-3">
        {unlocked ? (
          <>
            <Button
              className="h-14 w-full text-[17px]"
              onClick={() => {
                sessionStorage.setItem(SEND_FROM_KEY, id);
                onNavigate("send");
              }}
            >
              Use my savings
            </Button>
            <Button
              variant="ghost"
              className="h-14 w-full text-[17px]"
              onClick={() => {
                sessionStorage.setItem(LOCK_TITLE_KEY, title);
                onNavigate("lock");
              }}
            >
              Lock it again
            </Button>
          </>
        ) : (
          <Button className="h-14 w-full text-[17px]" onClick={() => setAdding((a) => !a)} aria-expanded={adding}>
            Add sats
          </Button>
        )}
        {adding && !unlocked ? <ReceiveCard vaultId={id} embedded autoShow /> : null}
        <p className="m-0 text-sm text-muted">Nobody can open it before then, not even GhostKey.</p>
      </div>
    </PageShell>
  );
}
