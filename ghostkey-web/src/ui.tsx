/**
 * Reusable UI primitives.
 *
 * Every portal in v1 redefined its own Field, Card, friendlyKind,
 * prettyCadence, StatusDot, etc. They now live here and the portals
 * import them. Keeps each screen file focused on its content and lets
 * the visual language stay consistent.
 *
 * Nothing here owns business state; primitives are presentational.
 */
import { useEffect, useRef, useState } from "react";
import type { ReactNode, ButtonHTMLAttributes } from "react";

/* ----------------------------- Button ------------------------------- */

type Variant = "primary" | "ghost" | "quiet";

interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: "sm" | "md" | "lg";
  loading?: boolean;
}

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  disabled,
  children,
  className = "",
  ...rest
}: BtnProps) {
  const sizeCls =
    size === "lg" ? "px-7 py-3.5 text-base" : size === "sm" ? "px-3 py-1.5 text-xs" : "";
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`btn btn-${variant} ${sizeCls} ${className}`}
    >
      {loading ? <Spinner /> : null}
      {children}
    </button>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-r-transparent"
    />
  );
}

/* ----------------------------- Field -------------------------------- */

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="mb-5">
      <label htmlFor={htmlFor} className="field-label">
        {label}
      </label>
      {children}
      {error ? (
        <p className="mt-2 text-xs text-alarm" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="mt-2 text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

/* ------------------------------ Tile -------------------------------- */

export function Tile({
  selected,
  onClick,
  title,
  sub,
  disabled,
}: {
  selected: boolean;
  onClick: () => void;
  title: string;
  sub?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-selected={selected || undefined}
      className="tile"
      aria-pressed={selected}
    >
      <span className="tile-title">{title}</span>
      {sub ? <span className="tile-sub">{sub}</span> : null}
    </button>
  );
}

/* --------------------------- Progress bar --------------------------- */

export function ProgressBar({
  value,
  label = "Progress",
}: {
  value: number;
  /** Accessible name — role="progressbar" is meaningless to a screen
   *  reader without one (axe: aria-progressbar-name, WCAG 1.1.1). */
  label?: string;
}) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      className="h-[3px] w-full overflow-hidden rounded-full bg-[var(--border)]"
    >
      <div
        className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-500"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/* ----------------------------- Status pill -------------------------- */

export type Tone = "ok" | "warning" | "alarm" | "neutral";

export function StatusPill({ tone, label }: { tone: Tone; label: string }) {
  const cls =
    tone === "ok" ? "pill-ok"
    : tone === "warning" ? "pill-warning"
    : tone === "alarm" ? "pill-alarm"
    : "pill-neutral";
  return (
    <span className={`pill ${cls}`}>
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 rounded-full bg-current"
      />
      {label}
    </span>
  );
}

/* ------------------------- Section eyebrow -------------------------- */

export function Eyebrow({
  children,
  dim = false,
}: {
  children: ReactNode;
  dim?: boolean;
}) {
  return <p className={dim ? "eyebrow-dim" : "eyebrow"}>{children}</p>;
}

/* --------------------------- Disclosure ----------------------------- */

export function Disclosure({
  summary,
  children,
  defaultOpen = false,
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="card-flat overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm font-medium text-muted hover:text-[var(--text)]"
      >
        <span className="inline-flex items-center gap-2">{summary}</span>
        <Chevron open={open} />
      </button>
      <div
        className={`grid transition-[grid-template-rows] duration-300 ${
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
      >
        <div className="overflow-hidden">
          <div className="border-t border-app px-4 py-4">{children}</div>
        </div>
      </div>
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`h-4 w-4 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
      aria-hidden="true"
    >
      <path d="M5 8l5 5 5-5" />
    </svg>
  );
}

/* ------------------------ Toast / Inline alert ---------------------- */

export function InlineAlert({
  tone = "warning",
  children,
}: {
  tone?: Tone;
  children: ReactNode;
}) {
  const bg =
    tone === "alarm" ? "var(--alarm-tint)"
    : tone === "ok" ? "var(--ok-tint)"
    : tone === "warning" ? "var(--warning-tint)"
    : "var(--surface-2)";
  const color =
    tone === "alarm" ? "var(--alarm)"
    : tone === "ok" ? "var(--ok)"
    : tone === "warning" ? "var(--warning)"
    : "var(--text-muted)";
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-xl border border-app p-3 text-sm"
      style={{ background: bg, color }}
    >
      <span aria-hidden="true" className="mt-0.5">{tone === "ok" ? "✓" : "!"}</span>
      <div className="text-[var(--text)]">{children}</div>
    </div>
  );
}

/* ------------------------ Pulse heartbeat --------------------------- */

/**
 * Big circle with two animated concentric rings. Clickable; falls back
 * to plain circle under prefers-reduced-motion (handled in CSS).
 */
export function Heartbeat({
  onTap,
  disabled,
  size = 88,
}: {
  onTap?: () => void;
  disabled?: boolean;
  size?: number;
}) {
  return (
    <button
      type="button"
      onClick={onTap}
      disabled={disabled}
      aria-label="Check in"
      className="pulse-ring relative inline-flex items-center justify-center rounded-full transition-transform duration-150 focus:outline-none disabled:cursor-default"
      style={{
        width: size,
        height: size,
        border: "2.5px solid var(--accent)",
        background: "var(--accent-tint-2)",
        boxShadow: "0 0 36px -6px var(--accent-glow)",
      }}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--accent-text)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-7 w-7"
        aria-hidden="true"
      >
        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
      </svg>
    </button>
  );
}

/* ------------------------- Avatar (initial) ------------------------- */

export function Avatar({ name, size = 44 }: { name: string; size?: number }) {
  const initial = (name?.trim()?.charAt(0) || "?").toUpperCase();
  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 items-center justify-center rounded-full font-display font-bold"
      style={{
        width: size,
        height: size,
        background: "var(--accent-tint-2)",
        color: "var(--accent-text)",
        border: "1px solid var(--accent)",
        fontSize: size * 0.4,
      }}
    >
      {initial}
    </span>
  );
}

