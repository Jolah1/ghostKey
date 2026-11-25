/**
 * Several savings goals at once (#367 step 2).
 *
 * Goals share the vault's one deposit address, so each goal's money is a
 * ledger on the server, not a set of coins. New money is sorted with one
 * tap ("Which goal is this for?"), money can be moved between goals, and
 * a send can be taken off a goal. Kept calm on purpose: one line and a
 * bar per goal, and everything else opens on tap.
 */
import { useId, useState } from "react";
import { ApiError, api, type SavingsGoalView, type SavingsView } from "./api";
import { Button } from "./ui";
import { formatAmount, useUnit } from "./units";
import { parseAmount, satsToBip21Btc } from "./bip21";
import { GOAL_PRESETS, goalProgress, goalShares, savePerPeriod } from "./savings";

/** Same cap as the server. */
const MAX_GOALS = 10;

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

function errText(e: unknown, fallback: string): string {
  return e instanceof ApiError && e.message ? e.message : fallback;
}

export function GoalsSection({
  vaultId,
  ownerToken,
  view,
  onView,
  balanceSat,
  balanceHidden,
}: {
  vaultId: string;
  ownerToken: string | null;
  view: SavingsView;
  onView: (v: SavingsView) => void;
  /** Null while the balance loads or when it's hidden. */
  balanceSat: number | null;
  balanceHidden: boolean;
}) {
  const unit = useUnit();
  const goals = view.goals ?? [];
  const [openId, setOpenId] = useState<string | null>(null);
  const [form, setForm] = useState<{ mode: "add" } | { mode: "edit"; goal: SavingsGoalView } | null>(null);
  const [moving, setMoving] = useState<{ from: string | null } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const balance = balanceHidden ? null : balanceSat;
  const { shown, notInGoalSat } = goalShares(
    goals.map((g) => g.saved_sat),
    balance,
  );

  async function run(fn: () => Promise<SavingsView>, fallback: string) {
    setBusy(true);
    setError(null);
    try {
      onView(await fn());
      return true;
    } catch (e) {
      setError(errText(e, fallback));
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (form) {
    return (
      <GoalForm
        initial={form.mode === "edit" ? form.goal : null}
        busy={busy}
        error={error}
        onCancel={() => {
          setForm(null);
          setError(null);
        }}
        onSave={async (g) => {
          const ok = await run(
            () =>
              form.mode === "edit"
                ? api.updateSavingsGoal(vaultId, ownerToken, form.goal.id, g)
                : api.addSavingsGoal(vaultId, ownerToken, g),
            "Couldn't save that. Try again.",
          );
          if (ok) setForm(null);
        }}
      />
    );
  }

  if (moving) {
    return (
      <MoveForm
        goals={goals}
        from={moving.from}
        notInGoalSat={notInGoalSat}
        busy={busy}
        error={error}
        onCancel={() => {
          setMoving(null);
          setError(null);
        }}
        onMove={async (body) => {
          const ok = await run(
            () => api.moveSavings(vaultId, ownerToken, body),
            "Couldn't move that. Try again.",
          );
          if (ok) setMoving(null);
        }}
      />
    );
  }

  const next = goals.length > 0 ? view.unsorted?.[0] : undefined;

  return (
    <div data-testid="goals">
      {next ? (
        <div className="mb-5 rounded-xl border border-[var(--accent)] p-4" data-testid="sort-prompt">
          <p className="text-sm">
            <span className="font-semibold">
              +{formatAmount(next.amount_sat, unit)} arrived
            </span>{" "}
            <span className="text-muted">on {longDate(next.seen_at)}. Which goal is it for?</span>
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {goals.map((g) => (
              <button
                key={g.id}
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => api.sortDeposit(vaultId, ownerToken, next.outpoint, g.id),
                    "Couldn't save that. Try again.",
                  )
                }
                className="rounded-full border border-app px-3 py-1.5 text-sm hover:bg-[var(--surface-2)] disabled:opacity-50"
              >
                {g.title}
              </button>
            ))}
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(
                  () => api.sortDeposit(vaultId, ownerToken, next.outpoint, null),
                  "Couldn't save that. Try again.",
                )
              }
              className="rounded-full px-3 py-1.5 text-sm text-muted underline-offset-2 hover:underline disabled:opacity-50"
            >
              Not for a goal
            </button>
          </div>
        </div>
      ) : null}

      {goals.length === 0 ? (
        <div>
          <p className="text-sm text-muted">
            Give your savings a goal. Nothing is locked, and nothing happens if
            you miss a date.
          </p>
          <Button size="sm" variant="ghost" className="mt-3" onClick={() => setForm({ mode: "add" })}>
            What are you saving for?
          </Button>
        </div>
      ) : (
        <ul className="space-y-4" aria-label="Your goals">
          {goals.map((g, i) => {
            const saved = shown[i];
            const progress = g.amount_sat ? goalProgress(saved, g.amount_sat) : null;
            const pace =
              progress && g.target_date ? savePerPeriod(progress.remainingSat, new Date(), g.target_date) : null;
            const open = openId === g.id;
            return (
              <li key={g.id} data-testid="goal">
                <button
                  type="button"
                  className="w-full text-left"
                  aria-expanded={open}
                  onClick={() => {
                    setOpenId(open ? null : g.id);
                    setConfirmRemove(null);
                    setError(null);
                  }}
                >
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="font-semibold">{g.title}</span>
                    <span className="shrink-0 text-sm text-muted">
                      {balanceHidden
                        ? ""
                        : progress
                          ? `${progress.pct}%`
                          : formatAmount(saved, unit)}
                    </span>
                  </span>
                  {g.amount_sat ? (
                    <span
                      className="mt-2 block h-2 w-full overflow-hidden rounded-full bg-surface-2"
                      role="progressbar"
                      aria-label={`Progress toward ${g.title}`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={balanceHidden ? 0 : (progress?.pct ?? 0)}
                    >
                      <span
                        className="block h-full rounded-full"
                        style={{
                          width: `${balanceHidden ? 0 : (progress?.pct ?? 0)}%`,
                          background: "var(--accent)",
                        }}
                      />
                    </span>
                  ) : null}
                </button>

                {open ? (
                  <div className="mt-3 space-y-2 text-sm" data-testid="goal-details">
                    <p className="text-muted">
                      {balanceHidden
                        ? "Show your balance to see this goal's progress."
                        : progress?.reached
                          ? `You've reached ${formatAmount(g.amount_sat!, unit)}. Well done.`
                          : g.amount_sat
                            ? `${formatAmount(saved, unit)} of ${formatAmount(g.amount_sat, unit)}`
                            : `${formatAmount(saved, unit)} saved`}
                      {g.target_date ? ` · by ${longDate(g.target_date)}` : ""}
                    </p>
                    {pace && !balanceHidden ? (
                      <p className="text-muted" data-testid="savings-pace">
                        Save about {formatAmount(pace.perWeek, unit)} a week
                        {pace.perMonth ? ` (or ${formatAmount(pace.perMonth, unit)} a month)` : ""} to get there.
                      </p>
                    ) : null}
                    {confirmRemove === g.id ? (
                      <div className="flex flex-wrap items-center gap-3">
                        <span className="text-muted">
                          Remove {g.title}? Its money stays saved, just not in a goal.
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={busy}
                          onClick={async () => {
                            const ok = await run(
                              () => api.removeSavingsGoal(vaultId, ownerToken, g.id),
                              "Couldn't remove it. Try again.",
                            );
                            if (ok) {
                              setOpenId(null);
                              setConfirmRemove(null);
                            }
                          }}
                        >
                          Yes, remove
                        </Button>
                        <button
                          type="button"
                          className="text-xs text-muted underline underline-offset-2"
                          onClick={() => setConfirmRemove(null)}
                        >
                          Keep it
                        </button>
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                        <button
                          type="button"
                          className="text-muted underline underline-offset-2 hover:text-[var(--text)]"
                          onClick={() => setForm({ mode: "edit", goal: g })}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="text-muted underline underline-offset-2 hover:text-[var(--text)]"
                          onClick={() => setMoving({ from: g.id })}
                        >
                          Move money
                        </button>
                        <button
                          type="button"
                          className="text-muted underline underline-offset-2 hover:text-[var(--text)]"
                          onClick={() => setConfirmRemove(g.id)}
                        >
                          Remove
                        </button>
                      </div>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {goals.length > 0 ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-xs">
          <span className="text-muted">
            {notInGoalSat && notInGoalSat > 0 && !balanceHidden ? (
              <>
                {formatAmount(notInGoalSat, unit)} not in a goal ·{" "}
                <button
                  type="button"
                  className="underline underline-offset-2 hover:text-[var(--text)]"
                  onClick={() => setMoving({ from: null })}
                >
                  Put it in a goal
                </button>
              </>
            ) : null}
          </span>
          {goals.length < MAX_GOALS ? (
            <button
              type="button"
              className="text-muted underline underline-offset-2 hover:text-[var(--text)]"
              onClick={() => setForm({ mode: "add" })}
            >
              + Add a goal
            </button>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p className="mt-3 text-sm text-alarm" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Add or edit a goal: quick picks or a typed name, then an optional
 *  amount and date. */
function GoalForm({
  initial,
  busy,
  error,
  onCancel,
  onSave,
}: {
  initial: SavingsGoalView | null;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: (g: { title: string; amount_sat: number | null; target_date: string | null }) => void;
}) {
  const unit = useUnit();
  const titleId = useId();
  const amountId = useId();
  const dateId = useId();
  const [title, setTitle] = useState(initial?.title ?? "");
  const [amount, setAmount] = useState(
    initial?.amount_sat ? (unit === "btc" ? satsToBip21Btc(initial.amount_sat) : String(initial.amount_sat)) : "",
  );
  const [date, setDate] = useState(initial?.target_date ?? "");
  const [localError, setLocalError] = useState<string | null>(null);
  const isPreset = (GOAL_PRESETS as readonly string[]).includes(title.trim());

  function submit() {
    if (!title.trim()) {
      setLocalError("Say what you're saving for, for example \"School fees\".");
      return;
    }
    const parsed = parseAmount(amount, unit);
    if (parsed === "invalid") {
      setLocalError(unit === "btc" ? "Enter an amount like 0.05." : "Enter a whole number of sats.");
      return;
    }
    setLocalError(null);
    onSave({ title: title.trim(), amount_sat: parsed, target_date: date || null });
  }

  const shownError = localError ?? error;
  return (
    <div className="space-y-3" data-testid="goal-form">
      <p className="font-semibold">{initial ? "Edit goal" : "What are you saving for?"}</p>
      {!initial ? (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Goal ideas">
          {GOAL_PRESETS.map((g) => (
            <button
              key={g}
              type="button"
              aria-pressed={title.trim() === g}
              onClick={() => setTitle(title.trim() === g ? "" : g)}
              className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
                title.trim() === g
                  ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_18%,transparent)] font-medium text-[var(--text)]"
                  : "border-app text-[var(--text)] hover:bg-[var(--surface-2)]"
              }`}
            >
              {g}
            </button>
          ))}
        </div>
      ) : null}
      <div>
        <label htmlFor={titleId} className="block text-sm font-medium">
          {initial ? "Name" : "Or type your own"}
        </label>
        <input
          id={titleId}
          className="input mt-1 w-full"
          maxLength={60}
          placeholder="e.g. Okada for my brother"
          value={!initial && isPreset ? "" : title}
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
      {shownError ? (
        <p className="text-sm text-alarm" role="alert">
          {shownError}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={submit} loading={busy}>
          Save goal
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** Move money from one goal (or from money not in a goal) to another. */
function MoveForm({
  goals,
  from: initialFrom,
  notInGoalSat,
  busy,
  error,
  onCancel,
  onMove,
}: {
  goals: SavingsGoalView[];
  from: string | null;
  notInGoalSat: number | null;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onMove: (b: { from_goal_id: string | null; to_goal_id: string | null; amount_sat: number }) => void;
}) {
  const unit = useUnit();
  const fromId = useId();
  const toId = useId();
  const amountId = useId();
  const NONE = "";
  const [from, setFrom] = useState<string>(initialFrom ?? NONE);
  const firstOther = goals.find((g) => g.id !== (initialFrom ?? NONE))?.id ?? NONE;
  const [to, setTo] = useState<string>(initialFrom === null ? (goals[0]?.id ?? NONE) : firstOther);
  const [amount, setAmount] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const available =
    from === NONE ? notInGoalSat : Math.max(0, goals.find((g) => g.id === from)?.saved_sat ?? 0);

  function submit() {
    const parsed = parseAmount(amount, unit);
    if (parsed === "invalid" || parsed === null || parsed <= 0) {
      setLocalError(unit === "btc" ? "Enter an amount like 0.001." : "Enter a whole number of sats.");
      return;
    }
    if (from === to) {
      setLocalError("Choose two different places.");
      return;
    }
    if (available != null && parsed > available) {
      setLocalError(`There's only ${formatAmount(available, unit)} there.`);
      return;
    }
    setLocalError(null);
    onMove({ from_goal_id: from || null, to_goal_id: to || null, amount_sat: parsed });
  }

  const options = (
    <>
      <option value={NONE}>Not in a goal</option>
      {goals.map((g) => (
        <option key={g.id} value={g.id}>
          {g.title}
        </option>
      ))}
    </>
  );
  const shownError = localError ?? error;
  return (
    <div className="space-y-3" data-testid="move-form">
      <p className="font-semibold">Move money</p>
      <p className="text-xs text-muted">
        This only changes which goal the money counts toward. Your bitcoin
        doesn&apos;t move.
      </p>
      <div>
        <label htmlFor={fromId} className="block text-sm font-medium">
          From
        </label>
        <select id={fromId} className="input mt-1 w-full" value={from} onChange={(e) => setFrom(e.target.value)}>
          {options}
        </select>
        {available != null ? (
          <p className="mt-1 text-xs text-dim">{formatAmount(available, unit)} there</p>
        ) : null}
      </div>
      <div>
        <label htmlFor={toId} className="block text-sm font-medium">
          To
        </label>
        <select id={toId} className="input mt-1 w-full" value={to} onChange={(e) => setTo(e.target.value)}>
          {options}
        </select>
      </div>
      <div>
        <label htmlFor={amountId} className="block text-sm font-medium">
          How much (in {unit === "btc" ? "BTC" : "sats"})
        </label>
        <input
          id={amountId}
          className="input mt-1 w-full"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </div>
      {shownError ? (
        <p className="text-sm text-alarm" role="alert">
          {shownError}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={submit} loading={busy}>
          Move
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** After a send: "Take it from which goal?" One tap, or skip. */
export function SpendFromGoal({
  vaultId,
  ownerToken,
  goals,
  amountSat,
  onView,
}: {
  vaultId: string;
  ownerToken: string | null;
  goals: SavingsGoalView[];
  amountSat: number;
  onView: (v: SavingsView) => void;
}) {
  const unit = useUnit();
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (goals.length === 0) return null;
  if (done !== null) {
    return done ? <p className="mt-3 text-sm text-muted">Taken off {done}.</p> : null;
  }
  return (
    <div className="mt-4 rounded-xl border border-app p-4" data-testid="spend-from-goal">
      <p className="text-sm">
        Take the {formatAmount(amountSat, unit)} from a goal?
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {goals.map((g) => (
          <button
            key={g.id}
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                onView(await api.spendFromGoal(vaultId, ownerToken, g.id, amountSat));
                setDone(g.title);
              } catch (e) {
                setError(errText(e, "Couldn't save that. Try again."));
              } finally {
                setBusy(false);
              }
            }}
            className="rounded-full border border-app px-3 py-1.5 text-sm hover:bg-[var(--surface-2)] disabled:opacity-50"
          >
            {g.title}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setDone("")}
          className="rounded-full px-3 py-1.5 text-sm text-muted underline-offset-2 hover:underline"
        >
          Not from a goal
        </button>
      </div>
      {error ? (
        <p className="mt-2 text-sm text-alarm" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
