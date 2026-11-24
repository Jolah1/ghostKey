/**
 * A Bitcoin address the owner can pay into: an optional amount, a QR
 * code, an "Open in wallet" link, the address in full, and a copy button.
 *
 * Every place we show a deposit address uses this, so none of them can
 * forget the QR or the copy button again (#373: a new heir's address
 * used to appear as bare text).
 *
 * The QR and the link carry a BIP21 payment link (#374): `bitcoin:ADDRESS`,
 * plus `?amount=` when the owner types one, so scanning or tapping opens
 * their wallet with everything filled in. The amount is optional and is
 * never guessed. The address is lowercase, because some wallets reject
 * uppercase bech32 (#399). The QR is rendered locally to a data: URL, so
 * nothing goes to a third-party QR service (the CSP would block one).
 */
import { useId, useMemo, useState } from "react";
import qrcode from "qrcode-generator";
import { Button } from "./ui";
import { bip21Uri, parseAmount } from "./bip21";
import { useUnit } from "./units";

export function AddressQr({ address }: { address: string }) {
  const unit = useUnit();
  const amountId = useId();
  const [amountInput, setAmountInput] = useState("");
  const [copied, setCopied] = useState(false);

  const parsed = parseAmount(amountInput, unit);
  const amountSats = typeof parsed === "number" ? parsed : null;
  const uri = bip21Uri(address, amountSats);

  const qrUrl = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(uri);
    qr.make();
    return qr.createDataURL(5, 8);
  }, [uri]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Some browsers block clipboard access; the address is still
      // visible for manual selection.
    }
  }

  return (
    <div>
      <label htmlFor={amountId} className="block text-xs text-muted">
        Amount (optional, in {unit === "btc" ? "BTC" : "sats"})
      </label>
      <input
        id={amountId}
        className="input mt-1 w-full"
        inputMode="decimal"
        autoComplete="off"
        placeholder={unit === "btc" ? "e.g. 0.001" : "e.g. 100,000"}
        value={amountInput}
        onChange={(e) => setAmountInput(e.target.value)}
        aria-invalid={parsed === "invalid"}
      />
      {parsed === "invalid" ? (
        <p className="mt-1 text-xs text-alarm" role="alert">
          {unit === "btc"
            ? "Enter an amount like 0.001, up to 8 decimal places."
            : "Enter a whole number of sats, like 100000."}{" "}
          The code below has no amount until then.
        </p>
      ) : null}
      <div className="my-3 flex justify-center">
        <img
          src={qrUrl}
          alt={`QR code for paying ${address}`}
          className="h-40 w-40 rounded-lg bg-white p-1"
        />
      </div>
      <div className="card flex items-center gap-3 px-4 py-3">
        <code className="flex-1 break-all font-mono text-sm">{address}</code>
        <Button variant="quiet" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <a
        href={uri}
        className="mt-2 inline-block text-sm text-[var(--accent-text)] underline-offset-2 hover:underline"
      >
        Open in my wallet
      </a>
    </div>
  );
}
