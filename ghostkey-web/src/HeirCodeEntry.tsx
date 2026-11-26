/**
 * The heir code on the claim page (option a).
 *
 * The heir types the five words their family member gave them. The
 * browser turns them into a key (Argon2id) and checks it by opening
 * something locked with it: the video message while they wait, or their
 * Bitcoin key once the claim is open. GhostKey never sees the code.
 *
 * The context holds the code's key for the page's lifetime, so the heir
 * types it once and it opens both the video and the claim.
 */
import { createContext, useContext, useState, type ReactNode } from "react";

import { deriveHeirCodeKek, looksLikeHeirCode, type HeirCodeKdf } from "./crypto/heirCode";
import { Button, Field, InlineAlert } from "./ui";
import { useVocab } from "./vocab";

interface HeirCodeState {
  kdf: HeirCodeKdf;
  codeKek: Uint8Array | null;
  setCodeKek: (k: Uint8Array) => void;
}

const HeirCodeContext = createContext<HeirCodeState | null>(null);

/** Wraps a claim page whose heir key is locked with an heir code. */
export function HeirCodeProvider({ kdf, children }: { kdf: HeirCodeKdf; children: ReactNode }) {
  const [codeKek, setCodeKek] = useState<Uint8Array | null>(null);
  return (
    <HeirCodeContext.Provider value={{ kdf, codeKek, setCodeKek }}>
      {children}
    </HeirCodeContext.Provider>
  );
}

/** Null on a vault without an heir code (older vaults use the link). */
export function useHeirCode(): HeirCodeState | null {
  return useContext(HeirCodeContext);
}

/**
 * Ask for the code and check it. `check` gets the code's key and throws
 * if it doesn't open what it should; only then is the key kept.
 */
export function HeirCodeEntry({
  check,
  submitLabel,
}: {
  check: (codeKek: Uint8Array) => void | Promise<void>;
  submitLabel?: string;
}) {
  const h = useVocab().heirCode;
  const ctx = useHeirCode();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState(0);
  const [error, setError] = useState<string | null>(null);
  if (!ctx) return null;
  const ready = looksLikeHeirCode(code);

  async function onSubmit() {
    if (!ctx || !ready) return;
    setBusy(true);
    setError(null);
    setPct(0);
    let kek: Uint8Array | null = null;
    try {
      kek = await deriveHeirCodeKek(code, ctx.kdf, (p) => setPct(Math.round(p * 100)));
      await check(kek);
      ctx.setCodeKek(kek);
      kek = null;
    } catch {
      setError(h.wrong);
    } finally {
      kek?.fill(0);
      setBusy(false);
    }
  }

  return (
    <form
      className="mt-3"
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit();
      }}
    >
      <Field label={h.label} htmlFor="heir-code-input" hint={h.hint}>
        <input
          id="heir-code-input"
          className="input font-mono"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder={h.placeholder}
        />
      </Field>
      {error && (
        <div className="mt-3">
          <InlineAlert tone="alarm">{error}</InlineAlert>
        </div>
      )}
      <div className="mt-3">
        <Button type="submit" disabled={!ready || busy}>
          {busy ? h.checking(pct) : (submitLabel ?? h.unlock)}
        </Button>
      </div>
    </form>
  );
}
