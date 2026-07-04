/**
 * Top navigation bar. Minimal, always visible.
 *
 * Layout follows Tando: wordmark · center links · right-side CTA + theme.
 * Mobile collapses to wordmark + CTA + hamburger; the sheet slides
 * under the bar with the same links.
 */
import { useEffect, useState } from "react";
import { Brand } from "./Brand";
import type { Route } from "./App";
import { useTheme } from "./theme";
import { LanguageToggle } from "./vocab";

interface NavItem {
  key: Route;
  label: string;
}

/**
 * Signed out: the visitor's jobs are set up / sign in / inherit —
 * the dashboard would only bounce them to the password prompt.
 * Signed in: "Sign in" disappears (they already did) and the
 * dashboard takes its place. Sessions end automatically after a
 * period of inactivity (see App's guard), so there's no sign-out
 * button to clutter the bar.
 */
const SIGNED_OUT_ITEMS: NavItem[] = [
  { key: "setup",     label: "Set up" },
  { key: "checkin",   label: "Sign in" },
  { key: "inherit",   label: "Inherit" },
];

const SIGNED_IN_ITEMS: NavItem[] = [
  { key: "dashboard", label: "Dashboard" },
  { key: "tools",     label: "Tools" },
  { key: "recovery",  label: "Recovery kit" },
  { key: "inherit",   label: "Inherit" },
];

interface Props {
  route: Route;
  onNavigate: (r: Route) => void;
  signedIn: boolean;
}

export function NavBar({ route, onNavigate, signedIn }: Props) {
  const [open, setOpen] = useState(false);
  const { theme, toggle } = useTheme();
  const items = signedIn ? SIGNED_IN_ITEMS : SIGNED_OUT_ITEMS;

  useEffect(() => { setOpen(false); }, [route]);

  return (
    <header
      className="sticky top-0 z-30 border-b border-app backdrop-blur-md"
      style={{ backgroundColor: "color-mix(in srgb, var(--bg) 80%, transparent)" }}
    >
      <div className="mx-auto flex h-[60px] max-w-6xl items-center justify-between gap-4 px-5 md:px-8">
        <Brand size="md" onClick={() => onNavigate("landing")} />

        <nav
          className="hidden h-full items-center gap-7 md:flex"
          aria-label="Primary"
        >
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => onNavigate(item.key)}
              data-active={item.key === route || undefined}
              className="nav-link h-full"
              aria-current={item.key === route ? "page" : undefined}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <LanguageToggle />
          <ThemeToggle theme={theme} onToggle={toggle} />
          {!signedIn && route !== "setup" && (
            <button
              type="button"
              onClick={() => onNavigate("setup")}
              className="btn btn-ghost hidden md:inline-flex"
            >
              Set up
            </button>
          )}
          {signedIn && route !== "dashboard" && (
            <button
              type="button"
              onClick={() => onNavigate("dashboard")}
              className="btn btn-ghost hidden md:inline-flex"
            >
              Dashboard
            </button>
          )}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls="mobile-menu"
            aria-label={open ? "Close menu" : "Open menu"}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full text-[var(--text)] md:hidden"
            style={{ border: "1px solid var(--border-hi)" }}
          >
            {open ? <CloseIcon /> : <MenuIcon />}
          </button>
        </div>
      </div>

      {open && (
        <div id="mobile-menu" className="border-t border-app md:hidden">
          <nav className="mx-auto flex max-w-6xl flex-col gap-1 px-5 py-3">
            {items.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => onNavigate(item.key)}
                data-active={item.key === route || undefined}
                className="nav-link mobile"
              >
                {item.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => onNavigate(signedIn ? "dashboard" : "setup")}
              className="btn btn-primary mt-2"
            >
              {signedIn ? "Open your dashboard" : "Set up your vault"}
            </button>
          </nav>
        </div>
      )}
    </header>
  );
}

function ThemeToggle({ theme, onToggle }: { theme: "dark" | "light"; onToggle: () => void }) {
  const isDark = theme === "dark";
  return (
    <button
      type="button"
      onClick={onToggle}
      className="inline-flex h-9 w-9 items-center justify-center rounded-full text-[var(--text)] transition-colors hover:bg-[var(--surface-2)]"
      style={{ border: "1px solid var(--border-hi)" }}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Light mode" : "Dark mode"}
    >
      {isDark ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

/* Inline icons keep the nav bar zero-dependency. */
function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}
function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}
function MenuIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="h-4 w-4" aria-hidden="true">
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}
function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="h-4 w-4" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
