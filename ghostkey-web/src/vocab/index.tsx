/**
 * i18n shell (#204): language selection, `*-NG`-locale auto-detect, a
 * persisted language dropdown, and hooks to read the active copy.
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
 * Language dropdown. Sits beside the theme toggle in the nav. Lists every
 * language by its full name straight from the vocab tables, so adding a
 * language needs no change here — it appears in the list automatically.
 */
export function LanguageToggle() {
  const { lang, setLang } = useLang();
  const langs = Object.entries(VOCABS) as [Lang, Vocab][];
  return (
    <div className="relative inline-flex">
      <select
        value={lang}
        onChange={(e) => setLang(e.target.value as Lang)}
        aria-label="Language"
        className="h-9 cursor-pointer appearance-none rounded-full pl-3 pr-8 text-xs font-semibold text-[var(--text)] transition-colors hover:bg-[var(--surface-2)]"
        style={{ border: "1px solid var(--border-hi)", backgroundColor: "transparent" }}
      >
        {langs.map(([code, v]) => (
          <option
            key={code}
            value={code}
            style={{ backgroundColor: "var(--surface)", color: "var(--text)" }}
          >
            {v.langName}
          </option>
        ))}
      </select>
      <ChevronDownIcon />
    </div>
  );
}

function ChevronDownIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-dim)]"
      aria-hidden="true"
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}
