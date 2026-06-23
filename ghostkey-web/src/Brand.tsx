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
    size === "lg" ? "h-9"
    : size === "sm" ? "h-6"
    : "h-7";
  return (
    <a
      href="#/landing"
      onClick={(e) => {
        if (onClick) { e.preventDefault(); onClick(); }
      }}
      className="inline-flex items-center gap-2.5 focus:outline-none"
      aria-label={`${brand.name} home`}
    >
      {/* Transparent shield + key logo, height-fit (width auto) so the
          key isn't cropped. Reads on both themes. */}
      <img src="/brand-mark.png" alt="" className={`${mark} w-auto`} />
      <span className={`font-display font-bold tracking-tight text-[var(--text)] ${fs}`}>
        ghost<span className="text-accent">Key</span>
      </span>
    </a>
  );
}
