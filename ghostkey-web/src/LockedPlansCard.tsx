/**
 * Home's "Your plans": one row per locked goal (days left, or Unlocked),
 * and "+ Lock a goal" while the server has locked goals switched on.
 * Shows nothing at all when there are no plans and locking is off.
 */
import { useEffect, useState } from "react";
import type { Route } from "./App";
import { api } from "./api";
import { PLAN_KEY } from "./lockedGoals";
import { getLockedGoals } from "./vaultStore";

export function LockedPlansCard({ parentId, onNavigate }: { parentId: string; onNavigate: (r: Route) => void }) {
  const [enabled, setEnabled] = useState(false);
  const [now] = useState(() => Date.now());
  const plans = getLockedGoals(parentId);
  useEffect(() => {
    let live = true;
    api
      .health()
      .then((h) => live && setEnabled(Boolean(h.locked_goals_enabled)))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  if (plans.length === 0 && !enabled) return null;

  return (
    <section aria-labelledby="plans-h" className="mt-5 rounded-[20px] border border-app bg-surface p-5" data-testid="your-plans">
      <h2 id="plans-h" className="m-0 font-display text-lg font-bold text-[var(--text)]">
        Your plans
      </h2>
      <ul className="m-0 mt-3 flex list-none flex-col gap-2 p-0">
        {plans.map((p) => {
          const until = p.locked!.until * 1000;
          const days = Math.ceil((until - now) / 86_400_000);
          return (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => {
                  sessionStorage.setItem(PLAN_KEY, p.id);
                  onNavigate("plan");
                }}
                className="flex min-h-14 w-full items-center gap-3 rounded-2xl bg-[var(--bg-elev)] px-4 text-left"
              >
                <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="5" y="11" width="14" height="10" rx="2" />
                  <path d="M8 11V7a4 4 0 0 1 8 0v4" />
                </svg>
                <span className="flex-1 text-[15px] font-semibold text-[var(--text)]">{p.locked!.title}</span>
                <span className="text-sm text-muted">
                  {until <= now ? "Unlocked" : `${days} ${days === 1 ? "day" : "days"} left`}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {enabled ? (
        <button
          type="button"
          onClick={() => onNavigate("lock")}
          className="mt-3 min-h-11 text-[15px] font-semibold text-[var(--accent)]"
        >
          + Lock a goal
        </button>
      ) : null}
    </section>
  );
}
