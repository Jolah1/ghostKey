/**
 * Savings card (#367): what you're saving for, how close you are, what
 * you've put aside, and your recent deposits.
 *
 * Borrowed from PiggyVest's Target Savings: "What are you saving for?",
 * an optional amount and date, a progress bar, and a "save about X a
 * week" line. Not borrowed: anything that pulls money, penalises, or
 * counts streaks. Nothing here can be missed or failed; the total only
 * goes up, and progress is simply the balance against the goal.
 */
import { useEffect, useId, useState } from "react";
import { ApiError, api, type SavingsView } from "./api";
import { Button } from "./ui";
import { formatAmount, useUnit } from "./units";
import { parseAmount, satsToBip21Btc } from "./bip21";
import { goalProgress, savePerPeriod } from "./savings";

function longDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function tomorrow(): string {
  const t = new Date(Date.now() + 86_400_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}

export function SavingsCard({
  vaultId,
  ownerToken,
}: {
  vaultId: string;
  ownerToken: string | null;
}) {
  const unit = useUnit();
  const titleId = useId();
  const amountId = useId();
  const dateId = useId();
  const [view, setView] = useState<SavingsView | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .getSavings(vaultId, ownerToken)
      .then((v) => alive && setView(v))
      .catch(() => alive && setFailed(true));
    api
      .getVaultBalance(vaultId)
      .then((b) => alive && setBalance(b.total_sat))
      .catch(() => {
        /* progress just waits for a balance */
      });
    return () => {
      alive = false;
    };
  }, [vaultId, ownerToken]);

  if (failed) return null;
  if (!view) return <section className="card-flat p-5 text-sm text-muted">Loading your savings…</section>;

  function startEdit() {
    setTitle(view?.goal?.title ?? "");
    const goalSat = view?.goal?.amount_sat;
    setAmount(goalSat ? (unit === "btc" ? satsToBip21Btc(goalSat) : String(goalSat)) : "");
    setDate(view?.goal?.target_date ?? "");
    setError(null);
    setEditing(true);
  }

  async function save() {
    const parsed = parseAmount(amount, unit);
    if (parsed === "invalid") {
      setError(unit === "btc" ? "Enter an amount like 0.05." : "Enter a whole number of sats.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const v = await api.setSavingsGoal(vaultId, ownerToken, {
        title: title.trim(),
        amount_sat: parsed,
        target_date: date || null,
      });
      setView(v);
      setEditing(false);
    } catch (e) {
      setError(e instanceof ApiError && e.message ? e.message : "Couldn't save that. Try again.");
    } finally {
      setSaving(false);
    }
  }

  async function clear() {
    setSaving(true);
    try {
      await api.clearSavingsGoal(vaultId, ownerToken);
      setView({ ...view!, goal: null });
      setEditing(false);
    } catch (e) {
      setError(e instanceof ApiError && e.message ? e.message : "Couldn't remove it. Try again.");
    } finally {
      setSaving(false);
    }
  }

  const goal = view.goal;
  const progress = goal?.amount_sat && balance != null ? goalProgress(balance, goal.amount_sat) : null;
  const pace =
    progress && goal?.target_date ? savePerPeriod(progress.remainingSat, new Date(), goal.target_date) : null;
  const deposits = showAll ? view.deposits : view.deposits.slice(0, 5);

  return (
    <section className="card-flat p-5" data-testid="savings-card">
      <p className="text-xs uppercase tracking-wider text-dim">Savings</p>

      {editing ? (
        <div className="mt-3 space-y-3">
          <div>
            <label htmlFor={titleId} className="block text-sm font-medium">
              What are you saving for?
            </label>
            <input
              id={titleId}
              className="input mt-1 w-full"
              maxLength={60}
              placeholder="e.g. School fees, Rainy day, House 2028"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor={amountId} className="block text-sm font-medium">
              Goal amount (optional, in {unit === "btc" ? "BTC" : "sats"})
            </label>
            <input
              id={amountId}
              className="input mt-1 w-full"
              inputMode="decimal"
              placeholder={unit === "btc" ? "e.g. 0.05" : "e.g. 5,000,000"}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor={dateId} className="block text-sm font-medium">
              By when? (optional)
            </label>
            <input
              id={dateId}
              type="date"
              className="input mt-1 w-full"
              min={tomorrow()}
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          {error ? (
            <p className="text-sm text-alarm" role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void save()} loading={saving}>
              Save goal
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={saving}>
              Cancel
            </Button>
            {goal ? (
              <Button size="sm" variant="ghost" onClick={() => void clear()} disabled={saving}>
                Remove goal
              </Button>
            ) : null}
          </div>
        </div>
      ) : goal ? (
        <div className="mt-2">
          <div className="flex items-baseline justify-between gap-3">
            <p className="font-semibold">{goal.title}</p>
            <button
              type="button"
              onClick={startEdit}
              className="shrink-0 text-xs text-muted underline-offset-2 hover:underline"
            >
              Edit goal
            </button>
          </div>
          {goal.amount_sat ? (
            <>
              <div
                className="mt-3 h-2 w-full overflow-hidden rounded-full bg-surface-2"
                role="progressbar"
                aria-label={`Progress toward ${goal.title}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progress?.pct ?? 0}
              >
                <div
                  className="h-full rounded-full"
                  style={{ width: `${progress?.pct ?? 0}%`, background: "var(--accent)" }}
                />
              </div>
              <p className="mt-2 text-sm text-muted">
                {balance == null
                  ? "Checking your balance…"
                  : progress?.reached
                    ? `You've reached ${formatAmount(goal.amount_sat, unit)}. Well done.`
                    : `${formatAmount(balance, unit)} of ${formatAmount(goal.amount_sat, unit)}`}
                {goal.target_date ? ` · by ${longDate(goal.target_date)}` : ""}
              </p>
              {pace ? (
                <p className="mt-1 text-sm text-muted" data-testid="savings-pace">
                  Save about {formatAmount(pace.perWeek, unit)} a week
                  {pace.perMonth ? ` (or ${formatAmount(pace.perMonth, unit)} a month)` : ""} to get there.
                </p>
              ) : null}
            </>
          ) : goal.target_date ? (
            <p className="mt-1 text-sm text-muted">By {longDate(goal.target_date)}</p>
          ) : null}
        </div>
      ) : (
        <div className="mt-2">
          <p className="text-sm text-muted">
            Give your savings a purpose. A goal is just for you: nothing is locked,
            and nothing happens if you miss a date.
          </p>
          <div className="mt-3">
            <Button size="sm" variant="ghost" onClick={startEdit}>
              What are you saving for?
            </Button>
          </div>
        </div>
      )}

      <div className="mt-5 border-t border-app pt-4">
        <p className="text-sm">
          <span className="font-semibold">{formatAmount(view.total_saved_sat, unit)}</span>{" "}
          <span className="text-muted">
            put aside so far
            {view.deposit_count > 0
              ? `, in ${view.deposit_count} deposit${view.deposit_count === 1 ? "" : "s"}`
              : ""}
          </span>
        </p>
        {deposits.length > 0 ? (
          <ul className="mt-3 space-y-1.5 text-sm" aria-label="Recent deposits">
            {deposits.map((d) => (
              <li key={`${d.height}-${d.seen_at}-${d.amount_sat}`} className="flex justify-between gap-3">
                <span className="text-muted">{longDate(d.seen_at)}</span>
                <span>
                  +{formatAmount(d.amount_sat, unit)}
                  {d.spent ? <span className="ml-1 text-xs text-dim">(moved out)</span> : null}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-sm text-muted">Your deposits will show up here.</p>
        )}
        {view.deposits.length > 5 ? (
          <button
            type="button"
            onClick={() => setShowAll((s) => !s)}
            className="mt-2 text-xs text-muted underline-offset-2 hover:underline"
          >
            {showAll ? "Show fewer" : `Show all ${view.deposits.length}`}
          </button>
        ) : null}
      </div>
    </section>
  );
}
