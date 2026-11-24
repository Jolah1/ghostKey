/**
 * A Bitcoin address the owner can pay into: a QR code, the address in
 * full, and a copy button.
 *
 * Every place we show a deposit address uses this, so none of them can
 * forget the QR or the copy button again (#373: a new heir's address
 * used to appear as bare text).
 *
 * The QR encodes the address exactly as the copy button gives it, in
 * lowercase. Uppercase bech32 is valid but some wallets reject it (#399).
 * It is rendered locally to a data: URL, so the address never goes to a
 * third-party QR service (the CSP would block one anyway).
 */
import { useMemo, useState } from "react";
import qrcode from "qrcode-generator";
import { Button } from "./ui";

export function AddressQr({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  const qrUrl = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(address);
    qr.make();
    return qr.createDataURL(5, 8);
  }, [address]);

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
      <div className="mb-3 flex justify-center">
        <img
          src={qrUrl}
          alt={`QR code for address ${address}`}
          className="h-40 w-40 rounded-lg bg-white p-1"
        />
      </div>
      <div className="card flex items-center gap-3 px-4 py-3">
        <code className="flex-1 break-all font-mono text-sm">{address}</code>
        <Button variant="quiet" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}
