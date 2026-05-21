/**
 * Persistent banner shown when the API is unreachable. Reassuring tone:
 * the user's money is on Bitcoin, not on this server.
 */
export function ServerOfflineBanner({ message }: { message?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="border-b border-app bg-surface-2"
    >
      <div className="mx-auto flex max-w-6xl items-start gap-3 px-5 py-2 text-sm md:px-8">
        <span aria-hidden="true" className="mt-1 inline-block h-2 w-2 rounded-full bg-warning" />
        <div className="min-w-0 leading-tight">
          <p className="text-[var(--text)]">
            Reminder service is unreachable.{" "}
            <span className="text-muted">
              Your Bitcoin is safe. It lives on Bitcoin, not here.
            </span>
          </p>
          {message ? (
            <p className="mt-0.5 truncate font-mono text-[10px] text-dim">{message}</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
