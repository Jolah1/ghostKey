/**
 * Small sats / BTC switch (#375), and beside it $ / ₦ for the small line
 * under amounts. Both choices are remembered on this device and every
 * amount on screen follows them straight away.
 */
import { setFiat, setUnit, useFiat, useUnit, type Fiat, type Unit } from "./units";

const FIATS: { id: Fiat; label: string; name: string }[] = [
  { id: "usd", label: "$", name: "US dollars" },
  { id: "ngn", label: "₦", name: "Naira" },
];

const OPTIONS: { id: Unit; label: string }[] = [
  { id: "sats", label: "sats" },
  { id: "btc", label: "BTC" },
];

export function UnitToggle() {
  const unit = useUnit();
  const fiat = useFiat();
  return (
    <div className="inline-flex items-center gap-1.5">
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
    <div
      role="group"
      aria-label="Show value in"
      className="inline-flex rounded-full border border-app p-0.5 text-xs"
    >
      {FIATS.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={fiat === o.id}
          aria-label={o.name}
          title={o.name}
          onClick={() => setFiat(o.id)}
          className={`rounded-full px-2.5 py-0.5 ${
            fiat === o.id ? "bg-[var(--accent-tint)] text-[var(--text)]" : "text-muted"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
    </div>
  );
}
