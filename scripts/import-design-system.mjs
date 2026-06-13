#!/usr/bin/env node
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), "..");

const REQUIRED_CSS_VARIABLES = [
  "--bg",
  "--surface",
  "--subtle",
  "--bg-subtle",
  "--bg-muted",
  "--muted-surface",
  "--border",
  "--border-strong",
  "--border-soft",
  "--bg-app",
  "--bg-panel",
  "--bg-elevated",
  "--fg",
  "--fg-strong",
  "--muted",
  "--soft",
  "--faint",
  "--text",
  "--text-strong",
  "--text-muted",
  "--text-soft",
  "--text-faint",
  "--accent",
  "--accent-strong",
  "--accent-soft",
  "--accent-tint",
  "--accent-hover",
  "--on-accent",
  "--green",
  "--green-fg",
  "--green-bg",
  "--green-border",
  "--blue",
  "--blue-fg",
  "--blue-bg",
  "--blue-border",
  "--purple",
  "--purple-fg",
  "--purple-bg",
  "--purple-border",
  "--red",
  "--red-fg",
  "--red-bg",
  "--red-border",
  "--amber",
  "--amber-fg",
  "--amber-bg",
  "--amber-border",
  "--shadow-xs",
  "--shadow-sm",
  "--shadow-md",
  "--shadow-lg",
  "--radius-sm",
  "--radius",
  "--radius-md",
  "--radius-lg",
  "--radius-pill",
  "--serif",
  "--sans",
  "--mono",
  "--ease",
  "--t-fast",
  "--modal-padding",
];

const STATUS_DEFAULTS = {
  green: { fg: "#15803d", bg: "#ecfdf5", border: "#bbf7d0" },
  blue: { fg: "#2563eb", bg: "#eff6ff", border: "#bfdbfe" },
  purple: { fg: "#7c3aed", bg: "#f5f3ff", border: "#ddd6fe" },
  red: { fg: "#b91c1c", bg: "#fef2f2", border: "#fecaca" },
  amber: { fg: "#b45309", bg: "#fffbeb", border: "#fde68a" },
};

