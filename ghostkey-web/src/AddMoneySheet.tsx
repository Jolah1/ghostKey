/**
 * The nav's "Add money": the same deposit card as the dashboard, in a
 * popup, so saving is one tap from any page. It opens for the vault that
 * is active on this device; with several heirs it says whose share the
 * money goes to.
 */
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { ReceiveCard } from "./ReceiveCard";
import { getActiveVaultId, getVaultMeta, getVaultsByGroup } from "./vaultStore";

export function AddMoneySheet({ onClose }: { onClose: () => void }) {
  const vaultId = getActiveVaultId();
  const meta = vaultId ? getVaultMeta(vaultId) : null;
  const multiHeir = meta?.groupId ? getVaultsByGroup(meta.groupId).length > 1 : false;
  const closeRef = useRef<HTMLButtonElement>(null);

  // Escape closes; focus starts on the close button so keyboard users
  // land inside the dialog.
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Portalled to <body>: the nav bar's backdrop blur makes it the
  // containing block for fixed children, which squeezed the popup into
  // the 60px bar.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 md:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-money-title"
    >
      <div className="card max-h-[90vh] w-full max-w-md overflow-y-auto p-5 md:p-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="add-money-title" className="font-serif text-2xl">
              Add money
            </h2>
            {multiHeir && meta ? (
              <p className="mt-1 text-xs text-muted">
                Goes to {meta.heir.name}&apos;s share
              </p>
            ) : null}
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-xl leading-none text-muted hover:text-[var(--text)]"
          >
            ×
          </button>
        </div>
        <div className="mt-4">
          {vaultId ? (
            <ReceiveCard vaultId={vaultId} embedded autoShow />
          ) : (
            <p className="text-sm text-muted">
              There&apos;s no vault on this device yet.
            </p>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
