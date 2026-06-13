import type { Config } from "tailwindcss";

/**
 * Tailwind aliases for the active yaka-bridge design system.
 * All visual values map to CSS variables from `app/design-system.css`.
 */
const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./modules/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  // Shared resets live in app/globals.css; design values live in app/design-system.css.
  corePlugins: { preflight: false },
  darkMode: ["selector", "[data-theme='dark']"],
  theme: {
    extend: {
      colors: {
        // Surfaces
        bg: "var(--bg)",
        surface: "var(--surface)",
        subtle: "var(--subtle)",
        "bg-subtle": "var(--bg-subtle)",
        "bg-muted": "var(--bg-muted)",

        // Borders
        border: "var(--border)",
        "border-strong": "var(--border-strong)",
        "border-soft": "var(--border-soft)",

        // Text
        fg: "var(--fg)",
        "fg-strong": "var(--fg-strong)",
        muted: "var(--muted)",
        soft: "var(--soft)",
        faint: "var(--faint)",
        // Backward-compat aliases
        text: "var(--fg)",
        "text-strong": "var(--fg-strong)",
        "text-muted": "var(--muted)",
        "text-soft": "var(--soft)",
        "text-faint": "var(--faint)",

        // Accent
        accent: "var(--accent)",
        "accent-strong": "var(--accent-strong)",
        "accent-soft": "var(--accent-soft)",
        "accent-tint": "var(--accent-tint)",
        "accent-hover": "var(--accent-hover)",

        // Status tint families
        green: {
          DEFAULT: "var(--green)",
          fg: "var(--green-fg)",
          bg: "var(--green-bg)",
          border: "var(--green-border)",
        },
        blue: {
          DEFAULT: "var(--blue)",
          fg: "var(--blue-fg)",
          bg: "var(--blue-bg)",
          border: "var(--blue-border)",
        },
        purple: {
          DEFAULT: "var(--purple)",
          fg: "var(--purple-fg)",
          bg: "var(--purple-bg)",
          border: "var(--purple-border)",
        },
        red: {
          DEFAULT: "var(--red)",
          fg: "var(--red-fg)",
          bg: "var(--red-bg)",
          border: "var(--red-border)",
        },
        amber: {
          DEFAULT: "var(--amber)",
          fg: "var(--amber-fg)",
          bg: "var(--amber-bg)",
          border: "var(--amber-border)",
        },
      },
      fontFamily: {
        display: ["var(--serif)"],
        serif: ["var(--serif)"],
        sans: ["var(--sans)"],
        mono: ["var(--mono)"],
      },
      fontSize: {
        eyebrow: ["11px", { lineHeight: "1", letterSpacing: "0.08em" }],
        caption: ["11.5px", { lineHeight: "1.4" }],
        label: ["12px", { lineHeight: "1.4", fontWeight: "500" }],
        base: ["13.5px", { lineHeight: "1.5" }],
        body: ["13.5px", { lineHeight: "1.5" }],
        "body-strong": ["13px", { lineHeight: "1.45", fontWeight: "600" }],
        card: ["15px", { lineHeight: "1.25", fontWeight: "600" }],
        h4: ["14px", { lineHeight: "1.2", fontWeight: "600" }],
        h3: ["17px", { lineHeight: "1.2", fontWeight: "600" }],
        h2: ["22px", { lineHeight: "1.2", letterSpacing: "-0.02em", fontWeight: "600" }],
        h1: ["30px", { lineHeight: "1.2", letterSpacing: "-0.02em", fontWeight: "600" }],
      },
      borderRadius: {
        sm: "var(--radius-sm)",
        DEFAULT: "var(--radius)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
        pill: "var(--radius-pill)",
      },
      boxShadow: {
        xs: "var(--shadow-xs)",
        sm: "var(--shadow-sm)",
        md: "var(--shadow-md)",
        lg: "var(--shadow-lg)",
      },
      transitionTimingFunction: {
        tf: "var(--ease)",
      },
      transitionDuration: {
        fast: "var(--t-fast)",
      },
      keyframes: {
        pulse: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.45" },
        },
      },
      animation: {
        pulse: "pulse 1.6s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