const DARK_STATUS_DEFAULTS = {
  green: { fg: "#86efac", bg: "#052e16", border: "#166534" },
  blue: { fg: "#93c5fd", bg: "#172554", border: "#1d4ed8" },
  purple: { fg: "#c4b5fd", bg: "#2e1065", border: "#6d28d9" },
  red: { fg: "#fca5a5", bg: "#450a0a", border: "#991b1b" },
  amber: { fg: "#fcd34d", bg: "#451a03", border: "#92400e" },
};

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function resolvePath(path) {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function writeJson(path, value) {
  ensureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function slugify(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function normalizeId(value, defaultValue = "custom") {
  return slugify(value) || defaultValue;
}

function sourceFromArgs(args) {
  const targetDir = args["target-dir"] ? resolvePath(String(args["target-dir"])) : ROOT;
  const id = normalizeId(args.id || args["design-system"] || args.design || args["source-id"] || "imported");

  if (args["opendesign-root"]) {
    const root = resolvePath(String(args["opendesign-root"]));
    const sourceId = normalizeId(args["source-id"] || args.id || id);
    const doc = findDesignDoc(root, sourceId);
    if (!doc) {
      throw new Error(`No DESIGN.md found for source-id "${sourceId}" under ${root}`);
    }
    return {
      id,
      targetDir,
      sourcePath: dirname(doc),
      designDocPath: doc,
      sourceKind: "opendesign",
      sourceId,
    };
  }

  if (!args.source) {
    throw new Error("Missing --source <DESIGN.md|design-system-dir> or --opendesign-root <dir> --source-id <id>");
  }

  const sourcePath = resolvePath(String(args.source));
  const doc = resolveDesignDoc(sourcePath, id);
  return {
    id,
    targetDir,
    sourcePath: statSync(sourcePath).isFile() ? dirname(sourcePath) : sourcePath,
    designDocPath: doc,
    sourceKind: "custom",
    sourceId: basename(statSync(sourcePath).isFile() ? dirname(sourcePath) : sourcePath),
  };
}

function resolveDesignDoc(sourcePath, id) {
  if (!existsSync(sourcePath)) throw new Error(`Design source not found: ${sourcePath}`);
  const stat = statSync(sourcePath);
  if (stat.isFile()) {
    if (!/\.md$/i.test(sourcePath)) throw new Error(`Design source file must be markdown: ${sourcePath}`);
    return sourcePath;
  }
  const direct = [
    join(sourcePath, "DESIGN.md"),
    join(sourcePath, "design.md"),
    join(sourcePath, "docs", "DESIGN.md"),
    join(sourcePath, "design", "DESIGN.md"),
  ];
  for (const candidate of direct) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  const found = findDesignDoc(sourcePath, id);
  if (found) return found;
  throw new Error(`No DESIGN.md found under ${sourcePath}`);
}

function findDesignDoc(root, preferredId) {
  const preferred = normalizeId(preferredId);
  const docs = [];
  walk(root, (file) => {
    if (basename(file).toLowerCase() === "design.md") docs.push(file);
  });
  if (!docs.length) return null;
  const scored = docs
    .map((file) => {
      const rel = relative(root, file).split(/[\\/]/).map(slugify);
      let score = 0;
      if (slugify(basename(dirname(file))) === preferred) score += 100;
      if (rel.includes(preferred)) score += 50;
      if (relative(root, file).split(/[\\/]/).length <= 3) score += 10;
      return { file, score };
    })
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  return scored[0]?.file ?? null;
}

function walk(dir, onFile) {
  const ignored = new Set([".git", "node_modules", ".next", "dist", "build", "release", "target", ".turbo"]);
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (ignored.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, onFile);
    else if (entry.isFile()) onFile(full);
  }
}

function extractName(raw, id) {
  const h1 = raw.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return sanitizeText(h1?.replace(/^design system\s*[:\-]\s*/i, "")) || titleFromId(id);
}

function extractDescription(raw) {
  const lines = raw.split(/\r?\n/).map((line) => line.trim());
  for (const line of lines) {
    if (!line || line.startsWith("#") || line.startsWith("|") || line.startsWith("```")) continue;
    return sanitizeText(line.replace(/^[-*]\s+/, "")).slice(0, 180);
  }
  return "Imported design system.";
}

function titleFromId(id) {
  return String(id)
    .split("-")
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function sanitizeText(value) {
  return String(value || "")
    .replace(/[`*_#>\[\]()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractColors(raw) {
  const lines = raw.split(/\r?\n/);
  const colors = [];
  const seen = new Set();
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const matches = line.matchAll(/#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g);
    for (const match of matches) {
      const hex = normalizeHex(match[0]);
      if (!hex) continue;
      const label = sanitizeText(line.slice(0, match.index).replace(/[:|-]+$/g, ""));
      const key = `${hex}:${label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      colors.push({
        hex,
        label,
        line: sanitizeText(line),
        index: colors.length,
        luminance: luminance(hex),
        saturation: saturation(hex),
      });
    }
  }
  return colors;
}

function normalizeHex(value) {
  const raw = String(value || "").replace("#", "").trim();
  if (![3, 4, 6, 8].includes(raw.length) || /[^0-9a-f]/i.test(raw)) return null;
  const full = raw.length <= 4
    ? raw.slice(0, 3).split("").map((c) => c + c).join("")
    : raw.slice(0, 6);
  return `#${full.toLowerCase()}`;
}

function hexToRgb(hex) {
  const normalized = normalizeHex(hex);
  if (!normalized) return [0, 0, 0];
  return [
    parseInt(normalized.slice(1, 3), 16),
    parseInt(normalized.slice(3, 5), 16),
    parseInt(normalized.slice(5, 7), 16),
  ];
}

function toHex([r, g, b]) {
  return `#${[r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("")}`;
}

function mixHex(a, b, bWeight) {
  const ar = hexToRgb(a);
  const br = hexToRgb(b);
  return toHex(ar.map((channel, i) => channel * (1 - bWeight) + br[i] * bWeight));
}

function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const l1 = luminance(a);
  const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function saturation(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const light = (max + min) / 2;
  return light > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min);
}

function bestForeground(bg) {
  return contrast(bg, "#111111") >= contrast(bg, "#ffffff") ? "#111111" : "#ffffff";
}

function pickColor(colors, patterns, options = {}) {
  const exclude = new Set((options.exclude ?? []).map((hex) => normalizeHex(hex)).filter(Boolean));
  const candidates = colors.filter((color) => {
    if (exclude.has(color.hex)) return false;
    const haystack = `${color.label} ${color.line}`.toLowerCase();
    return patterns.some((pattern) => pattern.test(haystack));
  });
  const minContrastBg = options.minContrastBg;
  const filtered = minContrastBg
    ? candidates.filter((color) => contrast(color.hex, minContrastBg) >= (options.minContrast ?? 2.5))
    : candidates;
  return (filtered[0] ?? candidates[0])?.hex ?? null;
}

function firstLightNeutral(colors) {
  return colors
    .filter((color) => color.luminance > 0.78 && color.saturation < 0.22)
    .sort((a, b) => b.luminance - a.luminance)[0]?.hex ?? null;
}

function firstDarkNeutral(colors) {
  return colors
    .filter((color) => color.luminance < 0.18 && color.saturation < 0.25)
    .sort((a, b) => a.luminance - b.luminance)[0]?.hex ?? null;
}

function firstNonNeutral(colors, exclude = []) {
  const excluded = new Set(exclude.map((hex) => normalizeHex(hex)).filter(Boolean));
  return colors
    .filter((color) => !excluded.has(color.hex) && color.saturation > 0.22 && color.luminance > 0.08 && color.luminance < 0.82)
    .sort((a, b) => b.saturation - a.saturation || a.index - b.index)[0]?.hex ?? null;
}

function extractFonts(raw) {
  const quoted = Array.from(raw.matchAll(/["'`]([^"'`\n]{3,60})["'`]/g)).map((match) => match[1]);
  const lines = raw.split(/\r?\n/);
  const fontFromLine = (patterns, defaultValue) => {
    for (const line of lines) {
      const lower = line.toLowerCase();
      if (!patterns.some((pattern) => pattern.test(lower))) continue;
      const quotedValue = quoted.find((value) => lower.includes(value.toLowerCase()));
      if (quotedValue && /^[\w\s.,-]+$/.test(quotedValue)) return `"${quotedValue}"`;
      const family = line.match(/font-family\s*:\s*([^;\n]+)/i)?.[1]?.trim();
      if (family && !/[{}<>;]/.test(family)) return family;
    }
    return defaultValue;
  };
  return {
    serif: fontFromLine([/serif/, /display/, /heading/, /title/], "Georgia, 'Times New Roman', serif"),
    sans: fontFromLine([/sans/, /body/, /inter/, /system/], "-apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"),
    mono: fontFromLine([/mono/, /code/, /terminal/], "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace"),
  };
}

function deriveTokens(raw, id, name) {
  const colors = extractColors(raw);
  const background =
    pickColor(colors, [/background/, /canvas/, /page/, /paper/, /app bg/]) ||
    firstLightNeutral(colors) ||
    "#ffffff";
  const foreground =
    pickColor(colors, [/foreground/, /\btext\b/, /\bink\b/, /body/, /heading/], {
      minContrastBg: background,
      minContrast: 4.5,
      exclude: [background],
    }) ||
    firstDarkNeutral(colors) ||
    bestForeground(background);
  const surface =
    pickColor(colors, [/surface/, /card/, /panel/, /elevated/, /sheet/], { exclude: [background, foreground] }) ||
    (luminance(background) > 0.5 ? mixHex(background, "#ffffff", 0.72) : mixHex(background, "#ffffff", 0.08));
  const accent =
    pickColor(colors, [/accent/, /brand/, /primary/, /action/, /cta/, /link/], { exclude: [background, foreground, surface] }) ||
    firstNonNeutral(colors, [background, foreground, surface]) ||
    "#2563eb";
  const muted =
    pickColor(colors, [/muted/, /secondary text/, /caption/, /metadata/, /placeholder/], {
      minContrastBg: background,
      minContrast: 3,
      exclude: [background, foreground, surface, accent],
    }) ||
    mixHex(foreground, background, 0.42);
  const border =
    pickColor(colors, [/border/, /divider/, /hairline/, /stroke/, /rule/], { exclude: [background, foreground, surface, accent] }) ||
    mixHex(foreground, background, 0.84);

  const darkBg =
    pickColor(colors, [/dark.*background/, /dark.*canvas/, /night.*background/]) ||
    mixHex(foreground, "#000000", 0.82);
  const darkSurface =
    pickColor(colors, [/dark.*surface/, /dark.*card/, /dark.*panel/], { exclude: [darkBg] }) ||
    mixHex(darkBg, "#ffffff", 0.07);
  const darkFg =
    pickColor(colors, [/dark.*foreground/, /dark.*text/, /inverse.*text/], {
      minContrastBg: darkBg,
      minContrast: 4.5,
      exclude: [darkBg, darkSurface],
    }) ||
    mixHex(background, "#ffffff", 0.78);

  const fonts = extractFonts(raw);
  const onAccent = bestForeground(accent);
  const initial = (name || id || "B").trim().slice(0, 1).toUpperCase() || "B";

  return {
    name,
    description: extractDescription(raw),
    light: {
      bg: background,
      surface,
      subtle: mixHex(background, foreground, 0.04),
      bgMuted: mixHex(background, foreground, 0.08),
      border,
      borderStrong: mixHex(border, foreground, 0.18),
      borderSoft: mixHex(border, background, 0.55),
      fg: foreground,
      fgStrong: mixHex(foreground, "#000000", luminance(foreground) > 0.4 ? 0.18 : 0.04),
      muted,
      soft: mixHex(muted, background, 0.34),
      faint: mixHex(muted, background, 0.56),
      accent,
      accentStrong: mixHex(accent, "#000000", 0.13),
      accentSoft: mixHex(accent, background, 0.72),
      accentTint: mixHex(accent, background, 0.88),
      accentHover: mixHex(accent, "#000000", 0.13),
      onAccent,
      status: STATUS_DEFAULTS,
      shadowColor: foreground,
    },
    dark: {
      bg: darkBg,
      surface: darkSurface,
      subtle: mixHex(darkSurface, "#ffffff", 0.04),
      bgMuted: mixHex(darkSurface, "#ffffff", 0.09),
      border: mixHex(darkSurface, "#ffffff", 0.12),
      borderStrong: mixHex(darkSurface, "#ffffff", 0.24),
      borderSoft: mixHex(darkSurface, "#ffffff", 0.06),
      fg: darkFg,
      fgStrong: mixHex(darkFg, "#ffffff", 0.12),
      muted: mixHex(darkFg, darkBg, 0.38),
      soft: mixHex(darkFg, darkBg, 0.58),
      faint: mixHex(darkFg, darkBg, 0.72),
      accent: mixHex(accent, "#ffffff", 0.18),
      accentStrong: mixHex(accent, "#ffffff", 0.28),
      accentSoft: mixHex(accent, darkBg, 0.64),
      accentTint: mixHex(accent, darkBg, 0.82),
      accentHover: mixHex(accent, "#ffffff", 0.28),
      onAccent: bestForeground(mixHex(accent, "#ffffff", 0.18)),
      status: DARK_STATUS_DEFAULTS,
    },
    fonts,
    logoText: initial,
  };
}

function shadowTokens(color, dark = false) {
  const rgb = hexToRgb(color).join(" ");
  if (dark) {
    return {
      xs: "0 1px 0 rgb(0 0 0 / 0.20)",
      sm: "0 1px 2px rgb(0 0 0 / 0.30), 0 1px 3px rgb(0 0 0 / 0.20)",
      md: "0 6px 24px rgb(0 0 0 / 0.40), 0 2px 6px rgb(0 0 0 / 0.25)",
      lg: "0 24px 60px rgb(0 0 0 / 0.60), 0 8px 16px rgb(0 0 0 / 0.30)",
    };
  }
  return {
    xs: `0 1px 0 rgb(${rgb} / 0.04)`,
    sm: `0 1px 2px rgb(${rgb} / 0.05), 0 1px 3px rgb(${rgb} / 0.04)`,
    md: `0 6px 24px rgb(${rgb} / 0.07), 0 2px 6px rgb(${rgb} / 0.04)`,
    lg: `0 24px 60px rgb(${rgb} / 0.16), 0 8px 16px rgb(${rgb} / 0.07)`,
  };
}

function cssBlock(theme, fonts, dark = false) {
  const shadows = shadowTokens(theme.shadowColor || theme.fg, dark);
  const status = theme.status;
  return `  --bg: ${theme.bg};
  --surface: ${theme.surface};
  --subtle: ${theme.subtle};
  --bg-subtle: ${theme.subtle};
  --bg-muted: ${theme.bgMuted};
  --muted-surface: ${theme.bgMuted};
  --border: ${theme.border};
  --border-strong: ${theme.borderStrong};
  --border-soft: ${theme.borderSoft};
  --bg-app: ${theme.bg};
  --bg-panel: ${theme.surface};
  --bg-elevated: ${theme.surface};

  --fg: ${theme.fg};
  --fg-strong: ${theme.fgStrong};
  --muted: ${theme.muted};
  --soft: ${theme.soft};
  --faint: ${theme.faint};
  --text: ${theme.fg};
  --text-strong: ${theme.fgStrong};
  --text-muted: ${theme.muted};
  --text-soft: ${theme.soft};
  --text-faint: ${theme.faint};

  --accent: ${theme.accent};
  --accent-strong: ${theme.accentStrong};
  --accent-soft: ${theme.accentSoft};
  --accent-tint: ${theme.accentTint};
  --accent-hover: ${theme.accentHover};
  --on-accent: ${theme.onAccent};

  --green: ${status.green.fg};
  --green-fg: ${status.green.fg};
  --green-bg: ${status.green.bg};
  --green-border: ${status.green.border};
  --blue: ${status.blue.fg};
  --blue-fg: ${status.blue.fg};
  --blue-bg: ${status.blue.bg};
  --blue-border: ${status.blue.border};
  --purple: ${status.purple.fg};
  --purple-fg: ${status.purple.fg};
  --purple-bg: ${status.purple.bg};
  --purple-border: ${status.purple.border};
  --red: ${status.red.fg};
  --red-fg: ${status.red.fg};
  --red-bg: ${status.red.bg};
  --red-border: ${status.red.border};
  --amber: ${status.amber.fg};
  --amber-fg: ${status.amber.fg};
  --amber-bg: ${status.amber.bg};
  --amber-border: ${status.amber.border};

  --shadow-xs: ${shadows.xs};
  --shadow-sm: ${shadows.sm};
  --shadow-md: ${shadows.md};
  --shadow-lg: ${shadows.lg};

  --radius-sm: 6px;
  --radius: 10px;
  --radius-md: 10px;
  --radius-lg: 14px;
  --radius-pill: 999px;

  --serif: ${fonts.serif};
  --sans: ${fonts.sans};
  --mono: ${fonts.mono};

  --ease: cubic-bezier(.2,0,.2,1);
  --t-fast: 120ms;
  --modal-padding: 22px;`;
}

function buildTokensCss(id, tokens) {
  return `/* yaka-bridge design system: ${tokens.name} */\n:root {\n  color-scheme: light;\n${cssBlock(tokens.light, tokens.fonts)}\n}\n\n[data-theme="dark"] {\n  color-scheme: dark;\n${cssBlock(tokens.dark, tokens.fonts, true)}\n}\n\n@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]):not([data-theme="dark"]) {\n    color-scheme: dark;\n${cssBlock(tokens.dark, tokens.fonts, true)}\n  }\n}\n`;
}

function buildBridgeTokens(tokens) {
  const light = tokens.light;
  return {
    bg: light.bg,
    panel: light.surface,
    surface: light.surface,
    paper: light.surface,
    border: light.border,
    borderStrong: light.borderStrong,
    borderSoft: light.borderSoft,
    line: light.border,
    text: light.fg,
    fg: light.fg,
    fgStrong: light.fgStrong,
    muted: light.muted,
    soft: light.soft,
    accent: light.accent,
    accentStrong: light.accentStrong,
    accentTint: light.accentTint,
    accentSoft: light.accentSoft,
    onAccent: light.onAccent,
    green: light.status.green.fg,
    greenBg: light.status.green.bg,
    greenBorder: light.status.green.border,
    blue: light.status.blue.fg,
    blueBg: light.status.blue.bg,
    blueBorder: light.status.blue.border,
    purple: light.status.purple.fg,
    purpleBg: light.status.purple.bg,
    purpleBorder: light.status.purple.border,
    amber: light.status.amber.fg,
    amberBg: light.status.amber.bg,
    amberBorder: light.status.amber.border,
    red: light.status.red.fg,
    redBg: light.status.red.bg,
    redBorder: light.status.red.border,
    secondary: light.bgMuted,
    logBg: light.subtle,
    shadow: shadowTokens(light.shadowColor).md,
    shadowHover: shadowTokens(light.shadowColor).lg,
    radiusSm: "6px",
    radius: "10px",
    radiusLg: "14px",
    radiusPill: "999px",
    ease: "cubic-bezier(.2,0,.2,1)",
    tFast: "120ms",
    sans: tokens.fonts.sans,
    mono: tokens.fonts.mono,
    logoText: tokens.logoText,
    iconBg: light.accentTint,
    iconFg: light.fg,
    iconAccent: light.accent,
    iconBorder: light.border,
  };
}

function copyOptionalMark(sourceDir, fileName, target) {
  const candidates = [
    join(sourceDir, "assets", fileName),
    join(sourceDir, fileName),
    join(sourceDir, "public", fileName),
    join(sourceDir, "assets", "logo.svg"),
    join(sourceDir, "logo.svg"),
  ];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        copyFileSync(candidate, target);
        return true;
      }
    } catch {
      // Ignore unreadable optional assets.
    }
  }
  return false;
}

function writeGeneratedMark(target, label, tokens) {
  const t = tokens.light;
  const initial = escapeXml(tokens.logoText || label.slice(0, 1).toUpperCase() || "B");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img" aria-label="${escapeXml(label)}">
  <rect width="1024" height="1024" rx="224" fill="${t.accentTint}"/>
  <path d="M274 512h476" fill="none" stroke="${t.fg}" stroke-width="58" stroke-linecap="round"/>
  <rect x="214" y="356" width="218" height="218" rx="64" fill="${t.fg}"/>
  <rect x="592" y="450" width="218" height="218" rx="64" fill="${t.accent}"/>
  <circle cx="512" cy="512" r="70" fill="${t.surface}" stroke="${t.fg}" stroke-width="44"/>
  <text x="512" y="812" text-anchor="middle" font-family="Arial, sans-serif" font-size="104" font-weight="800" fill="${t.fg}">${initial}</text>
</svg>
`;
  writeFileSync(target, svg, "utf8");
}

function escapeXml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
  })[c]);
}

