/**
 * Last-resort error boundary around the whole app. Without it, a
 * render-time exception unmounts React and leaves a blank page — the
 * worst possible outcome for a non-technical owner mid-check-in.
 * Instead we show a calm, recoverable card.
 *
 * The reload button is a full page reload on purpose: it clears
 * whatever transient state broke the render, and every flow in the
 * app (check-in, claim, setup resume) survives a reload — durable
 * state lives in localStorage and on the server.
 */
import { Component, type ReactNode } from "react";

/**
 * Whether to surface the raw error on the crash card.
 *
 * Off for everyone by default: an owner mid-check-in or a grieving
 * heir must never be shown a stack trace. It's opt-in per browser, so
 * only someone debugging sees it:
 *
 *   localStorage.setItem("gk:debug", "1")   — sticky, survives reloads
 *   https://ghostkeyapp.com/?debug=1#/...   — one-off, no console needed
 *
 * The query form matters on mobile, where there's no console to open.
 * Reads are wrapped because localStorage throws in some privacy modes.
 */
function debugEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const q = new URLSearchParams(window.location.search).get("debug");
    if (q === "1") return true;
    return window.localStorage.getItem("gk:debug") === "1";
  } catch {
    return false;
  }
}

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  componentStack: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): State {
    return { error, componentStack: null };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    // Console only — there's no telemetry sink yet, and the message
    // may contain user data we'd rather not ship anywhere.
    console.error("GhostKey UI crashed:", error, info.componentStack);
    // Kept so the debug-gated block below can show it. A phone has no
    // console, so without this a crash there is undiagnosable.
    this.setState({ componentStack: info.componentStack ?? null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="min-h-screen bg-app">
        <div
          className="mx-auto flex max-w-md flex-col items-center px-5 py-24 text-center"
          role="alert"
        >
          <h1 className="font-display text-2xl font-bold">
            Something went wrong on this page
          </h1>
          <p className="mt-3 text-sm text-muted">
            Your vault and your Bitcoin are not affected. This is only a
            display problem, and reloading the page almost always fixes it.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-8 rounded-full bg-[var(--accent)] px-6 py-2.5 text-sm font-semibold text-[var(--text-on-accent)]"
          >
            Reload the page
          </button>
          <p className="mt-4 text-xs text-dim">
            If it keeps happening, close the tab and open the site
            again. And remember, your money is always reachable with
            your emergency recovery file.
          </p>
          {debugEnabled() ? (
            <pre className="mt-8 w-full overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[var(--surface-2,var(--surface))] p-3 text-left text-[11px] leading-relaxed text-muted">
              {this.state.error.message}
              {this.state.error.stack ? `\n\n${this.state.error.stack}` : ""}
              {this.state.componentStack ?? ""}
            </pre>
          ) : null}
        </div>
      </main>
    );
  }
}
