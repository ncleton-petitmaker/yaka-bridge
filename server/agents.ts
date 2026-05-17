/**
 * Détection et configuration de l'agent Claude Code en local.
 * Inspiré d'opendesign apps/daemon/src/agents.ts mais simplifié (mono-agent).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const CANDIDATES_BIN = ["claude", "openclaude"] as const;

let cachedClaudeBin: string | null = null;

/**
 * Construit un PATH enrichi avec les emplacements typiques de Claude Code,
 * indispensable car le daemon est spawné par Electron avant que l'utilisateur
 * installe Claude. Son `process.env.PATH` ne contient donc pas `~/.local/bin`.
 */
function buildEnrichedPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  const extras = [
    "/usr/local/bin",
    "/opt/homebrew/bin",
    home ? path.join(home, ".local", "bin") : null,
    home ? path.join(home, ".claude", "bin") : null,
  ].filter(Boolean) as string[];
  return [process.env.PATH, ...extras].filter(Boolean).join(path.delimiter);
}

function which(bin: string): string | null {
  const enrichedPath = buildEnrichedPath();
  const result = spawnSync(process.platform === "win32" ? "where" : "which", [bin], {
    encoding: "utf8",
    shell: false,
    env: { ...process.env, PATH: enrichedPath, Path: enrichedPath },
  });
  if (result.status !== 0) return null;
  const first = (result.stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  if (!first) return null;
  return existsSync(first) ? first : null;
}

/**
 * Fallback dur : teste les chemins canoniques où l'installer Claude pose
 * le binaire. Utile si `which` échoue parce que le PATH du process daemon
 * n'a pas été rafraîchi après l'install.
 */
function probeKnownPaths(): string | null {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return null;
  const isWin = process.platform === "win32";
  const candidates = isWin
    ? [
        path.join(home, ".local", "bin", "claude.exe"),
        path.join(home, ".local", "bin", "claude.cmd"),
        path.join(home, ".claude", "bin", "claude.exe"),
      ]
    : [
        path.join(home, ".local", "bin", "claude"),
        path.join(home, ".claude", "bin", "claude"),
        "/usr/local/bin/claude",
        "/opt/homebrew/bin/claude",
      ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

export function findClaudeBin(): string | null {
  if (cachedClaudeBin && existsSync(cachedClaudeBin)) return cachedClaudeBin;
  for (const candidate of CANDIDATES_BIN) {
    const found = which(candidate);
    if (found) {
      cachedClaudeBin = found;
      return found;
    }
  }
  const probed = probeKnownPaths();
  if (probed) {
    cachedClaudeBin = probed;
    return probed;
  }
  return null;
}

/**
 * Force la prochaine résolution à refaire le scan disque (sans cache).
 * À appeler après une install de Claude Code détectée par le wizard.
 */
export function resetClaudeBinCache(): void {
  cachedClaudeBin = null;
}

export interface BuildArgsOptions {
  /** Liste de dossiers que Claude est autorisé à lire/écrire au-delà du cwd */
  addDirs?: string[];
  /** Outils whitelistés. Par défaut whitelist sécuritaire (Read/Write/Glob/Skill). */
  allowedTools?: string[];
  /** Modèle, par défaut "default" (héritage du compte) */
  model?: string;
  /** Mode de permission : "default" (interactif), "acceptEdits", "bypassPermissions" */
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions";
  /** Chemin du fichier de config MCP à passer via --mcp-config. Si fourni,
   *  expose les servers MCP déclarés dedans à Claude Code. */
  mcpConfig?: string;
  /** Nombre max de tours Claude (circuit breaker). Défaut : 30. */
  maxTurns?: number;
}

/**
 * Whitelist d'outils par défaut, conservative. Le caller peut override via
 * `opts.allowedTools`. On exclut Task (sub-agents → coût démultiplié) et Bash
 * (sécurité). Grep/Glob sont rarement utiles mais peu coûteux.
 */
const DEFAULT_ALLOWED_TOOLS = ["Read", "Write", "Glob", "Skill"];

/**
 * Nom de la variable d'environnement utilisée pour résoudre le `dataDir` :
 * c'est elle qui contient le path racine d'écriture (skills, audit-log, etc.).
 * Le template injecte le nom à scaffolding via le placeholder
 * `{{DATA_DIR_ENV_VAR}}` (ex : "CALIBRE_DATA_DIR"). À l'exécution, fallback
 * sur `./data` relatif au cwd si la variable n'est pas définie.
 */
const DATA_DIR_ENV_VAR = "{{DATA_DIR_ENV_VAR}}";

export function buildClaudeArgs(opts: BuildArgsOptions = {}): string[] {
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    // --effort low : Sonnet 4.6 défaut = high, donc thinking adaptatif très long
    // (5-10 min de thinking_delta par tour, runs imprévisibles). low garantit
    // une latence prévisible. Kill-switch complémentaire via env
    // CLAUDE_CODE_DISABLE_THINKING=1 dans le spawn (cf. server/runs.ts).
    "--effort", "low",
    // Circuit breaker : si Claude dépasse 30 tours, c'est qu'il boucle sur
    // une erreur → on stoppe pour limiter le gaspillage. À ajuster selon le
    // domaine (extraction structurée typique : 5-15 tours).
    "--max-turns", opts.maxTurns ? String(opts.maxTurns) : "30",
  ];

  if (opts.model && opts.model !== "default") {
    args.push("--model", opts.model);
  }

  const tools = opts.allowedTools ?? DEFAULT_ALLOWED_TOOLS;
  if (tools.length > 0) {
    args.push("--allowedTools", tools.join(","));
  }

  if (opts.addDirs && opts.addDirs.length > 0) {
    args.push("--add-dir", ...opts.addDirs);
  }

  // bypassPermissions par défaut : sans ça, certaines écritures (chemins
  // réseau, volumes montés, etc.) déclenchent une demande d'approbation
  // interactive que Claude Code ne peut pas afficher dans le contexte d'un
  // run automatisé. La défense en profondeur repose sur :
  //   - `--add-dir` (whitelist Claude CLI)
  //   - `permissions.deny` dans `.claude/settings.json`
  //   - hook PreToolUse `restrict-write-paths.mjs`
  args.push("--permission-mode", opts.permissionMode ?? "bypassPermissions");

  // MCP : activé automatiquement si une config a été générée à `<dataDir>/.claude/mcp.json`.
  // opts.mcpConfig peut override le path. La détection du dataDir suit l'env
  // var injectée par scaffolding (DATA_DIR_ENV_VAR) avec fallback `./data`.
  const fsSync = require("node:fs") as typeof import("node:fs");
  const pathSync = require("node:path") as typeof import("node:path");
  const dataDir =
    process.env[DATA_DIR_ENV_VAR] ?? pathSync.resolve(process.cwd(), "data");
  const defaultMcpConfig = pathSync.resolve(dataDir, ".claude", "mcp.json");
  const mcpConfig = opts.mcpConfig ?? (fsSync.existsSync(defaultMcpConfig) ? defaultMcpConfig : null);
  if (mcpConfig) {
    args.push("--mcp-config", mcpConfig);
  }

  return args;
}