function importDesignSystem(args) {
  const source = sourceFromArgs(args);
  const raw = readFileSync(source.designDocPath, "utf8");
  const name = extractName(raw, source.id);
  const tokens = deriveTokens(raw, source.id, name);
  const targetSystemDir = resolve(source.targetDir, "design-systems", source.id);
  const assetsDir = join(targetSystemDir, "assets");
  ensureDir(assetsDir);

  writeFileSync(join(targetSystemDir, "DESIGN.md"), raw, "utf8");
  writeFileSync(join(targetSystemDir, "tokens.css"), buildTokensCss(source.id, tokens), "utf8");

  const appMark = join(assetsDir, "app-mark.svg");
  const bridgeMark = join(assetsDir, "bridge-mark.svg");
  if (!copyOptionalMark(source.sourcePath, "app-mark.svg", appMark)) {
    writeGeneratedMark(appMark, `${name} app mark`, tokens);
  }
  if (!copyOptionalMark(source.sourcePath, "bridge-mark.svg", bridgeMark)) {
    writeGeneratedMark(bridgeMark, `${name} Bridge mark`, tokens);
  }

  const manifest = {
    contractVersion: "1.0.0",
    id: source.id,
    name,
    version: "1.0.0",
    description: tokens.description,
    sourceKind: source.sourceKind,
    source: {
      id: source.sourceId,
      path: relative(targetSystemDir, source.designDocPath),
      importedAt: new Date().toISOString(),
    },
    targets: ["app", "modules", "bridge"],
    files: {
      tokens: "tokens.css",
      designDoc: "DESIGN.md",
      appMark: "assets/app-mark.svg",
      bridgeMark: "assets/bridge-mark.svg",
    },
    tailwind: {
      usesCssVariables: true,
      tokenPrefix: "--",
    },
    bridge: {
      tokens: buildBridgeTokens(tokens),
    },
    requiredCssVariables: REQUIRED_CSS_VARIABLES,
  };
  writeJson(join(targetSystemDir, "design-system.config.json"), manifest);

  return { ...source, targetSystemDir, name };
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help || args.h) {
    console.log(`Usage:
  npm run design:import -- --id <id> --source <DESIGN.md|dir> [--apply]
  npm run design:import -- --id <id> --opendesign-root <repo> --source-id <opendesign-id> [--apply]

Options:
  --target-dir <dir>   Repo to write into. Defaults to current yaka-bridge repo.
  --apply              Run scripts/apply-design-system.mjs after import.
`);
    return;
  }

  const result = importDesignSystem(args);
  console.log(`Imported design system "${result.id}" from ${result.designDocPath}`);
  console.log(`  target ${relative(process.cwd(), result.targetSystemDir)}`);

  if (args.apply) {
    const targetApplyScript = resolve(result.targetDir, "scripts", "apply-design-system.mjs");
    const applyScript = existsSync(targetApplyScript)
      ? targetApplyScript
      : resolve(ROOT, "scripts", "apply-design-system.mjs");
    const apply = spawnSync(process.execPath, [
      applyScript,
      "--design-system",
      result.id,
      "--source",
      result.targetSystemDir,
      "--target-dir",
      result.targetDir,
    ], { stdio: "inherit" });
    if (apply.status !== 0) {
      process.exit(apply.status || 1);
    }
  }
}

try {
  main();
} catch (err) {
  console.error(`[design:import] ${err?.message || err}`);
  process.exit(1);
}
