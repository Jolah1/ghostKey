/**
 * Dashboard — the home of an active vault on this device.
 *
 * Reads the active vault id from localStorage, fetches the current
 * vault and event history, and renders:
 *
 *   - "You're still here" greeting + last check-in line
 *   - Heartbeat card with the tap-to-check-in CTA
 *   - Status grid (active / waiting period)
 *   - Heir card (from local store, since the API stores opaque text)
 *   - Recent activity
 *
 * If there is no active vault on this device, we offer the two paths
 * out: set one up, or sign in with email + password.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Avatar,
  Button,
  Heartbeat,
  StatusPill,
  friendlyEventKind,
  shortAddr,
  useTicker,
  usePolling,
} from "./ui";
import qrcode from "qrcode-generator";
import {
  ApiError,
  api,
  type VaultView,
  type VaultEvent,
  type VaultBalanceView,
  type VaultAddressView,
  type OwnerSendResponse,
  type HeirProfileView,
} from "./api";
import { countdown, parseRfc } from "./time";
import { AssistChat } from "./AssistChat";
import {
  getActiveVaultId,
  getVaultMeta,
  getVaultOwnerToken,
  getVaultsByGroup,
  removeVaultMeta,
  setActiveVaultId,
  type VaultMeta,
} from "./vaultStore";
import { LightningCheckin } from "./LightningCheckin";
import { AddHeirPortal } from "./AddHeirPortal";
import { ConfirmSend } from "./ConfirmSend";
import {
  addressMatchesNetwork,
  bech32PrefixFor,
  looksLikeBitcoinAddress,
} from "./address";
import {
  getPushSubscription,
  isPushSupported,
  subscribeToPush,
} from "./push";
import { unsealOwner } from "./crypto/sealing";
import { usePrice, btcAndUsd, satsToUsd, formatUsd } from "./fiat";
import type { Route } from "./App";

interface Props {
  onNavigate: (r: Route) => void;
}

export function Dashboard({ onNavigate }: Props) {
  const activeId = useMemo(() => getActiveVaultId(), []);
  const meta = useMemo(
    () => (activeId ? getVaultMeta(activeId) : null),
    [activeId],
  );
  // Owner token persists in localStorage from setup. If it's missing
  // (e.g. the user cleared their site data, or the vault was created
  // before per-vault auth shipped), the server will reject mutations
  // with 401. We surface that as an inline error rather than a silent
  // failure.
  const ownerToken = useMemo(
    () => (activeId ? getVaultOwnerToken(activeId) : null),
    [activeId],
  );
  // Multi-heir groups: if this vault has a `groupId`, look up all
  // sibling vaults on this device. The dashboard renders the group
  // as one card (Heart-beat targets the active vault; the check-in
  // button fans out to all siblings client-side so one tap resets
  // every heir's countdown).
  //
  // For legacy single-heir vaults, `groupId` is null and `groupVaults`
  // is just `[meta]`. The rendering paths handle both.
  const groupVaults = useMemo(() => {
    if (!meta) return [];
    if (!meta.groupId) return [meta];
    return getVaultsByGroup(meta.groupId);
  }, [meta]);

  const [vault, setVault] = useState<VaultView | null>(null);
  const [events, setEvents] = useState<VaultEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justChecked, setJustChecked] = useState(false);
  // Whether this server has a Lightning provider wired up. We read
  // it once on mount via /health; if the server flips state we'll
  // pick it up on the next page load. Treating it as static-per-load
  // avoids re-rendering the dashboard every poll.
  const [lightningEnabled, setLightningEnabled] = useState(false);
  // Whether the server is running in seconds-scale demo mode. Drives
  // the "Waiting period" StatCard's units (seconds vs blocks) so the
  // dashboard matches what the operator picked at setup time.
  const [demoMode, setDemoMode] = useState(false);
  // Whether the Lightning check-in modal is open. The modal owns its
  // own invoice + polling state; we just toggle visibility here.
  const [lightningOpen, setLightningOpen] = useState(false);
  // Whether the "Add a heir" modal is open.
  const [addHeirOpen, setAddHeirOpen] = useState(false);
  // VAPID public key from /health, or null when the server has no
  // push keypair configured. Gates the reminder opt-in card.
  const [pushKey, setPushKey] = useState<string | null>(null);

  const now = useTicker(1000);

  const refresh = useCallback(async () => {
    if (!activeId) return;
    try {
      const [v, evs] = await Promise.all([
        api.getVault(activeId, ownerToken),
        api.listEvents(activeId, ownerToken),
      ]);
      setVault(v);
      setEvents(evs);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setError(
          "This browser doesn't have the credentials for this vault. " +
            "Sign in with your email and password, or create a new vault.",
        );
        return;
      }
      if (e instanceof ApiError && e.status === 404) {
        // The server no longer has this vault (e.g. owner deleted it
        // from another device, or it was an old test row). Drop the
        // local meta so the dashboard doesn't keep clinging to a row
        // that's gone — then route to landing rather than auto-
        // switching to whatever other vault happens to be in
        // localStorage.
        removeVaultMeta(activeId);
        onNavigate("landing");
        return;
      }
      // Otherwise swallow; the next tick may succeed.
    }
  }, [activeId, ownerToken, onNavigate]);

  // Initial load.
  useEffect(() => {
    if (activeId) void refresh();
  }, [activeId, refresh]);

  // Probe the server once to learn whether Lightning check-ins are
  // available. Silent on failure — we just leave the button hidden.
  useEffect(() => {
    let alive = true;
    api
      .health()
      .then((h) => {
        if (!alive) return;
        setLightningEnabled(Boolean(h.lightning_enabled));
        setDemoMode(Boolean(h.demo_mode));
        setPushKey(h.push_public_key ?? null);
      })
      .catch(() => {
        if (!alive) return;
        setLightningEnabled(false);
        setDemoMode(false);
        setPushKey(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Live polling while visible.
  usePolling(refresh, 8000, [activeId]);

  async function onCheckin() {
    if (!vault) return;
    setBusy(true);
    setError(null);
    try {
      // Fan out to every sibling in the group. For single-heir
      // vaults this is just one call against `vault.id`; for
      // multi-heir groups it loops through every sibling. Each
      // sibling has its own ownerToken (issued at vault creation),
      // so we read them from localStorage per vault.
      //
      // We don't parallelise: serial is friendlier to the server
      // (the worker has rate-limit headroom for parallel but the
      // optics of "5 simultaneous POSTs" surprise some operators
      // looking at logs). The whole loop is dominated by network
      // latency, not server work; sub-second total even for 5
      // heirs.
      //
      // If any sibling fails, we surface the FIRST error and stop —
      // partial fan-out leaves the group in mixed-state, which is
      // visible in the dashboard list as "Heir #3 is alarmed but
      // Heirs #1 and #2 are ok." Better than rolling back the
      // successful ones (which would require an admin route we
      // don't have).
      for (const sibling of groupVaults) {
        const token = getVaultOwnerToken(sibling.id);
        await api.checkin(sibling.id, token);
      }
      await refresh();
      setJustChecked(true);
      window.setTimeout(() => setJustChecked(false), 4000);
    } catch (e) {
      // 409 = already checked in this period. Treat as a soft "you're
      // good" rather than a failure: the button's locked anyway, the
      // user just got their answer.
      if (e instanceof ApiError && e.status === 409) {
        setError(
          "Already checked in this period. Your next check-in opens when the current cycle ends.",
        );
        await refresh();
      } else {
        setError(e instanceof ApiError ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  }

  // Owner-initiated heir removal. Deletes the server-side vault row
  // (cascading events/notifications/lightning_invoices) and the local
  // metadata. For a multi-heir group, picks a remaining sibling as
  // the next active vault and reloads so the dashboard re-renders
  // against it. For a single-heir vault, routes back to landing.
  // On-chain funds are unaffected — the owner still holds the xpub.
  async function onRemoveHeir(siblingId: string, heirName: string) {
    const token = getVaultOwnerToken(siblingId);
    if (!token) {
      setError(
        "This browser doesn't have the owner credential for that heir. Sign in first.",
      );
      return;
    }
    const ok = window.confirm(
      `Remove ${heirName} as an heir?\n\n` +
        `This revokes the inheritance plan for this heir:\n` +
        `  • ${heirName} can no longer claim through GhostKey.\n` +
        `  • Pending alarm notifications are cancelled.\n\n` +
        `Your Bitcoin stays yours. GhostKey never held your keys, ` +
        `so the funds remain spendable from your own wallet at any time.`,
    );
    if (!ok) return;
    try {
      await api.deleteVault(siblingId, token);
    } catch (e) {
      // 404 means the server row was already gone — fall through and
      // clean up local state anyway so the UI stops referencing it.
      if (!(e instanceof ApiError && e.status === 404)) {
        setError(e instanceof ApiError ? e.message : String(e));
        return;
      }
    }
    removeVaultMeta(siblingId);
    const remaining = groupVaults.filter((v) => v.id !== siblingId);
    if (remaining.length === 0) {
      onNavigate("landing");
      return;
    }
    // Switch active to the first remaining sibling and reload so all
    // derived state (groupVaults, vault, events) refreshes.
    setActiveVaultId(remaining[0].id);
    if (typeof window !== "undefined") window.location.reload();
  }

  if (!activeId || !meta) {
    return <EmptyState onNavigate={onNavigate} />;
  }

  // Three derived flags shape the dashboard's "past the line" rendering:
  //   - isClaiming: heir has the claim link or is broadcasting; the
  //     check-in loop is effectively over (server may still accept a
  //     check-in but the UX shouldn't suggest it).
  //   - isClosed: heir's claim transaction was accepted by the server;
  //     terminal state, dismiss-and-go.
  //   - isPastDeadline: deadline elapsed but scheduler hasn't ticked
  //     yet; used by the Greeting to swap copy from "You're still
  //     here" to "Missed deadline".
  const isClaiming =
    vault?.status === "timelock_started" || vault?.status === "claiming";
  const isClosed = vault?.status === "claimed";
  const isPastDeadline =
    vault != null &&
    (vault.status === "alarmed" ||
      isClaiming ||
      isClosed ||
      parseRfc(vault.next_deadline_at) < now);

  return (
    <main className="bg-app fade-in">
      <div className="mx-auto max-w-2xl px-5 py-10 md:py-14 lg:max-w-5xl">
        <Greeting
          meta={meta}
          vault={vault}
          now={now}
          isClaiming={isClaiming}
          isClosed={isClosed}
          isPastDeadline={isPastDeadline}
        />

        {vault?.status === "frozen" ? (
          <div className="mt-4">
            <FrozenBanner vault={vault} now={now} />
          </div>
        ) : vault?.status === "alarmed" ? (
          <div className="mt-4">
            <AlarmBanner vault={vault} now={now} />
          </div>
        ) : null}

        {/* Single column on mobile; on desktop the cards split into a
            wide "act" column (check-in, balance) and a narrower
            "facts" column (status, heir, emergency tools). The mobile
            source order is unchanged — the grid only kicks in at lg. */}
        <div className="mt-10 lg:grid lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start lg:gap-8">
          <div className="min-w-0">
            {/* T6 (#117): an unconfirmed email guards the one mechanism
                that prevents an accidental trigger, so it leads the column
                rather than sitting near the bottom. */}
            {vault && !isClosed && !isClaiming && vault.owner_contact_verified === false ? (
              <div className="mb-5">
                <ConfirmEmailCard vaultId={vault.id} ownerToken={ownerToken} />
              </div>
            ) : null}

            <div>
              {isClosed ? (
                <VaultClosedCard
                  meta={meta}
                  onDismiss={() => {
                    // Final close-out: drop the local meta so the next
                    // dashboard visit isn't tied to a terminal vault.
                    // The server-side row stays — claim history is the
                    // owner's record. They can also "Remove heir" before
                    // dismissing if they want it gone server-side too.
                    removeVaultMeta(meta.id);
                    onNavigate("landing");
                  }}
                />
              ) : isClaiming ? (
                <ClaimInProgressCard meta={meta} status={vault!.status} />
              ) : (
                <HeartbeatCard
                  meta={meta}
                  vault={vault}
                  now={now}
                  busy={busy}
                  justChecked={justChecked}
                  error={error}
                  onCheckin={onCheckin}
                  lightningEnabled={lightningEnabled}
                  onLightning={() => setLightningOpen(true)}
                />
              )}
            </div>

            {vault ? (
              <div className="mt-5">
                <MoneyCard
                  vaultId={vault.id}
                  network={vault.network}
                  ownerToken={ownerToken}
                  canManage={!isClosed && !isClaiming}
                />
              </div>
            ) : null}

            {vault?.lnurl_checkin && !isClosed && !isClaiming ? (
              <div className="mt-5">
                <LnurlCard lnurl={vault.lnurl_checkin} />
              </div>
            ) : null}

            {vault && !isClosed && !isClaiming && pushKey && ownerToken ? (
              <div className="mt-5">
                <PushOptInCard
                  vaultId={vault.id}
                  ownerToken={ownerToken}
                  vapidPublicKey={pushKey}
                />
              </div>
            ) : null}
          </div>

          <div className="min-w-0">
            {vault ? (
              <p className="text-sm text-muted lg:mt-0 mt-5">
                If you miss a check-in, your heir waits{" "}
                <span className="text-[var(--text)]">
                  {demoMode
                    ? prettySeconds(vault.grace_period_secs)
                    : prettyBlocks(vault.timelock_blocks)}
                </span>{" "}
                before they can claim.
              </p>
            ) : null}

            <div className="mt-5">
              {groupVaults.length > 1 ? (
                <HeirGroupList
                  groupVaults={groupVaults}
                  activeId={activeId}
                  onSelect={(id) => {
                    // Switch active vault. Reload so the dashboard
                    // re-runs against the new active id. We could do
                    // this purely via state instead but a reload also
                    // refreshes the server state, which is what the
                    // user wants ("show me Bob now").
                    if (typeof window !== "undefined") {
                      window.localStorage.setItem("gk:activeVaultId", id);
                      window.location.reload();
                    }
                  }}
                  onRemove={onRemoveHeir}
                />
              ) : (
                <HeirCard
                  meta={meta}
                  vault={vault}
                  onRemove={
                    // Heir protection: once a claim is live the owner can
                    // no longer remove the heir (server enforces this too).
                    isClosed || isClaiming
                      ? undefined
                      : () => onRemoveHeir(meta.id, meta.heir.name)
                  }
                />
              )}

              {/* Add another heir — own share, own claim link, same
                  one-tap check-in. Stays available even after an heir
                  has claimed: a new heir reuses your owner key, so you
                  can keep building your plan without starting over. */}
              {vault ? (
                <div className="mt-3">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setAddHeirOpen(true)}
                  >
                    Add Heir
                  </Button>
                </div>
              ) : null}
            </div>

            {vault?.lnurl_panic && vault.status !== "frozen" && !isClosed && !isClaiming ? (
              <div className="mt-5">
                <PanicCard lnurl={vault.lnurl_panic} hasTrustedContact={Boolean(vault.has_trusted_contact)} />
              </div>
            ) : null}
            {/* Recovery file now lives on its own nav page (Recovery
                kit) to keep the dashboard calm. */}
          </div>
        </div>

        <div className="mt-12">
          <ActivityList events={events} />
        </div>
      </div>

      {addHeirOpen && activeId && vault ? (
        <AddHeirPortal
          siblingVaultId={activeId}
          vault={vault}
          groupId={meta.groupId}
          ownerEmail={meta.owner.address}
          onClose={() => setAddHeirOpen(false)}
          onAdded={() => {
            setAddHeirOpen(false);
            // Reload so groupVaults / active state re-derive against
            // the newly added sibling.
            if (typeof window !== "undefined") window.location.reload();
          }}
        />
      ) : null}

      {lightningOpen && activeId ? (
        <LightningCheckin
          vaultId={activeId}
          ownerToken={ownerToken}
          onPaid={() => {
            setLightningOpen(false);
            setJustChecked(true);
            window.setTimeout(() => setJustChecked(false), 4000);
            void refresh();
          }}
          onClose={() => setLightningOpen(false)}
          onFreeCheckin={() => {
            setLightningOpen(false);
            onCheckin();
          }}
        />
      ) : null}

      <AssistChat
        intro="Questions about check-ins, the waiting period, or what your heir will see? Ask away."
      />
    </main>
  );
}

