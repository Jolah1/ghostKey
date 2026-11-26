import { useEffect, useId, useState } from "react";
import { api, type SealedBlobsView } from "./api";
import { Button, InlineAlert } from "./ui";
import { heirCodeForDisplay, openOwnerHeirCode } from "./crypto/heirCode";
import { b64decode, deriveOwnerKek } from "./crypto/sealing";
import { unlockErrorMessage } from "./unlockErrors";
import { downloadHeirEnvelope, type HeirEnvelope } from "./independenceProof";

/**
 * The heir card: one heir's code, and the heir file. The code is shown
 * here and in Settings (sealed under the owner's password), never sent
 * by GhostKey. "Send it" uses the phone's own share sheet, so the code
 * goes from the owner's device straight to the heir.
 */
export function HeirCodeCard({
  heirName,
  code,
  envelope,
}: {
  heirName: string;
  code: string;
  envelope?: HeirEnvelope;
}) {
  const [copied, setCopied] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const who = heirName || "your heir";
  const words = heirCodeForDisplay(code);
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(words);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard may be blocked; the words can be selected instead.
    }
  }

  async function shareCode() {
    try {
      await navigator.share({
        title: "Your GhostKey heir code",
        text:
          `I've named you as my heir on GhostKey. If anything ever happens to me, ` +
          `GhostKey will email you a link. You'll need this code to open it: ${words}. ` +
          `Please keep it somewhere safe and private.`,
      });
    } catch {
      // Cancelled, or not allowed: nothing to do.
    }
  }

  return (
    <div className="card-flat p-5" data-testid="heir-card">
      <p className="font-serif text-lg">For {who}</p>
      <p className="mt-3 text-xs uppercase tracking-wider text-dim">Heir code</p>
      <p
        className="mt-1 select-all rounded bg-[var(--bg-elev)] px-3 py-3 font-mono text-lg"
        data-testid="heir-code"
      >
        {words}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {canShare && (
          <Button onClick={() => void shareCode()}>Send it to {who}</Button>
        )}
        <Button variant="ghost" onClick={() => void copyCode()}>
          {copied ? "Copied" : "Copy code"}
        </Button>
      </div>
      <p className="mt-3 text-sm text-muted">
        Send it now, or write it on paper for {who}. You can see it again
        in Settings. If {who} loses it, they can't claim.
      </p>
      {envelope && (
        <div className="mt-5 border-t border-app pt-4">
          <p className="text-sm text-muted">
            The heir file lets {who} claim even if GhostKey is gone. It opens
            with the same code. Keep it with your important papers.
          </p>
          <div className="mt-3">
            <Button
              variant="ghost"
              onClick={() => {
                downloadHeirEnvelope(envelope);
                setDownloaded(true);
              }}
            >
              {downloaded ? "Download again" : "Download the heir file"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Settings: show the heir code again. The code is sealed under the
 * owner's password, so the password opens it here, in this browser.
 * Renders nothing on a vault without an heir code.
 */
export function ShowHeirCodeCard({
  vaultId,
  ownerToken,
  heirName,
}: {
  vaultId: string;
  ownerToken: string;
  heirName: string;
}) {
  const pwId = useId();
  const [blobs, setBlobs] = useState<SealedBlobsView | null>(null);
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [given, setGiven] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getSealedBlobs(vaultId, ownerToken)
      .then((b) => {
        if (!cancelled) setBlobs(b);
      })
      .catch(() => {
        // No sealed blobs (or offline): nothing to show.
      });
    return () => {
      cancelled = true;
    };
  }, [vaultId, ownerToken]);

  if (!blobs?.heir_code_owner_ct_b64 || !blobs.heir_code_owner_nonce_b64) return null;
  const who = heirName || "your heir";

  async function reveal() {
    if (!blobs?.heir_code_owner_ct_b64 || !blobs.heir_code_owner_nonce_b64) return;
    setBusy(true);
    setError(null);
    let kek: Uint8Array | null = null;
    try {
      kek = await deriveOwnerKek(password, b64decode(blobs.password_salt_b64), {
        memKiB: blobs.password_kdf_mem_kib,
        iters: blobs.password_kdf_iters,
      });
      setCode(
        openOwnerHeirCode(kek, {
          v: 1,
          ct: blobs.heir_code_owner_ct_b64,
          nonce: blobs.heir_code_owner_nonce_b64,
        }),
      );
      setPassword("");
    } catch (e) {
      setError(unlockErrorMessage(e));
    } finally {
      kek?.fill(0);
      setBusy(false);
    }
  }

  if (code) {
    return (
      <div className="mt-6">
        <HeirCodeCard heirName={heirName} code={code} />
        <div className="mt-3 flex flex-wrap gap-2">
          {given ? (
            <p className="text-sm text-muted">Noted. We won't ask again.</p>
          ) : (
            <Button
              onClick={() =>
                void api
                  .markHeirCodeShared(vaultId, ownerToken)
                  .then(() => setGiven(true))
                  .catch(() => setError("Couldn't save that. Try again."))
              }
            >
              I've given it to {who}
            </Button>
          )}
          <Button variant="ghost" onClick={() => setCode(null)}>
            Hide the code
          </Button>
        </div>
        {error && (
          <div className="mt-3">
            <InlineAlert tone="alarm">{error}</InlineAlert>
          </div>
        )}
      </div>
    );
  }

  return (
    <section className="card-flat mt-6 p-5" data-testid="show-heir-code">
      <p className="font-medium">{who}'s heir code</p>
      <p className="mt-1 text-sm text-muted">
        The five words {who} needs to claim. Only you and {who} know them.
      </p>
      {!open ? (
        <Button className="mt-4" variant="ghost" onClick={() => setOpen(true)}>
          Show the code
        </Button>
      ) : (
        <form
          className="mt-4"
          onSubmit={(e) => {
            e.preventDefault();
            void reveal();
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
          <Button className="mt-3" type="submit" disabled={!password || busy}>
            {busy ? "Unlocking…" : "Show the code"}
          </Button>
        </form>
      )}
    </section>
  );
}
