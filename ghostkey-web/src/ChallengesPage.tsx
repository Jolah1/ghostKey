/**
 * Savings challenges: optional, no penalty, nobody told. Three parts:
 * the ones going (progress and Stop), the ones you can start (each opens
 * a tiny form), and badges for the ones you finished.
 *
 * The server works out all progress from real deposits, spends and goals
 * (challenges.rs); this page only shows it and sends join / stop.
 */
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import type { Route } from "./App";
import {
  ApiError,
  api,
  type ChallengeKind,
  type ChallengeView,
  type JoinChallenge,
  type SavingsGoalView,
} from "./api";
import { Button } from "./ui";
import { formatAmount, useUnit } from "./units";
import { parseAmount } from "./bip21";
import { HOLD_MONTHS, WEEK1_PRESETS, WEEK52_UNITS, challengeName, challengeStatus } from "./challenges";
import { getActiveVaultId, getVaultOwnerToken } from "./vaultStore";

const MONTH_LETTERS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];

const OFFERS: { kind: ChallengeKind; title: string; blurb: string }[] = [
  {
    kind: "week52",
    title: "52-week challenge",
    blurb: "Save a little more each week for a year. Miss a week and catch up later.",
  },
  {
    kind: "hold",
    title: "Don't touch it",
    blurb: "Leave your bitcoin where it is for 3, 6 or 12 months.",
  },
  {
    kind: "every_month",
    title: "Save every month",
    blurb: "Add something every month from now to December. Any amount counts.",
  },
  {
    kind: "goal_by_date",
    title: "Hit a goal by its date",
    blurb: "Turn a goal with an amount and a date into a challenge.",
  },
];

function chipClass(on: boolean): string {
  return `rounded-full border px-3 py-1.5 text-sm transition-colors ${
    on
      ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_18%,transparent)] font-medium text-[var(--text)]"
      : "border-app text-[var(--text)] hover:bg-[var(--surface-2)]"
  }`;
}

