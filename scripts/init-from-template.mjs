#!/usr/bin/env node
/**
 * Initialise un repo template en remplaçant les placeholders `{{KEY}}` par les
 * valeurs fournies (CLI args ou prompts interactifs).
 *
 * Usage :
 *   node scripts/init-from-template.mjs \
 *     --app-name "Demo-Calibre" \
 *     --app-id "com.example.demo-erp" \
 *     --next-port 3200 \
 *     --daemon-port 7556 \
 *     --data-dir "Demo-Calibre" \
 *     --entity-name "batch" \
 *     --entity-name-plural "batches" \
 *     --domain-brief "Calibre Marcelle…"
 *
 * Si une option est absente, prompt interactif (stdin readline).
 *
 * Comportement :
 *   1. Lit template.config.json (placeholders + computed + fileExtensions).
 *   2. Demande / récupère les valeurs.
 *   3. Calcule les valeurs `computed` (APP_NAME_KEBAB, ...).
 *   4. Walk récursif sur le repo (skip ignorePaths). Pour chaque fichier dont
 *      l'extension est dans fileExtensions, remplace `{{KEY}}` -> valeur.
 *   5. Écrit `.factory-meta.json` au root pour traçabilité.
 *
 * Ne touche PAS à : .git, node_modules, .next, dist, data, vendor, release.
 */
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  existsSync,
} from "node:fs";
import { resolve, join, dirname, extname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");

function loadTemplateConfig() {
  const p = resolve(ROOT, "template.config.json");
  if (!existsSync(p)) {
    throw new Error(`template.config.json introuvable à la racine: ${p}`);
  }
  return JSON.parse(readFileSync(p, "utf8"));
}

// ----- CLI args -----

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
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

const ARG_TO_KEY = {
  "app-name": "APP_NAME",
  "app-id": "APP_ID",
  "next-port": "NEXT_PORT",
  "daemon-port": "DAEMON_PORT",
  "data-dir": "DATA_DIR_NAME",
  "entity-name": "ENTITY_NAME",
  "entity-name-plural": "ENTITY_NAME_PLURAL",
  "domain-brief": "DOMAIN_BRIEF",
};

// ----- Prompts -----

function ask(rl, question) {
  return new Promise((res) => rl.question(question, (a) => res(a)));
}

async function gatherValues(config, cliArgs) {
  const values = {};
  // Pré-remplit depuis CLI
  for (const [argKey, placeholderKey] of Object.entries(ARG_TO_KEY)) {
    if (cliArgs[argKey] != null && cliArgs[argKey] !== true) {
      values[placeholderKey] = String(cliArgs[argKey]);
    }
  }

  // Prompt pour les manquants
  const missing = config.placeholders.filter((p) => !values[p.key] && p.required);
  if (missing.length > 0) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      for (const p of missing) {
        const ex = p.example ? ` (ex: ${p.example})` : "";
        const ans = await ask(rl, `${p.key} — ${p.description}${ex}\n> `);
        values[p.key] = ans.trim();
        if (!values[p.key]) {
          throw new Error(`${p.key} est requis`);
        }
      }
    } finally {
      rl.close();
    }
  }
  return values;
}

// ----- Transforms (computed values) -----

