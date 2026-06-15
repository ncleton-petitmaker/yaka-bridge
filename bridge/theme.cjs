const fs = require("node:fs");
const path = require("node:path");

const SYSTEM_BRIDGE_FALLBACK = {
  bg: "Canvas",
  panel: "Canvas",
  surface: "Canvas",
  paper: "Canvas",
  border: "ButtonBorder",
  borderStrong: "GrayText",
  borderSoft: "color-mix(in srgb, ButtonBorder 55%, Canvas)",
  text: "CanvasText",
  fg: "CanvasText",
  fgStrong: "CanvasText",
  muted: "GrayText",
  soft: "GrayText",
  accent: "Highlight",
  accentStrong: "Highlight",
  accentTint: "color-mix(in srgb, Highlight 10%, Canvas)",
  accentSoft: "color-mix(in srgb, Highlight 20%, Canvas)",
  onAccent: "HighlightText",
  green: "green",
  greenBg: "color-mix(in srgb, green 10%, Canvas)",
  greenBorder: "color-mix(in srgb, green 35%, Canvas)",
  blue: "Highlight",
  blueBg: "color-mix(in srgb, Highlight 10%, Canvas)",
  blueBorder: "color-mix(in srgb, Highlight 35%, Canvas)",
  purple: "Highlight",
  purpleBg: "color-mix(in srgb, Highlight 10%, Canvas)",
  purpleBorder: "color-mix(in srgb, Highlight 35%, Canvas)",
  amber: "darkgoldenrod",
  amberBg: "color-mix(in srgb, darkgoldenrod 10%, Canvas)",
  amberBorder: "color-mix(in srgb, darkgoldenrod 35%, Canvas)",
  red: "firebrick",
  redBg: "color-mix(in srgb, firebrick 10%, Canvas)",
  redBorder: "color-mix(in srgb, firebrick 35%, Canvas)",
  secondary: "ButtonFace",
  logBg: "ButtonFace",
  shadow: "0 18px 44px rgb(15 23 42 / 0.10), 0 3px 10px rgb(15 23 42 / 0.06)",
  shadowHover: "0 24px 60px rgb(15 23 42 / 0.14), 0 4px 12px rgb(15 23 42 / 0.07)",
  radiusSm: "6px",
  radius: "10px",
  radiusLg: "14px",
  radiusPill: "999px",
  ease: "ease",
  tFast: "120ms",
  sans: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
  mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  logoText: "B",
  iconBg: "color-mix(in srgb, Highlight 10%, Canvas)",
  iconFg: "CanvasText",
  iconAccent: "Highlight",
  iconBorder: "ButtonBorder",
  logoImage: "bridge-mark.png",
};

function loadBridgeDesign() {
  const candidates = [
    path.join(__dirname, "design-system.json"),
    path.join(process.cwd(), "bridge", "design-system.json"),
  ];
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf8"));
      return normalizeBridgeDesign(parsed);
    } catch {
      // Keep Bridge bootable if the generated design file is missing or corrupt.
    }
  }
  return normalizeBridgeDesign({});
}

function normalizeBridgeDesign(input = {}) {
  const merged = { ...SYSTEM_BRIDGE_FALLBACK, ...input };
  merged.fg = input.fg || input.text || merged.fg;
  merged.text = input.text || input.fg || merged.text;
  merged.fgStrong = input.fgStrong || input.textStrong || merged.fgStrong;
  merged.panel = input.panel || input.surface || merged.panel;
  merged.surface = input.surface || input.panel || merged.surface;
  merged.paper = input.paper || input.surface || input.panel || merged.paper;
  merged.line = input.line || input.border || merged.border;
  merged.borderStrong = input.borderStrong || input.lineStrong || merged.borderStrong;
  merged.borderSoft = input.borderSoft || merged.borderSoft;
  merged.accentStrong = input.accentStrong || input.accentHover || merged.accentStrong;
  merged.accentTint = input.accentTint || input.accentSoft || merged.accentTint;
  merged.accentSoft = input.accentSoft || input.accentTint || merged.accentSoft;
  merged.secondary = input.secondary || input.bgMuted || input.logBg || merged.secondary;
  merged.logBg = input.logBg || input.secondary || merged.logBg;
  merged.iconBg = input.iconBg || input.accentTint || merged.iconBg;
  merged.iconFg = input.iconFg || input.fg || input.text || merged.iconFg;
  merged.iconAccent = input.iconAccent || input.accent || merged.iconAccent;
  merged.iconBorder = input.iconBorder || input.border || merged.iconBorder;
  return merged;
}

