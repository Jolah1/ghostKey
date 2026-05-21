/** @type {import("tailwindcss").Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  // Theme is driven by CSS variables in src/index.css, not Tailwind config.
  // We only register tokens here so Tailwind can resolve class names that
  // some components still use (text-accent, bg-surface, etc.). Anything
  // colour-related should read var(--*) so dark/light mode just works.
  theme: {
    extend: {
      colors: {
        accent: "var(--accent)",
        surface: "var(--surface)",
        "surface-2": "var(--surface-2)",
        ok: "var(--ok)",
        warning: "var(--warning)",
        alarm: "var(--alarm)",
      },
      fontFamily: {
        sans:    ['"Inter"', "system-ui", "sans-serif"],
        display: ['"Inter Tight"', '"Inter"', "system-ui", "sans-serif"],
        serif:   ['"Inter Tight"', '"Inter"', "system-ui", "sans-serif"],
        mono:    ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      maxWidth: {
        prose: "62ch",
      },
    },
  },
  plugins: [],
};
