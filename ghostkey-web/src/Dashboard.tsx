/**
 * Dashboard — the home of an active vault on this device.
 *
 * Reads the active vault id from localStorage, fetches the current
 * vault and the savings view, and renders, savings first:
 *
 *   - The savings promise ("Stack sats. Build your future.") and what
 *     was added this month
 *   - The savings hero: balance, Add money, goal, reminders, deposits
 *   - A one-line check-in, which becomes the full Heartbeat card at the
 *     top once a check-in is overdue
 *   - "Build wealth that outlives you": the heirs, the wait, the last
 *     check-in, with heir management one tap away
 *
 * Anything that needs fixing (unconfirmed email, unreachable guardian,
 * overdue check-in, frozen or claimed share) still comes before savings.
 *
 * If there is no active vault on this device, we offer the two paths
 * out: set one up, or sign in with email + password.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Avatar,
  Button,
  Heartbeat,
  useTicker,
  usePolling,
} from "./ui";
import { ReceiveCard } from "./ReceiveCard";
import { ChooseHeirCard } from "./ChooseHeir";
import { SpendFromGoal } from "./Goals";
import { SavingsCard } from "./SavingsCard";
import { addedThisMonth } from "./savings";
import { challengeName, freshWins, homeChallengeLine, markWinSeen, seenWins } from "./challenges";
import {
  ApiError,
  api,
  type VaultView,
  type VaultBalanceView,
  type OwnerSendResponse,
  type HeirProfileView,
  type SavingsView,
  type ChallengeView,
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
import { usePrice, satsToUsd, formatUsd } from "./fiat";
import { formatAmount, usdLine, useUnit } from "./units";
import { UnitToggle } from "./UnitToggle";
import { fanOutCheckin } from "./checkin";
import { heirContactDue } from "./heirContact";
import { useToolDoneState } from "./toolStatus";
import type { Route } from "./App";
import { unlockErrorMessage } from "./unlockErrors";

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justChecked, setJustChecked] = useState(false);
  // Whether the server is running in seconds-scale demo mode. Drives
  // the "Waiting period" StatCard's units (seconds vs blocks) so the
  // dashboard matches what the operator picked at setup time.
  const [demoMode, setDemoMode] = useState(false);
  // Whether the "Add a heir" modal is open.
  const [addHeirOpen, setAddHeirOpen] = useState(false);
  // Whether the "Close this vault" confirmation is open.
  const [closeOpen, setCloseOpen] = useState(false);
  // Whether the "Manage heirs" panel is open.
  const [manageOpen, setManageOpen] = useState(false);
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
  // Savings lead the page, so the balance and the savings view are
  // fetched here once and shared by the headline and the savings hero.
  const balanceState = useVaultBalance(activeId);
  const [savings, setSavings] = useState<SavingsView | null>(null);
  useEffect(() => {
    if (!activeId || !ownerToken) return;
    let alive = true;
    api
      .getSavings(activeId, ownerToken)
      .then((v) => alive && setSavings(v))
      .catch(() => {
        /* the hero just shows the balance without the savings details */
      });
    return () => {
      alive = false;
    };
  }, [activeId, ownerToken]);

  const now = useTicker(1000);

  const refresh = useCallback(async () => {
    if (!activeId) return;
    try {
      const v = await api.getVault(activeId, ownerToken);
      setVault(v);
      const perHeir = await Promise.all(
        groupVaults.map(async (g) => {
          const token = getVaultOwnerToken(g.id);
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
          return { id: g.id, status };
        }),
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

  // Probe the server once for demo mode and the push key. Silent on
  // failure: both just stay off.
  useEffect(() => {
    let alive = true;
    api
      .health()
      .then((h) => {
        if (!alive) return;
        setDemoMode(Boolean(h.demo_mode));
        setPushKey(h.push_public_key ?? null);
      })
      .catch(() => {
        if (!alive) return;
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
  // (cascading events and notifications) and the local
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
  const heirNotice = heirReachNotice(vault);
  const guardiansToFix = guardianReachNotice(vault);
  const isClosed = vault?.status === "claimed";
  // Not funded yet: the check-in clock hasn't started, so no deadline
  // is "past" and none of the check-in affordances apply.
  // No heir chosen yet (inheritance skipped at setup): savings only.
  // The server keeps such a vault `unfunded` so no clock runs, which is
  // why "unfunded" alone no longer means "waiting for coins".
  const heirPending = vault?.heir_pending === true;
  const statusUnfunded = vault?.status === "unfunded";
  const isUnfunded = statusUnfunded && !heirPending;
  const isPastDeadline =
    vault != null &&
    !statusUnfunded &&
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
          savings={savings}
          balanceHidden={balanceState.hidden}
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

        {/* Single column on mobile; on desktop a wide savings column and a
            narrower "If you stop showing up" column. The mobile source
            order is unchanged — the grid only kicks in at lg. */}
        <div className="mt-10 lg:grid lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start lg:gap-8">
          <div className="min-w-0">
            {/* Anything that needs fixing comes before the savings. T6
                (#117): an unconfirmed email guards the one mechanism that
                prevents an accidental trigger, so it leads the column. */}
            {vault && !isClosed && !isClaiming && vault.owner_contact_verified === false ? (
              <div className="mb-5">
                <ConfirmEmailCard vaultId={vault.id} ownerToken={ownerToken} />
              </div>
            ) : null}

            {guardiansToFix > 0 ? (
              <div className="mb-5">
                <div
                  className="flex items-center justify-between gap-3 rounded-xl border border-app px-4 py-3"
                  style={{ background: "var(--warning-tint)", color: "var(--warning)" }}
                  role="alert"
                  data-testid="guardian-reach-card"
                >
                  <p className="text-sm text-[var(--text)]">
                    <span className="font-semibold">
                      {guardiansToFix === 1
                        ? "We can't reach one of your guardians."
                        : `We can't reach ${guardiansToFix} of your guardians.`}
                    </span>{" "}
                    Your heir needs a guardian to claim, so add an email for
                    them now.
                  </p>
                  <button
                    type="button"
                    onClick={() => onNavigate("heir-contact")}
                    className="shrink-0 text-xs font-medium text-[var(--text)] underline underline-offset-2"
                  >
                    Fix guardians
                  </button>
                </div>
              </div>
            ) : null}

            {heirNotice ? (
              <div className="mb-5">
                <HeirReachCard
                  kind={heirNotice}
                  heirName={meta.heir.name}
                  onNavigate={onNavigate}
                />
              </div>
            ) : null}

            {/* The state cards that outrank saving: still loading, a
                share claimed or being claimed, not funded yet, or a
                check-in that is overdue. Otherwise the savings lead. */}
            {!vault && !error ? (
              <div className="mb-5">
                <VaultLoadingCard />
              </div>
            ) : isClosed ? (
              <div className="mb-5">
                <VaultClosedCard
                  meta={meta}
                  multiHeir={groupVaults.length > 1}
                />
              </div>
            ) : isClaiming ? (
              <div className="mb-5">
                <ClaimInProgressCard
                  meta={meta}
                  status={vault!.status}
                  unlockEta={vault?.unlock_eta ?? null}
                />
              </div>
            ) : isUnfunded ? (
              <div className="mb-5">
                <AwaitingFundingCard
                  meta={meta}
                  held={vault.activation_held === true}
                />
              </div>
            ) : vault && isPastDeadline ? (
              <div className="mb-5">
                <HeartbeatCard
                  meta={meta}
                  vault={vault}
                  now={now}
                  busy={busy}
                  justChecked={justChecked}
                  error={error}
                  onCheckin={onCheckin}
                />
              </div>
            ) : null}

            {vault ? (
              <SavingsHero
                vaultId={vault.id}
                network={vault.network}
                ownerToken={ownerToken}
                canManage={!isClosed && !isClaiming}
                heirLabel={groupVaults.length > 1 ? meta.heir.name : null}
                balanceState={balanceState}
                savings={savings}
                onSavings={setSavings}
                onNavigate={onNavigate}
              />
            ) : null}

            {vault && !isClosed && !isClaiming && !statusUnfunded && !isPastDeadline ? (
              <div className="mt-5">
                <CheckinRow
                  vault={vault}
                  now={now}
                  busy={busy}
                  justChecked={justChecked}
                  error={error}
                  onCheckin={onCheckin}
                />
              </div>
            ) : null}

            {/* A sign-in or network error with no vault to show it on. */}
            {!vault && error ? (
              <p className="text-sm text-alarm">{error}</p>
            ) : null}
          </div>

          <div className="mt-10 min-w-0 lg:mt-0">
            <h2 className="font-serif text-2xl">Build wealth that outlives you</h2>
            <p className="mt-1 text-sm text-muted">
              If you stop showing up, your bitcoin goes to the people you
              choose. It is never lost.
            </p>

            {vault && heirPending && ownerToken ? (
              <div className="mt-4">
                <ChooseHeirCard
                  vaultId={vault.id}
                  ownerToken={ownerToken}
                  waitLabel={
                    demoMode
                      ? prettySeconds(vault.grace_period_secs)
                      : prettyBlocks(vault.timelock_blocks)
                  }
                  onChosen={() => {
                    if (typeof window !== "undefined") window.location.reload();
                  }}
                />
              </div>
            ) : null}

            {vault && !heirPending ? (
              <div className="mt-4">
                <LegacySummary
                  heirNames={groupVaults.map((g) => g.heir.name).filter(Boolean)}
                  waitLabel={
                    demoMode
                      ? prettySeconds(vault.grace_period_secs)
                      : prettyBlocks(vault.timelock_blocks)
                  }
                  lastCheckin={
                    vault.last_checkin_at
                      ? humanAgo(parseRfc(vault.last_checkin_at), now)
                      : "Not yet"
                  }
                  manageOpen={manageOpen}
                  onToggleManage={() => setManageOpen((o) => !o)}
                  onNavigate={onNavigate}
                />
              </div>
            ) : null}

            {/* Heir management stays one tap away, not on show. */}
            {vault && !heirPending && manageOpen ? (
              <div className="mt-4 space-y-4" data-testid="manage-heirs">
                <p className="text-xs text-muted">
                  Your heir can claim once your bitcoin has sat untouched for
                  the wait above. Adding or moving money restarts that wait;
                  checking in keeps your plan active but doesn&apos;t.
                </p>
                {groupVaults.length > 1 ? (
                  <HeirGroupList
                    groupVaults={groupVaults}
                    activeId={activeId}
                    onSelect={(id) => {
                      // Switch active vault. Reload so the dashboard
                      // re-runs against the new active id and refreshes
                      // the server state ("show me Bob now").
                      if (typeof window !== "undefined") {
                        window.localStorage.setItem("gk:activeVaultId", id);
                        window.location.reload();
                      }
                    }}
                    onRemove={onRemoveHeir}
                    statusById={shareStatus}
                  />
                ) : null}

                {/* The heir's contact and note, sealed at rest; only the
                    signed-in owner can open them. */}
                {ownerToken ? (
                  <div className="card-flat p-5">
                    <HeirDetailsCard
                      vaultId={vault.id}
                      ownerToken={ownerToken}
                      onEdit={
                        !isClosed && !isClaiming
                          ? () => onNavigate("heir-contact")
                          : undefined
                      }
                    />
                  </div>
                ) : null}

                {/* Add another heir: own share, own claim link, same
                    one-tap check-in. A new heir reuses your owner key. */}
                <div className="flex flex-wrap items-center gap-4">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setAddHeirOpen(true)}
                  >
                    Add heir
                  </Button>
                  {/* Closing the vault: only once every heir has claimed,
                      or when one share is left and there's no other way
                      to end it. */}
                  {canClose ? (
                    <button
                      type="button"
                      onClick={() => setCloseOpen(true)}
                      className="text-xs text-dim underline underline-offset-4 hover:text-muted"
                    >
                      Close this vault
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}

            {/* One suggested next step at most. Everything else lives on
                the Family page. */}
            <NextStep
              onNavigate={onNavigate}
              showPractice={
                Boolean(vault) &&
                !heirPending &&
                !isClosed &&
                !isClaiming &&
                !vault?.drill_started_at
              }
              showMessage={
                Boolean(vault) &&
                !heirPending &&
                !isClosed &&
                toolsDone.hasVideo !== true
              }
              showReminders={
                Boolean(vault) &&
                !heirPending &&
                !isClosed &&
                !isClaiming &&
                !statusUnfunded &&
                Boolean(pushKey) &&
                Boolean(ownerToken) &&
                toolsDone.remindersOn !== true
              }
            />
          </div>
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

      <AssistChat
        intro="Questions about check-ins, the waiting period, or what your heir will see? Ask away."
      />
    </main>
  );
}

/* ------------------------------ Savings hero ------------------------------ */

/**
 * The top of the dashboard: what you've saved, the one big "Add money"
 * button, and your goal, year, reminders and deposits underneath. Send is
 * there but quieter, since saving is the everyday job. Add and Send only
 * appear while the vault is active and the owner is signed in here.
 */
function SavingsHero({
  vaultId,
  network,
  ownerToken,
  canManage,
  heirLabel,
  balanceState,
  savings,
  onSavings,
  onNavigate,
}: {
  vaultId: string;
  network: string;
  ownerToken: string | null;
  canManage: boolean;
  /** Whose share this card is for. Shown only for multi-heir accounts,
   *  so the deposit address reads as belonging to a specific heir. */
  heirLabel: string | null;
  balanceState: VaultBalanceState;
  /** Null while loading, or when the savings view isn't available. */
  savings: SavingsView | null;
  onSavings: (v: SavingsView) => void;
  onNavigate: (r: Route) => void;
}) {
  const canSend = canManage && Boolean(ownerToken);
  const [panel, setPanel] = useState<"add" | "send" | null>(null);
  // Challenges are a quiet extra: if they don't load (or the server
  // doesn't have them yet), Home just doesn't mention them.
  const [challenges, setChallenges] = useState<ChallengeView[] | null>(null);
  const [seen, setSeen] = useState<string[]>(() => seenWins());
  useEffect(() => {
    if (!ownerToken) return;
    let live = true;
    api
      .getChallenges(vaultId, ownerToken)
      .then((r) => live && setChallenges(r.challenges))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [vaultId, ownerToken]);
  const win = challenges ? freshWins(challenges, seen, new Date())[0] : undefined;
  const challengeLine =
    challenges && canManage ? homeChallengeLine(challenges, (savings?.deposit_count ?? 0) > 0) : null;
  const toggle = (p: "add" | "send") => setPanel((cur) => (cur === p ? null : p));

  return (
    <section
      className="card overflow-hidden p-5 md:p-7"
      data-testid="savings-hero"
      style={{
        // A soft glow of the accent in one corner, so the balance reads
        // as the centre of the app without adding anything to read.
        background:
          "radial-gradient(120% 90% at 100% 0%, color-mix(in srgb, var(--accent) 16%, transparent), transparent 60%), var(--surface)",
      }}
    >
      {heirLabel ? (
        <p className="mb-3 text-xs uppercase tracking-wider text-dim">
          {heirLabel}'s share
        </p>
      ) : null}
      <BalanceDisplay state={balanceState} />

      <div className="mt-6 flex items-start gap-6">
        {canManage ? (
          <RoundAction
            label="Add money"
            primary
            expanded={panel === "add"}
            onClick={() => toggle("add")}
            icon={<path d="M12 5v14M5 12h14" />}
          />
        ) : null}
        {canSend ? (
          <RoundAction
            label="Send"
            expanded={panel === "send"}
            onClick={() => toggle("send")}
            icon={<path d="M12 19V5M6 11l6-6 6 6" />}
          />
        ) : null}
        <RoundAction
          label="History"
          onClick={() => onNavigate("activity")}
          icon={
            <>
              <circle cx="12" cy="12" r="8" />
              <path d="M12 8v4l3 2" />
            </>
          }
        />
      </div>

      {win ? (
        <div
          className="mt-5 rounded-2xl border border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] p-4"
          data-testid="challenge-win"
          role="status"
        >
          <p className="font-medium">
            You did it: {challengeName(win, savings?.goals?.find((g) => g.id === win.goal_id)?.title)}
          </p>
          <p className="mt-1 text-sm text-muted">Your badge is on the Challenges page.</p>
          <div className="mt-3 flex gap-4 text-sm">
            <button
              type="button"
              onClick={() => onNavigate("challenges")}
              className="font-medium text-accent underline-offset-2 hover:underline"
            >
              See your badge
            </button>
            <button
              type="button"
              onClick={() => {
                markWinSeen(win.id);
                setSeen(seenWins());
              }}
              className="text-muted underline-offset-2 hover:underline"
            >
              Nice
            </button>
          </div>
        </div>
      ) : null}
      {challengeLine ? (
        <p className="mt-4 text-sm" data-testid="challenge-line">
          <span className="font-medium">{challengeLine}</span>
          <span className="text-muted"> · </span>
          <button
            type="button"
            onClick={() => onNavigate("challenges")}
            className="text-muted underline underline-offset-2 hover:text-[var(--text)]"
          >
            See
          </button>
        </p>
      ) : null}

      {panel === "add" ? (
        <div className="mt-5 border-t border-app pt-5">
          <ReceiveCard vaultId={vaultId} embedded autoShow />
        </div>
      ) : null}
      {panel === "send" && ownerToken ? (
        <div className="mt-5 border-t border-app pt-5">
          <SendCard
            vaultId={vaultId}
            network={network}
            ownerToken={ownerToken}
            embedded
            afterSend={(outSat) =>
              savings && savings.goals?.length ? (
                <SpendFromGoal
                  vaultId={vaultId}
                  ownerToken={ownerToken}
                  goals={savings.goals}
                  amountSat={outSat}
                  onView={onSavings}
                />
              ) : null
            }
          />
        </div>
      ) : null}

      {savings ? (
        <div className="mt-6 border-t border-app pt-5">
          <SavingsCard
            vaultId={vaultId}
            ownerToken={ownerToken}
            view={savings}
            onView={onSavings}
            balanceSat={balanceState.balance?.total_sat ?? null}
            balanceHidden={balanceState.hidden}
          />
        </div>
      ) : null}
    </section>
  );
}

/** A round icon button with its label underneath. */
function RoundAction({
  label,
  icon,
  onClick,
  primary = false,
  expanded,
}: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  primary?: boolean;
  /** Set for buttons that open a panel in place. */
  expanded?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={expanded}
      className="group flex w-16 flex-col items-center gap-2 text-xs text-[var(--text)]"
    >
      <span
        className={`flex h-12 w-12 items-center justify-center rounded-full transition-transform group-hover:scale-105 ${
          primary
            ? "bg-[var(--accent)] text-[var(--bg)]"
            : "border border-[var(--border-hi)] text-[var(--text)]"
        }`}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-5 w-5"
          aria-hidden="true"
        >
          {icon}
        </svg>
      </span>
      {label}
    </button>
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

/** Balance state for the savings hero, shared with the headline so the
 *  chain is asked once. Hiding the balance is remembered per device and
 *  also skips the slow lookup.
 *
 *  The last known balance (saved by the server after every scan) shows
 *  at once while the live lookup runs. `asOf` says how old it is, and is
 *  null once a live answer is on screen. If the live lookup fails, the
 *  saved balance stays up with its age instead of an error. */
export interface VaultBalanceState {
  balance: VaultBalanceView | null;
  /** When the balance on screen was checked, if it is the saved one. */
  asOf: string | null;
  loading: boolean;
  /** True a few seconds into a slow load. */
  slow: boolean;
  error: string | null;
  hidden: boolean;
  load: () => Promise<void>;
  toggleHidden: () => void;
}

function useVaultBalance(vaultId: string | null): VaultBalanceState {
  const [balance, setBalance] = useState<VaultBalanceView | null>(null);
  const [asOf, setAsOf] = useState<string | null>(null);
  // What's on screen, read inside `load` without re-creating it: a saved
  // balance must never replace a live one.
  const shown = useRef<{ vaultId: string | null; live: boolean }>({ vaultId: null, live: false });
  const [loading, setLoading] = useState(false);
  // Flips true a few seconds into a slow load so the card reassures
  // instead of looking frozen — public explorers can crawl.
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState<boolean>(() => {
    try {
      return localStorage.getItem(BALANCE_HIDDEN_KEY) === "1";
    } catch {
      return false;
    }
  });

  const load = useCallback(async () => {
    if (!vaultId) return;
    if (shown.current.vaultId !== vaultId) {
      // Another vault: don't leave the last one's number up.
      shown.current = { vaultId, live: false };
      setBalance(null);
      setAsOf(null);
    }
    setLoading(true);
    setError(null);
    setSlow(false);
    // The saved balance, straight from the server's database. Shown only
    // until a live answer arrives, and never over one.
    const saved = api.getLastVaultBalance(vaultId).catch(() => null);
    void saved.then((last) => {
      if (last && shown.current.vaultId === vaultId && !shown.current.live) {
        setBalance(last);
        setAsOf(last.checked_at);
      }
    });
    // After a few seconds, show a "still checking" note so a slow public
    // explorer doesn't read as a frozen card.
    const slowAt = window.setTimeout(() => setSlow(true), 6000);
    try {
      // Cap the wait so a stuck explorer resolves to a clear, actionable
      // error instead of an endless spinner.
      const b = await withTimeout(api.getVaultBalance(vaultId), 20000);
      if (shown.current.vaultId !== vaultId) return;
      shown.current.live = true;
      setBalance(b);
      setAsOf(null);
    } catch (e) {
      // A saved balance on screen stays up, marked with its age; that
      // beats an error over a blank. A live one stays up too.
      if (shown.current.vaultId === vaultId && (shown.current.live || (await saved))) return;
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

  // Only reach out to the chain when the balance is visible.
  useEffect(() => {
    if (!hidden) void load();
  }, [load, hidden]);

  const toggleHidden = useCallback(() => {
    setHidden((h) => {
      const next = !h;
      try {
        localStorage.setItem(BALANCE_HIDDEN_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  return { balance, asOf, loading, slow, error, hidden, load, toggleHidden };
}

/** The big number at the top of the savings hero. */
function BalanceDisplay({ state }: { state: VaultBalanceState }) {
  const { balance, asOf, loading, slow, error, hidden, load, toggleHidden } = state;
  const usdPerBtc = usePrice();
  const unit = useUnit();

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-xs uppercase tracking-wider text-dim">Your savings</p>
        <div className="flex items-center gap-3">
          {!hidden ? <UnitToggle /> : null}
          {/* Refresh only earns its place when a load failed. */}
          {!hidden && error ? (
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
        <div className="mt-2 font-display text-5xl font-bold tracking-tight md:text-6xl">
          ••••••
        </div>
      ) : (
        <>
          <div
            className="mt-2 font-display text-5xl font-bold tracking-tight md:text-6xl"
            data-testid="savings-balance"
          >
            {balance ? formatAmount(balance.total_sat, unit) : loading ? "…" : "—"}
          </div>
          {balance && usdLine(balance.total_sat, usdPerBtc) ? (
            <p className="mt-1 text-sm text-accent">
              {usdLine(balance.total_sat, usdPerBtc)}
            </p>
          ) : null}
          {balance && balance.unconfirmed_sat > 0 ? (
            <p className="mt-1.5 text-sm text-muted">
              {formatAmount(balance.confirmed_sat, unit)} confirmed,{" "}
              {formatAmount(balance.unconfirmed_sat, unit)} pending
            </p>
          ) : null}
          {balance && asOf ? (
            <p className="mt-1.5 text-xs text-dim" data-testid="balance-as-of">
              Updated {humanAgo(new Date(asOf), new Date())}
              {loading ? (
                " · checking now"
              ) : (
                <>
                  {" · "}
                  <button
                    type="button"
                    onClick={() => void load()}
                    className="underline-offset-2 hover:underline"
                  >
                    Refresh
                  </button>
                </>
              )}
            </p>
          ) : null}
          {loading && slow && !error && !asOf ? (
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

/* ----------------------------- Receive card ------------------------------- */

/**
 * Lets the owner add funds after setup. The address comes from the
 * public address endpoint (the same first address every time — see
 * get_vault_address server-side), so no owner token is needed. The
 * address is fetched lazily on first expand, and the QR renders
 * locally as a data: URL — the CSP blocks external image hosts.
 */
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
  afterSend,
}: {
  vaultId: string;
  network: string;
  ownerToken: string;
  embedded?: boolean;
  /** Shown under a successful send, given what left the vault (amount
   *  plus fee). Savings uses it to ask which goal it came from. */
  afterSend?: (outSat: number) => ReactNode;
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
  const unit = useUnit();

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
      setError(unlockErrorMessage(e));
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
          Sent ✓ {formatAmount(result.sent_sat, unit)} is on its way.
        </p>
        <p className="mt-1.5 text-sm text-muted">
          Network fee: {formatAmount(result.fee_sat, unit)}.{" "}
          {result.remaining_sat > 0
            ? `The remaining ${formatAmount(result.remaining_sat, unit)} stays in this share, still covered by your inheritance plan. Your heir's waiting clock starts fresh from this move.`
            : "This share is now empty; add Bitcoin any time to keep the plan going."}
        </p>
        {afterSend ? afterSend(result.sent_sat + result.fee_sat) : null}
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
                    : `${formatAmount(amountSat as number, unit)}${amountUsd ? ` (≈ ${amountUsd})` : ""}`
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
  savings,
  balanceHidden,
}: {
  meta: VaultMeta;
  vault: VaultView | null;
  now: Date;
  isClaiming: boolean;
  isClosed: boolean;
  isUnfunded: boolean;
  isPastDeadline: boolean;
  multiHeir: boolean;
  savings: SavingsView | null;
  /** Amounts stay off the headline when the owner hid their balance. */
  balanceHidden: boolean;
}) {
  const unit = useUnit();
  const deadline = vault?.next_deadline_at
    ? parseRfc(vault.next_deadline_at)
    : null;

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
    // Everyday state: savings lead. The check-in has its own row below
    // the savings, and takes the headline back only when it's overdue.
    // Same promise as the website's front page.
    headline = "Stack sats. Build your future.";
    const month = savings ? addedThisMonth(savings.deposits, now) : null;
    sub =
      month == null
        ? ""
        : month === 0
          ? "Nothing added this month yet. Any amount counts."
          : balanceHidden
            ? "You've added to your savings this month."
            : `You've added ${formatAmount(month, unit)} this month.`;
  }

  return (
    <div>
      <h1 className="font-serif text-3xl md:text-4xl">{headline}</h1>
      {sub ? <p className="mt-1 text-sm text-muted">{sub}</p> : null}
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
          Tap Add money below to send Bitcoin to this share. Nothing
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
}: {
  meta: VaultMeta;
  vault: VaultView | null;
  now: Date;
  busy: boolean;
  justChecked: boolean;
  error: string | null;
  onCheckin: () => void;
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
          onTap={busy || locked ? undefined : onCheckin}
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

        {/* Checking in is free: being signed in on this device is the
            proof of life. */}
        <div className="mt-6 flex w-full max-w-xs flex-col items-stretch gap-3 md:max-w-none md:flex-row md:flex-wrap md:items-center md:justify-center">
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
        </div>

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

/**
 * The everyday check-in: one quiet row under the savings. It grows back
 * into the full HeartbeatCard at the top of the page once a check-in is
 * overdue, so it can never be missed when it matters.
 */
function CheckinRow({
  vault,
  now,
  busy,
  justChecked,
  error,
  onCheckin,
}: {
  vault: VaultView;
  now: Date;
  busy: boolean;
  justChecked: boolean;
  error: string | null;
  onCheckin: () => void;
}) {
  const cd = countdown(parseRfc(vault.next_deadline_at), now);
  // Same once-per-period lockout as the HeartbeatCard.
  const nextOpen = vault.last_checkin_at
    ? new Date(
        parseRfc(vault.last_checkin_at).getTime() +
          vault.checkin_period_secs * 1000,
      )
    : null;
  const locked = nextOpen !== null && nextOpen > now;
  const lockedCd = locked && nextOpen ? countdown(nextOpen, now) : null;

  return (
    <section className="card-flat p-4" data-testid="checkin-row">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-[var(--text)]">
            {justChecked
              ? "Thanks, you're checked in"
              : locked
                ? "You're checked in"
                : "Still here?"}
          </p>
          <p className="text-xs text-muted" aria-live="polite">
            {locked
              ? // `friendly` already starts with "in".
                `Next check-in opens ${lockedCd?.friendly ?? "shortly"}.`
              : `Check in ${cd.friendly}. It's free and takes one tap.`}
          </p>
        </div>
        {locked || justChecked ? (
          <span className="shrink-0 text-sm text-muted" aria-hidden="true">
            ✓
          </span>
        ) : (
          <Button size="sm" onClick={onCheckin} loading={busy} className="shrink-0">
            I&apos;m still here
          </Button>
        )}
      </div>
      {error ? <p className="mt-2 text-sm text-alarm">{error}</p> : null}
    </section>
  );
}

/**
 * "If you stop showing up": the inheritance plan in one glance. Who
 * inherits, how long Bitcoin makes them wait, and when you last checked
 * in, with links to the details. Visible, but never in the way of saving.
 */
function LegacySummary({
  heirNames,
  waitLabel,
  lastCheckin,
  manageOpen,
  onToggleManage,
  onNavigate,
}: {
  heirNames: string[];
  waitLabel: string;
  lastCheckin: string;
  manageOpen: boolean;
  onToggleManage: () => void;
  onNavigate: (r: Route) => void;
}) {
  const rows: Array<{ label: string; value: string }> = [
    {
      label: heirNames.length === 1 ? "Heir" : "Heirs",
      value: heirNames.join(", ") || "Not set",
    },
    { label: "They wait", value: waitLabel },
    { label: "Last check-in", value: lastCheckin },
  ];
  return (
    <section className="card-flat p-5" data-testid="legacy-summary">
      <dl className="space-y-2 text-sm">
        {rows.map((r) => (
          <div key={r.label} className="flex justify-between gap-3">
            <dt className="text-muted">{r.label}</dt>
            <dd className="text-right text-[var(--text)]">{r.value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <button
          type="button"
          onClick={onToggleManage}
          aria-expanded={manageOpen}
          className="text-muted underline underline-offset-2 hover:text-[var(--text)]"
        >
          {manageOpen ? "Hide heirs" : "Manage heirs"}
        </button>
        <button
          type="button"
          onClick={() => onNavigate("tools")}
          className="text-muted underline underline-offset-2 hover:text-[var(--text)]"
        >
          Family settings
        </button>
        <button
          type="button"
          onClick={() => onNavigate("recovery")}
          className="text-muted underline underline-offset-2 hover:text-[var(--text)]"
        >
          Recovery kit
        </button>
      </div>
    </section>
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
/* ------------------------- Heir reachability ------------------------------- */

/**
 * Which heir warning, if any, the dashboard should show (#327).
 *
 * `unreachable` always shows: something we sent the heir bounced or was
 * marked as spam, and the owner is the only person who can fix it.
 * `unconfirmed` is a gentler nudge to send a practice claim, since that
 * is the one thing that proves the address works. It stays hidden once
 * a practice is out, so an owner who did the right thing isn't nagged
 * while the delivery report comes back.
 *
 * Neither shows once a claim is underway. The link has already gone
 * out, and fixing the address then would not send it again, so the card
 * would reassure the owner about something it can't fix.
 */
/**
 * How many guardians need fixing, or 0 when the card shouldn't show
 * (#81). A guardian vault can only be claimed once the guardians get
 * their links, so an unreachable guardian is a claim that would stall.
 * Hidden once a claim is underway, for the same reason as the heir card.
 */
export function guardianReachNotice(
  vault: Pick<VaultView, "status" | "guardians_unreachable"> | null,
): number {
  if (!vault) return 0;
  if (
    vault.status === "claimed" ||
    vault.status === "claiming" ||
    vault.status === "timelock_started"
  ) {
    return 0;
  }
  return Math.max(0, vault.guardians_unreachable ?? 0);
}

export function heirReachNotice(
  vault: Pick<VaultView, "status" | "heir_reachability" | "drill_started_at"> | null,
): "unreachable" | "unconfirmed" | null {
  if (!vault) return null;
  if (
    vault.status === "claimed" ||
    vault.status === "claiming" ||
    vault.status === "timelock_started"
  ) {
    return null;
  }
  if (vault.heir_reachability === "unreachable") return "unreachable";
  if (vault.heir_reachability === "unconfirmed" && !vault.drill_started_at) {
    return "unconfirmed";
  }
  return null;
}

function HeirReachCard({
  kind,
  heirName,
  onNavigate,
}: {
  kind: "unreachable" | "unconfirmed";
  heirName: string;
  onNavigate: (r: Route) => void;
}) {
  const name = heirName || "your heir";
  if (kind === "unreachable") {
    return (
      <div
        className="flex items-center justify-between gap-3 rounded-xl border border-app px-4 py-3"
        style={{ background: "var(--warning-tint)", color: "var(--warning)" }}
        role="alert"
        data-testid="heir-reach-card"
      >
        <p className="text-sm text-[var(--text)]">
          <span className="font-semibold">There&apos;s a problem reaching {name}.</span>{" "}
          If your Bitcoin were claimed today, they might not get the link.
          Check the address you saved for them.
        </p>
        <button
          type="button"
          onClick={() => onNavigate("heir-contact")}
          className="shrink-0 text-xs font-medium text-[var(--text)] underline underline-offset-2"
        >
          Check address
        </button>
      </div>
    );
  }
  return (
    <div
      className="card-flat flex items-center justify-between gap-3 px-4 py-3"
      data-testid="heir-reach-card"
    >
      <p className="text-sm text-[var(--text)]">
        <span className="font-semibold">We haven&apos;t reached {name} yet.</span>{" "}
        Send them a practice claim. It&apos;s how we check their address works.
      </p>
      <button
        type="button"
        onClick={() => onNavigate("practice")}
        className="shrink-0 text-xs font-medium text-[var(--text)] underline underline-offset-2"
      >
        Send practice
      </button>
    </div>
  );
}

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

/* -------------------------------- Next step ------------------------------- */

/**
 * At most one suggested task, so the dashboard never turns into a to-do
 * list. Practice comes first: it is the one thing that proves the heir's
 * address works (#327). Every tool stays on the Family page either way.
 */
function NextStep({
  onNavigate,
  showPractice,
  showMessage,
  showReminders,
}: {
  onNavigate: (r: Route) => void;
  showPractice: boolean;
  showMessage: boolean;
  showReminders: boolean;
}) {
  const next: { label: string; desc: string; route: Route } | null = showPractice
    ? {
        label: "Practice a claim",
        desc: "Check your heir can be reached",
        route: "practice",
      }
    : showMessage
      ? {
          label: "Message for your heir",
          desc: "Record a short video",
          route: "heir-message",
        }
      : showReminders
        ? {
            label: "Reminders",
            desc: "Get a nudge to check in",
            route: "reminders",
          }
        : null;
  if (!next) return null;

  return (
    <button
      type="button"
      onClick={() => onNavigate(next.route)}
      className="card-flat mt-5 flex w-full items-center gap-3 p-4 text-left transition-colors hover:bg-[var(--surface-2)]"
      data-testid="next-step"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-xs uppercase tracking-wider text-dim">
          Next step
        </span>
        <span className="mt-0.5 block text-sm font-medium text-[var(--text)]">
          {next.label}
        </span>
        <span className="block truncate text-xs text-muted">{next.desc}</span>
      </span>
      <span aria-hidden="true" className="shrink-0 text-lg text-dim">
        ›
      </span>
    </button>
  );
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
  // The heir is contacted only once BOTH the server deadline and the
  // on-chain waiting period have run out; show whichever ends later.
  const { due, waitingOnChain } = heirContactDue(
    vault.claim_eligible_at,
    vault.unlock_eta,
  );
  // Round up to whole days (12.1 hours left reads "1 day") so the copy
  // never under-counts how urgent things are.
  const daysLeft = due
    ? Math.max(
        0,
        Math.ceil((due.getTime() - now.getTime()) / (24 * 3600 * 1000)),
      )
    : null;
  const dateText = due
    ? due.toLocaleDateString(undefined, {
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : null;
  return (
    <section className="rounded-md border border-red-500/40 bg-red-500/10 p-4">
      <p className="text-sm font-semibold text-red-300">
        You missed a check-in.
      </p>
      <p className="mt-1 text-xs text-red-200/80">
        {waitingOnChain && dateText
          ? `Your heir can't claim until your coins have sat untouched for the waiting period, around ${dateText}. We'll contact them shortly before then. Check in to cancel.`
          : daysLeft != null && daysLeft > 0
            ? `${daysLeft} day${daysLeft === 1 ? "" : "s"} left before your heir is notified. Check in to reset the clock.`
            : daysLeft != null
              ? "Your heir is about to be notified. Check in now to cancel."
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

/* ----------------------------- Panic card --------------------------------- */

/**
 * Emergency stop. Freezes this share for 90 days so no claim can go
 * ahead, and alerts the trusted contact if one is on file. Free and
 * signed-in; it used to be triggered by paying a Lightning invoice.
 */
export function PanicCard({
  vaultId,
  ownerToken,
  hasTrustedContact,
}: {
  vaultId: string;
  ownerToken: string | null;
  // The "alert your trusted contact" copy only renders when one is on
  // file. Promising an alert the server won't send is issue #70.
  hasTrustedContact: boolean;
}) {
  const [step, setStep] = useState<"closed" | "confirm" | "sending" | "done">(
    "closed",
  );
  const [frozenUntil, setFrozenUntil] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function freeze() {
    setStep("sending");
    setError(null);
    try {
      const resp = await api.panicStop(vaultId, ownerToken);
      setFrozenUntil(parseRfc(resp.frozen_until));
      setStep("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep("confirm");
    }
  }

  if (step === "done") {
    return (
      <section className="rounded-md border border-amber-500/40 bg-amber-500/10 p-5">
        <p className="text-sm font-semibold text-amber-200">
          This share is frozen.
        </p>
        <p className="mt-1 text-xs text-amber-100/80">
          No claim can go ahead
          {frozenUntil
            ? ` until ${frozenUntil.toLocaleDateString(undefined, {
                day: "numeric",
                month: "long",
                year: "numeric",
              })}`
            : " for 90 days"}
          . It unfreezes by itself after that.
          {hasTrustedContact ? " Your trusted contact has been alerted." : ""}
        </p>
      </section>
    );
  }

  if (step === "closed") {
    return (
      <section className="card-flat p-5">
        <p className="text-xs uppercase tracking-wider text-dim">
          Emergency stop
        </p>
        <p className="mt-1.5 text-sm text-muted">
          If your password, phone or wallet is ever compromised, freeze this
          share for 90 days
          {hasTrustedContact ? " and alert your trusted contact" : ""}.
        </p>
        <div className="mt-3">
          <Button size="sm" variant="ghost" onClick={() => setStep("confirm")}>
            Freeze this share
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-md border border-amber-500/40 bg-amber-500/5 p-5">
      <p className="text-sm font-semibold text-amber-200">
        Freeze this share for 90 days?
      </p>
      <p className="mt-1 text-xs text-amber-100/80">
        Your heir cannot claim during that time, and it can&apos;t be undone
        early. Your bitcoin doesn&apos;t move.
        {hasTrustedContact
          ? " Your trusted contact will be told you triggered an emergency freeze."
          : ""}
      </p>
      {error ? (
        <p className="mt-2 text-xs text-alarm" role="alert">
          {error}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={() => void freeze()}
          loading={step === "sending"}
        >
          Yes, freeze it
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setStep("closed")}
          disabled={step === "sending"}
        >
          Cancel
        </Button>
      </div>
    </section>
  );
}