/* --------------------- usePolling / useTicker ----------------------- */

/**
 * Wall-clock ticker that pauses when the tab is hidden — no point
 * re-rendering once per second when no one's looking. Returns the
 * current Date.
 */
export function useTicker(intervalMs = 1000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let id: number | null = null;
    let alive = true;

    const start = () => {
      if (id !== null) return;
      id = window.setInterval(() => {
        if (alive) setNow(new Date());
      }, intervalMs);
    };
    const stop = () => {
      if (id !== null) {
        window.clearInterval(id);
        id = null;
      }
    };
    const onVis = () => {
      if (document.hidden) stop();
      else { setNow(new Date()); start(); }
    };

    start();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false;
      stop();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [intervalMs]);
  return now;
}

/**
 * Run `fn` on an interval, but only while the tab is visible.
 * Designed for light polling against the API. `fn` should be stable
 * (wrap in useCallback) or pass `deps` to refresh the interval.
 */
export function usePolling(
  fn: () => Promise<void> | void,
  intervalMs: number,
  deps: unknown[] = [],
) {
  const ref = useRef(fn);
  // Keep the ref pointing at the latest fn without retriggering the
  // interval effect below. Assigned in an effect (not during render)
  // so renders stay pure; commit order guarantees it runs before any
  // tick can observe it.
  useEffect(() => {
    ref.current = fn;
  });
  useEffect(() => {
    let alive = true;
    let id: number | null = null;
    const tick = async () => {
      if (!alive) return;
      try { await ref.current(); } catch { /* swallow */ }
    };
    const start = () => {
      if (id !== null) return;
      id = window.setInterval(tick, intervalMs);
    };
    const stop = () => { if (id !== null) { window.clearInterval(id); id = null; } };
    const onVis = () => {
      if (document.hidden) stop();
      else { void tick(); start(); }
    };
    start();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false;
      stop();
      document.removeEventListener("visibilitychange", onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, ...deps]);
}

/* ----------------------- Friendly formatters ------------------------ */

export function friendlyEventKind(kind: string): string {
  switch (kind) {
    case "registered": return "Vault activated";
    case "checkin": return "Checked in";
    case "warning": return "Reminder due soon";
    case "pre_deadline_reminder": return "Reminder sent";
    case "alarm": return "Missed check-in";
    case "resolved": return "Back on track";
    case "lightning_invoice_issued": return "Check-in invoice created";
    case "owner_send": return "You sent Bitcoin";
    case "vault_empty": return "Vault is empty";
    case "received": return "You received Bitcoin";
    case "owner_contact_verified": return "Email confirmed";
    case "timelock_started": return "Waiting period started";
    case "claim_issued": return "Claim link sent to your heir";
    case "claim_opened": return "Your heir opened the claim link";
    case "claim_psbt_built": return "Your heir prepared the transaction";
    case "claim_broadcast": return "Your heir broadcast the claim";
    case "claim_ready": return "Your heir can now claim";
    // Legacy event: older builds recorded this on every heir page
    // load. It never meant the owner checked in (that's "checkin").
    // It marks the heir being active on the claim. No longer emitted.
    case "claim_resolved": return "Your heir opened the claim page";
    case "panic_activated": return "Emergency freeze on";
    case "panic_expired": return "Emergency freeze ended";
    case "drill_started": return "Practice claim sent";
    case "drill_opened": return "Your heir opened the practice link";
    case "drill_completed": return "Your heir completed the practice claim";
    default:
      // Never show a raw database code (T4 #117). De-snake-case any
      // event we haven't named yet: "some_new_event" -> "Some new event".
      return kind
        .replace(/_/g, " ")
        .replace(/^\w/, (c) => c.toUpperCase());
  }
}

/**
 * Pretty short address ellipsis. "bc1q…f4a2" form.
 */
export function shortAddr(s: string): string {
  if (!s) return "";
  if (s.length <= 12) return s;
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}
