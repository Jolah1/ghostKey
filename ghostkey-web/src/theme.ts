/**
 * Theme: dark by default, persisted to localStorage, with a manual
 * toggle. On first visit we respect prefers-color-scheme but the spec
 * picks dark as the brand default so we still bias toward dark.
 *
 * The actual switch is a single `data-theme` attribute on <html>. CSS
 * variables in index.css do all the real work, so no component needs
 * to read this beyond the toggle itself.
 */
import { useEffect, useState, useCallback } from "react";

export type Theme = "dark" | "light";

const KEY = "gk:theme";

function readInitial(): Theme {
  if (typeof window === "undefined") return "dark";
  // The index.html boot script already set the attribute before paint;
  // mirror that here so React's view stays in sync.
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "light" || attr === "dark") return attr;
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    /* localStorage blocked — fall through */
  }
  return "dark";
}

export function useTheme(): { theme: Theme; toggle: () => void; set: (t: Theme) => void } {
  const [theme, setTheme] = useState<Theme>(readInitial);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem(KEY, theme); } catch { /* ignore */ }
  }, [theme]);

  const toggle = useCallback(
    () => setTheme((t) => (t === "dark" ? "light" : "dark")),
    [],
  );

  return { theme, toggle, set: setTheme };
}
