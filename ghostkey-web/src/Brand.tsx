/**
 * Logo lockup: shield mark + wordmark. Mirrors the brand art —
 * lowercase "ghost" in plain text, "Key" in the teal accent.
 * Clicking returns to landing.
 */
import { brand } from "./vocab";

export function Brand({
  onClick,
  size = "md",
}: {
  onClick?: () => void;
  size?: "sm" | "md" | "lg";
}) {
  const fs =
    size === "lg" ? "text-2xl"
    : size === "sm" ? "text-base"
    : "text-lg";
  const mark =
    size === "lg" ? "h-9 w-9"
    : size === "sm" ? "h-6 w-6"
    : "h-7 w-7";
  return (
    <a
      href="#/landing"
      onClick={(e) => {
        if (onClick) { e.preventDefault(); onClick(); }
      }}
      className="inline-flex items-center gap-2.5 focus:outline-none"
      aria-label={`${brand.name} home`}
    >
      {/* The mark keeps its native navy ground (the shield interior is
          navy too), so it reads as an app-icon tile on both themes. */}
      <img src="/brand-mark.png" alt="" className={`${mark} rounded-lg`} />
      <span className={`font-display font-bold tracking-tight text-[var(--text)] ${fs}`}>
        ghost<span className="text-accent">Key</span>
      </span>
    </a>
  );
}