function toKebabCase(s) {
  return String(s)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function toUpperSnakeCase(s) {
  return toKebabCase(s).replace(/-/g, "_").toUpperCase();
}

function applyComputed(values, config) {
  for (const c of config.computed ?? []) {
    if (c.value != null) {
      values[c.key] = String(c.value);
      continue;
    }
    if (!c.from) continue;
    const src = values[c.from];
    if (src == null) {
      throw new Error(
        `computed ${c.key} a besoin de ${c.from} (introuvable)`
      );
    }
    switch (c.transform) {
      case "kebab-case":
        values[c.key] = toKebabCase(src);
        break;
      case "upper-snake-case":
        values[c.key] = toUpperSnakeCase(src);
        break;
      case "lower-case":
        values[c.key] = String(src).toLowerCase();
        break;
      default:
        if (c.transform?.startsWith("suffix:")) {
          values[c.key] = src + c.transform.slice("suffix:".length);
        } else if (c.transform?.startsWith("prefix:")) {
          values[c.key] = c.transform.slice("prefix:".length) + src;
        } else {
          values[c.key] = src;
        }
    }
  }
  return values;
}

// ----- Walk + replace -----

function shouldSkip(path, ignorePaths) {
  for (const ig of ignorePaths) {
    if (path === ig || path.startsWith(ig + "/")) return true;
  }
  return false;
}

function walk(dir, rootDir, ignorePaths, out = []) {
  const rel = relative(rootDir, dir);
  if (rel && shouldSkip(rel, ignorePaths)) return out;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    const relPath = relative(rootDir, full);
    if (shouldSkip(relPath, ignorePaths)) continue;
    if (stat.isDirectory()) {
      walk(full, rootDir, ignorePaths, out);
    } else if (stat.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function applyReplacements(content, values) {
  let out = content;
  let count = 0;
  for (const [key, val] of Object.entries(values)) {
    const token = `{{${key}}}`;
    while (out.includes(token)) {
      out = out.replace(token, val);
      count++;
    }
  }
  const demoRuntimeDefaults = {
    "Bridge ERP Demo": values.APP_NAME,
    "bridge-erp-demo": values.APP_NAME_KEBAB,
    "Template ERP modulaire cloud/bridge": values.DOMAIN_BRIEF,
  };
  for (const [current, next] of Object.entries(demoRuntimeDefaults)) {
    if (!next) continue;
    if (current === String(next)) continue;
    while (out.includes(current)) {
      out = out.replace(current, String(next));
      count++;
    }
  }
  return { content: out, count };
}

function processFile(path, values, fileExtensions) {
  const ext = extname(path).toLowerCase();
  if (!fileExtensions.includes(ext)) return null;
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  if (!raw.includes("{{")) return null;
  const { content, count } = applyReplacements(raw, values);
  if (count === 0 || content === raw) return null;
  writeFileSync(path, content, "utf8");
  return count;
}

// ----- Main -----

async function main() {
  const cliArgs = parseArgs(process.argv);
  const config = loadTemplateConfig();
  let values = await gatherValues(config, cliArgs);
  values = applyComputed(values, config);

  console.log("\nValeurs résolues :");
  for (const [k, v] of Object.entries(values)) {
    console.log(`  ${k} = ${v}`);
  }

  if (cliArgs["dry-run"]) {
    console.log("\n(dry-run, pas d'écriture)");
    return;
  }

  const files = walk(ROOT, ROOT, config.ignorePaths ?? []);
  let touched = 0;
  let replacementsTotal = 0;
  for (const f of files) {
    const n = processFile(f, values, config.fileExtensions ?? []);
    if (n != null) {
      touched++;
      replacementsTotal += n;
      const rel = relative(ROOT, f);
      console.log(`  ✓ ${rel} (${n} remplacements)`);
    }
  }

  // Écrit .factory-meta.json pour traçabilité
  const meta = {
    templateVersion: config.templateVersion,
    templateName: config.templateName,
    generatedAt: new Date().toISOString(),
    placeholderValues: values,
  };
  writeFileSync(
    resolve(ROOT, ".factory-meta.json"),
    JSON.stringify(meta, null, 2),
    "utf8"
  );

  console.log(
    `\n✓ ${touched} fichiers modifiés (${replacementsTotal} remplacements). .factory-meta.json écrit.`
  );
  console.log("\nProchaines étapes :");
  console.log("  npm install");
  console.log("  npm run typecheck");
  console.log("  npm run electron");
}

main().catch((err) => {
  console.error(`\n[init-from-template] ${err?.message || err}`);
  process.exit(1);
});
