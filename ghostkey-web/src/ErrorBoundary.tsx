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
    // Also keep it in state so the card can offer it behind a
    // disclosure. On a phone there's no console to open, so without
    // this a production crash is undiagnosable from a user's report.
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
          {/* Tucked behind a disclosure: nobody needs this to recover,
              but when an owner reports "it keeps doing this" it's the
              difference between a fix and a guess. Phones have no
              console to open. */}
          <details className="mt-6 w-full text-left">
            <summary className="cursor-pointer text-xs text-dim">
              Technical details
            </summary>
            <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[var(--surface-2,var(--surface))] p-3 text-[11px] leading-relaxed text-muted">
              {this.state.error.message}
              {this.state.componentStack ?? ""}
            </pre>
          </details>
        </div>
      </main>
    );
  }
}