/* ------------------------------- Money card ------------------------------- */

/**
 * One card for everything money: balance, adding funds, sending. Tabs
 * keep the dashboard calm instead of three stacked cards. Add/Send only
 * appear while the vault is active and the owner is signed in here.
 */
function MoneyCard({
  vaultId,
  network,
  ownerToken,
  canManage,
}: {
  vaultId: string;
  network: string;
  ownerToken: string | null;
  canManage: boolean;
}) {
  const canSend = canManage && Boolean(ownerToken);
  const canSeeHeir = Boolean(ownerToken);
  type Tab = "balance" | "heir" | "add" | "send";
  const [tab, setTab] = useState<Tab>("balance");
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "balance", label: "Balance" },
    ...(canSeeHeir ? [{ id: "heir" as Tab, label: "Heir" }] : []),
    ...(canManage ? [{ id: "add" as Tab, label: "Add" }] : []),
    ...(canSend ? [{ id: "send" as Tab, label: "Send" }] : []),
  ];

  return (
    <section className="card-flat p-5">
      <div role="tablist" className="flex gap-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              tab === t.id
                ? "bg-[var(--accent)] text-[var(--bg)]"
                : "text-muted hover:bg-[var(--surface-2)]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="mt-4">
        {tab === "balance" ? <BalanceCard vaultId={vaultId} embedded /> : null}
        {tab === "heir" && ownerToken ? (
          <HeirDetailsCard vaultId={vaultId} ownerToken={ownerToken} />
        ) : null}
        {tab === "add" ? <ReceiveCard vaultId={vaultId} embedded /> : null}
        {tab === "send" && ownerToken ? (
          <SendCard
            vaultId={vaultId}
            network={network}
            ownerToken={ownerToken}
            embedded
          />
        ) : null}
      </div>
    </section>
  );
}

