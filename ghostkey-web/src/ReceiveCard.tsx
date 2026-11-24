/**
 * "Add money": the vault's deposit address, checked in this browser
 * before it is shown (#378), with a QR and a copy button. Used inside the
 * dashboard's savings hero and in the nav's Add money sheet.
 */
import { useCallback, useEffect, useState } from "react";
import { ApiError, api, type VaultAddressView } from "./api";
import { DepositAddress } from "./DepositAddress";
import { Button } from "./ui";

export function ReceiveCard({
  vaultId,
  embedded,
  autoShow,
}: {
  vaultId: string;
  embedded?: boolean;
  /** Load and show the address straight away: the owner already asked
   *  for it by tapping "Add money". */
  autoShow?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [view, setView] = useState<VaultAddressView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onExpand = useCallback(async () => {
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
  }, [vaultId, view]);

  useEffect(() => {
    if (autoShow) void onExpand();
    // Once, on mount: later changes to `view` must not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoShow]);

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
        <div className="mt-3 max-w-sm">
          <DepositAddress vaultId={vaultId} address={view.address} network={view.network} />
          {view.network !== "bitcoin" ? (
            <p className="mt-2 text-xs text-dim">
              This vault is on {view.network}. Only send {view.network}{" "}
              coins here.
            </p>
          ) : null}
        </div>
      ) : null}
      {error ? <p className="mt-2 text-sm text-alarm">{error}</p> : null}
    </section>
  );
}
