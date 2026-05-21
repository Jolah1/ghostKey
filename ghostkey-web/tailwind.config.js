/** @type {import("tailwindcss").Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Reflects the HSL tokens defined in index.css. All accents are
        // saturated 100% and used flat (no gradients) per the
        // neo-brutalist style.
        ink: "hsl(0 0% 0%)",
        paper: "hsl(0 0% 100%)",
        muted: {
          DEFAULT: "hsl(0 0% 95%)",
          foreground: "hsl(0 0% 40%)",
        },
        lime: "hsl(72 100% 50%)",
        cyan: "hsl(189 100% 50%)",
        pink: "hsl(313 100% 65%)",
        yellow: "hsl(50 100% 50%)",
        orange: "hsl(29 100% 50%)",
        red: "hsl(0 100% 61%)",
        // Semantic aliases so vault status code stays readable.
        ok: "hsl(72 100% 50%)",      // lime
        warning: "hsl(50 100% 50%)", // yellow
        alarmed: "hsl(0 100% 61%)",  // red
      },
      fontFamily: {
        sans: ['"Space Grotesk"', "system-ui", "sans-serif"],
        display: ['"Space Grotesk"', "system-ui", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      borderWidth: {
        3: "3px",
        5: "5px",
      },
      boxShadow: {
        // Hard-offset solid black shadows (no blur). Heirloom's neo-* idiom.
        "neo-sm": "4px 4px 0 0 hsl(0 0% 0%)",
        "neo-md": "8px 8px 0 0 hsl(0 0% 0%)",
        "neo-lg": "12px 12px 0 0 hsl(0 0% 0%)",
        "neo-xl": "16px 16px 0 0 hsl(0 0% 0%)",
      },
      keyframes: {
        slideUp: {
          "0%": { opacity: "0", transform: "translateY(24px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        pulseGlow: {
          "0%, 100%": { boxShadow: "8px 8px 0 0 hsl(0 0% 0%)" },
          "50%": {
            boxShadow:
              "12px 12px 0 0 hsl(0 0% 0%), 0 0 20px hsl(72 100% 50% / 0.45)",
          },
        },
        shake: {
          "0%,100%": { transform: "translateX(0)" },
          "25%": { transform: "translateX(-6px)" },
          "50%": { transform: "translateX(6px)" },
          "75%": { transform: "translateX(-3px)" },
        },
      },
      animation: {
        "slide-up": "slideUp 0.4s cubic-bezier(0,0,.2,1)",
        "pulse-glow": "pulseGlow 2.4s ease-in-out infinite",
        shake: "shake 0.4s ease-out",
      },
    },
  },
  plugins: [],
};
