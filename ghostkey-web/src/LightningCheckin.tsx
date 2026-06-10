/**
 * Lightning check-in modal.
 *
 * The owner-facing alternative to tapping the heartbeat button: pay
 * a 1-sat BOLT11 invoice from any Lightning wallet (Phoenix, Blue,
 * Cash App, Wallet of Satoshi, Lexe, Breez, etc.) to prove liveness
 * cryptographically. Server-side this resets the same fields the
 * regular `POST /checkin` does — see `mark_paid_and_checkin` in
 * `crates/ghostkey-server/src/lightning.rs`.
 *
 * Why a separate component (not inlined in Dashboard)?
 *   - Polling logic and modal state are non-trivial; isolating them
 *     keeps Dashboard readable.
 *   - The same modal will eventually be reused from the CheckinPortal
 *     (legacy lookup-by-id flow) once we wire it there too.
 *
 * Failure modes the UI must surface clearly:
 *   1. Server has no Lightning provider configured → 4xx with a
 *      specific error string. We render "Lightning is not enabled on
 *      this server" and offer the regular button as the fallback.
 *   2. Invoice mints OK but the user never pays → the row is marked
 *      `expired` server-side; we show "Invoice expired. Tap to mint
 *      a new one."
 *   3. The user pays but the poller is slow → we keep polling for
 *      up to 90s and then offer "Still waiting?  Refresh status"
 *      manually rather than spin forever.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import qrcode from "qrcode-generator";
import { Button } from "./ui";
import { ApiError, api, type LightningInvoiceView } from "./api";

interface Props {
  vaultId: string;
  ownerToken: string | null;
  /** Called when the invoice is confirmed paid. The parent typically
   *  refreshes the vault state so the dashboard reflects the new
   *  deadline + cleared alarm. */
  onPaid: () => void;
  /** Called when the user dismisses the modal without paying. */
  onClose: () => void;
}

type State =
  | { kind: "minting" }
  | { kind: "ready"; invoice: LightningInvoiceView; paying: boolean }
  | { kind: "paid"; invoice: LightningInvoiceView }
  | { kind: "expired"; invoice: LightningInvoiceView }
  | { kind: "error"; message: string };

// How long we keep polling before falling back to a manual refresh.
// Most Lightning payments settle in 1–5s; 90s is conservative for
// users on the other side of a Boltz swap.
const POLL_TIMEOUT_MS = 90_000;
// Server poller ticks at 3s; matching here keeps lag bounded.
const POLL_INTERVAL_MS = 3_000;

