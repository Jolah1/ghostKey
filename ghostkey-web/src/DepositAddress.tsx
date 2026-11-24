/**
 * A vault's deposit address, checked in the browser before it is shown
 * (#378). See depositCheck.ts for what the check does and doesn't cover.
 *
 * - Verified: the address, QR and payment link, plus a quiet "checked" line.
 * - Mismatch: no address at all, and a plain explanation. Showing it would
 *   invite the owner to pay somewhere that isn't their vault.
 * - Unchecked: the address, with an honest note that we couldn't check.
 */
import { useEffect, useState } from "react";
import { AddressQr } from "./AddressQr";
import { InlineAlert } from "./ui";
import { checkDepositAddress, type DepositCheck } from "./depositCheck";

export function DepositAddress({
  vaultId,
  address,
  network,
}: {
  vaultId: string;
  address: string;
  network: string;
}) {
  const [check, setCheck] = useState<DepositCheck | null>(null);

  useEffect(() => {
    let alive = true;
    setCheck(null);
    void checkDepositAddress(vaultId, address, network).then((c) => {
      if (alive) setCheck(c);
    });
    return () => {
      alive = false;
    };
  }, [vaultId, address, network]);

  if (!check) {
    return <p className="text-sm text-muted">Checking this address…</p>;
  }

  if (check.kind === "mismatch") {
    return (
      <InlineAlert tone="alarm">
        <span className="font-semibold">Don&apos;t send money to this vault right now.</span>{" "}
        The address our server gave doesn&apos;t match your vault, so we&apos;re
        not showing it. Your savings already in the vault are safe. Please
        contact GhostKey support before depositing.
      </InlineAlert>
    );
  }

  return (
    <div>
      <AddressQr address={address} />
      <p className="mt-2 text-xs text-dim" data-testid="deposit-check">
        {check.kind === "verified"
          ? "✓ Checked on this device: this address belongs to your vault."
          : "We couldn't double-check this address on this device."}
      </p>
    </div>
  );
}
