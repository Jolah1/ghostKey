/**
 * Inherit portal.
 *
 * Used to be a vault-lookup-by-ID page for the heir. With per-vault
 * owner authentication shipping in 060dbfc's follow-up, that flow no
 * longer works: the only way a heir can read vault state is via their
 * one-time `/claim/<token>` link. This page is now a redirect /
 * guidance page that explains what to do.
 *
 * We keep the route reachable from the navbar and the landing page so
 * that heirs who don't have their link can be told *what to expect*
 * (a SMS / email / WhatsApp message containing the link) and *what
 * not to do* (paste a vault ID — that's an owner-side concept).
 */
import { useState } from "react";
import { Button, Field, InlineAlert } from "./ui";

export function InheritPortal() {
  const [claimUrl, setClaimUrl] = useState("");
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = claimUrl.trim();
    if (!trimmed) return;
    // Accept either a full URL or just the token. Anything that
    // ends with /claim/<token> or contains #claim/<token> we route
    // to. Otherwise treat it as a bare token.
    try {
      let token: string | null = null;
      if (trimmed.includes("claim/")) {
        const after = trimmed.split("claim/").pop()?.trim() || "";
        token = after.replace(/^[/#]+/, "");
      } else {
        token = trimmed;
      }
      if (token) {
        window.location.hash = `#/claim/${token}`;
      }
    } catch {
      // ignore; the user just sees the input untouched
    }
  };

  return (
    <main className="bg-app fade-in">
      <div className="mx-auto max-w-2xl px-5 py-12 md:py-16">
        <header className="text-center">
          <p className="eyebrow">Inherit</p>
          <h1 className="mt-6 font-serif text-3xl md:text-5xl">
            Someone trusted you with this
          </h1>
          <p className="mx-auto mt-3 max-w-md text-muted">
            If you're here, someone you knew left something behind and
            trusted you to look after it. We'll walk you through it slowly,
            one step at a time. If you don't have your link yet, that's
            normal. It arrives by SMS, WhatsApp, or email when the time
            comes. There's no account to sign in to.
          </p>
        </header>

        <div className="mt-10 card-flat p-5">
          <p className="text-xs uppercase tracking-wider text-dim">
            What the link looks like
          </p>
          <p className="mt-2 font-mono text-xs text-[var(--text)] break-all">
            https://www.ghostkeyapp.com/#/claim/AbCdEf12_3456_etc…
          </p>
          <p className="mt-3 text-sm text-muted">
            Your link is private and works only once. Please don't share it
            with anyone.
          </p>
        </div>

        <form onSubmit={submit} className="mt-8">
          <Field
            label="Already have your link?"
            hint="Paste the whole URL, or just the token at the end."
          >
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                type="text"
                value={claimUrl}
                onChange={(e) => setClaimUrl(e.target.value)}
                placeholder="https://www.ghostkeyapp.com/#/claim/…"
                spellCheck={false}
                autoComplete="off"
                className="input font-mono text-[13px]"
              />
              <Button type="submit" disabled={!claimUrl.trim()}>
                Open it
              </Button>
            </div>
          </Field>
        </form>

        <div className="mt-8">
          <InlineAlert tone="neutral">
            Don't have a link yet? That's normal. You'll only receive one if
            the person who set up the vault stops checking in. Until then,
            there is nothing on this site for you to do.
          </InlineAlert>
        </div>
      </div>
    </main>
  );
}
