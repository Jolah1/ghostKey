/**
 * Review-and-confirm step shown before any one-shot broadcast.
 *
 * Two places in the app otherwise sign and broadcast on a single tap,
 * with no playback of where the money is going:
 *
 *   - the owner Send flow (Dashboard `SendCard`)
 *   - the heir one-shot claim (ClaimPage `PasswordVaultClaim`)
 *
 * A pasted address is the catastrophic-error surface — one wrong
 * character and the Bitcoin is gone with no recourse — so both now route
 * through this panel: it plays back the amount and destination and makes
 * the person take a second, separate action before anything moves.
 *
 * The heir manual-PSBT path (Door B) already has its own review (the
 * build summary plus the wallet's own signing prompt), so it doesn't use
 * this.
 *
 * Deliberately dumb: it takes already-formatted labels and two
 * callbacks. It validates nothing itself — the caller has already
 * checked the address shape and network match. Its whole job is the
 * second look and the deliberate gesture.
 */
import { Button, InlineAlert } from "./ui";

export function ConfirmSend({
  destination,
  amountLabel,
  networkLabel,
  feeLabel,
  rows = [],
  busy = false,
  confirmLabel = "Yes, send it",
  showHeading = true,
  onConfirm,
  onBack,
}: {
  /** The validated destination address, shown in full so every
   *  character can be checked. */
  destination: string;
  /** What's leaving the vault, already formatted (e.g. "50,000 sat" or
   *  "Everything in this share"). */
  amountLabel: string;
  /** Human network name (e.g. "Bitcoin", "signet network"). */
  networkLabel: string;
  /** Optional fee-rate playback (e.g. "2 sat/vB"). Omitted where the
   *  server picks the fee and the user never set one. */
  feeLabel?: string;
  /** More label/value lines under the network (fee, what's left). */
  rows?: { label: string; value: string }[];
  /** Disables both buttons while the send is in flight. */
  busy?: boolean;
  /** Confirm-button text; callers swap it for progress ("Sending…"). */
  confirmLabel?: string;
  /** Off where the page title already says "check it". */
  showHeading?: boolean;
  onConfirm: () => void;
  onBack: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        {showHeading ? (
          <p className="mb-3 text-xs uppercase tracking-wider text-dim">
            Check this before you send
          </p>
        ) : null}
        <dl className="flex flex-col gap-3 text-sm">
          <div>
            <dt className="text-muted">Sending</dt>
            <dd className="mt-0.5 font-semibold text-[var(--text)]">
              {amountLabel}
            </dd>
          </div>
          <div>
            <dt className="text-muted">To this address</dt>
            <dd className="mt-0.5 break-all font-mono text-xs text-[var(--text)]">
              {destination}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted">Network</dt>
            <dd className="text-[var(--text)]">{networkLabel}</dd>
          </div>
          {rows.map((r) => (
            <div key={r.label} className="flex justify-between gap-3">
              <dt className="text-muted">{r.label}</dt>
              <dd className="text-[var(--text)]">{r.value}</dd>
            </div>
          ))}
          {feeLabel ? (
            <div className="flex justify-between gap-3">
              <dt className="text-muted">Fee rate</dt>
              <dd className="font-mono text-[var(--text)]">{feeLabel}</dd>
            </div>
          ) : null}
        </dl>
      </div>

      <InlineAlert tone="warning">
        Check the address. Bitcoin sent to a wrong address can&apos;t come
        back.
      </InlineAlert>

      <div className="flex flex-wrap gap-2">
        <Button onClick={onConfirm} disabled={busy} loading={busy}>
          {confirmLabel}
        </Button>
        <Button variant="ghost" onClick={onBack} disabled={busy}>
          Go back
        </Button>
      </div>
    </div>
  );
}