export function LightningCheckin({
  vaultId,
  ownerToken,
  onPaid,
  onClose,
}: Props) {
  const [state, setState] = useState<State>({ kind: "minting" });
  const [copied, setCopied] = useState(false);

  const startedAt = useRef<number>(Date.now());
  const cancelled = useRef(false);

  // Mint the invoice on mount. We deliberately do NOT auto-retry on
  // failure here — the user should see what went wrong and decide.
  useEffect(() => {
    cancelled.current = false;
    let alive = true;
    (async () => {
      try {
        const inv = await api.lightningCreateInvoice(vaultId, ownerToken);
        if (!alive) return;
        setState({ kind: "ready", invoice: inv, paying: false });
      } catch (e) {
        if (!alive) return;
        setState({
          kind: "error",
          message:
            e instanceof ApiError
              ? e.message
              : e instanceof Error
                ? e.message
                : String(e),
        });
      }
    })();
    return () => {
      alive = false;
      cancelled.current = true;
    };
  }, [vaultId, ownerToken]);

  // Polling loop. Triggered once the invoice is ready and continues
  // until paid / expired / timed out / cancelled.
  useEffect(() => {
    if (state.kind !== "ready") return;
    const hash = state.invoice.payment_hash;

    let cancelledLocal = false;
    const timer = window.setInterval(async () => {
      if (cancelledLocal || cancelled.current) return;

      // Soft timeout — stop polling but leave the UI usable so the
      // user can manually refresh status.
      if (Date.now() - startedAt.current > POLL_TIMEOUT_MS) {
        clearInterval(timer);
        return;
      }

      try {
        const s = await api.lightningInvoiceStatus(vaultId, hash, ownerToken);
        if (cancelledLocal || cancelled.current) return;
        if (s.status === "paid") {
          clearInterval(timer);
          setState((prev) =>
            prev.kind === "ready"
              ? { kind: "paid", invoice: prev.invoice }
              : prev,
          );
          // Give the user a beat to see the success state before the
          // parent re-renders the dashboard.
          window.setTimeout(onPaid, 800);
        } else if (s.status === "expired") {
          clearInterval(timer);
          setState((prev) =>
            prev.kind === "ready"
              ? { kind: "expired", invoice: prev.invoice }
              : prev,
          );
        }
      } catch {
        // Network blip; next tick may succeed.
      }
    }, POLL_INTERVAL_MS);

    return () => {
      cancelledLocal = true;
      clearInterval(timer);
    };
  }, [state.kind, vaultId, ownerToken, onPaid, state]);

  const copy = useCallback((s: string) => {
    void navigator.clipboard.writeText(s).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ln-modal-title"
    >
      <div className="card relative w-full max-w-md p-6">
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="absolute right-3 top-3 rounded-full p-2 text-muted hover:bg-surface-2 hover:text-[var(--text)]"
        >
          ✕
        </button>

        <h2 id="ln-modal-title" className="font-serif text-2xl">
          Check in with Lightning
        </h2>
        <p className="mt-2 text-sm text-muted">
          Pay this 1-sat invoice from any Lightning wallet. The vault
          accepts the payment as proof you're still here and resets the
          countdown.
        </p>

        <div className="mt-6 min-h-[200px]">
          {state.kind === "minting" && (
            <p className="text-sm text-muted">Minting invoice…</p>
          )}

          {state.kind === "error" && (
            <div className="rounded-md border border-alarm/40 bg-alarm/10 p-3 text-sm">
              <p className="font-medium text-alarm">
                Couldn't create an invoice
              </p>
              <p className="mt-1 text-xs text-muted">{state.message}</p>
              <p className="mt-3 text-xs text-muted">
                Tap the heartbeat button on the dashboard instead — it does
                the same job server-side.
              </p>
            </div>
          )}

          {(state.kind === "ready" || state.kind === "paid" ||
            state.kind === "expired") && (
            <InvoicePanel
              invoice={state.invoice}
              status={state.kind}
              copied={copied}
              onCopy={copy}
            />
          )}
        </div>

        <div className="mt-6 flex items-center justify-end gap-2">
          {state.kind === "paid" ? (
            <Button onClick={onPaid}>Done</Button>
          ) : (
            <Button variant="quiet" onClick={onClose}>
              {state.kind === "expired" ? "Close" : "Cancel"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function InvoicePanel({
  invoice,
  status,
  copied,
  onCopy,
}: {
  invoice: LightningInvoiceView;
  status: "ready" | "paid" | "expired";
  copied: boolean;
  onCopy: (s: string) => void;
}) {
  // Rendered locally to a data: URL — the CSP only allows
  // `img-src 'self' data: blob:`, so an external QR service would be
  // blocked, and this way the BOLT11 never round-trips through a
  // third party. Type 0 = auto-size; uppercase bech32 keeps the QR
  // in the denser alphanumeric-friendly form wallets expect.
  const qrUrl = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(invoice.bolt11.toUpperCase());
    qr.make();
    return qr.createDataURL(6, 8);
  }, [invoice.bolt11]);

  return (
    <div className="text-center">
      {status === "paid" ? (
        <div className="flex flex-col items-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-ok/20 text-3xl">
            ✓
          </div>
          <p className="mt-3 font-semibold text-ok">Payment received</p>
          <p className="mt-1 text-xs text-muted">
            Vault countdown reset.
          </p>
        </div>
      ) : status === "expired" ? (
        <div className="flex flex-col items-center">
          <p className="font-semibold text-warning">Invoice expired</p>
          <p className="mt-1 text-xs text-muted">
            Close and reopen to mint a new one.
          </p>
        </div>
      ) : (
        <>
          <img
            src={qrUrl}
            alt="Lightning invoice QR code"
            width={240}
            height={240}
            className="mx-auto rounded-md border border-app bg-white p-2"
          />
          <p className="mt-3 text-sm">
            <span className="font-display text-xl font-bold text-accent">
              {invoice.amount_sat}
            </span>{" "}
            <span className="text-muted">sat</span>
          </p>
          <p className="mt-1 text-xs text-muted">
            Waiting for payment…
          </p>

          <div className="mt-4 flex flex-col gap-2">
            <button
              type="button"
              onClick={() => onCopy(invoice.bolt11)}
              className="rounded-md border border-app bg-surface-2 px-3 py-2 font-mono text-[11px] text-muted hover:text-[var(--text)] break-all text-left"
              title="Click to copy"
            >
              {invoice.bolt11.slice(0, 40)}…{invoice.bolt11.slice(-12)}
            </button>
            <p className="text-[11px] text-dim">
              {copied ? "Copied to clipboard" : "Tap to copy the full invoice"}
            </p>
          </div>
        </>
      )}
    </div>
  );
}