/* ----------------------------- Balance card ------------------------------- */

const BALANCE_HIDDEN_KEY = "gk:balanceHidden";

/** Resolve `p`, or reject after `ms` so a slow balance fetch (public
 *  explorers can crawl) never leaves the card stuck loading. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), ms),
    ),
  ]);
}

function BalanceCard({
  vaultId,
  embedded,
}: {
  vaultId: string;
  embedded?: boolean;
}) {
  const [balance, setBalance] = useState<VaultBalanceView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const usdPerBtc = usePrice();
  const [hidden, setHidden] = useState<boolean>(() => {
    try {
      return localStorage.getItem(BALANCE_HIDDEN_KEY) === "1";
    } catch {
      return false;
    }
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const b = await withTimeout(api.getVaultBalance(vaultId), 25000);
      setBalance(b);
    } catch (e) {
      // Keep raw server text (e.g. "500 Internal Server Error") out of the
      // owner's face — a chain/explorer hiccup isn't actionable jargon. The
      // figure already falls back to "—" when nothing loaded, so it never
      // reads as a misleading zero.
      const msg = e instanceof Error ? e.message : String(e);
      setError(
        msg === "timeout"
          ? "Couldn't load your balance. Tap Refresh to try again."
          : "Couldn't load your balance right now. Tap Refresh to try again.",
      );
    } finally {
      setLoading(false);
    }
  }, [vaultId]);

  // Only reach out to the chain when the balance is visible. Hiding it
  // also skips the slow lookup.
  useEffect(() => {
    if (!hidden) void load();
  }, [load, hidden]);

  function toggleHidden() {
    setHidden((h) => {
      const next = !h;
      try {
        localStorage.setItem(BALANCE_HIDDEN_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  return (
    <div className={embedded ? "" : "card-flat p-5"}>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-xs uppercase tracking-wider text-dim">
          {embedded ? "" : "Balance"}
        </p>
        <div className="flex items-center gap-3">
          {!hidden ? (
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="text-xs text-muted underline-offset-2 hover:underline disabled:opacity-50"
            >
              {loading ? "Refreshing" : "Refresh"}
            </button>
          ) : null}
          <button
            type="button"
            onClick={toggleHidden}
            className="text-xs text-muted underline-offset-2 hover:underline"
          >
            {hidden ? "Show" : "Hide"}
          </button>
        </div>
      </div>
      {hidden ? (
        <div className="mt-2 font-display text-2xl font-bold tracking-tight">
          ••••••
        </div>
      ) : (
        <>
          <div className="mt-2 font-display text-2xl font-bold tracking-tight">
            {balance ? formatSats(balance.total_sat) : loading ? "…" : "—"}
          </div>
          {balance ? (
            <p className="mt-1 text-sm text-muted">
              {btcAndUsd(balance.total_sat, usdPerBtc)}
            </p>
          ) : null}
          {balance && balance.unconfirmed_sat > 0 ? (
            <p className="mt-1.5 text-sm text-muted">
              {formatSats(balance.confirmed_sat)} confirmed,{" "}
              {formatSats(balance.unconfirmed_sat)} pending
            </p>
          ) : null}
          {error ? <p className="mt-2 text-sm text-alarm">{error}</p> : null}
        </>
      )}
    </div>
  );
}

/* ------------------------------- Heir card -------------------------------- */

/** Owner-only view of who the vault is for: the heir's name, how they'll
 *  be reached, their contact, and the note left for them. Fetched from
 *  the owner-authed `/vaults/:id/heir`; the details are sealed at rest. */
function HeirDetailsCard({
  vaultId,
  ownerToken,
}: {
  vaultId: string;
  ownerToken: string;
}) {
  const [heir, setHeir] = useState<HeirProfileView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getVaultHeir(vaultId, ownerToken)
      .then((h) => {
        if (!cancelled) setHeir(h);
      })
      .catch((e) => {
        if (!cancelled)
          setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [vaultId, ownerToken]);

  if (loading) return <p className="text-sm text-muted">Loading…</p>;
  if (error)
    return (
      <p className="text-sm text-alarm">
        Couldn't load your heir's details right now. Try again in a moment.
      </p>
    );
  if (!heir || (!heir.name && !heir.contact && !heir.note)) {
    return (
      <p className="text-sm text-muted">
        No heir details on file for this vault.
      </p>
    );
  }

  const channelLabel =
    heir.channel === "sms"
      ? "SMS"
      : heir.channel === "whatsapp"
        ? "WhatsApp"
        : heir.channel === "email"
          ? "Email"
          : null;

  return (
    <div className="flex flex-col gap-3">
      <HeirRow label="Name" value={heir.name ?? "—"} />
      <HeirRow label="Reach them by" value={channelLabel ?? "—"} />
      <HeirRow label="Contact" value={heir.contact ?? "—"} mono />
      {heir.note ? (
        <div>
          <p className="text-xs uppercase tracking-wider text-dim">
            Note you left for them
          </p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-soft">
            {heir.note}
          </p>
        </div>
      ) : null}
      <p className="text-xs text-dim">
        Only you can see this. Your heir's details are stored encrypted and
        shown here to the signed-in owner.
      </p>
    </div>
  );
}

function HeirRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-xs uppercase tracking-wider text-dim">{label}</span>
      <span
        className={`break-all text-right text-sm text-[var(--text)] ${mono ? "font-mono" : ""}`}
      >
        {value}
      </span>
    </div>
  );
}

function formatSats(sats: number): string {
  if (sats === 0) return "0 sat";
  if (sats >= 100_000_000) {
    const btc = sats / 100_000_000;
    return `${btc.toLocaleString(undefined, { maximumFractionDigits: 8 })} BTC`;
  }
  return `${sats.toLocaleString()} sat`;
}

/* ----------------------------- Receive card ------------------------------- */

/**
 * Lets the owner add funds after setup. The address comes from the
 * public address endpoint (the same first address every time — see
 * get_vault_address server-side), so no owner token is needed. The
 * address is fetched lazily on first expand, and the QR renders
 * locally as a data: URL — the CSP blocks external image hosts.
 */
