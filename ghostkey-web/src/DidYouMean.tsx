/**
 * "Did you mean ada@gmail.com?" under an email field (#327).
 *
 * A typo in an heir's address stays invisible until the claim link fires,
 * the one moment nobody can fix it, and every address on our bounce list
 * has been a misspelling of a real domain (gmial.com). So the address is
 * questioned while the owner is still typing it, everywhere it is first
 * typed, not only on the page for changing it later.
 *
 * Advisory and never blocking: it asks a moment after typing stops, so
 * the question is on screen before Next, and if the check fails or the
 * server is old, nothing shows.
 */
import { useEffect, useState } from "react";
import { api } from "./api";

/** `ada@gmial.com` + `gmail.com` -> `ada@gmail.com`. */
export function swapDomain(address: string, domain: string): string {
  const at = address.trim().lastIndexOf("@");
  if (at <= 0) return address;
  return `${address.trim().slice(0, at)}@${domain}`;
}

/** Worth asking about: something@something.something. */
function looksComplete(address: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(address.trim());
}

export function DidYouMean({
  address,
  onUse,
  delayMs = 600,
}: {
  address: string;
  onUse: (fixed: string) => void;
  delayMs?: number;
}) {
  const [found, setFound] = useState<{ for: string; domain: string } | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    const a = address.trim();
    if (!looksComplete(a)) return;
    let live = true;
    const t = window.setTimeout(() => {
      api
        .checkContact(a)
        .then((r) => live && setFound(r.suggestion ? { for: a, domain: r.suggestion } : null))
        .catch(() => live && setFound(null));
    }, delayMs);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [address, delayMs]);

  const a = address.trim();
  if (!found || found.for !== a || dismissed === a) return null;
  const fixed = swapDomain(a, found.domain);
  return (
    <div
      role="status"
      data-testid="did-you-mean"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[14px] border border-[color-mix(in_srgb,var(--warning)_45%,transparent)] bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] px-4 py-3 text-[15px] text-[var(--text-body)]"
    >
      <span className="min-w-0 flex-1">
        Did you mean <strong className="break-all text-[var(--text)]">{fixed}</strong>?
      </span>
      <span className="flex gap-2">
        <button
          type="button"
          className="min-h-11 rounded-full bg-[var(--accent)] px-4 text-sm font-semibold text-[var(--text-on-accent)]"
          onClick={() => onUse(fixed)}
        >
          Use that
        </button>
        <button
          type="button"
          className="min-h-11 rounded-full px-3 text-sm font-semibold text-muted underline-offset-2 hover:underline"
          onClick={() => setDismissed(a)}
        >
          No, it&apos;s right
        </button>
      </span>
    </div>
  );
}
