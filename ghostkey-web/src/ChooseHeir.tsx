/**
 * "Choose who inherits" on Home, for a vault set up without an heir.
 *
 * The owner types a name, an email and their password. This browser
 * fetches the heir key sealed under that password, opens it, checks it
 * is the heir key in this vault's descriptor, and re-seals it under a
 * fresh claim token (see crypto/heirLater.ts). The server then stores it
 * exactly as if the heir had been chosen at setup, and the check-in clock
 * starts. Nothing is sent if the password is wrong or the key doesn't
 * match.
 */
import { useId, useState } from "react";
import { ApiError, api } from "./api";
import { Button } from "./ui";
import type { Network } from "./crypto/keygen";
import {
  HeirKeyMismatchError,
  WrongPasswordError,
  resealHeirForClaim,
} from "./crypto/heirLater";
import { getVaultMeta, saveVaultMeta } from "./vaultStore";

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function ChooseHeirCard({
  vaultId,
  ownerToken,
  waitLabel,
  onChosen,
}: {
  vaultId: string;
  ownerToken: string;
  /** "3 months": how long the heir waits, already fixed in the address. */
  waitLabel: string;
  onChosen: () => void;
}) {
  const nameId = useId();
  const emailId = useId();
  const pwId = useId();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const n = name.trim();
    const e = email.trim();
    if (!n) return setError("Say who inherits.");
    if (!EMAIL_SHAPE.test(e)) return setError("That email looks off. Check it.");
    if (!password) return setError("Type your password to continue.");
    setBusy(true);
    setError(null);
    setProgress(0);
    try {
      const blobs = await api.getSealedBlobs(vaultId, ownerToken);
      if (
        !blobs.heir_xprv_owner_ct_b64 ||
        !blobs.heir_xprv_owner_nonce_b64 ||
        !blobs.heir_xpub_fragment_external
      ) {
        setError("This vault already has an heir, or can't choose one this way.");
        return;
      }
      const sealed = await resealHeirForClaim(
        password,
        {
          passwordSalt: blobs.password_salt_b64,
          memKiB: blobs.password_kdf_mem_kib,
          iters: blobs.password_kdf_iters,
          blob: { v: 1, ct: blobs.heir_xprv_owner_ct_b64, nonce: blobs.heir_xprv_owner_nonce_b64 },
          heirFragment: blobs.heir_xpub_fragment_external,
          network: blobs.network as Network,
        },
        (p) => setProgress(Math.round(p * 100)),
      );
      await api.chooseHeir(vaultId, ownerToken, {
        name: n,
        contact: e,
        channel: "email",
        ...sealed,
      });
      const meta = getVaultMeta(vaultId);
      if (meta) {
        saveVaultMeta({
          ...meta,
          label: `${n}'s inheritance`,
          heir: { ...meta.heir, name: n, email: e },
        });
      }
      setPassword("");
      onChosen();
    } catch (err) {
      setError(
        err instanceof WrongPasswordError || err instanceof HeirKeyMismatchError
          ? err.message
          : err instanceof ApiError && err.message
            ? err.message
            : "Couldn't save that. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card-flat p-5" data-testid="choose-heir">
      <p className="font-medium">No one chosen yet</p>
      <p className="mt-1 text-sm text-muted">
        Choose who gets your savings if you stop showing up. They hear
        nothing from us until then. Once you choose, a free monthly
        check-in keeps it that way.
      </p>
      {!open ? (
        <Button className="mt-4" onClick={() => setOpen(true)}>
          Choose who inherits
        </Button>
      ) : (
        <div className="mt-4 space-y-3">
          <div>
            <label htmlFor={nameId} className="block text-sm font-medium">
              Their name
            </label>
            <input
              id={nameId}
              className="input mt-1 w-full"
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div>
            <label htmlFor={emailId} className="block text-sm font-medium">
              Their email
            </label>
            <input
              id={emailId}
              type="email"
              className="input mt-1 w-full"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div>
            <label htmlFor={pwId} className="block text-sm font-medium">
              Your password
            </label>
            <input
              id={pwId}
              type="password"
              className="input mt-1 w-full"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
            <p className="mt-1 text-xs text-dim">
              It unlocks their key on this device. We never see it.
            </p>
          </div>
          <p className="text-xs text-muted">
            If you stop showing up, they can claim after your bitcoin sits
            untouched for {waitLabel}.
          </p>
          {error ? (
            <p className="text-sm text-alarm" role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void submit()} loading={busy}>
              {busy && progress > 0 && progress < 100 ? `Unlocking… ${progress}%` : "Save"}
            </Button>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