function ReceiveCard({
  vaultId,
  embedded,
}: {
  vaultId: string;
  embedded?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [view, setView] = useState<VaultAddressView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function onExpand() {
    setExpanded(true);
    if (view) return;
    setLoading(true);
    setError(null);
    try {
      setView(await api.getVaultAddress(vaultId));
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : String(e),
      );
    } finally {
      setLoading(false);
    }
  }

  // Uppercase bech32 packs into the QR's alphanumeric mode, giving a
  // sparser, easier-to-scan code. Wallets accept either case.
  const qrUrl = useMemo(() => {
    if (!view) return null;
    const qr = qrcode(0, "M");
    qr.addData(view.address.toUpperCase());
    qr.make();
    return qr.createDataURL(5, 8);
  }, [view]);

  function onCopy() {
    if (!view) return;
    void navigator.clipboard.writeText(view.address).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <section className={embedded ? "" : "card-flat p-5"}>
      {!embedded ? (
        <p className="text-xs uppercase tracking-wider text-dim">Add Bitcoin</p>
      ) : null}
      <p className={`text-sm text-muted ${embedded ? "" : "mt-1.5"}`}>
        Send any amount from any wallet or exchange, as often as you like. New
        funds join the same plan automatically.
      </p>
      {!expanded ? (
        <div className="mt-3">
          <Button size="sm" variant="ghost" onClick={() => void onExpand()}>
            Show vault address
          </Button>
        </div>
      ) : loading ? (
        <p className="mt-3 text-xs text-muted">Loading address…</p>
      ) : view ? (
        <div className="mt-3 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
          {qrUrl ? (
            <img
              src={qrUrl}
              alt={`QR code for vault address ${view.address}`}
              className="h-36 w-36 rounded-lg bg-white p-1"
            />
          ) : null}
          <div className="min-w-0">
            <p className="break-all font-mono text-xs">{view.address}</p>
            <div className="mt-2 flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={onCopy}>
                {copied ? "Copied ✓" : "Copy address"}
              </Button>
            </div>
            {view.network !== "bitcoin" ? (
              <p className="mt-2 text-xs text-dim">
                This vault is on {view.network}. Only send {view.network}{" "}
                coins here.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
      {error ? <p className="mt-2 text-sm text-alarm">{error}</p> : null}
    </section>
  );
}

/* ------------------------------ Send card --------------------------------- */

/**
 * Owner spend. The password unlocks the sealed owner key right here in
 * the browser (same Argon2id + XChaCha20 unseal as cross-device sign-in);
 * the key then rides one TLS request to the server, which signs in
 * memory, broadcasts, and discards it — the exact contract the heir
 * claim flow documents in psbt_routes.rs. Change from a partial send
 * returns to the vault's internal keychain, so the remainder stays
 * covered by the inheritance plan (with a fresh heir countdown).
 */
function SendCard({
  vaultId,
  network,
  ownerToken,
  embedded,
}: {
  vaultId: string;
  network: string;
  ownerToken: string;
  embedded?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [destination, setDestination] = useState("");
  const [amountStr, setAmountStr] = useState("");
  const [sendAll, setSendAll] = useState(false);
  const [password, setPassword] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [phase, setPhase] = useState<"idle" | "unlocking" | "sending">("idle");
  const [unlockPct, setUnlockPct] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<OwnerSendResponse | null>(null);
  const usdPerBtc = usePrice();

  const busy = phase !== "idle";
  const amountSat = sendAll ? null : Number.parseInt(amountStr, 10);
  const amountUsd =
    !sendAll &&
    Number.isFinite(amountSat) &&
    (amountSat as number) > 0 &&
    usdPerBtc != null
      ? formatUsd(satsToUsd(amountSat as number, usdPerBtc))
      : null;
  const addrShapeOk = looksLikeBitcoinAddress(destination);
  const addrNetworkOk = addressMatchesNetwork(destination, network);
  const addrOk = addrShapeOk && addrNetworkOk;
  const amountOk =
    sendAll || (Number.isFinite(amountSat) && (amountSat as number) > 0);
  const canSubmit =
    !busy && addrOk && password.length > 0 && amountOk;

  async function onSend() {
    setError(null);
    setPhase("unlocking");
    setUnlockPct(0);
    let ownerXprv: string;
    try {
      // Legacy (non-password) vaults have no sealed blobs; the server
      // 400s with a self-explanatory message.
      const blobs = await api.getSealedBlobs(vaultId);
      const unsealed = await unsealOwner({
        password,
        passwordSalt: blobs.password_salt_b64,
        memKiB: blobs.password_kdf_mem_kib,
        iters: blobs.password_kdf_iters,
        ownerXprvBlob: {
          v: 1,
          ct: blobs.owner_xprv_ct_b64,
          nonce: blobs.owner_xprv_nonce_b64,
        },
        ownerTokenBlob: {
          v: 1,
          ct: blobs.owner_token_ct_b64,
          nonce: blobs.owner_token_nonce_b64,
        },
        onProgress: (pct) => setUnlockPct(Math.round(pct * 100)),
      });
      ownerXprv = unsealed.ownerXprv;
    } catch (e) {
      setPhase("idle");
      setError(
        e instanceof ApiError
          ? e.message
          : "That password didn't unlock the vault. Check it and try again.",
      );
      return;
    }

    setPhase("sending");
    try {
      const res = await api.ownerSend(vaultId, ownerToken, {
        destination: destination.trim(),
        ...(sendAll ? {} : { amount_sat: amountSat as number }),
        owner_xprv: ownerXprv,
      });
      setResult(res);
      setPassword("");
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : String(e),
      );
    } finally {
      setPhase("idle");
    }
  }

  if (result) {
    return (
      <section className={embedded ? "" : "card-flat p-5"}>
        {!embedded ? (
          <p className="text-xs uppercase tracking-wider text-dim">
            Send Bitcoin
          </p>
        ) : null}
        <p className="mt-2 text-sm font-semibold text-ok">
          Sent ✓ {formatSats(result.sent_sat)} is on its way.
        </p>
        <p className="mt-1.5 text-sm text-muted">
          Network fee: {formatSats(result.fee_sat)}.{" "}
          {result.remaining_sat > 0
            ? `The remaining ${formatSats(result.remaining_sat)} stays in your vault, still covered by your inheritance plan. Your heir's waiting clock starts fresh from this move.`
            : "The vault is now empty; add Bitcoin any time to keep the plan going."}
        </p>
        <div className="mt-3 flex items-center gap-3">
          <a
            href={result.explorer_url}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-muted underline underline-offset-2"
          >
            View on mempool.space
          </a>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setResult(null);
              setDestination("");
              setAmountStr("");
              setSendAll(false);
              setConfirming(false);
            }}
          >
            Send again
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section className={embedded ? "" : "card-flat p-5"}>
      {!embedded ? (
        <p className="text-xs uppercase tracking-wider text-dim">Send Bitcoin</p>
      ) : null}
      <p className="mt-1.5 text-sm text-muted">
        Your money is never locked up. Pay anyone from your vault, and
        whatever you leave behind stays covered by the same inheritance
        plan.
      </p>
      {!expanded ? (
        <div className="mt-3">
          <Button size="sm" variant="ghost" onClick={() => setExpanded(true)}>
            Send from this vault
          </Button>
        </div>
      ) : (
        <form
          className="mt-3 flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) setConfirming(true);
          }}
        >
          <label className="block">
            <span className="text-xs text-muted">Send to (Bitcoin address)</span>
            <input
              type="text"
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
              placeholder={`${bech32PrefixFor(network)}…`}
              autoComplete="off"
              spellCheck={false}
              disabled={busy || confirming}
              className="input mt-1 w-full font-mono text-xs"
            />
            {destination && !addrShapeOk ? (
              <span className="mt-1 block text-xs text-alarm">
                That doesn't look like a Bitcoin address. Check the start.
              </span>
            ) : destination && !addrNetworkOk ? (
              <span className="mt-1 block text-xs text-alarm">
                That address is for a different network. It should start with{" "}
                {bech32PrefixFor(network)}.
              </span>
            ) : null}
          </label>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <label className="block flex-1">
              <span className="text-xs text-muted">Amount (sats)</span>
              <input
                type="number"
                inputMode="numeric"
                min={1}
                value={sendAll ? "" : amountStr}
                onChange={(e) => setAmountStr(e.target.value)}
                placeholder={sendAll ? "everything" : "e.g. 50000"}
                disabled={busy || sendAll || confirming}
                className="input mt-1 w-full"
              />
            </label>
            <label className="flex items-center gap-2 pb-2 text-xs text-muted">
              <input
                type="checkbox"
                checked={sendAll}
                onChange={(e) => setSendAll(e.target.checked)}
                disabled={busy || confirming}
              />
              Send everything
            </label>
          </div>
          {amountUsd ? (
            <p className="-mt-1 text-xs text-dim">≈ {amountUsd}</p>
          ) : null}
          <label className="block">
            <span className="text-xs text-muted">Your password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              disabled={busy || confirming}
              className="input mt-1 w-full"
            />
            <span className="mt-1 block text-xs text-dim">
              Your password unlocks the vault key right here in your browser.
            </span>
          </label>
          {error ? <p className="text-xs text-alarm">{error}</p> : null}
          {confirming ? (
            <div className="card-flat p-4">
              <ConfirmSend
                destination={destination.trim()}
                amountLabel={
                  sendAll
                    ? "Everything in your vault"
                    : `${formatSats(amountSat as number)}${amountUsd ? ` (≈ ${amountUsd})` : ""}`
                }
                networkLabel={network === "bitcoin" ? "Bitcoin" : `${network} network`}
                busy={busy}
                confirmLabel={
                  phase === "unlocking"
                    ? `Unlocking… ${unlockPct}%`
                    : phase === "sending"
                      ? "Sending…"
                      : "Yes, send it"
                }
                onConfirm={() => void onSend()}
                onBack={() => setConfirming(false)}
              />
            </div>
          ) : (
            <div>
              <Button size="sm" disabled={!canSubmit} type="submit">
                Review
              </Button>
            </div>
          )}
        </form>
      )}
    </section>
  );
}

/* ----------------------------- Greeting ----------------------------------- */

function Greeting({
  meta,
  vault,
  now,
  isClaiming,
  isClosed,
  isPastDeadline,
}: {
  meta: VaultMeta;
  vault: VaultView | null;
  now: Date;
  isClaiming: boolean;
  isClosed: boolean;
  isPastDeadline: boolean;
}) {
  const last = vault?.last_checkin_at
    ? parseRfc(vault.last_checkin_at)
    : null;
  const deadline = vault?.next_deadline_at
    ? parseRfc(vault.next_deadline_at)
    : null;
  const ago = last ? humanAgo(last, now) : null;

  // Headline + sub copy switch with the vault's lifecycle. Always
  // phrased relative to the owner's POV — they're the one reading
  // this dashboard.
  let headline: string;
  let sub: string;
  if (isClosed) {
    headline = "Vault closed";
    sub = `${meta.heir.name || "Your heir"} claimed the funds.`;
  } else if (isClaiming) {
    headline = "Your heir is claiming";
    sub = `${meta.heir.name || "Your heir"} has the claim link. The check-in loop is over for this vault.`;
  } else if (isPastDeadline) {
    headline = "Deadline missed";
    const missedAgo = deadline ? humanAgo(deadline, now) : null;
    sub = missedAgo
      ? `Check-in was due ${missedAgo}. Tap below to recover, or your heir will be contacted.`
      : "Tap below to recover before your heir is contacted.";
  } else {
    headline = "You're still here";
    const next = deadline ? countdown(deadline, now).friendly : null;
    sub =
      (last ? `Last checked in ${ago}.` : `Vault for ${meta.heir.name} is active.`) +
      // `friendly` already starts with "in", so no extra "in" here (T3).
      (next ? ` Next reminder ${next}.` : "");
  }

  return (
    <div>
      <h1 className="font-serif text-3xl md:text-4xl">{headline}</h1>
      <p className="mt-1 text-sm text-muted">{sub}</p>
    </div>
  );
}

/* --------------------------- Heartbeat card ------------------------------- */

/**
 * Terminal-state replacement for the HeartbeatCard. Shown when the
 * vault's status flips to `claimed` — the heir has broadcast the
 * claim transaction, so the check-in loop is over and there's
 * nothing for the owner to do here anymore.
 */
function VaultClosedCard({
  meta,
  onDismiss,
}: {
  meta: VaultMeta;
  onDismiss: () => void;
}) {
  return (
    <section className="card relative overflow-hidden p-5 text-center md:p-8">
      <div className="flex flex-col items-center">
        <div
          aria-hidden="true"
          className="flex h-16 w-16 items-center justify-center rounded-full bg-[var(--surface-2,var(--surface))] text-3xl"
        >
          ✓
        </div>
        <h2 className="mt-6 font-serif text-2xl">Vault closed</h2>
        <p className="mt-2 max-w-md text-sm text-muted">
          {meta.heir.name || "Your heir"} claimed the funds. Check-ins are
          no longer needed. This vault's work is done.
        </p>
        <Button onClick={onDismiss} className="mt-6">
          Done
        </Button>
      </div>
    </section>
  );
}

/**
 * Heir-is-claiming state. Replaces HeartbeatCard during
 * `timelock_started` (claim link issued, heir hasn't broadcast yet)
 * and `claiming` (broadcast in flight). The owner can't meaningfully
 * "check in to recover" once the heir has the link — the demo
 * narrative is now about the heir's side of the flow.
 */
function ClaimInProgressCard({
  meta,
  status,
}: {
  meta: VaultMeta;
  status: string;
}) {
  const broadcasting = status === "claiming";
  const heirName = meta.heir.name || "Your heir";
  return (
    <section className="card relative overflow-hidden p-5 text-center md:p-8">
      <div className="flex flex-col items-center">
        <div
          aria-hidden="true"
          className="flex h-16 w-16 items-center justify-center rounded-full bg-[var(--surface-2,var(--surface))] text-3xl"
        >
          ⏳
        </div>
        <h2 className="mt-6 font-serif text-2xl">
          {broadcasting ? "Heir is broadcasting" : "Heir was sent the claim link"}
        </h2>
        <p className="mt-2 max-w-md text-sm text-muted">
          {broadcasting
            ? `${heirName} is finalising the claim transaction.`
            : `${heirName} can open the link any time. The check-in loop is over for this vault.`}
        </p>
      </div>
    </section>
  );
}

function HeartbeatCard({
  meta,
  vault,
  now,
  busy,
  justChecked,
  error,
  onCheckin,
  lightningEnabled,
  onLightning,
}: {
  meta: VaultMeta;
  vault: VaultView | null;
  now: Date;
  busy: boolean;
  justChecked: boolean;
  error: string | null;
  onCheckin: () => void;
  lightningEnabled: boolean;
  onLightning: () => void;
}) {
  const cd = vault
    ? countdown(parseRfc(vault.next_deadline_at), now)
    : null;

  // Once-per-period lockout. The server refuses a second check-in
  // inside the same cycle, so we mirror that here: the next allowable
  // tap is `last_checkin_at + checkin_period_secs`. While that's in
  // the future, we lock the buttons and show a countdown to when the
  // gate reopens. Alarmed vaults are exempt — by definition the
  // period has already elapsed if status flipped to 'alarmed'.
  const nextOpen =
    vault && vault.last_checkin_at && vault.status !== "alarmed"
      ? new Date(
          parseRfc(vault.last_checkin_at).getTime() +
            vault.checkin_period_secs * 1000,
        )
      : null;
  const locked = nextOpen !== null && nextOpen > now;
  const lockedCd = locked && nextOpen ? countdown(nextOpen, now) : null;

  return (
    <section className="card relative overflow-hidden p-5 text-center md:p-8">
      <div className="flex flex-col items-center">
        <Heartbeat
          onTap={
            busy || locked
              ? undefined
              : lightningEnabled
                ? onLightning
                : onCheckin
          }
          disabled={busy || locked}
        />

        <h2 className="mt-6 font-serif text-2xl">
          {justChecked
            ? "Thanks, you're safe"
            : locked
              ? "You're all set"
              : "Time to check in"}
        </h2>
        <p className="mt-1 text-sm text-muted">
          {justChecked
            ? `${meta.heir.name}'s countdown starts again.`
            : locked
              ? // `friendly` already starts with "in" (T3, T7).
                `You're covered for this period. Your next check-in opens ${lockedCd?.friendly ?? "shortly"}.`
              : `Let ${meta.heir.name} know the clock is reset.`}
        </p>

        {/* Lightning is THE check-in when the server supports it: the
            small payment is the proof of life. The free button only
            appears on servers without Lightning (local dev, demo) so
            those keep working. */}
        <div className="mt-6 flex w-full max-w-xs flex-col items-stretch gap-3 md:max-w-none md:flex-row md:flex-wrap md:items-center md:justify-center">
          {lightningEnabled ? (
            <Button
              onClick={onLightning}
              disabled={justChecked || locked}
              size="lg"
            >
              {justChecked
                ? "Checked in ✓"
                : locked
                  ? "Checked in for this period"
                  : "⚡ Check in with Lightning"}
            </Button>
          ) : (
            <Button
              onClick={onCheckin}
              loading={busy}
              disabled={justChecked || locked}
              size="lg"
            >
              {justChecked
                ? "Checked in ✓"
                : locked
                  ? "Checked in for this period"
                  : "I'm still here"}
            </Button>
          )}
        </div>

        {!locked && lightningEnabled ? (
          <>
            <p className="mt-2 text-xs text-dim">
              Pay the small invoice from any Lightning wallet. The
              payment is your proof of life.
            </p>
            <LightningStatusBadge />
          </>
        ) : null}

        {cd ? (
          <p className="mt-5 text-xs text-muted" aria-live="polite">
            {/* Labelled so it doesn't read as a contradictory second
                countdown (T3). `friendly` already starts with "in". */}
            Check-in due{" "}
            <span className="text-[var(--text)] font-medium">{cd.friendly}</span>
          </p>
        ) : null}

        {error ? (
          <p className="mt-4 text-sm text-alarm">{error}</p>
        ) : null}
      </div>
    </section>
  );
}

/* --------------------------- Lightning status ----------------------------- */

/**
 * Reachability badge for the Lightning sidecar.
 *
 * `/health` only reports "operator wired up env vars." A user
 * staring at the "⚡ Pay a few sats" button doesn't yet know whether
 * the sidecar is actually up. We poll `/health/lightning` (server
 * caches the underlying probe for 5s, so this is cheap) and surface
 * the answer as a tiny coloured dot + label inline with the hint.
 *
 * Render-skip rules:
 *   - 404 from older servers → render nothing. Callers shouldn't
 *     even see this component on those builds, but defence-in-depth.
 *   - probe returns `enabled: false` → render nothing (the parent
 *     already gates on `lightningEnabled`; reaching this state means
 *     the operator flipped env vars between renders, in which case
 *     hiding the badge until next page load is fine).
 *   - probe pending on first mount → render nothing rather than a
 *     flash of "unknown" copy.
 */
function LightningStatusBadge() {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "hidden" }
    | { kind: "ready" }
    | { kind: "warming" }
    | { kind: "error"; message: string }
  >({ kind: "loading" });

  useEffect(() => {
    let alive = true;

    const poll = () => {
      api
        .healthLightning()
        .then((r) => {
          if (!alive) return;
          if (!r.enabled) {
            setState({ kind: "hidden" });
          } else if (r.error) {
            setState({ kind: "error", message: r.error });
          } else if (r.ready) {
            setState({ kind: "ready" });
          } else {
            setState({ kind: "warming" });
          }
        })
        .catch(() => {
          if (!alive) return;
          // 404 / network error — older server or offline.
          // Stay quiet rather than scaring the user.
          setState({ kind: "hidden" });
        });
    };

    poll();
    // Refresh in the background every 30s so the user sees a
    // sidecar recovery (or failure) without a page reload. Five-
    // second server-side cache means this is one downstream
    // network call per probe regardless of how many tabs are open.
    const timer = window.setInterval(poll, 30_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  if (state.kind === "loading" || state.kind === "hidden") return null;

  const dotColour =
    state.kind === "ready"
      ? "var(--ok)"
      : state.kind === "warming"
        ? "var(--warning)"
        : "var(--alarm)";
  const label =
    state.kind === "ready"
      ? "Sidecar ready"
      : state.kind === "warming"
        ? "Sidecar warming up"
        : "Sidecar unreachable";
  const title =
    state.kind === "error" ? state.message : undefined;

  return (
    <p
      className="mt-1.5 text-xs text-dim"
      title={title}
      data-testid="ln-status-badge"
    >
      <span
        aria-hidden="true"
        className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle"
        style={{ background: dotColour }}
      />
      {label}
    </p>
  );
}

/* --------------------------- Push opt-in card ----------------------------- */

/** localStorage key for "Not now". Per-vault so a new vault on the
 *  same device gets a fresh ask. */
const pushDismissKey = (vaultId: string) => `gk:pushDismissed:${vaultId}`;

/**
 * One-time offer to turn on check-in reminders via web push.
 *
 * Renders nothing unless every precondition holds: the browser
 * supports push, permission isn't already denied, the user hasn't
 * subscribed yet, and they haven't dismissed the card for this
 * vault. After a successful subscribe it shows a brief "Reminders
 * are on" confirmation, then disappears for good (the subscription
 * check hides it on subsequent visits).
 */
/* ------------------------- Confirm-email card ------------------------------ */

/**
 * Shown while `vault.owner_contact_verified === false`: the owner
 * gave us a reminder email at setup but hasn't tapped the
 * confirmation link yet. Until they do, we can't be sure reminders
 * actually reach them — and a typo'd address fails silently, which
 * for this product means the heir gets contacted without the owner
 * ever seeing a nudge. The card disappears on the poll after they
 * tap the link.
 */
function ConfirmEmailCard({
  vaultId,
  ownerToken,
}: {
  vaultId: string;
  ownerToken: string | null;
}) {
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "sending" }
    | { kind: "sent" }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  async function onResend() {
    setState({ kind: "sending" });
    try {
      await api.resendVerification(vaultId, ownerToken);
      setState({ kind: "sent" });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // Cooldown: one was sent moments ago. From the owner's seat
        // that's the same outcome as a successful resend.
        setState({ kind: "sent" });
        return;
      }
      setState({
        kind: "error",
        message:
          e instanceof ApiError
            ? e.message
            : "That didn't work. Try again in a moment.",
      });
    }
  }

  // T6 (#117): this guards the one mechanism that stops an accidental,
  // irreversible trigger, so it's a prominent warning banner with the
  // stakes named — not a quiet grey strip. The caller renders it only
  // while the email is unconfirmed, so it persists until that's fixed.
  return (
    <div
      className="flex items-center justify-between gap-3 rounded-xl border border-app px-4 py-3"
      style={{ background: "var(--warning-tint)", color: "var(--warning)" }}
      role="alert"
      data-testid="confirm-email-card"
    >
      <p className="text-sm text-[var(--text)]">
        {state.kind === "sent" ? (
          "Confirmation email sent. Tap the link in it. Check spam too."
        ) : state.kind === "error" ? (
          state.message
        ) : (
          <>
            <span className="font-semibold">Confirm your email.</span> Until
            you do, we can&apos;t remind you to check in, and a missed
            reminder can trigger the inheritance by accident.
          </>
        )}
      </p>
      {state.kind !== "sent" ? (
        <button
          type="button"
          onClick={() => void onResend()}
          disabled={state.kind === "sending"}
          className="shrink-0 text-xs font-medium text-[var(--text)] underline underline-offset-2 disabled:opacity-50"
        >
          {state.kind === "sending" ? "Sending" : "Resend"}
        </button>
      ) : null}
    </div>
  );
}

function PushOptInCard({
  vaultId,
  ownerToken,
  vapidPublicKey,
}: {
  vaultId: string;
  ownerToken: string;
  vapidPublicKey: string;
}) {
  type CardState =
    | { kind: "checking" }
    | { kind: "hidden" }
    | { kind: "offer" }
    | { kind: "busy" }
    | { kind: "done" }
    | { kind: "error"; message: string };
  const [state, setState] = useState<CardState>({ kind: "checking" });

  useEffect(() => {
    let alive = true;
    if (
      !isPushSupported() ||
      Notification.permission === "denied" ||
      window.localStorage.getItem(pushDismissKey(vaultId)) === "1"
    ) {
      setState({ kind: "hidden" });
      return;
    }
    getPushSubscription()
      .then((sub) => {
        if (!alive) return;
        setState(sub ? { kind: "hidden" } : { kind: "offer" });
      })
      .catch(() => {
        if (!alive) return;
        setState({ kind: "hidden" });
      });
    return () => {
      alive = false;
    };
  }, [vaultId]);

  async function onTurnOn() {
    setState({ kind: "busy" });
    try {
      await subscribeToPush(vaultId, ownerToken, vapidPublicKey);
      setState({ kind: "done" });
    } catch (e) {
      // Permission denied is a decision, not a failure — put the
      // card away rather than nag. Anything else gets a retryable
      // plain-words error line.
      if (Notification.permission === "denied") {
        setState({ kind: "hidden" });
        return;
      }
      setState({
        kind: "error",
        message:
          e instanceof ApiError
            ? e.message
            : "That didn't work. You can try again any time.",
      });
    }
  }

  function onNotNow() {
    window.localStorage.setItem(pushDismissKey(vaultId), "1");
    setState({ kind: "hidden" });
  }

  if (state.kind === "checking" || state.kind === "hidden") return null;

  if (state.kind === "done") {
    return (
      <div
        className="card-flat px-4 py-3 text-sm text-muted"
        data-testid="push-optin-card"
      >
        <span className="text-ok">✓</span> Reminders are on.
      </div>
    );
  }

  return (
    <div
      className="card-flat flex items-center justify-between gap-3 px-4 py-3"
      data-testid="push-optin-card"
    >
      <p className="text-sm text-muted">
        {state.kind === "error"
          ? state.message
          : "Get a reminder before each check-in?"}
      </p>
      <div className="flex shrink-0 items-center gap-3">
        <button
          type="button"
          onClick={() => void onTurnOn()}
          disabled={state.kind === "busy"}
          className="text-xs text-muted underline-offset-2 hover:underline disabled:opacity-50"
        >
          {state.kind === "busy" ? "Turning on" : "Turn on"}
        </button>
        <button
          type="button"
          onClick={onNotNow}
          disabled={state.kind === "busy"}
          className="text-xs text-dim underline-offset-2 hover:underline disabled:opacity-50"
        >
          Not now
        </button>
      </div>
    </div>
  );
}

function prettyBlocks(blocks: number): string {
  const days = Math.round((blocks * 10) / 1440); // 10 min/block → days
  if (days >= 30) {
    const m = Math.round(days / 30);
    return `${m} month${m === 1 ? "" : "s"}`;
  }
  return `${days} day${days === 1 ? "" : "s"}`;
}

function prettySeconds(secs: number): string {
  if (secs < 60) return `${secs} second${secs === 1 ? "" : "s"}`;
  if (secs < 3600) {
    const m = Math.round(secs / 60);
    return `${m} minute${m === 1 ? "" : "s"}`;
  }
  const h = Math.round(secs / 3600);
  return `${h} hour${h === 1 ? "" : "s"}`;
}

/* ------------------------------ Heir card --------------------------------- */

function HeirCard({
  meta,
  vault,
  onRemove,
}: {
  meta: VaultMeta;
  vault: VaultView | null;
  /** When provided, renders a "Remove" button. Omit on terminal
   *  states (claimed vaults) where removal isn't meaningful. */
  onRemove?: () => void;
}) {
  const status = vault?.status ?? "ok";
  // T1 (#117): while the owner is alive and checking in, the heir is just
  // standing by — they cannot take anything. Showing "Ready to claim" in
  // success-green there is false and frightening. Green/"claim" wording is
  // reserved for the genuinely claimable path (timelock_started, which the
  // owner sees as an alarm).
  const pill =
    status === "claimed"
      ? { tone: "neutral" as const, label: "Claimed" }
      : status === "timelock_started"
      ? { tone: "alarm" as const, label: "Claiming" }
      : { tone: "neutral" as const, label: "Standing by" };

  return (
    <div className="card-flat flex flex-wrap items-center gap-x-4 gap-y-2 p-5">
      <Avatar name={meta.heir.name} />
      {/* basis-40 keeps the name a readable width before the pill/Remove
          wrap to the next line on a narrow card — otherwise flex-1 + min-w-0
          let it collapse to "B…". The contact line, not the name, is what
          should truncate. */}
      <div className="min-w-0 flex-1 basis-40">
        <p className="font-semibold text-[var(--text)] break-words">
          {meta.heir.name}
        </p>
        <p className="truncate text-xs text-muted">
          {meta.heir.email ? `${meta.heir.email} · ` : ""}
          <span className="font-mono">{shortAddr(meta.heir.address)}</span>
        </p>
      </div>
      <StatusPill tone={pill.tone} label={pill.label} />
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          className="rounded-md px-2 py-1 text-xs text-muted hover:bg-[var(--surface-2,var(--surface))] hover:text-alarm"
          aria-label={`Remove ${meta.heir.name}`}
        >
          Remove
        </button>
      ) : null}
    </div>
  );
}

