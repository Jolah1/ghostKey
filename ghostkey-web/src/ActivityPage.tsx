/**
 * Full activity history — its own page, not a modal.
 *
 * The dashboard shows a single calm "Recent activity" card; tapping it
 * lands here for the whole story. Events span every heir in the account
 * (best-effort per sibling) and carry the money/mechanics detail the
 * server records — amounts, and the on-chain transaction id with a
 * tap-through to a public block explorer.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import type { Route } from "./App";
import { api, type VaultEvent } from "./api";
import {
  getActiveVaultId,
  getVaultMeta,
  getVaultOwnerToken,
  getVaultsByGroup,
} from "./vaultStore";
import { Button, friendlyEventKind, shortAddr } from "./ui";
import { formatBtc } from "./fiat";

/** A vault event tagged with which heir it belongs to, so a multi-heir
 *  account reads as one merged feed without hiding anything. */
type ActivityEvent = VaultEvent & { heirName?: string };

interface ExplorerLink {
  name: string;
  url: string;
}

/** Public block-explorer links for a txid. We offer more than one where
 *  possible, so a single provider being down (mempool.space has outages)
 *  still leaves a working way to view the transaction. Empty for networks
 *  with no public explorer (regtest / unknown). */
function explorerLinks(network: string, txid: string): ExplorerLink[] {
  switch (network.toLowerCase()) {
    case "bitcoin":
    case "mainnet":
      return [
        { name: "mempool.space", url: `https://mempool.space/tx/${txid}` },
        { name: "Blockstream", url: `https://blockstream.info/tx/${txid}` },
      ];
    case "testnet":
      return [
        { name: "mempool.space", url: `https://mempool.space/testnet/tx/${txid}` },
        { name: "Blockstream", url: `https://blockstream.info/testnet/tx/${txid}` },
      ];
    case "signet":
      // Blockstream has no signet explorer; mempool.space only.
      return [
        { name: "mempool.space", url: `https://mempool.space/signet/tx/${txid}` },
      ];
    default:
      return [];
  }
}

/** Narrow an event's free-form detail JSON to a plain object. */
function detailOf(e: ActivityEvent): Record<string, unknown> {
  return e.detail && typeof e.detail === "object"
    ? (e.detail as Record<string, unknown>)
    : {};
}
function num(d: Record<string, unknown>, k: string): number | null {
  return typeof d[k] === "number" ? (d[k] as number) : null;
}
function str(d: Record<string, unknown>, k: string): string | null {
  return typeof d[k] === "string" && d[k] ? (d[k] as string) : null;
}

/** One plain-language line about the money/mechanics of an event, or null
 *  when the title already says everything. */
function detailLine(e: ActivityEvent): string | null {
  const d = detailOf(e);
  switch (e.kind) {
    case "received": {
      const amt = num(d, "amount_sat");
      return amt != null ? `${formatBtc(amt)} in` : null;
    }
    case "owner_send": {
      const sent = num(d, "sent_sat");
      const left = num(d, "remaining_sat");
      if (sent != null && left != null)
        return `Sent ${formatBtc(sent)} · ${formatBtc(left)} left`;
      return sent != null ? `Sent ${formatBtc(sent)}` : null;
    }
    case "checkin":
      return str(d, "source") === "lightning" ? "via Lightning" : null;
    case "panic_activated":
      return str(d, "source") === "lightning" ? "via Lightning" : null;
    case "claim_broadcast":
    case "claim_psbt_built": {
      const total = num(d, "total_input_sats");
      return total != null ? `${formatBtc(total)} claimed` : null;
    }
    default:
      return null;
  }
}

/** The on-chain txid an event references, if any. */
function txidOf(e: ActivityEvent): string | null {
  return str(detailOf(e), "txid");
}

/** Green for good news, red for a missed check-in, amber for the rest —
 *  the same semantics as the dashboard's inline dots. */