function cssValue(value, defaultValue) {
  const raw = String(value ?? defaultValue ?? "").trim();
  if (!raw || /[{}<>;]/.test(raw)) return String(defaultValue ?? "");
  return raw;
}

function bridgeDesignCss(designInput) {
  const design = normalizeBridgeDesign(designInput);
  const vars = {
    "--bg": design.bg,
    "--fg": design.text,
    "--text": design.text,
    "--fg-strong": design.fgStrong,
    "--muted": design.muted,
    "--soft": design.soft,
    "--line": design.line,
    "--border": design.border,
    "--border-strong": design.borderStrong,
    "--border-soft": design.borderSoft,
    "--panel": design.panel,
    "--surface": design.surface,
    "--paper": design.paper,
    "--subtle": design.logBg,
    "--secondary": design.secondary,
    "--log-bg": design.logBg,
    "--ink": design.fgStrong,
    "--accent": design.accent,
    "--accent-strong": design.accentStrong,
    "--accent-tint": design.accentTint,
    "--accent-soft": design.accentSoft,
    "--on-accent": design.onAccent,
    "--rust": design.accent,
    "--rust-strong": design.accentStrong,
    "--teal": design.blue,
    "--green": design.green,
    "--green-bg": design.greenBg,
    "--green-border": design.greenBorder,
    "--grey": design.soft,
    "--amber": design.amber,
    "--amber-bg": design.amberBg,
    "--amber-border": design.amberBorder,
    "--blue": design.blue,
    "--blue-bg": design.blueBg,
    "--blue-border": design.blueBorder,
    "--purple": design.purple,
    "--purple-bg": design.purpleBg,
    "--purple-border": design.purpleBorder,
    "--red": design.red,
    "--red-bg": design.redBg,
    "--red-border": design.redBorder,
    "--shadow": design.shadow,
    "--shadow-hover": design.shadowHover || design.shadow,
    "--radius-sm": design.radiusSm,
    "--radius": design.radius,
    "--radius-lg": design.radiusLg,
    "--radius-pill": design.radiusPill,
    "--ease": design.ease,
    "--t-fast": design.tFast,
    "--font-sans": design.sans,
    "--font-mono": design.mono,
    "--icon-bg": design.iconBg,
    "--icon-fg": design.iconFg,
    "--icon-accent": design.iconAccent,
    "--icon-border": design.iconBorder,
  };
  const lines = Object.entries(vars)
    .map(([key, value]) => `  ${key}: ${cssValue(value, SYSTEM_BRIDGE_FALLBACK[key?.replace(/^--/, "")] ?? value)};`)
    .join("\n");
  return `:root {\n  color-scheme: light;\n${lines}\n}`;
}

function bridgeLogoDataUri(designInput) {
  const design = normalizeBridgeDesign(designInput);
  const configured = String(design.logoImage || "").trim();
  const names = [configured, "bridge-mark.png"].filter(Boolean);
  const candidates = [];
  for (const name of names) {
    if (path.isAbsolute(name)) {
      candidates.push(name);
    } else if (!name.includes("..")) {
      candidates.push(path.join(__dirname, name));
      candidates.push(path.join(process.cwd(), "public", name));
    }
  }

  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue;
      const ext = path.extname(candidate).toLowerCase();
      const mime = ext === ".svg" ? "image/svg+xml" : "image/png";
      return `data:${mime};base64,${fs.readFileSync(candidate).toString("base64")}`;
    } catch {
      // Text logo keeps the setup UI usable if the optional mark is absent.
    }
  }
  return null;
}

module.exports = {
  SYSTEM_BRIDGE_FALLBACK,
  bridgeDesignCss,
  bridgeLogoDataUri,
  loadBridgeDesign,
  normalizeBridgeDesign,
};