/**
 * Multi-heir group card. Lists every heir in the group with their
 * name, contact, and a "this is the active one" indicator. Tapping
 * a heir's row switches the active vault to that sibling — the
 * heartbeat/check-in card above already drives the active vault, so
 * this lets the owner inspect each heir's individual state without
 * leaving the dashboard.
 *
 * The per-heir status pill is intentionally NOT shown here yet — we
 * only have the active vault's `VaultView` from the server; fetching
 * status for every sibling on every dashboard load would multiply
 * server calls. Acceptable for an MVP: the active vault's status is
 * the one in the big check-in card; switching active vault shows
 * that sibling's status. Phase 2 (server-side vault_groups + a
 * batch fetch endpoint) makes this less awkward.
 */
function HeirGroupList({
  groupVaults,
  activeId,
  onSelect,
  onRemove,
}: {
  groupVaults: VaultMeta[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onRemove: (id: string, heirName: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs uppercase tracking-wider text-dim">
        Heirs ({groupVaults.length})
      </p>
      {groupVaults.map((meta) => {
        const isActive = meta.id === activeId;
        const heirName = meta.heir.name || "(unnamed)";
        return (
          <div
            key={meta.id}
            className={`card-flat flex items-center gap-4 p-4 transition-colors ${
              isActive
                ? "border-accent"
                : "hover:bg-[var(--surface-2)]"
            }`}
            style={isActive ? { background: "var(--accent-tint)" } : undefined}
            aria-current={isActive ? "true" : undefined}
          >
            <button
              type="button"
              onClick={() => onSelect(meta.id)}
              disabled={isActive}
              className="flex min-w-0 flex-1 items-center gap-4 text-left"
            >
              <Avatar name={heirName} />
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold text-[var(--text)]">
                  {heirName}
                </p>
                <p className="truncate text-xs text-muted">
                  {meta.heir.email || "—"}
                </p>
              </div>
              {isActive ? (
                <span className="text-xs text-accent font-medium">Active</span>
              ) : (
                <span className="text-xs text-muted">Tap to view</span>
              )}
            </button>
            <button
              type="button"
              onClick={() => onRemove(meta.id, heirName)}
              className="rounded-md px-2 py-1 text-xs text-muted hover:bg-[var(--surface-2,var(--surface))] hover:text-alarm"
              aria-label={`Remove ${heirName}`}
            >
              Remove
            </button>
          </div>
        );
      })}
      <p className="mt-1.5 text-xs text-dim">
        One tap on "I'm still here" checks in for all {groupVaults.length}{" "}
        heirs at once.
      </p>
    </div>
  );
}

/* ----------------------------- Activity list ------------------------------ */

function ActivityList({ events }: { events: VaultEvent[] }) {
  // Newest first, cap to 6.
  const items = useMemo(
    () => events.slice().reverse().slice(0, 6),
    [events],
  );
  return (
    <section aria-label="Recent activity">
      <p className="text-xs uppercase tracking-wider text-dim">
        Recent activity
      </p>
      {items.length === 0 ? (
        <p className="mt-3 text-sm text-muted">Nothing yet.</p>
      ) : (
        <ul role="list" className="mt-3 divide-y divide-[var(--border)]">
          {items.map((e) => (
            <li key={e.id} className="flex items-center gap-3 py-3 text-sm">
              <span
                aria-hidden="true"
                className={`h-2 w-2 rounded-full ${
                  e.kind === "checkin" || e.kind === "resolved"
                    ? "bg-ok"
                    : e.kind === "alarm"
                    ? "bg-alarm"
                    : "bg-warning"
                }`}
              />
              <span className="flex-1 text-muted">
                <strong className="font-semibold text-[var(--text)]">
                  {friendlyEventKind(e.kind)}
                </strong>
              </span>
              <span className="font-mono text-xs text-dim">
                {formatWhen(e.created_at)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function humanAgo(then: Date, now: Date): string {
  const ms = now.getTime() - then.getTime();
  if (ms < 0) return "moments ago";
  if (ms < 60_000) return "moments ago";
  if (ms < 3_600_000) {
    const m = Math.floor(ms / 60_000);
    return `${m} minute${m === 1 ? "" : "s"} ago`;
  }
  if (ms < 86_400_000) {
    const h = Math.floor(ms / 3_600_000);
    return `${h} hour${h === 1 ? "" : "s"} ago`;
  }
  const d = Math.floor(ms / 86_400_000);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

/* ----------------------------- Empty state -------------------------------- */

function EmptyState({ onNavigate }: { onNavigate: (r: Route) => void }) {
  return (
    <main className="bg-app fade-in">
      <div className="mx-auto max-w-xl px-5 py-20 text-center md:py-28">
        <p className="eyebrow-dim">Dashboard</p>
        <h1 className="mt-6 font-serif text-3xl md:text-4xl">
          No vault on this device yet
        </h1>
        <p className="mt-3 text-muted">
          Set one up in a few minutes, or sign in with your email and password
          if you already have one.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Button onClick={() => onNavigate("setup")}>Set up a vault</Button>
          <Button variant="ghost" onClick={() => onNavigate("checkin")}>
            Sign in
          </Button>
        </div>
      </div>
    </main>
  );
}

/* ----------------------------- Alarm banner ------------------------------- */

function AlarmBanner({ vault, now }: { vault: VaultView; now: Date }) {
  // claim_eligible_at is when the heir gets emailed if the owner does
  // nothing. "Days remaining" is the number the user reads first; we
  // round up to whole days (12.1 hours left → "1 day") so the copy
  // never under-counts how urgent things are.
  const due = vault.claim_eligible_at
    ? parseRfc(vault.claim_eligible_at)
    : null;
  const daysLeft = due
    ? Math.max(
        0,
        Math.ceil((due.getTime() - now.getTime()) / (24 * 3600 * 1000)),
      )
    : null;
  return (
    <section className="rounded-md border border-red-500/40 bg-red-500/10 p-4">
      <p className="text-sm font-semibold text-red-300">
        You missed a check-in.
      </p>
      <p className="mt-1 text-xs text-red-200/80">
        {daysLeft != null
          ? `${daysLeft} day${daysLeft === 1 ? "" : "s"} left before your heir is notified. Tap "I'm still here" above to reset.`
          : "Tap \"I'm still here\" above to reset the clock."}
      </p>
    </section>
  );
}

/* ----------------------------- Frozen banner ------------------------------ */

function FrozenBanner({ vault, now }: { vault: VaultView; now: Date }) {
  const until = vault.panic_frozen_until
    ? parseRfc(vault.panic_frozen_until)
    : null;
  const daysLeft = until
    ? Math.max(
        0,
        Math.ceil((until.getTime() - now.getTime()) / (24 * 3600 * 1000)),
      )
    : null;
  return (
    <section className="rounded-md border border-amber-500/40 bg-amber-500/10 p-4">
      <p className="text-sm font-semibold text-amber-200">
        Panic stop active. The vault is frozen.
      </p>
      <p className="mt-1 text-xs text-amber-100/80">
        {daysLeft != null
          ? `Auto-unfreezes in ${daysLeft} day${daysLeft === 1 ? "" : "s"}.`
          : "Auto-unfreezes after the 90-day window."}
        {vault.has_trusted_contact ? " Your trusted contact has been alerted." : ""}
      </p>
    </section>
  );
}

/* ----------------------------- LNURL card --------------------------------- */

function LnurlCard({ lnurl }: { lnurl: string }) {
  // Collapsed by default — the raw LNURL string is a wall of
  // monospace most visits never need (the big check-in button above
  // covers the common path). Expanding mirrors ReceiveCard.
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  function copy() {
    void navigator.clipboard.writeText(lnurl).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    });
  }
  // `lightning:` URI lets a wallet on the same device pick up the
  // LNURL directly when the user taps the button on mobile. On
  // desktop it's a no-op (no handler) — the QR rendering would help
  // there, but a string-copy fallback gets us 90% of the way without
  // pulling in a QR library.
  const deepLink = `lightning:${lnurl}`;
  return (
    <section className="card-flat p-5">
      <p className="text-xs uppercase tracking-wider text-dim">
        Check in with a tiny Lightning payment
      </p>
      <p className="mt-1.5 text-sm text-muted">
        The same code works every time. No setup, no expiry.
      </p>
      {!expanded ? (
        <div className="mt-3">
          <Button size="sm" variant="ghost" onClick={() => setExpanded(true)}>
            Show Lightning code
          </Button>
        </div>
      ) : (
        <>
          <div className="mt-3 break-all rounded bg-[var(--bg-elev)] p-3 font-mono text-xs">
            {lnurl}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="ghost" onClick={copy}>
              {copied ? "Copied ✓" : "Copy LNURL"}
            </Button>
            <a href={deepLink} className="inline-block">
              <Button size="sm" variant="ghost">
                Open in wallet
              </Button>
            </a>
            <Button size="sm" variant="ghost" onClick={() => setExpanded(false)}>
              Hide
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

/* ----------------------------- Panic card --------------------------------- */

function PanicCard({
  lnurl,
  hasTrustedContact,
}: {
  lnurl: string;
  // The "alert your trusted contact" copy only renders when one is on
  // file — promising an alert the server won't send is issue #70.
  hasTrustedContact: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [copied, setCopied] = useState(false);
  if (!expanded) {
    return (
      <section className="card-flat p-5">
        <p className="text-xs uppercase tracking-wider text-dim">
          Emergency stop
        </p>
        <p className="mt-1.5 text-sm text-muted">
          If your wallet is compromised, freeze this vault for 90 days
          {hasTrustedContact ? " and alert your trusted contact" : ""}.
        </p>
        <div className="mt-3">
          <Button size="sm" variant="ghost" onClick={() => setExpanded(true)}>
            Show panic stop
          </Button>
        </div>
      </section>
    );
  }
  if (!confirm) {
    return (
      <section className="rounded-md border border-amber-500/40 bg-amber-500/5 p-5">
        <p className="text-sm font-semibold text-amber-200">
          Sure you want a panic stop?
        </p>
        <p className="mt-1 text-xs text-amber-100/80">
          Paying the next QR freezes this vault for 90 days. Your heir
          cannot claim during that window.
          {hasTrustedContact
            ? " Your trusted contact will be alerted that you triggered a panic."
            : ""}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setConfirm(true)}
          >
            Yes, show me the QR
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setExpanded(false)}>
            Cancel
          </Button>
        </div>
      </section>
    );
  }
  const deepLink = `lightning:${lnurl}`;
  return (
    <section className="rounded-md border border-amber-500/40 bg-amber-500/5 p-5">
      <p className="text-sm font-semibold text-amber-200">
        Panic stop: pay to freeze
      </p>
      <p className="mt-1 text-xs text-amber-100/80">
        Pay this from any Lightning wallet. The freeze takes effect the
        moment the invoice settles.
      </p>
      <div className="mt-3 break-all rounded bg-[var(--bg-elev)] p-3 font-mono text-xs">
        {lnurl}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            void navigator.clipboard.writeText(lnurl).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 2000);
            });
          }}
        >
          {copied ? "Copied ✓" : "Copy"}
        </Button>
        <a href={deepLink} className="inline-block">
          <Button size="sm" variant="ghost">
            Open in wallet
          </Button>
        </a>
        <Button size="sm" variant="ghost" onClick={() => setExpanded(false)}>
          Hide
        </Button>
      </div>
    </section>
  );
}
