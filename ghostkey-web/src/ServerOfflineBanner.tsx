/**
 * Persistent banner shown when the API is unreachable.
 *
 * Spelled out in plain language: the family shouldn't panic if the
 * dashboard can't talk to its server — the on-chain promise is still
 * good.
 */
import { WifiOff } from "lucide-react";

interface Props {
  message?: string;
}

export function ServerOfflineBanner({ message }: Props) {
  return (
    <div
      role="alert"
      className="sticky top-0 z-30 border-b-4 border-ink bg-yellow"
    >
      <div className="mx-auto flex max-w-6xl items-start gap-3 px-6 py-3 text-sm">
        <WifiOff className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <p className="font-bold">Can't reach the reminders service.</p>
          <p className="text-ink/70">
            Your money is safe — it lives on Bitcoin, not here. You'll be
            able to tap "I'm OK" again as soon as the service is back.
          </p>
          {message && (
            <p className="mt-1 font-mono text-[10px] text-ink/50">{message}</p>
          )}
        </div>
      </div>
    </div>
  );
}
