import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  // preflight off : on garde les resets d'opendesign (globals.css copié d'opendesign)
  corePlugins: { preflight: false },
  darkMode: ["selector", "[data-theme='dark']"],
  theme: {
    extend: {
      colors: {
        // Mappe les couleurs Tailwind sur les CSS variables d'opendesign
        // pour utiliser bg-accent / text-muted / border-soft etc dans le markup
        accent: "var(--accent)",
        "accent-strong": "var(--accent-strong)",
        "accent-soft": "var(--accent-soft)",
        "accent-tint": "var(--accent-tint)",
        surface: "var(--bg-panel)",
        muted: "var(--text-muted)",
        soft: "var(--text-soft)",
        faint: "var(--text-faint)",
        strong: "var(--text-strong)",
        body: "var(--text)",
        "border-soft": "var(--border-soft)",
        "border-strong": "var(--border-strong)",
      },
      fontFamily: {
        sans: "var(--sans)",
        serif: "var(--serif)",
        mono: "var(--mono)",
      },
      borderRadius: {
        sm: "var(--radius-sm)",
        DEFAULT: "var(--radius)",
        lg: "var(--radius-lg)",
      },
      boxShadow: {
        xs: "var(--shadow-xs)",
        sm: "var(--shadow-sm)",
        md: "var(--shadow-md)",
        lg: "var(--shadow-lg)",
      },
    },
  },
  plugins: [],
};

export default config;
