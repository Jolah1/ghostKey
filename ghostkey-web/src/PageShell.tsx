/**
 * The frame every secondary page shares: a round back button, a title,
 * an optional one line of help, then the page's own content.
 */
import type { ReactNode } from "react";
import type { Route } from "./App";

export function PageShell({
  title,
  intro,
  onNavigate,
  onBack,
  backLabel = "Back to home",
  children,
}: {
  title: string;
  intro?: string;
  onNavigate: (r: Route) => void;
  /** Where the back link goes; home unless the page has its own steps. */
  onBack?: () => void;
  backLabel?: string;
  children: ReactNode;
}) {
  return (
    <main className="bg-app fade-in">
      <div className="mx-auto max-w-2xl px-5 pb-12 pt-4 md:pt-8">
        <div className="flex h-12 items-center">
          <button
            type="button"
            onClick={onBack ?? (() => onNavigate("dashboard"))}
            aria-label={backLabel}
            title={backLabel}
            className="flex h-11 w-11 items-center justify-center rounded-full bg-surface text-[var(--text)] transition-colors hover:bg-[var(--surface-2)]"
          >
            <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
        </div>
        <h1 className="mt-5 font-display text-[32px] font-extrabold leading-[1.1] tracking-[-0.02em] text-[var(--text)]">
          {title}
        </h1>
        {intro ? <p className="mt-2.5 text-[17px] leading-normal text-muted">{intro}</p> : null}
        <div className="mt-8">{children}</div>
      </div>
    </main>
  );
}
