/**
 * Status pill used everywhere on the dashboard.
 *
 * Translates a `VaultStatus` into a neo-brutalist colored badge with
 * an icon, so users can read the state at a glance.
 */
import {
  CheckCircle2,
  AlarmClockOff,
  Clock,
  HandHeart,
  AlertTriangle,
  type LucideIcon,
} from "lucide-react";
import { statusCopy } from "./vocab";
import type { VaultStatus } from "./api";

export function StatusPill({
  status,
  size = "md",
}: {
  status: VaultStatus;
  size?: "sm" | "md" | "lg";
}) {
  const c = statusCopy(status);
  const Icon = iconFor(status);
  const tone =
    c.tone === "ok"
      ? "bg-lime"
      : c.tone === "warning"
        ? "bg-yellow"
        : c.tone === "alarmed"
          ? "bg-red text-paper"
          : "bg-muted";
  const sizeCls =
    size === "lg"
      ? "px-5 py-2 text-base"
      : size === "sm"
        ? "px-2.5 py-0.5 text-[10px]"
        : "px-3 py-1 text-xs";
  return (
    <span className={`neo-badge ${tone} ${sizeCls}`}>
      <Icon
        className={size === "lg" ? "h-5 w-5" : "h-3.5 w-3.5"}
        strokeWidth={2.5}
      />
      {c.label}
    </span>
  );
}

function iconFor(status: VaultStatus): LucideIcon {
  switch (status) {
    case "ok":
      return CheckCircle2;
    case "warning":
      return Clock;
    case "alarmed":
      return AlertTriangle;
    case "timelock_started":
      return AlarmClockOff;
    case "claimed":
      return HandHeart;
  }
}
