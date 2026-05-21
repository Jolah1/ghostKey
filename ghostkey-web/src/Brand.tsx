/** Tiny logo + brand cluster reused in header and landing hero. */
import { brand } from "./vocab";

export function Brand({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const dim =
    size === "lg" ? "h-12 w-12" : size === "sm" ? "h-8 w-8" : "h-10 w-10";
  return (
    <div className="flex items-center gap-3">
      <Mark className={dim} />
      <div className="leading-none">
        <p className="font-display text-xl font-bold uppercase tracking-tight">
          {brand.name}
        </p>
        <p className="mt-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
          {brand.tagline}
        </p>
      </div>
    </div>
  );
}

export function Mark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      role="img"
      aria-label="GhostKey logo"
      className={className}
    >
      <rect
        x="2"
        y="2"
        width="28"
        height="28"
        rx="6"
        fill="hsl(72 100% 50%)"
        stroke="black"
        strokeWidth="3"
      />
      <path
        d="M16 7 L24 12 L24 22 L16 27 L8 22 L8 12 Z"
        fill="none"
        stroke="black"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      <circle cx="16" cy="17" r="3.5" fill="black" />
    </svg>
  );
}
