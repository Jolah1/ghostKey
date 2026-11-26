/**
 * The frame every secondary page shares: a back link, a title, an
 * optional one-line intro, then the page's own content.
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
      <div className="mx-auto max-w-2xl px-5 py-10 md:py-14">
        <button
          type="button"
          onClick={onBack ?? (() => onNavigate("dashboard"))}
          className="text-sm text-muted underline hover:text-[var(--text)]"
        >
          ← {backLabel}
        </button>
        <h1 className="mt-4 font-serif text-3xl">{title}</h1>
        {intro ? <p className="mt-2 text-sm text-muted">{intro}</p> : null}
        <div className="mt-8">{children}</div>
      </div>
    </main>
  );
}