function dotClass(kind: string): string {
  if (
    kind === "checkin" ||
    kind === "resolved" ||
    kind === "received" ||
    kind === "drill_completed"
  )
    return "bg-ok";
  if (kind === "alarm") return "bg-alarm";
  return "bg-warning";
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function ActivityPage({
  onNavigate,
}: {
  onNavigate: (r: Route) => void;
}) {
  const activeId = useMemo(() => getActiveVaultId(), []);
  const meta = useMemo(
    () => (activeId ? getVaultMeta(activeId) : null),
    [activeId],
  );
  const ownerToken = useMemo(
    () => (activeId ? getVaultOwnerToken(activeId) : null),
    [activeId],
  );
  const groupVaults = useMemo(() => {
    if (!meta) return [];
    if (!meta.groupId) return [meta];
    return getVaultsByGroup(meta.groupId);
  }, [meta]);
  const showHeir = groupVaults.length > 1;

  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [network, setNetwork] = useState<string>("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!activeId) {
      setLoading(false);
      return;
    }
    // Network drives the explorer links; a failure here just drops them.
    try {
      const v = await api.getVault(activeId, ownerToken);
      setNetwork(v.network);
    } catch {
      /* leave network empty → no explorer links */
    }
    const perHeir = await Promise.all(
      groupVaults.map((g) =>
        api
          .listEvents(g.id, getVaultOwnerToken(g.id))
          .then((evs): ActivityEvent[] =>
            evs.map((e) => ({ ...e, heirName: g.heir.name })),
          )
          .catch((): ActivityEvent[] => []),
      ),
    );
    // Newest first for a full-page read.
    setEvents(
      perHeir.flat().sort((a, b) => b.created_at.localeCompare(a.created_at)),
    );
    setLoading(false);
  }, [activeId, ownerToken, groupVaults]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="bg-app fade-in">
      <div className="mx-auto max-w-2xl px-5 py-10 md:py-14">
        <button
          type="button"
          onClick={() => onNavigate("dashboard")}
          className="text-sm text-muted underline hover:text-[var(--text)]"
        >
          ← Back to dashboard
        </button>

        <h1 className="mt-4 font-serif text-3xl">Activity</h1>
        <p className="mt-2 text-sm text-muted">
          {showHeir
            ? "Everything that has happened across your heirs."
            : "Everything that has happened with your vault."}
        </p>

        {!activeId ? (
          <div className="mt-10">
            <p className="text-sm text-muted">
              Open your dashboard first to see your activity.
            </p>
            <div className="mt-4">
              <Button onClick={() => onNavigate("dashboard")}>
                Go to dashboard
              </Button>
            </div>
          </div>
        ) : loading ? (
          <p className="mt-10 text-sm text-muted">Loading…</p>
        ) : events.length === 0 ? (
          <p className="mt-10 text-sm text-muted">Nothing yet.</p>
        ) : (
          <ul
            role="list"
            className="mt-8 divide-y divide-[var(--border)]"
          >
            {events.map((e) => {
              const line = detailLine(e);
              const txid = txidOf(e);
              const links = txid ? explorerLinks(network, txid) : [];
              return (
                <li key={`${e.vault_id}:${e.id}`} className="py-4">
                  <div className="flex items-start gap-3 text-sm">
                    <span
                      aria-hidden="true"
                      className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dotClass(
                        e.kind,
                      )}`}
                    />
                    <div className="min-w-0 flex-1">
                      <p>
                        {showHeir && e.heirName ? (
                          <span className="text-dim">{e.heirName} · </span>
                        ) : null}
                        <strong className="font-semibold text-[var(--text)]">
                          {friendlyEventKind(e.kind)}
                        </strong>
                      </p>
                      {line ? (
                        <p className="mt-0.5 text-muted">{line}</p>
                      ) : null}
                      {txid ? (
                        <p className="mt-1 font-mono text-xs text-dim">
                          txid {shortAddr(txid)}
                          {links.length > 0 ? (
                            <span>
                              {" · open in "}
                              {links.map((lnk, i) => (
                                <span key={lnk.name}>
                                  {i > 0 ? " · " : ""}
                                  <a
                                    href={lnk.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="underline hover:text-[var(--text)]"
                                  >
                                    {lnk.name} ↗
                                  </a>
                                </span>
                              ))}
                            </span>
                          ) : null}
                        </p>
                      ) : null}
                    </div>
                    <span className="shrink-0 font-mono text-xs text-dim">
                      {formatWhen(e.created_at)}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </main>
  );
}
