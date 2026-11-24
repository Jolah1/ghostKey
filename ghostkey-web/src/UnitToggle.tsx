/**
 * Small sats / BTC switch (#375). The choice is remembered on this device
 * and every amount on screen follows it straight away.
 */
import { setUnit, useUnit, type Unit } from "./units";

const OPTIONS: { id: Unit; label: string }[] = [
  { id: "sats", label: "sats" },
  { id: "btc", label: "BTC" },
];

export function UnitToggle() {
  const unit = useUnit();
  return (
    <div
      role="group"
      aria-label="Show amounts in"
      className="inline-flex rounded-full border border-app p-0.5 text-xs"
    >
      {OPTIONS.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={unit === o.id}
          onClick={() => setUnit(o.id)}
          className={`rounded-full px-2.5 py-0.5 ${
            unit === o.id
              ? "bg-[var(--accent-tint)] text-[var(--text)]"
              : "text-muted"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
