/**
 * Home's heir-code card (option a). Two jobs, one card:
 *
 * - `upgrade`: an older vault whose heir key GhostKey could still open.
 *   With the owner's password, this browser re-locks the heir key (and
 *   video) with a fresh heir code; the server then forgets its secret.
 *   No money moves.
 * - `unshared`: the vault has a code the owner hasn't confirmed giving.
 *   An heir without it can't claim, so Home keeps asking until "Yes".
 */
import { useId, useState } from "react";

import { api, ApiError, type VaultView } from "./api";
import type { Route } from "./App";
import { relockWithHeirCode, WrongOwnerPasswordError } from "./crypto/heirCode";
import { HeirCodeCard } from "./HeirCodeCard";
import { Button, InlineAlert } from "./ui";

export function HeirCodeNotice({
  vaultId,
  ownerToken,
  heirName,
  state,
  onChanged,
  onNavigate,
}: {
  vaultId: string;
  ownerToken: string;
  heirName: string;
  state: NonNullable<VaultView["heir_code_state"]>;
  onChanged: () => void;
  onNavigate: (r: Route) => void;
}) {
  const who = heirName || "your heir";
  const pwId = useId();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [pct, setPct] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newCode, setNewCode] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function markGiven() {
    setSaving(true);
    setError(null);
    try {
      await api.markHeirCodeShared(vaultId, ownerToken);
      onChanged();
    } catch {
      setError("Couldn't save that. Try again.");
    } finally {
      setSaving(false);
    }
  }

  async function switchToCode() {
    setError(null);
    setPct(0);
    try {
      const [kit, blobs] = await Promise.all([
        api.getHeirCodeUpgradeKit(vaultId, ownerToken),
        api.getSealedBlobs(vaultId, ownerToken),
      ]);
      const { body, code } = await relockWithHeirCode({
        password,
        owner: blobs,
        kit,
        onProgress: (p) => setPct(Math.round(p * 100)),
      });
      await api.upgradeToHeirCode(vaultId, ownerToken, body);
      setPassword("");
      setNewCode(code);
    } catch (e) {
      setError(
        e instanceof WrongOwnerPasswordError
          ? e.message
          : e instanceof ApiError && e.message
            ? e.message
            : "Couldn't switch just now. Nothing changed. Try again.",
      );
    } finally {
      setPct(null);
    }
  }

  if (newCode) {
    return (
      <section className="card-flat p-5" data-testid="heir-code-notice">
        <p className="font-medium">Done. Only {who} can open their key now.</p>
        <p className="mt-1 text-sm text-muted">
          Give {who} this code. Without it they can't claim.
        </p>
        <div className="mt-4">
          <HeirCodeCard heirName={heirName} code={newCode} />
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button onClick={() => void markGiven()} disabled={saving}>
            I've given it to {who}
          </Button>
          <Button variant="ghost" onClick={onChanged}>
            Later
          </Button>
        </div>
        {error && (
          <div className="mt-3">
            <InlineAlert tone="alarm">{error}</InlineAlert>
          </div>
        )}
      </section>
    );
  }

  if (state === "unshared") {
    return (
      <section className="card-flat p-5" data-testid="heir-code-notice">
        <p className="font-medium">Has {who} got their heir code?</p>
        <p className="mt-1 text-sm text-muted">
          They need it to claim. Only you and {who} know it.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button onClick={() => void markGiven()} disabled={saving}>
            Yes, I gave it
          </Button>
          <Button variant="ghost" onClick={() => onNavigate("heir-contact")}>
            Show the code
          </Button>
        </div>
        {error && (
          <div className="mt-3">
            <InlineAlert tone="alarm">{error}</InlineAlert>
          </div>
        )}
      </section>
    );
  }

  if (state !== "upgrade") return null;

  return (
    <section className="card-flat p-5" data-testid="heir-code-notice">
      <p className="font-medium">Make {who}'s access private</p>
      <p className="mt-1 text-sm text-muted">
        Today GhostKey could open {who}'s key. Switch to a code only you and{" "}
        {who} know. No money moves.
      </p>
      {!open ? (
        <Button className="mt-4" variant="ghost" onClick={() => setOpen(true)}>
          Switch to a code
        </Button>
      ) : (
        <form
          className="mt-4"
          onSubmit={(e) => {
            e.preventDefault();
            void switchToCode();
          }}
        >
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
          {error && (
            <div className="mt-3">
              <InlineAlert tone="alarm">{error}</InlineAlert>
            </div>
          )}
          <Button className="mt-3" type="submit" disabled={!password || pct !== null}>
            {pct !== null ? `Switching… ${pct}%` : "Switch"}
          </Button>
        </form>
      )}
    </section>
  );
}