export function ChallengesPage({ onNavigate }: { onNavigate: (r: Route) => void }) {
  const vaultId = useMemo(() => getActiveVaultId(), []);
  const ownerToken = useMemo(() => (vaultId ? getVaultOwnerToken(vaultId) : null), [vaultId]);
  const [challenges, setChallenges] = useState<ChallengeView[] | null>(null);
  const [goals, setGoals] = useState<SavingsGoalView[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!vaultId) return;
    try {
      const [c, s] = await Promise.all([
        api.getChallenges(vaultId, ownerToken),
        api.getSavings(vaultId, ownerToken).catch(() => null),
      ]);
      setChallenges(c.challenges);
      setGoals(s?.goals ?? []);
    } catch {
      setError("Couldn't load your challenges. Try again in a moment.");
    }
  }, [vaultId, ownerToken]);

  useEffect(() => {
    void load();
  }, [load]);

  const going = (challenges ?? []).filter((c) => c.state === "going");
  const badges = (challenges ?? []).filter((c) => c.state === "done");
  const offers = OFFERS.filter((o) => !going.some((c) => c.kind === o.kind));
  const goalTitle = (id: string | null) => goals.find((g) => g.id === id)?.title ?? null;

  return (
    <main className="bg-app fade-in">
      <div className="mx-auto max-w-2xl px-5 py-10 md:py-14">
        <button
          type="button"
          onClick={() => onNavigate("dashboard")}
          className="text-sm text-muted underline hover:text-[var(--text)]"
        >
          ← Back to home
        </button>
        <h1 className="mt-4 font-serif text-3xl">Challenges</h1>
        <p className="mt-2 text-sm text-muted">
          Optional. Stop any time: nothing happens to your money and nobody is told.
        </p>

        {!vaultId ? (
          <p className="mt-10 text-sm text-muted">Open your dashboard first.</p>
        ) : error ? (
          <p className="mt-10 text-sm text-alarm" role="alert">
            {error}
          </p>
        ) : challenges == null ? (
          <p className="mt-10 text-sm text-muted">Loading…</p>
        ) : (
          <>
            {going.length > 0 ? (
              <section className="mt-8" aria-labelledby="going-h">
                <h2 id="going-h" className="text-xs uppercase tracking-wider text-dim">
                  Going
                </h2>
                <ul className="mt-3 space-y-3">
                  {going.map((c) => (
                    <GoingCard
                      key={c.id}
                      c={c}
                      name={challengeName(c, goalTitle(c.goal_id))}
                      vaultId={vaultId}
                      ownerToken={ownerToken}
                      onList={setChallenges}
                    />
                  ))}
                </ul>
              </section>
            ) : null}

            {offers.length > 0 ? (
              <section className="mt-8" aria-labelledby="start-h">
                <h2 id="start-h" className="text-xs uppercase tracking-wider text-dim">
                  Start one
                </h2>
                <ul className="mt-3 space-y-3">
                  {offers.map((o) => (
                    <Offer
                      key={o.kind}
                      offer={o}
                      goals={goals}
                      vaultId={vaultId}
                      ownerToken={ownerToken}
                      onList={setChallenges}
                    />
                  ))}
                </ul>
              </section>
            ) : null}

            {badges.length > 0 ? (
              <section className="mt-8" aria-labelledby="badges-h">
                <h2 id="badges-h" className="text-xs uppercase tracking-wider text-dim">
                  Badges
                </h2>
                <ul className="mt-3 space-y-2">
                  {badges.map((c) => (
                    <li key={c.id} className="flex items-center gap-3" data-testid="badge">
                      <span
                        aria-hidden="true"
                        className="grid h-8 w-8 place-items-center rounded-full bg-[color-mix(in_srgb,var(--accent)_22%,transparent)] text-accent"
                      >
                        ✓
                      </span>
                      <span className="text-sm">
                        <span className="font-medium">{challengeName(c, goalTitle(c.goal_id))}</span>
                        <span className="text-muted">
                          {" "}
                          · finished{" "}
                          {new Date(c.completed_at!).toLocaleDateString("en-GB", {
                            day: "numeric",
                            month: "short",
                            year: "numeric",
                          })}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </>
        )}
      </div>
    </main>
  );
}

function GoingCard({
  c,
  name,
  vaultId,
  ownerToken,
  onList,
}: {
  c: ChallengeView;
  name: string;
  vaultId: string;
  ownerToken: string | null;
  onList: (l: ChallengeView[]) => void;
}) {
  const unit = useUnit();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function stop() {
    setBusy(true);
    setError(null);
    try {
      onList((await api.stopChallenge(vaultId, ownerToken, c.id)).challenges);
    } catch {
      setError("Couldn't stop it. Try again.");
      setBusy(false);
    }
  }

  return (
    <li className="card-flat p-4" data-testid="challenge-going">
      <p className="font-medium">{name}</p>
      {c.kind === "every_month" && c.months ? (
        <ol className="mt-3 flex gap-1.5" aria-label="Months">
          {c.months.map((ticked, i) => {
            const counts = i + 1 >= (c.from_month ?? 1);
            return (
              <li
                key={i}
                aria-label={`${new Date(2000, i, 1).toLocaleDateString("en-GB", { month: "long" })}: ${
                  !counts ? "before you joined" : ticked ? "saved" : "not yet"
                }`}
                className={`grid h-7 w-7 place-items-center rounded-full text-[11px] ${
                  ticked && counts
                    ? "bg-[var(--accent)] font-semibold text-[var(--bg)]"
                    : counts
                      ? "border border-app text-muted"
                      : "text-dim opacity-50"
                }`}
              >
                {MONTH_LETTERS[i]}
              </li>
            );
          })}
        </ol>
      ) : (
        <div
          className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--surface-2)]"
          role="progressbar"
          aria-label={name}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={c.pct}
        >
          <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${c.pct}%` }} />
        </div>
      )}
      <p className="mt-2 text-sm text-muted" data-testid="challenge-status">
        {challengeStatus(c, unit, new Date())}
      </p>
      {error ? (
        <p className="mt-2 text-sm text-alarm" role="alert">
          {error}
        </p>
      ) : null}
      {confirm ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <span>Stop this challenge?</span>
          <Button variant="ghost" onClick={() => void stop()} loading={busy}>
            Yes, stop
          </Button>
          <Button variant="ghost" onClick={() => setConfirm(false)} disabled={busy}>
            Keep going
          </Button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirm(true)}
          className="mt-3 text-xs text-muted underline-offset-2 hover:underline"
        >
          Stop
        </button>
      )}
    </li>
  );
}

function Offer({
  offer,
  goals,
  vaultId,
  ownerToken,
  onList,
}: {
  offer: (typeof OFFERS)[number];
  goals: SavingsGoalView[];
  vaultId: string;
  ownerToken: string | null;
  onList: (l: ChallengeView[]) => void;
}) {
  const unit = useUnit();
  const ownId = useId();
  const [open, setOpen] = useState(false);
  const [months, setMonths] = useState<number>(6);
  const [goalId, setGoalId] = useState<string>("");
  const [week1, setWeek1] = useState<number | null>(WEEK1_PRESETS[0]);
  const [own, setOwn] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const today = new Date().toISOString().slice(0, 10);
  const eligible = goals.filter((g) => g.amount_sat != null && g.target_date != null && g.target_date >= today);
  const monthName = new Date().toLocaleDateString("en-GB", { month: "long" });

  async function start() {
    let join: JoinChallenge;
    if (offer.kind === "hold") join = { kind: "hold", hold_months: months };
    else if (offer.kind === "goal_by_date") {
      if (!goalId) return setError("Pick a goal.");
      join = { kind: "goal_by_date", goal_id: goalId };
    } else if (offer.kind === "week52") {
      let w = week1;
      if (own.trim()) {
        const p = parseAmount(own, unit);
        if (p === "invalid" || p == null) return setError("Enter an amount, like 1,500.");
        w = p;
      }
      if (w == null || w < 100) return setError("Week 1 needs to be at least 100 sats.");
      join = { kind: "week52", week1_sat: w };
    } else join = { kind: "every_month" };
    setBusy(true);
    setError(null);
    try {
      onList((await api.joinChallenge(vaultId, ownerToken, join)).challenges);
    } catch (e) {
      setError(e instanceof ApiError && e.message ? e.message : "Couldn't start it. Try again.");
      setBusy(false);
    }
  }

  const w1 = own.trim() ? (() => {
    const p = parseAmount(own, unit);
    return typeof p === "number" ? p : null;
  })() : week1;

  return (
    <li className="card-flat p-4" data-testid={`offer-${offer.kind}`}>
      <p className="font-medium">{offer.title}</p>
      <p className="mt-1 text-sm text-muted">{offer.blurb}</p>
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-3 text-sm font-medium text-accent underline-offset-2 hover:underline"
        >
          Start
        </button>
      ) : (
        <div className="mt-4 space-y-3">
          {offer.kind === "hold" ? (
            <div className="flex flex-wrap gap-2" role="group" aria-label="How long">
              {HOLD_MONTHS.map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={months === m}
                  onClick={() => setMonths(m)}
                  className={chipClass(months === m)}
                >
                  {m} months
                </button>
              ))}
            </div>
          ) : null}

          {offer.kind === "every_month" ? (
            <p className="text-sm">From {monthName} to December. Any amount counts.</p>
          ) : null}

          {offer.kind === "goal_by_date" ? (
            eligible.length === 0 ? (
              <p className="text-sm text-muted">
                First give a goal an amount and a date. You can do that on Home.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2" role="group" aria-label="Which goal">
                {eligible.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    aria-pressed={goalId === g.id}
                    onClick={() => setGoalId(g.id)}
                    className={chipClass(goalId === g.id)}
                  >
                    {g.title}
                  </button>
                ))}
              </div>
            )
          ) : null}

          {offer.kind === "week52" ? (
            <>
              <div className="flex flex-wrap gap-2" role="group" aria-label="Week 1">
                {WEEK1_PRESETS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    aria-pressed={!own.trim() && week1 === p}
                    onClick={() => {
                      setWeek1(p);
                      setOwn("");
                    }}
                    className={chipClass(!own.trim() && week1 === p)}
                  >
                    {formatAmount(p, unit)}
                  </button>
                ))}
              </div>
              <div>
                <label htmlFor={ownId} className="block text-sm font-medium">
                  Or type your own week 1
                </label>
                <input
                  id={ownId}
                  className="input mt-1 w-full"
                  inputMode="decimal"
                  value={own}
                  onChange={(e) => setOwn(e.target.value)}
                />
              </div>
              {w1 != null && w1 > 0 ? (
                <p className="text-sm text-muted" data-testid="week52-plan">
                  Week 1: {formatAmount(w1, unit)}. Week 52: {formatAmount(w1 * 52, unit)}. All year:{" "}
                  {formatAmount(w1 * WEEK52_UNITS, unit)}.
                </p>
              ) : null}
            </>
          ) : null}

          {error ? (
            <p className="text-sm text-alarm" role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {offer.kind === "goal_by_date" && eligible.length === 0 ? null : (
              <Button onClick={() => void start()} loading={busy}>
                Start challenge
              </Button>
            )}
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}
