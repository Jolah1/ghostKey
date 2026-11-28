/**
 * The Family page's list of tools: the message for the heir, how they're
 * reached, the practice run, reminders and emergency options. One row
 * each; the tools themselves are their own pages.
 */
import type { Route } from "./App";
import type { VaultView } from "./api";
import type { ToolDoneState } from "./toolStatus";

export function FamilyTools({
  vault,
  ownerToken,
  pushKey,
  done,
  onNavigate,
}: {
  vault: VaultView;
  ownerToken: string | null;
  pushKey: string | null;
  done: ToolDoneState;
  onNavigate: (r: Route) => void;
}) {
  const isClaiming = vault.status === "timelock_started" || vault.status === "claiming";
  const isClosed = vault.status === "claimed";
  // No heir chosen yet: nobody to message, reach or practise with.
  const heirPending = vault.heir_pending === true;

  const items: Array<{ label: string; desc: string; route: Route }> = [];
  if (vault && !isClosed && !heirPending) {
    items.push({
      label: "Message for your heir",
      desc:
        done.hasVideo === true
          ? "Video saved. Watch, replace, or remove it"
          : "Record a short video for your heir",
      route: "heir-message",
    });
  }
  if (vault && !isClosed && !heirPending) {
    items.push({
      label: "How your heir is reached",
      desc: "Change their contact or the way we reach them",
      route: "heir-contact",
    });
  }
  if (vault && !isClosed && !isClaiming && !heirPending) {
    items.push({
      label: "Practice a claim",
      desc: vault.drill_completed_at
        ? "Completed. Send another any time"
        : vault.drill_started_at
          ? "Practice sent. See where it stands"
          : "Let your heir rehearse safely",
      route: "practice",
    });
  }
  if (vault && ownerToken && pushKey && !isClosed && !heirPending) {
    items.push({
      label: "Check-in reminders",
      desc:
        done.remindersOn === true
          ? "On for this device"
          : "Get a nudge to check in",
      route: "reminders",
    });
  }
  if (vault && vault.status !== "frozen" && !isClosed && !isClaiming && !heirPending) {
    items.push({
      label: "Emergency",
      desc: "Freeze your vault if something feels wrong",
      route: "emergency",
    });
  }

  if (items.length === 0) return null;
  return (
    <nav
          className="card-flat divide-y divide-[var(--border)] p-0"
          aria-label="Inheritance settings"
        >
          {items.map((it) => (
            <button
              key={it.route}
              type="button"
              onClick={() => onNavigate(it.route)}
              className="flex w-full items-center gap-3 p-4 text-left transition-colors hover:bg-[var(--surface-2)]"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-[var(--text)]">
                  {it.label}
                </span>
                <span className="block truncate text-xs text-muted">
                  {it.desc}
                </span>
              </span>
              <span aria-hidden="true" className="shrink-0 text-lg text-dim">
                ›
              </span>
            </button>
          ))}
        </nav>
  );
}
