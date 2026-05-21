/** @type {import("tailwindcss").Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Bitcoin-themed palette. Single accent (Bitcoin orange) on a
        // cream paper background, with near-black ink for text. Deliberate
        // restraint — closer to tando.me than to a typical crypto site.
        bitcoin: {
          DEFAULT: "#F7931B",
          50: "#fff7eb",
          100: "#feecd0",
          200: "#fdd79c",
          300: "#fbbb5e",
          400: "#f9a233",
          500: "#F7931B",
          600: "#d97306",
          700: "#b35a05",
          800: "#92450b",
          900: "#783a0c",
          950: "#451c04",
        },
        cream: {
          DEFAULT: "#FBF7F0",
          50: "#fefdfb",
          100: "#FBF7F0",
          200: "#f5ecd9",
          300: "#ecd9b3",
          400: "#dec089",
          500: "#cda05b",
        },
        ink: {
          DEFAULT: "#1A1A1A",
          50: "#f4f4f4",
          100: "#e6e6e6",
          200: "#c4c4c4",
          300: "#9a9a9a",
          400: "#737373",
          500: "#525252",
          600: "#3d3d3d",
          700: "#2b2b2b",
          800: "#1A1A1A",
          900: "#0a0a0a",
        },
        // Semantic aliases for vault status.
        ok: "#16a34a",       // emerald-600
        warning: "#f59e0b",  // amber-500
        alarmed: "#dc2626",  // red-600
      },
      fontFamily: {
        sans: ['"Inter"', "system-ui", "sans-serif"],
        display: ['"Inter Tight"', '"Inter"', "system-ui", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      boxShadow: {
        // Soft, warm shadows. No hard offsets.
        "soft-sm": "0 2px 8px -2px rgba(26, 26, 26, 0.06)",
        "soft":    "0 8px 24px -8px rgba(26, 26, 26, 0.08), 0 2px 6px -2px rgba(26, 26, 26, 0.06)",
        "soft-lg": "0 16px 48px -12px rgba(26, 26, 26, 0.10), 0 4px 12px -4px rgba(26, 26, 26, 0.06)",
        "glow":    "0 0 32px -8px rgba(247, 147, 27, 0.45)",
      },
      keyframes: {
        wordIn: {
          "0%":   { opacity: "0", transform: "translateY(40px) rotateX(-20deg)" },
          "100%": { opacity: "1", transform: "translateY(0) rotateX(0)" },
        },
        fadeUp: {
          "0%":   { opacity: "0", transform: "translateY(16px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        pulseGlow: {
          "0%, 100%": { boxShadow: "0 0 0 0 rgba(247, 147, 27, 0.4)" },
          "70%":      { boxShadow: "0 0 0 24px rgba(247, 147, 27, 0)" },
        },
        sweep: {
          "0%":   { backgroundPosition: "200% 0" },
          "100%": { backgroundPosition: "-200% 0" },
        },
      },
      animation: {
        "word-in":    "wordIn 0.7s cubic-bezier(0.16, 1, 0.3, 1) both",
        "fade-up":    "fadeUp 0.5s cubic-bezier(0.16, 1, 0.3, 1) both",
        "pulse-glow": "pulseGlow 2.2s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "sweep":      "sweep 6s linear infinite",
      },
      backgroundImage: {
        "swoosh":
          "radial-gradient(ellipse at 80% 0%, rgba(247, 147, 27, 0.15), transparent 60%), radial-gradient(ellipse at 0% 100%, rgba(247, 147, 27, 0.10), transparent 50%)",
      },
    },
  },
  plugins: [],
};
