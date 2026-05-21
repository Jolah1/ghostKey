/**
 * Persistent banner shown when the API is unreachable.
 *
 * Bitcoin-themed (orange), top-of-page, reassuring tone.
 */
import { WifiOff } from "lucide-react";

export function ServerOfflineBanner({ message }: { message?: string }) {
  return (
    <div
      role="alert"
      className="sticky top-0 z-40 border-b border-bitcoin/30 bg-bitcoin-50"
    >
      <div className="mx-auto flex max-w-6xl items-start gap-3 px-5 py-2.5 text-sm md:px-8">
        <WifiOff className="mt-0.5 h-4 w-4 shrink-0 text-bitcoin" />
        <div className="min-w-0">
          <p className="font-semibold text-bitcoin-900">
            Can't reach the reminders service.
          </p>
          <p className="text-bitcoin-900/80">
            Your money is safe — it lives on Bitcoin, not here. Try again in
            a minute.
          </p>
          {message && (
            <p className="mt-0.5 truncate font-mono text-[10px] text-bitcoin-900/50">
              {message}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
