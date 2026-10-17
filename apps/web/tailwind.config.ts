import type { Config } from "tailwindcss";

/**
 * Design tokens.
 *
 * The palette is driven by CSS variables declared in globals.css so a single
 * `data-theme` flip switches the whole archive, and so the severity colours
 * can be referenced from both Tailwind classes and inline styles.
 */
export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "rgb(var(--bg) / <alpha-value>)",
        surface: "rgb(var(--surface) / <alpha-value>)",
        raised: "rgb(var(--raised) / <alpha-value>)",
        line: "rgb(var(--line) / <alpha-value>)",
        "line-strong": "rgb(var(--line-strong) / <alpha-value>)",
        fg: "rgb(var(--fg) / <alpha-value>)",
        muted: "rgb(var(--muted) / <alpha-value>)",
        faint: "rgb(var(--faint) / <alpha-value>)",
        accent: "rgb(var(--accent) / <alpha-value>)",
        "accent-fg": "rgb(var(--accent-fg) / <alpha-value>)",
        sev: {
          info: "rgb(var(--sev-info) / <alpha-value>)",
          low: "rgb(var(--sev-low) / <alpha-value>)",
          medium: "rgb(var(--sev-medium) / <alpha-value>)",
          high: "rgb(var(--sev-high) / <alpha-value>)",
          critical: "rgb(var(--sev-critical) / <alpha-value>)",
        },
      },
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      fontSize: {
        "2xs": ["0.6875rem", { lineHeight: "1rem", letterSpacing: "0.01em" }],
      },
      borderRadius: {
        card: "0.625rem",
      },
      boxShadow: {
        // Linear-style: a hairline plus a soft lift, not a heavy drop shadow.
        card: "0 0 0 1px rgb(var(--line) / 1), 0 1px 2px rgb(0 0 0 / 0.16)",
        lifted:
          "0 0 0 1px rgb(var(--line-strong) / 1), 0 8px 24px -8px rgb(0 0 0 / 0.4), 0 2px 6px -2px rgb(0 0 0 / 0.3)",
      },
      maxWidth: {
        content: "72rem",
        prose: "46rem",
      },
      keyframes: {
        "fade-up": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "none" },
        },
        shimmer: {
          "100%": { transform: "translateX(100%)" },
        },
      },
      animation: {
        "fade-up": "fade-up 200ms cubic-bezier(0.22, 1, 0.36, 1) both",
        shimmer: "shimmer 1.6s infinite",
      },
    },
  },
  plugins: [],
} satisfies Config;
