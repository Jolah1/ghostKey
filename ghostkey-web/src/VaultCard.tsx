/**
 * Compact secondary vault card.
 *
 * Used in the dashboard below the hero when the user has more than one
 * vault. Same vocabulary and visual rules as the hero, but smaller and
 * grid-friendly.
 */
import { useEffect, useMemo, useState } from "react";
import { Heart, MoreHorizontal } from "lucide-react";
import {
  ApiError,
  api,
  type VaultListItem,
  type VaultView,
} from "./api";
import { countdown, parseRfc } from "./time";
import { StatusPill } from "./StatusPill";

interface Props {
  summary: VaultListItem;
  detail: VaultView | null;
  onOpen: () => void;
  onAfterCheckin: () => void;
}

export function VaultCard({ summary, detail, onOpen, onAfterCheckin }: Props) {
  const [now, setNow] = useState<Date>(new Date());
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const deadline = useMemo(
    () => parseRfc(summary.next_deadline_at),
    [summary.next_deadline_at],
  );
  const cd = useMemo(() => countdown(deadline, now), [deadline, now]);

  async function checkin() {
    setBusy(true);
    setActionError(null);
    try {
      await api.checkin(summary.id);
      onAfterCheckin();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="neo-card flex h-full flex-col p-5">
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-display text-lg font-bold leading-tight truncate">
            {summary.label ?? (
              <em className="not-italic text-muted-foreground">
                Family savings
              </em>
            )}
          </h3>
          {detail && (
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              {detail.network}
            </p>
          )}
        </div>
        <StatusPill status={summary.status} size="sm" />
      </header>

      <div className="mt-4">
        <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
          Time until reminder
        </p>
        <p
          className={`font-display tabular-nums text-3xl font-bold ${
            cd.ms < 0 ? "text-red" : "text-ink"
          }`}
        >
          {cd.pretty}
        </p>
        <p className="text-xs text-muted-foreground">{cd.friendly}</p>
      </div>

      {actionError && (
        <p className="mt-3 text-xs font-medium text-red">{actionError}</p>
      )}

      <div className="mt-auto flex items-center gap-2 pt-5">
        <button
          onClick={checkin}
          disabled={busy}
          className="neo-button-lime flex-1 !px-3 !py-2 text-sm"
        >
          <Heart className="h-4 w-4" fill="currentColor" />
          {busy ? "One sec…" : "I'm OK"}
        </button>
        <button
          onClick={onOpen}
          className="neo-button !px-3 !py-2 text-sm"
          aria-label="Open details"
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </div>
    </article>
  );
}
