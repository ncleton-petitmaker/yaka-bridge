#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

const CLIENT_TERMS = [
  /rossini/i,
  /rossinienergy/i,
  /prix-achats/i,
  /PrixAchats/,
  /petitmaker/i,
  /Belgique/i,
  /énergie/i,
];

const CLIENT_TERM_ALLOWLINES = [
  /ncleton-petitmaker/i,
];

const SECURITY_TERMS = [
  /BRIDGE_CONTROL_PLANE_TOKEN/,
  /serviceRoleKey\s*\?\?\s*anonKey/,
  /auth=off/,
  /auth locale désactivée/i,
  /APP_DAEMON_TOKEN absent/i,
];

const RUNTIME_PROTO_TERMS = [
  /\bfallback\b/i,
  /\bstub\b/i,
  /\bTODO\b/,
  /\bFIXME\b/,
];

const SECRET_TERMS = [
  /sk-[A-Za-z0-9_-]{16,}/,
  /sb_secret_[A-Za-z0-9_-]+/,
  /BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY/,
];

const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".cjs",
  ".mjs",
  ".json",
  ".md",
  ".sql",
  ".yml",
  ".yaml",
  ".css",
]);

const SKIP_DIRS = new Set([
  ".git",
  ".next",
  "node_modules",
  "dist",
  "release",
  "release-bridge",
  "data",
  "Projets",
  "supabase/.branches",
  "supabase/selfhosted",
]);

const SKIP_FILES = new Set([
  ".factory-meta.json",
  "brief.generated.md",
  "scripts/security-grep.mjs",
]);

const RUNTIME_PREFIXES = [
  "app/",
  "bridge/",
  "components/",
  "electron/",
  "lib/",
  "modules/",
  "server/",
  "scripts/",
  "supabase/migrations/",
];

const PROTO_ALLOW_PREFIXES = [
  ".claude/",
  "data-template/.claude/",
  "docs/",
  "scripts/new-app-from-brief.mjs",
];

const failures = [];

for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file).replace(/\\/g, "/");
  if (SKIP_FILES.has(rel)) continue;
  const raw = readFileSync(file, "utf8");
  scan(rel, raw, CLIENT_TERMS, "client-name", CLIENT_TERM_ALLOWLINES);
  scan(rel, raw, SECURITY_TERMS, "security-pattern");
  scan(rel, raw, SECRET_TERMS, "secret-pattern");
  if (isRuntimePath(rel) && !PROTO_ALLOW_PREFIXES.some((prefix) => rel.startsWith(prefix))) {
    scan(rel, raw, RUNTIME_PROTO_TERMS, "runtime-prototype-marker");
  }
}

if (failures.length > 0) {
  console.error("Security grep failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Security grep passed.");

function scan(rel, raw, patterns, kind, allowLines = []) {
  const lines = raw.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (allowLines.some((allowLine) => allowLine.test(line))) return;
    for (const pattern of patterns) {
      if (pattern.test(line)) {
        failures.push(`${kind}: ${rel}:${index + 1}: ${line.trim().slice(0, 180)}`);
      }
    }
  });
}

function isRuntimePath(rel) {
  return RUNTIME_PREFIXES.some((prefix) => rel.startsWith(prefix));
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = relative(ROOT, full).replace(/\\/g, "/");
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (!SKIP_DIRS.has(entry) && !SKIP_DIRS.has(rel)) walk(full, out);
      continue;
    }
    if (!stat.isFile() || !TEXT_EXTENSIONS.has(extname(entry))) continue;
    out.push(full);
  }
  return out;
}
