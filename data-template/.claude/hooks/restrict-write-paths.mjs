#!/usr/bin/env node
/**
 * Hook PreToolUse : bloque toute écriture (Write, Edit, MultiEdit, NotebookEdit)
 * en dehors de la whitelist de dossiers autorisés.
 *
 * ⚠️ RUNTIME : ce hook est un construct **Claude Code**. Il ne s'exécute PAS
 * sous le runtime Codex (`codex exec`), qui est le runtime par défaut du
 * template. Sous Codex, le confinement effectif est assuré par `--sandbox` +
 * la validation `server/path-guard.ts` côté daemon. Ce fichier ne sert donc de
 * protection QUE si l'app est branchée sur le runtime Claude Code.
 *
 * Sécurité défense-en-profondeur (runtime Claude Code uniquement) :
 *  - `--add-dir` côté CLI n'est PAS une sandbox stricte (Anthropic doc)
 *  - `bypassPermissions` mode contourne les prompts interactifs
 *  - Donc on AJOUTE ce hook qui exit code 2 = blocage dur de l'opération
 *
 * Format Claude Code hooks PreToolUse :
 *  - stdin : JSON { tool_name, tool_input: { file_path, ... } }
 *  - exit 0 = autoriser
 *  - exit 2 = bloquer (stderr est renvoyé à Claude pour qu'il corrige)
 *
 * La variable d'environnement utilisée pour résoudre le dataDir est injectée
 * au scaffolding par `scripts/init-from-template.mjs` (placeholder
 * `{{DATA_DIR_ENV_VAR}}`, ex: DEMO_ERP_DATA_DIR). Fallback : process.cwd().
 */
import { resolve as resolvePath, isAbsolute } from "node:path";
import { realpathSync, existsSync, readFileSync } from "node:fs";

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const DATA_DIR_ENV_VAR = "{{DATA_DIR_ENV_VAR}}";

function getDataDir() {
  return process.env[DATA_DIR_ENV_VAR] || process.cwd();
}

function loadConfig() {
  const dataDir = getDataDir();
  const cfgPath = resolvePath(dataDir, ".claude", "app-config.json");
  try {
    if (existsSync(cfgPath)) {
      return JSON.parse(readFileSync(cfgPath, "utf8"));
    }
  } catch {
    /* ignore */
  }
  // Fallback : config app-config.json à côté de l'exécutable
  try {
    const defaultConfigPath = resolvePath(process.cwd(), ".claude", "app-config.json");
    if (existsSync(defaultConfigPath)) return JSON.parse(readFileSync(defaultConfigPath, "utf8"));
  } catch {
    /* ignore */
  }
  return {};
}

function buildAllowedDirs(cfg) {
  const dataDir = getDataDir();
  const dirs = new Set();
  dirs.add(resolvePath(dataDir));
  if (cfg.auditLogDir) dirs.add(resolvePath(cfg.auditLogDir));
  if (cfg.outputDir) dirs.add(resolvePath(cfg.outputDir));
  if (cfg.inputDir) dirs.add(resolvePath(cfg.inputDir));
  return Array.from(dirs);
}

/** Vérifie qu'un path résolu (avec realpath si possible) commence par
 *  un des dossiers autorisés. Bloque les escapes via ../ et symlinks. */
function isPathAllowed(filePath, allowedDirs) {
  if (!filePath || !isAbsolute(filePath)) return false;
  let resolved = resolvePath(filePath);
  try {
    if (existsSync(resolved)) resolved = realpathSync(resolved);
  } catch {
    /* path n'existe pas encore : on garde le resolve nominal */
  }
  return allowedDirs.some((dir) => {
    const dirResolved = resolvePath(dir);
    return (
      resolved === dirResolved ||
      resolved.startsWith(dirResolved + "/") ||
      resolved.startsWith(dirResolved + "\\")
    );
  });
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    process.exit(0);
  }
  const toolName = event.tool_name || event.tool || "";
  if (!WRITE_TOOLS.has(toolName)) {
    process.exit(0);
  }
  const filePath =
    event.tool_input?.file_path ||
    event.tool_input?.path ||
    event.input?.file_path ||
    "";
  if (!filePath) process.exit(0);
  const cfg = loadConfig();
  const allowed = buildAllowedDirs(cfg);
  if (isPathAllowed(filePath, allowed)) process.exit(0);
  process.stderr.write(
    `Écriture refusée : le chemin ${filePath} est en dehors des dossiers ` +
      `autorisés (${allowed.join(", ")}).\n` +
      `Choisissez un chemin SOUS l'un de ces dossiers et réessayez.`
  );
  process.exit(2);
}

main().catch((err) => {
  process.stderr.write(`Hook restrict-write-paths erreur : ${err?.message || err}`);
  process.exit(2);
});
