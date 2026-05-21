import { useEffect, useMemo, useState } from "react";
import {
  ApiError,
  api,
  type VaultListItem,
  type VaultStatus,
  type VaultView,
} from "./api";
import { countdown, parseRfc, severityFromDeadline } from "./time";

interface Props {
  summary: VaultListItem;
  onOpen: (detail: VaultView) => void;
  /** Called once the server has acknowledged a check-in. */
  onAfterCheckin: () => void;
}

export function VaultCard({ summary, onOpen, onAfterCheckin }: Props) {
  const [detail, setDetail] = useState<VaultView | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [now, setNow] = useState<Date>(new Date());
  const [busy, setBusy] = useState<"idle" | "checking-in">("idle");
  const [actionError, setActionError] = useState<string | null>(null);

  // Pull the detailed view once on mount, and again whenever the
  // summary's deadline changes (i.e. after a check-in or alarm).
  useEffect(() => {
    let alive = true;
    api
      .getVault(summary.id)
      .then((d) => {
        if (alive) setDetail(d);
      })
      .catch((e) => {
        if (alive) {
          setDetailError(e instanceof ApiError ? e.message : String(e));
        }
      });
    return () => {
      alive = false;
    };
  }, [summary.id, summary.next_deadline_at, summary.status]);

  // 1Hz tick for the countdown. Cheap and locally scoped to this card.
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const deadline = useMemo(
    () => parseRfc(summary.next_deadline_at),
    [summary.next_deadline_at],
  );
  const cd = useMemo(() => countdown(deadline, now), [deadline, now]);
  const severity = useMemo(
    () =>
      severityFromDeadline(cd, detail?.grace_period_secs ?? 0),
    [cd, detail?.grace_period_secs],
  );
  // Server status wins over our local derivation if it's stricter
  // (e.g. the scheduler has already transitioned to `alarmed`).
  const effective: VaultStatus =
    summary.status === "ok" ? severity : summary.status;

  async function checkin() {
    setBusy("checking-in");
    setActionError(null);
    try {
      await api.checkin(summary.id);
      onAfterCheckin();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("idle");
    }
  }

  return (
    <article className="flex h-full flex-col rounded border border-zinc-800 bg-zinc-900/40 p-4">
      <header className="flex items-start justify-between">
        <div>
          <h2 className="font-medium">
            {summary.label ?? <em className="text-zinc-500">(no label)</em>}
          </h2>
          <p className="font-mono text-[11px] text-zinc-500">{summary.id}</p>
        </div>
        <StatusPill status={effective} />
      </header>

      <div className="mt-4 flex items-baseline gap-2">
        <span
          className={`font-mono text-2xl tabular-nums ${
            cd.ms < 0 ? "text-alarmed" : "text-zinc-100"
          }`}
        >
          {cd.pretty}
        </span>
        <span className="text-xs text-zinc-500">
          {cd.ms < 0 ? "past deadline" : "until deadline"}
        </span>
      </div>

      {detailError && (
        <p className="mt-2 text-xs text-red-300">{detailError}</p>
      )}
      {detail && (
        <p className="mt-2 text-xs text-zinc-500">
          {detail.network} · timelock {detail.timelock_blocks} blocks ·
          cadence {detail.checkin_period_secs}s + {detail.grace_period_secs}s
        </p>
      )}

      {actionError && (
        <p className="mt-2 text-xs text-red-300">{actionError}</p>
      )}

      <div className="mt-auto flex items-center gap-2 pt-4">
        <button
          onClick={checkin}
          disabled={busy !== "idle"}
          className="rounded bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy === "checking-in" ? "Checking in…" : "Check in"}
        </button>
        <button
          onClick={() => detail && onOpen(detail)}
          disabled={detail === null}
          className="rounded border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Details
        </button>
      </div>
    </article>
  );
}

function StatusPill({ status }: { status: VaultStatus }) {
  const palette: Record<VaultStatus, string> = {
    ok: "bg-ok/15 text-ok",
    warning: "bg-warning/15 text-warning",
    alarmed: "bg-alarmed/15 text-alarmed",
    timelock_started: "bg-alarmed/15 text-alarmed",
    claimed: "bg-zinc-700/40 text-zinc-300",
  };
  return (
    <span
      className={`inline-block rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${palette[status]}`}
    >
      {status}
    </span>
  );
}
