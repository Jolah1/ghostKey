/**
 * Floating AI guide chat.
 *
 * A small, dismissible panel that asks the user's question to a
 * server-proxied Claude model. Used on the setup, dashboard, and
 * claim screens to answer "how does this work" without us having to
 * ship a docs site.
 *
 * Hard rule: nothing in the chat history ever touches keys. The
 * server-side handler refuses to forward seed phrases, xprvs, or
 * other secret-shaped strings (see `crates/ghostkey-server/src/assist.rs`).
 * The component does NOT include vault ids, owner emails, or
 * descriptors in the request — only the user's typed text.
 */
import { useEffect, useRef, useState } from "react";
import { api, ApiError, type AssistChatMessage } from "./api";

interface Props {
  /** A short label that opens the chat. Defaults to "Ask the guide". */
  label?: string;
  /** Optional opener message shown above the input on first open.
   *  Use this to set scope ("Ask anything about funding your vault"). */
  intro?: string;
}

export function AssistChat({ label = "Ask the guide", intro }: Props) {
  const [open, setOpen] = useState(false);
  // We only probe /health on first open — keeps the dashboard cheap.
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [messages, setMessages] = useState<AssistChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open || enabled !== null) return;
    let alive = true;
    api
      .health()
      .then((h) => {
        if (alive) setEnabled(Boolean(h.assist_enabled));
      })
      .catch(() => {
        if (alive) setEnabled(false);
      });
    return () => {
      alive = false;
    };
  }, [open, enabled]);

  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, busy]);

  async function send() {
    const text = draft.trim();
    if (!text || busy) return;
    setError(null);
    const next: AssistChatMessage[] = [
      ...messages,
      { role: "user", content: text },
    ];
    setMessages(next);
    setDraft("");
    setBusy(true);
    try {
      const resp = await api.assistChat(next);
      setMessages([
        ...next,
        { role: "assistant", content: resp.reply },
      ]);
    } catch (e) {
      // Roll back the user message on error so the input still shows
      // it and they can retry without retyping.
      setMessages(messages);
      setDraft(text);
      setError(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : String(e),
      );
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-5 right-5 z-40 rounded-full bg-[var(--surface)] px-4 py-2.5 text-sm font-medium shadow-lg ring-1 ring-[var(--border)] hover:bg-[var(--surface-2,var(--surface))]"
        aria-label={label}
      >
        💬 {label}
      </button>
    );
  }

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label="GhostKey guide chat"
      className="fixed bottom-5 right-5 z-40 flex w-[min(380px,calc(100vw-2rem))] flex-col rounded-2xl bg-[var(--surface)] shadow-xl ring-1 ring-[var(--border)]"
      style={{ maxHeight: "min(560px, calc(100vh - 2.5rem))" }}
    >
      <header className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
        <div>
          <p className="text-sm font-semibold">Guide</p>
          <p className="text-[11px] text-dim">
            Explains GhostKey — never asks for your seed.
          </p>
        </div>
        <button
          type="button"
          className="rounded-md px-2 py-1 text-sm text-muted hover:bg-[var(--surface-2,var(--surface))]"
          onClick={() => setOpen(false)}
          aria-label="Close guide"
        >
          ✕
        </button>
      </header>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-3 text-sm"
      >
        {enabled === false ? (
          <p className="text-muted">
            The AI guide isn't enabled on this server. Reach the team via
            the project README for help.
          </p>
        ) : messages.length === 0 ? (
          <div className="space-y-3">
            {intro ? <p className="text-muted">{intro}</p> : null}
            <p className="text-muted">
              Ask anything about how check-ins, the waiting period, or
              the heir's claim flow work. Never paste your seed phrase
              or private key — the guide will refuse to forward it.
            </p>
            <ul className="space-y-1 text-xs text-dim">
              <li>• What does my heir need to do?</li>
              <li>• Is my heir's email stored on the server?</li>
              <li>• What happens if I lose my password?</li>
            </ul>
          </div>
        ) : (
          <ul className="space-y-3">
            {messages.map((m, i) => (
              <li
                key={i}
                className={
                  m.role === "user"
                    ? "ml-6 rounded-xl bg-[var(--surface-2,rgba(255,255,255,0.03))] px-3 py-2"
                    : "mr-6 rounded-xl px-3 py-2 text-[var(--text)]"
                }
              >
                <p className="whitespace-pre-wrap leading-snug">{m.content}</p>
              </li>
            ))}
            {busy ? (
              <li className="mr-6 rounded-xl px-3 py-2 text-muted">
                <span className="inline-flex items-center gap-2">
                  <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-current" />
                  Thinking…
                </span>
              </li>
            ) : null}
          </ul>
        )}
        {error ? (
          <p className="mt-3 text-xs text-alarm">{error}</p>
        ) : null}
      </div>

      {enabled !== false ? (
        <form
          className="flex items-end gap-2 border-t border-[var(--border)] p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={2}
            disabled={busy}
            placeholder="Type your question…"
            className="flex-1 resize-none rounded-md bg-transparent px-2 py-1.5 text-sm outline-none ring-1 ring-[var(--border)] focus:ring-[var(--accent,#7c3aed)]"
          />
          <button
            type="submit"
            disabled={busy || draft.trim().length === 0}
            className="rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-medium text-[var(--text-on-accent)] disabled:opacity-50"
          >
            Send
          </button>
        </form>
      ) : null}
    </div>
  );
}
