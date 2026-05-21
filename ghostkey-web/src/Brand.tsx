/** Logo mark + wordmark used in the navbar and footer. */
import { brand } from "./vocab";

export function Brand({
  size = "md",
  href = "#",
  onClick,
}: {
  size?: "sm" | "md" | "lg";
  href?: string;
  onClick?: () => void;
}) {
  const markCls =
    size === "lg" ? "h-10 w-10" : size === "sm" ? "h-7 w-7" : "h-8 w-8";
  const nameCls =
    size === "lg"
      ? "text-2xl"
      : size === "sm"
        ? "text-base"
        : "text-lg";
  return (
    <a
      href={href}
      onClick={(e) => {
        if (onClick) {
          e.preventDefault();
          onClick();
        }
      }}
      className="inline-flex items-center gap-2.5 focus:outline-none"
    >
      <Mark className={markCls} />
      <span
        className={`font-display font-bold tracking-tight text-ink ${nameCls}`}
      >
        {brand.name}
      </span>
    </a>
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
      <rect x="1" y="1" width="30" height="30" rx="8" fill="#F7931B" />
      <path
        d="M11.5 9.5h6.2c2.6 0 4.2 1.4 4.2 3.6 0 1.6-.9 2.7-2.2 3.1v.1c1.7.4 2.7 1.6 2.7 3.4 0 2.5-1.8 4.1-4.6 4.1H11.5V9.5zm5.3 6.2c1.4 0 2.2-.7 2.2-1.9 0-1.2-.8-1.9-2.2-1.9h-2.5v3.8h2.5zm.3 6.4c1.6 0 2.5-.8 2.5-2.1 0-1.3-.9-2.1-2.5-2.1h-2.8v4.2h2.8z"
        fill="white"
      />
      <line
        x1="14.5"
        y1="7"
        x2="14.5"
        y2="10"
        stroke="white"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <line
        x1="18"
        y1="7"
        x2="18"
        y2="10"
        stroke="white"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <line
        x1="14.5"
        y1="22"
        x2="14.5"
        y2="25"
        stroke="white"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <line
        x1="18"
        y1="22"
        x2="18"
        y2="25"
        stroke="white"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
