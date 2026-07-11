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
import { useVocab } from "./vocab";

export function InheritPortal() {
  const v = useVocab();
  const p = v.inheritPortal;
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
          <p className="eyebrow">{p.eyebrow}</p>
          <h1 className="mt-6 font-serif text-3xl md:text-5xl">
            {p.title}
          </h1>
          <p className="mx-auto mt-3 max-w-md text-muted">
            {p.description}
          </p>
        </header>

        <div className="mt-10 card-flat p-5">
          <p className="text-xs uppercase tracking-wider text-dim">
            {p.whatLinkLooksLike}
          </p>
          <p className="mt-2 font-mono text-xs text-[var(--text)] break-all">
            {p.linkExample}
          </p>
          <p className="mt-3 text-sm text-muted">
            {p.linkPrivacyNote}
          </p>
        </div>

        <form onSubmit={submit} className="mt-8">
          <Field
            label={p.alreadyHaveLink}
            hint={p.linkHint}
          >
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                type="text"
                value={claimUrl}
                onChange={(e) => setClaimUrl(e.target.value)}
                placeholder={p.linkPlaceholder}
                spellCheck={false}
                autoComplete="off"
                className="input font-mono text-[13px]"
              />
              <Button type="submit" disabled={!claimUrl.trim()}>
                {p.openIt}
              </Button>
            </div>
          </Field>
        </form>

        <div className="mt-8">
          <InlineAlert tone="neutral">
            {p.noLinkYet}
          </InlineAlert>
        </div>
      </div>
    </main>
  );
}
