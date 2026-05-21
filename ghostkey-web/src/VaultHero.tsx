/**
 * The dashboard's "hero" card — used for the single most-urgent vault.
 *
 * Big sentence ("Your family is safe."), giant countdown, giant
 * "I'm OK today" button. This is the only thing a returning user
 * should need to see to feel reassured.
 */
import { useEffect, useMemo, useState } from "react";
import { Heart, Sparkles, MoreHorizontal } from "lucide-react";
import { ApiError, api, type VaultListItem, type VaultView } from "./api";
import { countdown, parseRfc } from "./time";
import { StatusPill } from "./StatusPill";
import { statusCopy } from "./vocab";

interface Props {
  summary: VaultListItem;
  detail: VaultView | null;
  onAfterCheckin: () => void;
  onOpenDetails: () => void;
}

export function VaultHero({
  summary,
  detail,
  onAfterCheckin,
  onOpenDetails,
}: Props) {
  const [now, setNow] = useState<Date>(new Date());
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [justCheckedIn, setJustCheckedIn] = useState(false);

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const deadline = useMemo(
    () => parseRfc(summary.next_deadline_at),
    [summary.next_deadline_at],
  );
  const cd = useMemo(() => countdown(deadline, now), [deadline, now]);
  const copy = statusCopy(summary.status);

  // Visual tone: take the worst of the server status and our local
  // "approaching deadline" derivation.
  const isOverdue = cd.ms <= 0;
  const tone =
    copy.tone === "ok" && isOverdue ? "warning" : copy.tone;
  const heroAccent =
    tone === "ok"
      ? "bg-lime"
      : tone === "warning"
        ? "bg-yellow"
        : tone === "alarmed"
          ? "bg-red"
          : "bg-paper";

  async function checkin() {
    setBusy(true);
    setActionError(null);
    try {
      await api.checkin(summary.id);
      setJustCheckedIn(true);
      window.setTimeout(() => setJustCheckedIn(false), 2400);
      onAfterCheckin();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-labelledby="vault-hero-title"
      className={`neo-card overflow-hidden p-0 ${
        tone === "ok" ? "" : tone === "alarmed" ? "animate-shake" : ""
      }`}
    >
      {/* Colored top band */}
      <div
        className={`flex items-center justify-between border-b-4 border-ink ${heroAccent} px-6 py-4 md:px-10`}
      >
        <div className="flex items-center gap-3">
          <StatusPill status={summary.status} size="lg" />
        </div>
        <div className="hidden md:block text-right text-[11px] font-bold uppercase tracking-widest">
          {summary.label ?? "Family savings"}
        </div>
      </div>

      {/* Hero body */}
      <div className="grid grid-cols-1 gap-10 px-6 py-10 md:grid-cols-2 md:px-10 md:py-14">
        <div>
          <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
            Status
          </p>
          <h2
            id="vault-hero-title"
            className="mt-2 font-display text-4xl font-bold leading-tight md:text-5xl"
          >
            {copy.longLabel}
          </h2>
          <p className="mt-4 text-lg leading-relaxed text-muted-foreground">
            {tone === "ok" && (
              <>
                Next reminder is{" "}
                <strong className="text-ink">{cd.friendly}</strong>. You don't
                need to do anything today.
              </>
            )}
            {tone === "warning" && (
              <>
                Tap below to reset the timer and let your family know you're
                still here.
              </>
            )}
            {tone === "alarmed" && (
              <>
                You missed a reminder. Tap below right now to reset everything
                — nothing has been lost yet.
              </>
            )}
            {tone === "neutral" && (
              <>This vault has already been claimed by your family.</>
            )}
          </p>
        </div>

        <div className="flex flex-col items-start gap-6 md:items-end">
          <div className="text-left md:text-right">
            <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
              Time until reminder
            </p>
            <p
              className={`mt-1 font-display tabular-nums font-bold ${
                cd.ms < 0 ? "text-red" : "text-ink"
              } text-5xl md:text-6xl`}
              aria-live="polite"
            >
              {cd.pretty}
            </p>
          </div>

          {tone !== "neutral" && (
            <button
              onClick={checkin}
              disabled={busy}
              className={`neo-button-lime w-full md:w-auto text-lg !px-8 !py-5 ${
                tone === "ok" ? "" : "animate-pulse-glow"
              }`}
            >
              {justCheckedIn ? (
                <>
                  <Sparkles className="h-5 w-5" /> Thanks — you're safe
                </>
              ) : busy ? (
                <>
                  <Heart className="h-5 w-5 animate-pulse" /> One sec…
                </>
              ) : (
                <>
                  <Heart className="h-5 w-5" fill="currentColor" /> I'm OK
                  today
                </>
              )}
            </button>
          )}
          {actionError && (
            <p className="text-sm font-medium text-red">
              {actionError}
            </p>
          )}
        </div>
      </div>

      {/* Footer strip */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t-4 border-ink bg-paper px-6 py-3 md:px-10">
        <p className="font-mono text-[11px] text-muted-foreground">
          {detail
            ? `${detail.network} · every ${prettyCadence(detail.checkin_period_secs)} + ${prettyCadence(detail.grace_period_secs)} grace`
            : "Loading details…"}
        </p>
        <button
          onClick={onOpenDetails}
          className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-muted-foreground hover:text-ink"
        >
          <MoreHorizontal className="h-4 w-4" /> Details & history
        </button>
      </div>
    </section>
  );
}

function prettyCadence(secs: number): string {
  if (secs >= 86400) return `${Math.round(secs / 86400)} day(s)`;
  if (secs >= 3600) return `${Math.round(secs / 3600)} hour(s)`;
  if (secs >= 60) return `${Math.round(secs / 60)} minute(s)`;
  return `${secs} second(s)`;
}
