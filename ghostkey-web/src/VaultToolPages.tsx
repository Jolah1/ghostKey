/**
 * Secondary vault pages, one per tool that used to crowd the dashboard:
 * the heir message, the practice run, emergency options, and reminders.
 *
 * Each is a thin wrapper: `useActiveVault()` loads the vault, a shared
 * shell draws the back link + title, and the existing card component does
 * the real work. Keeping the dashboard to status + money + heir was the
 * goal; these pages are one tap away from it.
 */
import type { ReactNode } from "react";

import type { Route } from "./App";
import { useActiveVault } from "./useActiveVault";
import { VideoMessageCard } from "./VideoMessageCard";
import { PracticeClaimCard } from "./PracticeClaimCard";
import { PanicCard, PushOptInCard } from "./Dashboard";
import { Button } from "./ui";

function ToolPage({
  title,
  intro,
  onNavigate,
  children,
}: {
  title: string;
  intro?: string;
  onNavigate: (r: Route) => void;
  children: ReactNode;
}) {
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
        <h1 className="mt-4 font-serif text-3xl">{title}</h1>
        {intro ? <p className="mt-2 text-sm text-muted">{intro}</p> : null}
        <div className="mt-8">{children}</div>
      </div>
    </main>
  );
}

/** Shared "no vault / still loading / nothing to show" fallback body. */
function Fallback({
  loading,
  hasVault,
  emptyText,
  onNavigate,
}: {
  loading: boolean;
  hasVault: boolean;
  emptyText: string;
  onNavigate: (r: Route) => void;
}) {
  if (loading) return <p className="text-sm text-muted">Loading…</p>;
  if (!hasVault) {
    return (
      <div>
        <p className="text-sm text-muted">
          Open your dashboard first to use this.
        </p>
        <div className="mt-4">
          <Button onClick={() => onNavigate("dashboard")}>
            Go to dashboard
          </Button>
        </div>
      </div>
    );
  }
  return <p className="text-sm text-muted">{emptyText}</p>;
}

interface PageProps {
  onNavigate: (r: Route) => void;
}

export function HeirMessagePage({ onNavigate }: PageProps) {
  const { meta, ownerToken, vault, loading } = useActiveVault();
  const ready = Boolean(meta && vault && vault.status !== "claimed");
  return (
    <ToolPage
      title="Message for your heir"
      intro="A short video only your heir can unlock. Proof the claim link is really from you."
      onNavigate={onNavigate}
    >
      {ready && meta ? (
        <VideoMessageCard
          vaultId={meta.id}
          ownerToken={ownerToken}
          heirName={meta.heir.name}
        />
      ) : (
        <Fallback
          loading={loading}
          hasVault={Boolean(meta)}
          emptyText="A message isn't available once a vault is closed."
          onNavigate={onNavigate}
        />
      )}
    </ToolPage>
  );
}

export function PracticeRunPage({ onNavigate }: PageProps) {
  const { meta, ownerToken, vault, loading } = useActiveVault();
  const isClaiming =
    vault?.status === "timelock_started" || vault?.status === "claiming";
  const ready = Boolean(meta && vault && vault.status !== "claimed" && !isClaiming);
  return (
    <ToolPage
      title="Practice a claim"
      intro="Let your heir rehearse the real claim while you're here — no funds move, nothing changes."
      onNavigate={onNavigate}
    >
      {ready && meta && vault ? (
        <PracticeClaimCard
          vaultId={meta.id}
          ownerToken={ownerToken}
          heirName={meta.heir.name}
          progress={vault}
        />
      ) : (
        <Fallback
          loading={loading}
          hasVault={Boolean(meta)}
          emptyText="Practice runs pause once a claim is underway."
          onNavigate={onNavigate}
        />
      )}
    </ToolPage>
  );
}

export function EmergencyPage({ onNavigate }: PageProps) {
  const { vault, loading, meta } = useActiveVault();
  const isClaiming =
    vault?.status === "timelock_started" || vault?.status === "claiming";
  const ready = Boolean(
    vault?.lnurl_panic &&
      vault.status !== "frozen" &&
      vault.status !== "claimed" &&
      !isClaiming,
  );
  return (
    <ToolPage
      title="Emergency options"
      intro="If your wallet is ever compromised, freeze this vault so no claim can proceed."
      onNavigate={onNavigate}
    >
      {ready && vault?.lnurl_panic ? (
        <PanicCard
          lnurl={vault.lnurl_panic}
          hasTrustedContact={Boolean(vault.has_trusted_contact)}
        />
      ) : (
        <Fallback
          loading={loading}
          hasVault={Boolean(meta)}
          emptyText="Emergency freeze isn't available for this vault right now."
          onNavigate={onNavigate}
        />
      )}
    </ToolPage>
  );
}

export function RemindersPage({ onNavigate }: PageProps) {
  const { meta, ownerToken, vault, pushKey, loading } = useActiveVault();
  const ready = Boolean(meta && ownerToken && pushKey && vault?.status !== "claimed");
  return (
    <ToolPage
      title="Reminders"
      intro="Get a nudge on this device when it's time to check in, so you never miss it."
      onNavigate={onNavigate}
    >
      {ready && meta && ownerToken && pushKey ? (
        <PushOptInCard
          vaultId={meta.id}
          ownerToken={ownerToken}
          vapidPublicKey={pushKey}
        />
      ) : (
        <Fallback
          loading={loading}
          hasVault={Boolean(meta)}
          emptyText="Reminders aren't available on this device or server."
          onNavigate={onNavigate}
        />
      )}
    </ToolPage>
  );
}
