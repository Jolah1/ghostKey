/**
 * "I was left something": where an heir starts.
 *
 * The message we send says: go to the site yourself, tap "I was left
 * something", and enter this code (#393). So the code box comes first:
 * nothing in the message has to be clicked, which is what "don't click
 * links in messages" asks. The code opens exactly what the link opens.
 * Pasting the link still works, behind "Have a link instead?".
 */
import { useState } from "react";
import { ApiError, api } from "./api";
import { Button, Field, InlineAlert } from "./ui";
import { useVocab } from "./vocab";

export function InheritPortal() {
  const v = useVocab();
  const p = v.inheritPortal;
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [showLink, setShowLink] = useState(false);
  const [claimUrl, setClaimUrl] = useState("");

  const submitCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim() || busy) return;
    setBusy(true);
    setCodeError(null);
    try {
      const { token } = await api.claimByCode(code.trim());
      window.location.hash = `#/claim/${token}`;
    } catch (err) {
      setCodeError(
        err instanceof ApiError && err.status === 429
          ? p.codeTooMany
          : err instanceof ApiError && err.status === 400
            ? err.message
            : p.codeWrong,
      );
    } finally {
      setBusy(false);
    }
  };

  const submitLink = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = claimUrl.trim();
    if (!trimmed) return;
    // Accept either a full URL or just the token.
    const token = trimmed.includes("claim/")
      ? (trimmed.split("claim/").pop()?.trim() || "").replace(/^[/#]+/, "")
      : trimmed;
    if (token) window.location.hash = `#/claim/${token}`;
  };

  return (
    <main className="bg-app fade-in">
      <div className="mx-auto max-w-2xl px-5 py-12 md:py-16">
        <header className="text-center">
          <p className="eyebrow">{p.eyebrow}</p>
          <h1 className="mt-6 font-serif text-3xl md:text-5xl">{p.title}</h1>
          <p className="mx-auto mt-3 max-w-md text-muted">{p.description}</p>
        </header>

        <section aria-labelledby="code-h" className="mt-10 card-flat p-5">
          <h2 id="code-h" className="m-0 text-lg font-semibold text-[var(--text)]">
            {p.codeTitle}
          </h2>
          <form onSubmit={(e) => void submitCode(e)} className="mt-4 flex flex-col gap-3">
            <Field label={p.codeLabel} hint={p.codeHint} error={codeError}>
              <input
                type="text"
                value={code}
                onChange={(e) => {
                  setCode(e.target.value);
                  setCodeError(null);
                }}
                placeholder="ABCD-EFGH-JKMN"
                spellCheck={false}
                autoComplete="one-time-code"
                autoCapitalize="characters"
                inputMode="text"
                maxLength={24}
                className="setup-input font-mono tracking-[0.12em]"
                data-testid="claim-code"
              />
            </Field>
            <Button type="submit" disabled={!code.trim()} loading={busy} className="h-14 w-full text-[17px]">
              {p.codeButton}
            </Button>
          </form>
        </section>

        <div className="mt-6">
          {showLink ? (
            <form onSubmit={submitLink} className="card-flat p-5">
              <Field label={p.alreadyHaveLink} hint={p.linkHint}>
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
              <p className="mt-3 text-sm text-muted">{p.linkPrivacyNote}</p>
            </form>
          ) : (
            <button
              type="button"
              className="min-h-11 text-[15px] font-semibold text-[var(--accent-text)] underline-offset-2 hover:underline"
              onClick={() => setShowLink(true)}
            >
              {p.haveLinkInstead}
            </button>
          )}
        </div>

        <div className="mt-8">
          <InlineAlert tone="neutral">{p.noLinkYet}</InlineAlert>
        </div>
      </div>
    </main>
  );
}
