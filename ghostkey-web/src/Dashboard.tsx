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
  getAllVaultMetas,
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
  isIosBrowserNeedingInstall,
  isPushSupported,
  subscribeToPush,
} from "./push";
import { unsealOwner } from "./crypto/sealing";
import { usePrice, btcAndUsd, satsToUsd, formatUsd } from "./fiat";
import { fanOutCheckin, lastResortCheckinOpen } from "./checkin";
import { useToolDoneState } from "./toolStatus";
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
  // Owner token is available only while this trusted-device session is
  // unlocked. If it's missing
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
  const [events, setEvents] = useState<ActivityEvent[]>([]);
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
  // Whether the "Close this vault" confirmation is open.
  const [closeOpen, setCloseOpen] = useState(false);
  // Status of every share in this vault, keyed by share id. The share
  // on screen also has its status in `vault`; this map is what lets the
  // dashboard say anything about the vault as a whole, like whether
  // every heir has claimed.
  const [shareStatus, setShareStatus] = useState<Record<string, string>>({});
  // Set when the owner closes out the last vault on this device. Keeps them
  // on the dashboard with an explanation instead of dropping them on the
  // landing page as though they had never signed in.
  const [emptied, setEmptied] = useState<EmptyReason>(null);
  // VAPID public key from /health, or null when the server has no
  // push keypair configured. Gates the reminder opt-in card.
  const [pushKey, setPushKey] = useState<string | null>(null);
  // Set-once tools that are already done drop off the More list below;
  // the nav's Tools page stays their permanent home.
  const toolsDone = useToolDoneState(activeId, ownerToken);

  const now = useTicker(1000);

  const refresh = useCallback(async () => {
    if (!activeId) return;
    try {
      const v = await api.getVault(activeId, ownerToken);
      setVault(v);
      const perHeir = await Promise.all(
        groupVaults.map(async (g) => {
          const token = getVaultOwnerToken(g.id);
          // Activity spans the whole account, not just the heir on
          // screen, so nothing an owner did on another heir is hidden.
          // Best-effort per sibling: if one heir's fetch fails we just
          // omit its rows.
          const events = await api
            .listEvents(g.id, token)
            .then((evs): ActivityEvent[] =>
              evs.map((e) => ({ ...e, heirName: g.heir.name })),
            )
            .catch((): ActivityEvent[] => []);
          // The share on screen already has its status in `v`; the rest
          // need their own fetch. Without it the dashboard can only
          // speak about one share, so it can't tell a claimed sibling
          // from a live one, or know when the whole vault is finished.
          const status =
            g.id === activeId
              ? v.status
              : await api
                  .getVault(g.id, token)
                  .then((sv): string | null => sv.status)
                  .catch((): string | null => null);
          return { id: g.id, events, status };
        }),
      );
      setEvents(
        perHeir
          .flatMap((p) => p.events)
          .sort((a, b) => a.created_at.localeCompare(b.created_at)),
      );
      const statuses: Record<string, string> = {};
      for (const p of perHeir) {
        if (p.status) statuses[p.id] = p.status;
      }
      setShareStatus(statuses);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setError(
          "Sign in with your email and password to open this vault.",
        );
        return;
      }
      if (e instanceof ApiError && e.status === 404) {
        // The server no longer has this vault (e.g. owner deleted it
        // from another device, or it was an old test row). Drop the
        // local meta so the dashboard doesn't keep clinging to a row
        // that's gone, then say so in place. Silently switching to
        // whatever else is in localStorage is what made a claimed
        // sibling look like the vault the owner had just been on.
        removeVaultMeta(activeId);
        setEmptied("gone");
        return;
      }
      // Otherwise swallow; the next tick may succeed.
    }
  }, [activeId, ownerToken, groupVaults]);

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
      // A refusal on one sibling doesn't stop the rest: see
      // `fanOutCheckin`. A 409 is the normal answer for a sibling that
      // can't be checked in right now (already checked in this period,
      // or already claimed), so we skip it and keep going.
      const { checkedIn, skipped, hardError } = await fanOutCheckin(
        groupVaults.map((g) => g.id),
        async (id) => {
          try {
            await api.checkin(id, getVaultOwnerToken(id));
            return "checked-in";
          } catch (e) {
            if (e instanceof ApiError && e.status === 409) return "skipped";
            return { error: e instanceof ApiError ? e.message : String(e) };
          }
        },
      );
      await refresh();
      if (checkedIn > 0) {
        // At least one heir's clock moved. Any 409s alongside it are
        // heirs that didn't need the tap, which isn't worth an error.
        setJustChecked(true);
        window.setTimeout(() => setJustChecked(false), 4000);
      } else if (hardError) {
        setError(hardError);
      } else if (skipped > 0) {
        setError(
          "Already checked in this period. Your next check-in opens when the current cycle ends.",
        );
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
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
      // Other heirs may live in other groups; removeVaultMeta has already
      // pointed us at one. Only show the empty state when the device truly
      // has nothing left, never bounce to the landing page.
      const elsewhere = getAllVaultMetas();
      if (elsewhere.length === 0) {
        setEmptied("removed");
        return;
      }
      setActiveVaultId(elsewhere[0].id);
      if (typeof window !== "undefined") window.location.reload();
      return;
    }
    // Switch active to the first remaining sibling and reload so all
    // derived state (groupVaults, vault, events) refreshes.
    setActiveVaultId(remaining[0].id);
    if (typeof window !== "undefined") window.location.reload();
  }

  // Closing the whole vault. This is the only way to end the last
  // share, which is why it carries a full explanation instead of
  // sitting in the heir list as one more "Remove". It deletes every
  // share row and the local copies of them.
  //
  // It does nothing to the Bitcoin. The coins stay where they are and
  // stay spendable from the owner's own wallet, and the timelock is
  // baked into the address either way, so closing here cannot undo it.
  async function onCloseVault() {
    setError(null);
    const pairs: Array<{ meta: VaultMeta; token: string }> = [];
    const missing: string[] = [];
    for (const g of groupVaults) {
      const token = getVaultOwnerToken(g.id);
      if (token) pairs.push({ meta: g, token });
      else missing.push(g.heir.name || "an heir");
    }
    if (missing.length > 0) {
      setCloseOpen(false);
      setError(
        `This browser doesn't have the owner credential for ${missing.join(
          ", ",
        )}. Sign in first, then close the vault.`,
      );
      return;
    }
    setBusy(true);
    let done = 0;
    for (const { meta: g, token } of pairs) {
      try {
        await api.deleteVault(g.id, token);
      } catch (e) {
        // A 404 means the row is already gone, so keep going and clean
        // up locally. Anything else stops here and says how far it got,
        // rather than leaving the owner thinking the vault is closed.
        if (!(e instanceof ApiError && e.status === 404)) {
          setBusy(false);
          setCloseOpen(false);
          setError(
            `Closed ${done} of ${pairs.length} shares, then couldn't close ` +
              `${g.heir.name || "one of them"}: ` +
              `${e instanceof ApiError ? e.message : String(e)}. ` +
              `Try again to finish.`,
          );
          return;
        }
      }
      removeVaultMeta(g.id);
      done += 1;
    }
    setBusy(false);
    setCloseOpen(false);
    // Other vaults may live on this device under a different email.
    const elsewhere = getAllVaultMetas();
    if (elsewhere.length === 0) {
      setEmptied("closed");
      return;
    }
    setActiveVaultId(elsewhere[0].id);
    if (typeof window !== "undefined") window.location.reload();
  }

  if (emptied) {
    return <EmptyState onNavigate={onNavigate} reason={emptied} />;
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
  // Not funded yet: the check-in clock hasn't started, so no deadline
  // is "past" and none of the check-in affordances apply.
  const isUnfunded = vault?.status === "unfunded";
  const isPastDeadline =
    vault != null &&
    !isUnfunded &&
    (vault.status === "alarmed" ||
      isClaiming ||
      isClosed ||
      parseRfc(vault.next_deadline_at) < now);
  // Whether every heir has claimed, and whether to offer closing the
  // vault at all. See `vaultCloseState`.
  const { allClaimed: allSharesClaimed, canClose } = vaultCloseState(
    groupVaults,
    shareStatus,
  );

  return (
    <main className="bg-app fade-in">
      {/* pb-28 reserves space for the fixed GhostKey AI button
          (bottom-5) so it never overlaps the last activity rows. */}
      <div className="mx-auto max-w-2xl px-5 py-10 pb-28 md:py-14 md:pb-28 lg:max-w-5xl">
        <Greeting
          meta={meta}
          vault={vault}
          now={now}
          isClaiming={isClaiming}
          isClosed={isClosed}
          isUnfunded={isUnfunded}
          isPastDeadline={isPastDeadline}
          multiHeir={groupVaults.length > 1}
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
              {!vault && !error ? (
                <VaultLoadingCard />
              ) : isClosed ? (
                <VaultClosedCard
                  meta={meta}
                  multiHeir={groupVaults.length > 1}
                />
              ) : isClaiming ? (
                <ClaimInProgressCard
                  meta={meta}
                  status={vault!.status}
                  unlockEta={vault?.unlock_eta ?? null}
                />
              ) : isUnfunded ? (
                <AwaitingFundingCard
                  meta={meta}
                  held={vault.activation_held === true}
                />
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
                  heirLabel={groupVaults.length > 1 ? meta.heir.name : null}
                  onNavigate={onNavigate}
                />
              </div>
            ) : null}

            {vault?.lnurl_checkin && !isClosed && !isClaiming && !isUnfunded ? (
              <div className="mt-5">
                <LnurlCard lnurl={vault.lnurl_checkin} />
              </div>
            ) : null}

          </div>

          <div className="min-w-0">
            {vault ? (
              <p className="text-sm text-muted lg:mt-0 mt-5">
                If you stop checking in, your heir can claim once your
                Bitcoin has sat untouched for about{" "}
                <span className="text-[var(--text)]">
                  {demoMode
                    ? prettySeconds(vault.grace_period_secs)
                    : prettyBlocks(vault.timelock_blocks)}
                </span>
                . Only moving or adding money resets that timer; checking
                in keeps your vault active but doesn&apos;t.
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
                  statusById={shareStatus}
                />
              ) : (
                // No "Remove" on the last share. A share is meant to end
                // in a claim, not a deletion: the owner can die before
                // the heir claims, and a stray tap here would take the
                // whole plan with it. Ending the last one is closing the
                // vault, which lives below with the full explanation.
                <HeirCard meta={meta} vault={vault} />
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

              {/* Closing the vault. Kept out of the way while the plan
                  is still doing its job: it shows once every heir has
                  claimed, or when one share is left and the owner has
                  no other way to end it. */}
              {vault && canClose ? (
                <div className="mt-4">
                  <button
                    type="button"
                    onClick={() => setCloseOpen(true)}
                    className="text-xs text-dim underline underline-offset-4 hover:text-muted"
                  >
                    Close this vault
                  </button>
                </div>
              ) : null}
            </div>

            {/* Set-once tools live on their own pages now, reached from
                this compact list, so the dashboard stays status + money +
                heir. Once a tool is done (video saved, practice sent,
                reminders on) its link leaves this list too; the nav's
                Tools page is the permanent home for all of them. */}
            <MoreLinks
              onNavigate={onNavigate}
              showMessage={
                Boolean(vault) && !isClosed && toolsDone.hasVideo !== true
              }
              showPractice={
                Boolean(vault) &&
                !isClosed &&
                !isClaiming &&
                !vault?.drill_started_at
              }
              showEmergency={
                Boolean(vault?.lnurl_panic) &&
                vault?.status !== "frozen" &&
                !isClosed &&
                !isClaiming
              }
              showReminders={
                Boolean(vault) &&
                !isClosed &&
                !isClaiming &&
                !isUnfunded &&
                Boolean(pushKey) &&
                Boolean(ownerToken) &&
                toolsDone.remindersOn !== true
              }
            />
          </div>
        </div>

        <div className="mt-12">
          <ActivityCard events={events} onOpen={() => onNavigate("activity")} />
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

      {closeOpen ? (
        <CloseVaultDialog
          shareCount={groupVaults.length}
          allClaimed={allSharesClaimed}
          busy={busy}
          onCancel={() => setCloseOpen(false)}
          onConfirm={onCloseVault}
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
          onFreeCheckin={
            // Last resort only: the free tap is offered inside the
            // Lightning modal's error state, but only within the final
            // 24h before the heir would be contacted. Outside that
            // window Lightning is the only way to check in.
            lastResortCheckinOpen(vault?.claim_eligible_at, now)
              ? () => {
                  setLightningOpen(false);
                  onCheckin();
                }
              : undefined
          }
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
  heirLabel,
  onNavigate,
}: {
  vaultId: string;
  network: string;
  ownerToken: string | null;
  canManage: boolean;
  /** Whose share this card is for. Shown only for multi-heir accounts,
   *  so the deposit address reads as belonging to a specific heir. */
  heirLabel: string | null;
  onNavigate: (r: Route) => void;
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
      {heirLabel ? (
        <p className="mb-3 text-xs uppercase tracking-wider text-dim">
          {heirLabel}'s share
        </p>
      ) : null}
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
          <HeirDetailsCard
            vaultId={vaultId}
            ownerToken={ownerToken}
            onEdit={canManage ? () => onNavigate("heir-contact") : undefined}
          />
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
  // Flips true a few seconds into a slow load so the card reassures
  // instead of looking frozen — public explorers can crawl.
  const [slow, setSlow] = useState(false);
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
    setSlow(false);
    // After a few seconds, show a "still checking" note so a slow public
    // explorer doesn't read as a frozen card.
    const slowAt = window.setTimeout(() => setSlow(true), 6000);
    try {
      // Cap the wait so a stuck explorer resolves to a clear, actionable
      // error instead of an endless spinner.
      const b = await withTimeout(api.getVaultBalance(vaultId), 20000);
      setBalance(b);
    } catch (e) {
      // Keep raw server text (e.g. "500 Internal Server Error") out of the
      // owner's face — a chain/explorer hiccup isn't actionable jargon. The
      // figure already falls back to "—" when nothing loaded, so it never
      // reads as a misleading zero.
      const msg = e instanceof Error ? e.message : String(e);
      setError(
        msg === "timeout"
          ? "Couldn't load your balance. The block explorer is slow right now. Tap Refresh to try again."
          : "Couldn't load your balance right now. Tap Refresh to try again.",
      );
    } finally {
      window.clearTimeout(slowAt);
      setSlow(false);
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
            aria-label={hidden ? "Show balance" : "Hide balance"}
            title={hidden ? "Show balance" : "Hide balance"}
            className="text-muted hover:text-[var(--text)]"
          >
            {hidden ? (
              // eye-off: balance is hidden, tap to reveal
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-4 w-4"
                aria-hidden="true"
              >
                <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
                <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
                <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
                <line x1="2" y1="2" x2="22" y2="22" />
              </svg>
            ) : (
              // eye: balance is shown, tap to hide
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-4 w-4"
                aria-hidden="true"
              >
                <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            )}
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
          {loading && slow && !error ? (
            <p className="mt-1.5 text-sm text-muted">
              Still checking your balance. Public networks can be slow, hang
              tight.
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
  onEdit,
}: {
  vaultId: string;
  ownerToken: string;
  /** Opens the contact editor. Omitted when the vault is closed or a
   *  claim is underway, where the editor would refuse anyway. */
  onEdit?: () => void;
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
      {/* The owner is looking at the exact field they want to change.
          Before this, the only way there was nav → Tools, which owners
          did not find (#315). */}
      {onEdit ? (
        <div>
          <button
            type="button"
            onClick={onEdit}
            className="text-sm text-[var(--accent)] underline hover:text-[var(--text)]"
          >
            Change how they're reached
          </button>
        </div>
      ) : null}
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
              alt={`QR code for the share address ${view.address}`}
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
      const blobs = await api.getSealedBlobs(vaultId, ownerToken);
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
            ? `The remaining ${formatSats(result.remaining_sat)} stays in this share, still covered by your inheritance plan. Your heir's waiting clock starts fresh from this move.`
            : "This share is now empty; add Bitcoin any time to keep the plan going."}
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
                    ? "Everything in this share"
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
  isUnfunded,
  isPastDeadline,
  multiHeir,
}: {
  meta: VaultMeta;
  vault: VaultView | null;
  now: Date;
  isClaiming: boolean;
  isClosed: boolean;
  isUnfunded: boolean;
  isPastDeadline: boolean;
  multiHeir: boolean;
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
  if (isUnfunded) {
    // Money lives in a share, not in the vault as a whole, so name the
    // heir whose share is waiting on it. With several heirs this is
    // the difference between "which one?" and an obvious next step.
    headline = `Fund ${meta.heir.name || "your heir"}'s share to start`;
    sub = `Add Bitcoin to this share to start it. Check-ins begin once the funds arrive, not before.`;
  } else if (isClosed) {
    // A claim ends one heir's share. It never closes the vault: the
    // owner keeps the same key and can add another heir on top of it.
    const heirName = meta.heir.name || "Your heir";
    headline = `${heirName}'s share is claimed`;
    sub = multiHeir
      ? `${heirName} claimed their share. Your other shares are unaffected.`
      : `${heirName} claimed their share. You can add another heir any time.`;
  } else if (isClaiming) {
    const heirName = meta.heir.name || "Your heir";
    if (vault?.status === "claiming") {
      headline = "Your heir is claiming";
      sub = `${heirName} is finalising the claim. The check-in loop is over for this share.`;
    } else {
      // timelock_started: the link is out, but Bitcoin's timelock has to
      // run before the funds can move. The heir is waiting, not claiming.
      headline = "Your heir is waiting to claim";
      const eta = vault?.unlock_eta
        ? parseRfc(vault.unlock_eta).toLocaleDateString(undefined, {
            weekday: "long",
            month: "long",
            day: "numeric",
          })
        : null;
      sub = eta
        ? `${heirName} has the claim link. The funds unlock on the Bitcoin network around ${eta}.`
        : `${heirName} has the claim link. Bitcoin holds the funds for a set time before they can be collected.`;
    }
  } else if (isPastDeadline) {
    headline = "Check-in overdue";
    const missedAgo = deadline ? humanAgo(deadline, now) : null;
    sub = missedAgo
      ? `Your check-in was due ${missedAgo}. Check in to reset the clock, or your heir will be contacted.`
      : `Check in to reset the clock before your heir is contacted.`;
  } else {
    headline = "You're still here";
    const next = deadline ? countdown(deadline, now).friendly : null;
    sub =
      (last ? `Last checked in ${ago}.` : `${meta.heir.name}'s share is active.`) +
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

/* ------------------------- Vault loading card ----------------------------- */

/**
 * Shown in the main card slot from mount until the first `/vaults/:id`
 * response lands. Without it the dashboard painted a greeting over a
 * mostly empty page — no cards, no signal — for however long the fetch
 * took, which read as broken on anything slower than a warm server.
 */
function VaultLoadingCard() {
  return (
    <section
      className="card-flat p-5 py-10 text-center"
      role="status"
      aria-live="polite"
    >
      <span
        aria-hidden="true"
        className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-[var(--accent)] border-r-transparent"
      />
      <p className="mt-3 text-sm text-muted">Opening your vault…</p>
    </section>
  );
}

/* --------------------------- Heartbeat card ------------------------------- */

/**
 * Pre-funding replacement for the HeartbeatCard. Shown while the vault
 * is `unfunded`: the check-in clock only starts once Bitcoin actually
 * lands on-chain, so there's nothing to check in on yet. We point the
 * owner at the balance card below (their deposit address) and reassure
 * them the countdown hasn't begun.
 */
/**
 * Funded, but the clock has not started because the owner's email is
 * still unconfirmed (#326).
 *
 * This replaces the "fund your share" card rather than sitting next to
 * it. Telling someone who has just sent Bitcoin to go and send Bitcoin
 * is how a person concludes their money is gone.
 *
 * The tone is deliberately not an error. Nothing is wrong and nothing
 * is at risk: the coins are on-chain in an address only the owner can
 * spend from, and one tap in an email starts everything.
 */
function ClockHeldCard({ meta }: { meta: VaultMeta }) {
  return (
    <section className="card relative overflow-hidden p-5 text-center md:p-8">
      <div className="flex flex-col items-center">
        <div
          aria-hidden="true"
          className="flex h-16 w-16 items-center justify-center rounded-full bg-[var(--surface-2,var(--surface))] text-3xl"
        >
          ✉
        </div>
        <h2 className="mt-6 font-serif text-2xl">
          Your Bitcoin arrived. Confirm your email to start.
        </h2>
        <p className="mt-2 max-w-md text-sm text-muted">
          The money is safe in your share and only you can spend it. We
          just can&apos;t start your check-in clock until we know we can
          reach you, because everything after it depends on you getting
          our reminders. Tap the link in the email we sent, and{" "}
          {meta.heir.name || "your heir"}&apos;s plan begins.
        </p>
      </div>
    </section>
  );
}

function AwaitingFundingCard({
  meta,
  held,
}: {
  meta: VaultMeta;
  /** The coins have landed; what's missing is the owner's confirmed
   *  email (#326). Same `unfunded` status, opposite instruction. */
  held: boolean;
}) {
  if (held) {
    return <ClockHeldCard meta={meta} />;
  }
  return (
    <section className="card relative overflow-hidden p-5 text-center md:p-8">
      <div className="flex flex-col items-center">
        <div
          aria-hidden="true"
          className="flex h-16 w-16 items-center justify-center rounded-full bg-[var(--surface-2,var(--surface))] text-3xl"
        >
          ₿
        </div>
        <h2 className="mt-6 font-serif text-2xl">
          {`Fund ${meta.heir.name || "your heir"}'s share to start`}
        </h2>
        <p className="mt-2 max-w-md text-sm text-muted">
          Send Bitcoin to this share using the balance card below. Nothing
          starts until the funds arrive: no check-in clock, no reminders, and
          {" "}
          {meta.heir.name || "your heir"} can't be contacted. Once it's funded,
          your monthly check-ins begin.
        </p>
      </div>
    </section>
  );
}

/**
 * Terminal-state replacement for the HeartbeatCard. Shown when the
 * vault's status flips to `claimed` — the heir has broadcast the
 * claim transaction, so the check-in loop is over and there's
 * nothing for the owner to do here anymore.
 */
function VaultClosedCard({
  meta,
  multiHeir,
}: {
  meta: VaultMeta;
  multiHeir: boolean;
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
        {/* A claim closes one heir's share, never the vault. The
            heading always carries the heir's name so this sentence can
            never be read as a statement about the owner's whole vault
            (which is what "This vault's work is done" did). There is no
            dismiss button: the share stays visible, marked claimed, and
            only leaves when the owner removes that heir. */}
        <h2 className="mt-6 font-serif text-2xl">
          {`${meta.heir.name || "Your heir"}'s share is claimed`}
        </h2>
        <p className="mt-2 max-w-md text-sm text-muted">
          {multiHeir
            ? `${meta.heir.name || "Your heir"} claimed their share. Your other shares are unaffected.`
            : `${meta.heir.name || "Your heir"} claimed their share. Nothing more to do for it. You can add another heir any time.`}
        </p>
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
  unlockEta,
}: {
  meta: VaultMeta;
  status: string;
  unlockEta: string | null;
}) {
  const broadcasting = status === "claiming";
  const heirName = meta.heir.name || "Your heir";
  const eta = unlockEta
    ? parseRfc(unlockEta).toLocaleDateString(undefined, {
        weekday: "long",
        month: "long",
        day: "numeric",
      })
    : null;
  const waitingSub = eta
    ? `${heirName} has the claim link. The funds unlock on the Bitcoin network around ${eta}.`
    : `${heirName} has the claim link. Bitcoin holds the funds for a set time before they can be collected.`;
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
          {broadcasting ? "Heir is broadcasting" : "Heir is waiting to claim"}
        </h2>
        <p className="mt-2 max-w-md text-sm text-muted">
          {broadcasting
            ? `${heirName} is finalising the claim transaction.`
            : waitingSub}
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
      ? "Lightning ready"
      : state.kind === "warming"
        ? "Lightning starting up"
        : "Lightning offline";
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
            <span className="font-semibold">Confirm your email.</span> Your
            check-in clock stays stopped until you do, so nothing starts
            and nobody is contacted. Tap the link and you&apos;re running.
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

export function PushOptInCard({
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
    | { kind: "install-hint" }
    | { kind: "busy" }
    | { kind: "done" }
    | { kind: "error"; message: string };
  const [state, setState] = useState<CardState>({ kind: "checking" });

  useEffect(() => {
    let alive = true;
    if (window.localStorage.getItem(pushDismissKey(vaultId)) === "1") {
      setState({ kind: "hidden" });
      return;
    }
    if (!isPushSupported()) {
      // iOS Safari in the browser can't do push at all — it's only
      // exposed to installed (Add to Home Screen) apps. The useful
      // nudge there is "install", not a dead "turn on" button (#224).
      setState(
        isIosBrowserNeedingInstall()
          ? { kind: "install-hint" }
          : { kind: "hidden" },
      );
      return;
    }
    if (Notification.permission === "denied") {
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

  if (state.kind === "install-hint") {
    return (
      <div
        className="card-flat flex items-center justify-between gap-3 px-4 py-3"
        data-testid="push-optin-card"
      >
        <p className="text-sm text-muted">
          Want check-in reminders on this phone? Tap Share, then "Add to
          Home Screen", and open GhostKey from there.
        </p>
        <button
          type="button"
          onClick={onNotNow}
          className="shrink-0 text-xs text-dim underline-offset-2 hover:underline"
        >
          Not now
        </button>
      </div>
    );
  }

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
}: {
  meta: VaultMeta;
  vault: VaultView | null;
}) {
  const status = vault?.status ?? "ok";
  // T1 (#117): while the owner is alive and checking in, the heir is just
  // standing by — they cannot take anything. Showing "Ready to claim" in
  // success-green there is false and frightening. We also separate the two
  // end states: `timelock_started` means the link is out but Bitcoin's
  // timelock is still running (the heir is waiting, not claiming), while
  // `claiming` is an actual broadcast in flight.
  const pill =
    status === "claimed"
      ? { tone: "neutral" as const, label: "Claimed" }
      : status === "claiming"
      ? { tone: "alarm" as const, label: "Claiming" }
      : status === "timelock_started"
      ? { tone: "warning" as const, label: "Waiting to claim" }
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
 * Each row's status comes from `statusById`, which the dashboard
 * fills by fetching every share on refresh. That is one call per
 * share; a server-side batch endpoint would do it in one, but the
 * fan-out already happens for activity, so this rides along with it.
 */
function HeirGroupList({
  groupVaults,
  activeId,
  statusById,
  onSelect,
  onRemove,
}: {
  groupVaults: VaultMeta[];
  activeId: string | null;
  /** Status of each share, keyed by share id. A share missing from the
   *  map is one whose fetch failed, so it gets the neutral treatment
   *  rather than a claim we can't stand behind. */
  statusById: Record<string, string>;
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
        const status = statusById[meta.id];
        const claimed = status === "claimed";
        const removable = shareRemovable(status);
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
              {claimed ? (
                <span className="text-xs text-muted font-medium">Claimed</span>
              ) : isActive ? (
                <span className="text-xs text-accent font-medium">Viewing</span>
              ) : (
                <span className="text-xs text-muted">Tap to view</span>
              )}
            </button>
            {removable ? (
              <button
                type="button"
                onClick={() => onRemove(meta.id, heirName)}
                className="rounded-md px-2 py-1 text-xs text-muted hover:bg-[var(--surface-2,var(--surface))] hover:text-alarm"
                aria-label={`Remove ${heirName}`}
              >
                Remove
              </button>
            ) : null}
          </div>
        );
      })}
      <p className="mt-1.5 text-xs text-dim">
        One check-in covers all {groupVaults.length}{" "}
        heirs at once.
      </p>
    </div>
  );
}

/* --------------------------- Close vault dialog --------------------------- */

/**
 * Closing the vault is the one destructive act GhostKey offers an
 * owner, so it gets a page of its own rather than a browser confirm.
 * Two things it has to say plainly, because getting either wrong
 * frightens people or misleads them:
 *
 *   - The Bitcoin is untouched. It never moved, and closing can't
 *     move it.
 *   - Closing does NOT undo the waiting period, and it does not reach
 *     into a recovery kit the heir already has. Saying otherwise would
 *     be the kind of impossibility claim this codebase doesn't make.
 */
function CloseVaultDialog({
  shareCount,
  allClaimed,
  busy,
  onCancel,
  onConfirm,
}: {
  shareCount: number;
  /** Every heir has already claimed, so the links being revoked are
   *  spent ones. Softens the warning without hiding it. */
  allClaimed: boolean;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [understood, setUnderstood] = useState(false);
  const shares = shareCount === 1 ? "share" : "shares";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="close-vault-title"
    >
      <div className="card relative w-full max-w-xl p-6 max-h-[90vh] overflow-y-auto">
        <button
          type="button"
          aria-label="Close"
          onClick={onCancel}
          disabled={busy}
          className="absolute right-3 top-3 rounded-full p-2 text-muted hover:bg-surface-2 hover:text-[var(--text)]"
        >
          ✕
        </button>

        <h2 id="close-vault-title" className="font-serif text-2xl">
          Close this vault?
        </h2>
        <p className="mt-2 text-sm text-muted">
          This ends the plan we hold for you. It does not touch your money.
        </p>

        <p className="mt-5 text-xs uppercase tracking-wider text-dim">
          What stays yours
        </p>
        <ul className="mt-2 space-y-2 text-sm text-muted">
          <li>
            Your Bitcoin stays where it is, in your own wallet. GhostKey
            never held your keys, so there is nothing here to give back.
          </li>
          <li>
            The waiting period is built into your Bitcoin address.
            Closing here cannot change that. If you gave an heir their
            recovery kit, they still have it. To end the plan on the
            Bitcoin side too, move your coins to a fresh wallet.
          </li>
        </ul>

        <p className="mt-5 text-xs uppercase tracking-wider text-dim">
          What goes
        </p>
        <ul className="mt-2 space-y-2 text-sm text-muted">
          <li>
            All {shareCount} {shares} in this vault are deleted.
            {allClaimed
              ? " Those claims are already done, so nobody loses anything they were waiting for."
              : " Your heirs can no longer claim through GhostKey."}
          </li>
          <li>
            The messages and files you left for them go with it. We keep
            no copy.
          </li>
          <li>Check-ins stop. Nobody will be contacted for you again.</li>
        </ul>

        <p className="mt-5 text-sm text-[var(--text)]">
          This cannot be undone. A claim link, once gone, cannot be
          brought back.
        </p>

        <label className="mt-5 flex items-start gap-3 text-sm text-muted">
          <input
            type="checkbox"
            checked={understood}
            onChange={(e) => setUnderstood(e.target.checked)}
            disabled={busy}
            className="mt-0.5"
          />
          <span>I understand this cannot be undone.</span>
        </label>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Keep my vault
          </Button>
          <Button
            onClick={onConfirm}
            disabled={!understood}
            loading={busy}
          >
            Close vault
          </Button>
        </div>
      </div>
    </div>
  );
}

/* -------------------------- Share lifecycle rules ------------------------- */

/**
 * Whether a share can still be removed from the heir list.
 *
 * Once a claim is live the server refuses removal, and a share that
 * has already been claimed is history the owner shouldn't be able to
 * delete with a stray tap. A share whose status we couldn't fetch
 * stays removable: the server is the one that decides, and it will
 * say no if it has to.
 */
export function shareRemovable(status: string | undefined): boolean {
  return status !== "claimed" && !claimInFlight(status);
}

/** The heir has the claim link and Bitcoin is doing its part. Nothing
 *  the owner does here may take that away. */
function claimInFlight(status: string | undefined): boolean {
  return status === "claiming" || status === "timelock_started";
}

/**
 * When to offer "Close this vault".
 *
 * Closing is kept out of the way while the plan is still doing its
 * job. It appears in exactly two places: once every heir has claimed,
 * so the vault has nothing left to do, and when a single share is
 * left, which is the only case where the owner has no other way to
 * end it (the last share has no "Remove").
 *
 * A share we couldn't fetch counts as not claimed, so `allClaimed`
 * only goes true when we actually know.
 *
 * Never while a claim is in flight. An heir holding a live claim link
 * must not have it deleted out from under them, and closing is a
 * delete with a longer explanation.
 */
export function vaultCloseState(
  shares: { id: string }[],
  statusById: Record<string, string>,
): { allClaimed: boolean; canClose: boolean } {
  const allClaimed =
    shares.length > 0 && shares.every((s) => statusById[s.id] === "claimed");
  const inFlight = shares.some((s) => claimInFlight(statusById[s.id]));
  return {
    allClaimed,
    canClose: !inFlight && (allClaimed || shares.length === 1),
  };
}

/* ----------------------------- Activity card ------------------------------ */

/** A vault event tagged with which heir it belongs to, so a multi-heir
 *  account can show one merged feed without hiding anything. */
type ActivityEvent = VaultEvent & { heirName?: string };

/**
 * Calm one-row summary of the newest event. Tapping it opens the full
 * history on its own page (details + explorer links live there), keeping
 * the dashboard uncluttered rather than stacking a long list below.
 */
function ActivityCard({
  events,
  onOpen,
}: {
  events: ActivityEvent[];
  onOpen: () => void;
}) {
  const latest = events.length ? events[events.length - 1] : null;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="View all activity"
      className="card-flat flex w-full items-center gap-4 p-5 text-left transition-colors hover:bg-[var(--surface-2)]"
    >
      <div className="min-w-0 flex-1">
        <p className="text-xs uppercase tracking-wider text-dim">
          Recent activity
        </p>
        {latest ? (
          <p className="mt-1 truncate text-sm">
            <strong className="font-semibold text-[var(--text)]">
              {friendlyEventKind(latest.kind)}
            </strong>
            <span className="text-muted"> · {formatWhen(latest.created_at)}</span>
          </p>
        ) : (
          <p className="mt-1 text-sm text-muted">Nothing yet.</p>
        )}
      </div>
      {events.length > 0 ? (
        <span className="shrink-0 text-xs text-dim">
          View all {events.length} →
        </span>
      ) : null}
    </button>
  );
}

/* ------------------------------- More links ------------------------------- */

/**
 * Compact list linking out to the set-once tools that used to be cards on
 * the dashboard (heir message, practice run, reminders, emergency). Each
 * link only shows when its tool applies, so the list disappears entirely
 * when there's nothing to offer.
 */
function MoreLinks({
  onNavigate,
  showMessage,
  showPractice,
  showEmergency,
  showReminders,
}: {
  onNavigate: (r: Route) => void;
  showMessage: boolean;
  showPractice: boolean;
  showEmergency: boolean;
  showReminders: boolean;
}) {
  const items: Array<{ label: string; desc: string; route: Route }> = [];
  if (showMessage)
    items.push({
      label: "Message for your heir",
      desc: "Record or update your video",
      route: "heir-message",
    });
  if (showPractice)
    items.push({
      label: "Practice a claim",
      // A practice run is now the only thing that confirms the heir's
      // address actually works (#327): the provider tells us it was
      // delivered. Say that, because "let them rehearse" sounds
      // optional and this isn't.
      desc: "Check your heir can be reached, and let them rehearse",
      route: "practice",
    });
  if (showReminders)
    items.push({
      label: "Reminders",
      desc: "Get a nudge to check in",
      route: "reminders",
    });
  if (showEmergency)
    items.push({
      label: "Emergency options",
      desc: "Freeze this share if needed",
      route: "emergency",
    });
  if (items.length === 0) return null;

  return (
    <nav
      className="card-flat mt-5 divide-y divide-[var(--border)] p-0"
      aria-label="More"
    >
      {items.map((it) => (
        <button
          key={it.route}
          type="button"
          onClick={() => onNavigate(it.route)}
          className="flex w-full items-center gap-3 p-4 text-left transition-colors hover:bg-[var(--surface-2)]"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-[var(--text)]">
              {it.label}
            </span>
            <span className="block truncate text-xs text-muted">{it.desc}</span>
          </span>
          <span aria-hidden="true" className="shrink-0 text-lg text-dim">
            ›
          </span>
        </button>
      ))}
    </nav>
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

/** Why the dashboard has nothing to show. `null` is a device that never
 *  had a vault; the rest are owners who just closed one out and need to
 *  be told that, not greeted like a stranger. */
export type EmptyReason = null | "removed" | "gone" | "closed";

function EmptyState({
  onNavigate,
  reason = null,
}: {
  onNavigate: (r: Route) => void;
  reason?: EmptyReason;
}) {
  // "Add an heir" and "set up a vault" are two different acts: the first
  // adds a share to the vault you are already signed into, the second
  // starts a separate vault on a separate email. This screen can only
  // offer the second one honestly, because the owner's email and key live
  // on the vault rows themselves — removing the last heir deletes the last
  // row and the account with it, so there is nothing here to add a share
  // to. Restoring "Add an heir" here needs the server to keep the row.
  const copy = {
    removed: {
      title: "That was your last heir",
      body: "Your vault has no shares left. Your Bitcoin is untouched and still yours. Set up a vault again whenever you're ready.",
    },
    gone: {
      title: "This share is no longer on the server",
      body: "It was removed, possibly from another device. Nothing here can reach it. Sign in if you have other shares.",
    },
    closed: {
      title: "Your vault is closed",
      body: "Your Bitcoin is untouched and still yours, in your own wallet. What's gone is the plan we held for it: the claim links no longer work, and nobody will be contacted for you. Set up a vault again whenever you're ready.",
    },
  };
  const shown = reason ? copy[reason] : null;

  return (
    <main className="bg-app fade-in">
      <div className="mx-auto max-w-xl px-5 py-20 text-center md:py-28">
        <p className="eyebrow-dim">Dashboard</p>
        <h1 className="mt-6 font-serif text-3xl md:text-4xl">
          {shown ? shown.title : "No vault on this device yet"}
        </h1>
        <p className="mt-3 text-muted">
          {shown
            ? shown.body
            : "Set one up in a few minutes, or sign in with your email and password if you already have one."}
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          {/* One route, one label. This button has always gone to the
              full new-email setup flow, so labelling it "Add an heir"
              told the owner it would do something it never did. */}
          <Button onClick={() => onNavigate("setup")}>Set up a vault</Button>
          {/* Sign in only where it can help. An owner who just closed out
              their last heir is already signed in on this device, so
              offering it there is noise. A vault that vanished from the
              server is the one case where signing in may find others. */}
          {!shown || reason === "gone" ? (
            <Button variant="ghost" onClick={() => onNavigate("checkin")}>
              Sign in
            </Button>
          ) : null}
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
          ? `${daysLeft} day${daysLeft === 1 ? "" : "s"} left before your heir is notified. Check in to reset the clock.`
          : "Check in to reset the clock."}
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

export function PanicCard({
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
