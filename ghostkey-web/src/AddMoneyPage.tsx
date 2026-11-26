/**
 * Add money, as its own page: Bitcoin or Lightning, then the address or
 * invoice. Reached from Home and from the + in the top bar.
 */
import type { Route } from "./App";
import { PageShell } from "./PageShell";
import { ReceiveCard } from "./ReceiveCard";
import { getActiveVaultId, getVaultMeta, getVaultsByGroup } from "./vaultStore";

export function AddMoneyPage({ onNavigate }: { onNavigate: (r: Route) => void }) {
  const vaultId = getActiveVaultId();
  const meta = vaultId ? getVaultMeta(vaultId) : null;
  const multiHeir = meta?.groupId ? getVaultsByGroup(meta.groupId).length > 1 : false;
  return (
    <PageShell
      title="Add money"
      intro={multiHeir && meta ? `Goes to ${meta.heir.name}'s share.` : undefined}
      onNavigate={onNavigate}
    >
      {vaultId ? (
        <ReceiveCard vaultId={vaultId} embedded autoShow />
      ) : (
        <p className="text-sm text-muted">Sign in to add money.</p>
      )}
    </PageShell>
  );
}
