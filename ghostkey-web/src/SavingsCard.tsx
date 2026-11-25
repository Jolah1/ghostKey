/**
 * Savings card (#367): your goals up front (several at once, see
 * Goals.tsx), and behind "Savings details" your year in savings, save
 * reminders and recent deposits.
 *
 * Borrowed from PiggyVest's Target Savings: "What are you saving for?",
 * an optional amount and date, a progress bar, and a "save about X a
 * week" line. Not borrowed: anything that pulls money or penalises.
 */
import { useId, useState } from "react";
import { ApiError, api, type SavingsView } from "./api";
import { Button } from "./ui";
import { formatAmount, useUnit } from "./units";
import { parseAmount, satsToBip21Btc } from "./bip21";
import { GoalsSection } from "./Goals";

function longDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/**
 * The goal, the year, save reminders and recent deposits. It sits inside
 * the dashboard's savings hero, which owns the data: the hero fetches the
 * savings view and the balance once and shares them with the headline.
 */
export function SavingsCard({
  vaultId,
  ownerToken,
  view,
  onView,
  balanceSat,
  balanceHidden = false,
}: {
  vaultId: string;
  ownerToken: string | null;
  view: SavingsView;
  onView: (v: SavingsView) => void;
  /** Null while the balance loads, or when it couldn't be read. */
  balanceSat: number | null;
  /** The owner hid their balance on this device, so progress stays hidden too. */
  balanceHidden?: boolean;
}) {
  const unit = useUnit();
  const [saving, setSaving] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const cadenceId = useId();
  const remAmountId = useId();
  const [remEditing, setRemEditing] = useState(false);
  const [cadence, setCadence] = useState<"weekly" | "monthly">("weekly");
  const [remAmount, setRemAmount] = useState("");
  const [remError, setRemError] = useState<string | null>(null);


  function startReminder() {
    setCadence(view?.reminder?.cadence ?? "weekly");
    const a = view?.reminder?.amount_sat;
    setRemAmount(a ? (unit === "btc" ? satsToBip21Btc(a) : String(a)) : "");
    setRemError(null);
    setRemEditing(true);
  }

  async function saveReminder() {
    const parsed = parseAmount(remAmount, unit);
    if (parsed === "invalid") {
      setRemError(unit === "btc" ? "Enter an amount like 0.001." : "Enter a whole number of sats.");
      return;
    }
    setSaving(true);
    setRemError(null);
    try {
      onView(await api.setSavingsReminder(vaultId, ownerToken, { cadence, amount_sat: parsed }));
      setRemEditing(false);
    } catch (e) {
      setRemError(e instanceof ApiError && e.message ? e.message : "Couldn't save that. Try again.");
    } finally {
      setSaving(false);
    }
  }

  async function stopReminder() {
    setSaving(true);
    try {
      await api.clearSavingsReminder(vaultId, ownerToken);
      onView({ ...view, reminder: null });
      setRemEditing(false);
    } catch (e) {
      setRemError(e instanceof ApiError && e.message ? e.message : "Couldn't stop it. Try again.");
    } finally {
      setSaving(false);
    }
  }

  const year = view.this_year;
  const reminder = view.reminder;
  const deposits = showAll ? view.deposits : view.deposits.slice(0, 5);

  return (
    <div data-testid="savings-card">
      <GoalsSection
        vaultId={vaultId}
        ownerToken={ownerToken}
        view={view}
        onView={onView}
        balanceSat={balanceSat}
        balanceHidden={balanceHidden}
      />

      {/* Everything else sits behind one link, so the card stays calm:
          balance, goals, and the one thing to do (Add money). */}
      <button
        type="button"
        onClick={() => setShowDetails((d) => !d)}
        aria-expanded={showDetails}
        className="mt-5 text-xs text-muted underline underline-offset-2 hover:text-[var(--text)]"
      >
        {showDetails ? "Hide details" : "Savings details"}
      </button>

      {showDetails ? (
      <div data-testid="savings-details">
      {/* Your year in savings: only shown once there's something to say. */}
      {year && year.deposit_count > 0 ? (
        <p className="mt-5 text-sm" data-testid="savings-year">
          <span className="font-semibold">Your {year.year} in savings:</span>{" "}
          <span className="text-muted">
            {formatAmount(year.total_sat, unit)} in {year.deposit_count} deposit
            {year.deposit_count === 1 ? "" : "s"}
            {year.best_month
              ? `. Best month: ${new Date(year.year, year.best_month - 1, 1).toLocaleDateString(undefined, { month: "long" })}`
              : ""}
            .
          </span>
        </p>
      ) : null}

      {/* Save reminders: the honest version of autosave. We can't pull
          bitcoin, so we remind, by email, on the owner's schedule. */}
      <div className="mt-5 border-t border-app pt-4" data-testid="savings-reminder">
        {remEditing ? (
          <div className="space-y-3">
            <div>
              <label htmlFor={cadenceId} className="block text-sm font-medium">
                Remind me to save
              </label>
              <select
                id={cadenceId}
                className="input mt-1 w-full"
                value={cadence}
                onChange={(e) => setCadence(e.target.value as "weekly" | "monthly")}
              >
                <option value="weekly">Every week</option>
                <option value="monthly">Every month</option>
              </select>
            </div>
            <div>
              <label htmlFor={remAmountId} className="block text-sm font-medium">
                How much each time (optional, in {unit === "btc" ? "BTC" : "sats"})
              </label>
              <input
                id={remAmountId}
                className="input mt-1 w-full"
                inputMode="decimal"
                placeholder={unit === "btc" ? "e.g. 0.001" : "e.g. 50,000"}
                value={remAmount}
                onChange={(e) => setRemAmount(e.target.value)}
              />
            </div>
            {remError ? (
              <p className="text-sm text-alarm" role="alert">
                {remError}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => void saveReminder()} loading={saving}>
                Save reminder
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setRemEditing(false)} disabled={saving}>
                Cancel
              </Button>
              {reminder ? (
                <Button size="sm" variant="ghost" onClick={() => void stopReminder()} disabled={saving}>
                  Stop reminders
                </Button>
              ) : null}
            </div>
          </div>
        ) : reminder ? (
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-sm text-muted">
              We&apos;ll remind you to save {reminder.cadence === "weekly" ? "every week" : "every month"}
              {reminder.amount_sat ? ` (about ${formatAmount(reminder.amount_sat, unit)})` : ""}. Next on{" "}
              {longDate(reminder.next_at)}.
            </p>
            <button
              type="button"
              onClick={startReminder}
              className="shrink-0 text-xs text-muted underline-offset-2 hover:underline"
            >
              Change
            </button>
          </div>
        ) : (
          <div>
            <p className="text-sm text-muted">
              Want a nudge? We can email you a reminder to save, weekly or
              monthly. Skipping one is fine: nothing happens.
            </p>
            <div className="mt-2">
              <Button size="sm" variant="ghost" onClick={startReminder}>
                Remind me to save
              </Button>
            </div>
          </div>
        )}
        {reminder && !view.owner_email_confirmed ? (
          <p className="mt-2 text-xs text-dim">
            Reminders go to your email once you&apos;ve confirmed it. Check your
            inbox for our confirmation link.
          </p>
        ) : null}
      </div>

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
      </div>
      ) : null}
    </div>
  );
}
