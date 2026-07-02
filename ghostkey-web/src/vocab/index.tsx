/**
 * i18n shell (#204): language selection, `*-NG`-locale auto-detect, a
 * persisted EN/PCM toggle, and hooks to read the active copy.
 *
 * Deliberately dependency-free — a tiny React context, no i18n library.
 * Language lives in context (not a per-hook `useState` like the theme)
 * so every text consumer re-renders together when the language flips.
 *
 * This is the shell + the strings that were already centralised. Most
 * screen copy is still inline in its components; migrating it into
 * `Vocab` is mechanical follow-up work, screen by screen.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { en } from "./en";
import { pcm } from "./pcm";
import type { Lang, Vocab } from "./types";

export { brandName } from "./types";
export type { Lang, Vocab, StatusCopy } from "./types";

const VOCABS: Record<Lang, Vocab> = { en, pcm };
const KEY = "gk:lang";

/**
 * Pure language choice, split out so it's testable without touching
 * `navigator`/`localStorage`: an explicit stored choice wins; else a
 * Nigerian browser locale (`*-NG`, e.g. `en-NG`, `ha-NG`) defaults to
 * Pidgin; else English.
 */
export function pickLang(stored: string | null, locales: readonly string[]): Lang {
  if (stored === "en" || stored === "pcm") return stored;
  if (locales.some((l) => /-NG$/i.test(l))) return "pcm";
  return "en";
}

/** Choose the initial language from the live browser environment. */
export function detectLang(): Lang {
  if (typeof window === "undefined") return "en";
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(KEY);
  } catch {
    /* localStorage blocked — fall through to locale detection */
  }
  const locales =
    navigator.languages && navigator.languages.length > 0
      ? navigator.languages
      : [navigator.language];
  return pickLang(stored, locales);
}

interface LangCtx {
  lang: Lang;
  setLang: (l: Lang) => void;
  vocab: Vocab;
}

const Ctx = createContext<LangCtx | null>(null);

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detectLang);

  useEffect(() => {
    // Keep the document language in sync for assistive tech. "pcm" is a
    // valid BCP-47 primary tag (ISO 639-3 Nigerian Pidgin).
    document.documentElement.setAttribute("lang", lang);
    try {
      localStorage.setItem(KEY, lang);
    } catch {
      /* ignore */
    }
  }, [lang]);

  const setLang = useCallback((l: Lang) => setLangState(l), []);

  return (
    <Ctx.Provider value={{ lang, setLang, vocab: VOCABS[lang] }}>
      {children}
    </Ctx.Provider>
  );
}

export function useLang(): LangCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useLang must be used within <LangProvider>");
  return ctx;
}

/** Shorthand for the active language's copy. */
export function useVocab(): Vocab {
  return useLang().vocab;
}

/**
 * EN/PCM segmented toggle. Sits beside the theme toggle in the nav.
 */
export function LanguageToggle() {
  const { lang, setLang } = useLang();
  const opts: { code: Lang; short: string; full: string }[] = [
    { code: "en", short: "EN", full: "English" },
    { code: "pcm", short: "PCM", full: "Pidgin" },
  ];
  return (
    <div
      role="group"
      aria-label="Language"
      className="inline-flex overflow-hidden rounded-full"
      style={{ border: "1px solid var(--border-hi)" }}
    >
      {opts.map((o) => {
        const active = o.code === lang;
        return (
          <button
            key={o.code}
            type="button"
            onClick={() => setLang(o.code)}
            aria-pressed={active}
            title={o.full}
            className="px-2.5 py-1 text-xs font-semibold transition-colors"
            style={{
              backgroundColor: active ? "var(--surface-2)" : "transparent",
              color: active ? "var(--text)" : "var(--text-dim)",
            }}
          >
            {o.short}
          </button>
        );
      })}
    </div>
  );
}
