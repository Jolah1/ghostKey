/**
 * Wordmark. Tando-inspired: heavy Inter Tight in mixed case, accent
 * on the second half. Clicking returns to landing.
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
  return (
    <a
      href="#/landing"
      onClick={(e) => {
        if (onClick) { e.preventDefault(); onClick(); }
      }}
      className="inline-flex items-center gap-2 focus:outline-none"
      aria-label={`${brand.name} home`}
    >
      <span className={`font-display font-bold tracking-tight text-[var(--text)] ${fs}`}>
        Ghost<span className="text-accent">Key</span>
      </span>
    </a>
  );
}
