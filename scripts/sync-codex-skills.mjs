#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_DIR = resolve(ROOT, "skills-template", "_global");
const TARGET_DIR = resolve(ROOT, ".codex", "skills");
const CHECK_ONLY = process.argv.includes("--check");

const generated = [];
const failures = [];

if (!existsSync(SOURCE_DIR)) {
  throw new Error(`Missing source skills directory: ${SOURCE_DIR}`);
}

for (const entry of readdirSync(SOURCE_DIR).sort()) {
  if (!entry.endsWith(".skill.md")) continue;
  const sourcePath = join(SOURCE_DIR, entry);
  const raw = readFileSync(sourcePath, "utf8");
  const name = readFrontmatterName(raw, entry);
  const targetPath = join(TARGET_DIR, name, "SKILL.md");
  generated.push(targetPath);

  if (CHECK_ONLY) {
    if (!existsSync(targetPath)) {
      failures.push(`missing ${relativeTarget(targetPath)}`);
      continue;
    }
    const existing = readFileSync(targetPath, "utf8");
    if (existing !== raw) failures.push(`stale ${relativeTarget(targetPath)}`);
    continue;
  }

  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, raw, "utf8");
  console.log(`[skills] synced ${entry} -> ${relativeTarget(targetPath)}`);
}

if (CHECK_ONLY) {
  if (failures.length) {
    console.error("Codex repo-local skills are not synchronized:");
    for (const failure of failures) console.error(`- ${failure}`);
    console.error("Run `npm run skills:sync`.");
    process.exit(1);
  }
  console.log(`Codex repo-local skills synchronized (${generated.length}).`);
}

function readFrontmatterName(raw, entry) {
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) throw new Error(`${entry} is missing YAML frontmatter`);
  const nameMatch = match[1].match(/^name:\s*([A-Za-z0-9_-]+)\s*$/m);
  if (!nameMatch) throw new Error(`${entry} is missing frontmatter name`);
  return nameMatch[1];
}

function relativeTarget(path) {
  return path.slice(ROOT.length + 1);
}
