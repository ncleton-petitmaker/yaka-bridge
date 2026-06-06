/**
 * Détection et configuration de l'agent Codex CLI (OpenAI) en local.
 * L'app est agentic-first : tous les runs (OCR factures, classification
 * d'emails, copilote) passent par `codex exec --json` authentifié en OAuth
 * ChatGPT (`codex login`), donc zéro clé API à gérer.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const CANDIDATES_BIN = ["codex"] as const;

let cachedCodexBin: string | null = null;

/**
 * Construit un PATH enrichi avec les emplacements typiques de Codex CLI,
 * indispensable car le daemon est spawné par Electron avant que l'utilisateur
 * installe Codex. Son `process.env.PATH` ne contient donc pas forcément les
 * dossiers d'install npm/homebrew.
 */
function buildEnrichedPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  const extras = [
    "/usr/local/bin",
    "/opt/homebrew/bin",
    home ? path.join(home, ".local", "bin") : null,
    home ? path.join(home, ".npm-global", "bin") : null,
    home ? path.join(home, ".codex", "bin") : null,
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
 * Fallback dur : teste les chemins canoniques où les installers (npm global,
 * homebrew) posent le binaire. Utile si `which` échoue parce que le PATH du
 * process daemon n'a pas été rafraîchi après l'install.
 */
function probeKnownPaths(): string | null {
  const home = process.env.HOME || process.env.USERPROFILE;
  const isWin = process.platform === "win32";
  const candidates = isWin
    ? [
        home ? path.join(home, "AppData", "Roaming", "npm", "codex.cmd") : null,
        home ? path.join(home, ".local", "bin", "codex.exe") : null,
      ]
    : [
        "/usr/local/bin/codex",
        "/opt/homebrew/bin/codex",
        home ? path.join(home, ".local", "bin", "codex") : null,
        home ? path.join(home, ".npm-global", "bin", "codex") : null,
      ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

export function findCodexBin(): string | null {
  if (cachedCodexBin && existsSync(cachedCodexBin)) return cachedCodexBin;
  for (const candidate of CANDIDATES_BIN) {
    const found = which(candidate);
    if (found) {
      cachedCodexBin = found;
      return found;
    }
  }
  const probed = probeKnownPaths();
  if (probed) {
    cachedCodexBin = probed;
    return probed;
  }
  return null;
}

/**
 * Force la prochaine résolution à refaire le scan disque (sans cache).
 * À appeler après une install de Codex détectée par le wizard.
 */
export function resetCodexBinCache(): void {
  cachedCodexBin = null;
}

// Compatibilité temporaire avec les parties du template qui n'ont pas encore
// été renommées : le runtime agentique est désormais Codex.
export const findClaudeBin = findCodexBin;
export const resetClaudeBinCache = resetCodexBinCache;

export interface BuildArgsOptions {
  /** Liste de dossiers que Codex est autorisé à écrire au-delà du cwd */
  addDirs?: string[];
  /**
   * Conservé pour compatibilité d'API (héritage du driver Claude) : Codex
   * n'a pas de whitelist d'outils, c'est le sandbox qui fait foi. Ignoré.
   */
  allowedTools?: string[];
  /** Modèle, par défaut "default" (héritage du compte ChatGPT) */
  model?: string;
  /**
   * Politique sandbox appliquée aux commandes shell générées par le modèle.
   * "read-only" par défaut : les mutations métier passent par les outils MCP
   * du daemon (qui ont leur propre validation + audit log), pas par le shell.
   */
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  /** Images jointes au prompt initial (vision : OCR de pages scannées). */
  images?: string[];
  /**
   * Chemin d'un fichier JSON Schema imposé à la réponse finale du run
   * (`--output-schema`). Pilier du pipeline OCR : la sortie est validée.
   */
  outputSchema?: string;
  /** Ne pas persister la session codex sur disque (runs jetables). */
  ephemeral?: boolean;
  /**
   * Expose le serveur MCP local du daemon au run (parité agentic-first :
   * l'agent a accès aux mêmes actions que l'UI). Défaut : true.
   */
  includeMcp?: boolean;
  /** Conservé pour compatibilité d'API ; sans équivalent `codex exec`. */
  maxTurns?: number;
}

/**
 * Nom de la variable d'environnement utilisée pour résoudre le `dataDir` :
 * c'est elle qui contient le path racine d'écriture (skills, audit-log, etc.).
 */
const DATA_DIR_ENV_VAR = "PRIX_ACHATS_BE_DATA_DIR";

/**
 * Construit les overrides `-c mcp_servers.*` qui exposent le serveur MCP
 * local au run Codex. Codex lit sa config MCP dans ~/.codex/config.toml :
 * on ne veut pas toucher la config globale de l'utilisateur, donc on passe
 * tout en overrides CLI (valeurs TOML : les strings JSON sont des strings
 * TOML valides, les arrays JSON des arrays TOML valides).
 */
function buildMcpOverrides(): string[] {
  const dataDir =
    process.env[DATA_DIR_ENV_VAR] ?? path.resolve(process.cwd(), "data");
  const root = process.cwd();
  const packagedMcp = path.resolve(root, "dist", "mcp.cjs");
  const devMcp = path.resolve(root, "server", "mcp.ts");
  const isPackaged = existsSync(packagedMcp);

  const command = isPackaged ? process.execPath : "npx";
  const cmdArgs = isPackaged ? [packagedMcp] : ["tsx", devMcp];
  const env: Record<string, string> = { [DATA_DIR_ENV_VAR]: dataDir };
  if (isPackaged) {
    env.ELECTRON_RUN_AS_NODE = process.env.ELECTRON_RUN_AS_NODE ?? "1";
  }

  const envToml = `{${Object.entries(env)
    .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
    .join(", ")}}`;

  return [
    "-c", `mcp_servers.prix_achats_be.command=${JSON.stringify(command)}`,
    "-c", `mcp_servers.prix_achats_be.args=${JSON.stringify(cmdArgs)}`,
    "-c", `mcp_servers.prix_achats_be.env=${envToml}`,
  ];
}

/**
 * Construit les arguments de `codex exec` pour un run non-interactif :
 * - `--json` : flux JSONL d'événements sur stdout (parsé par CodexStreamParser)
 * - `--skip-git-repo-check` : le cwd des runs (dataDir) n'est pas un repo git
 * - sandbox read-only par défaut (cf. BuildArgsOptions.sandbox)
 * Le prompt est envoyé via stdin (cf. server/runs.ts).
 */
export function buildCodexArgs(opts: BuildArgsOptions = {}): string[] {
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--color", "never",
    "--sandbox", opts.sandbox ?? "read-only",
  ];

  if (opts.model && opts.model !== "default") {
    args.push("--model", opts.model);
  }

  if (opts.addDirs && opts.addDirs.length > 0) {
    for (const dir of opts.addDirs) args.push("--add-dir", dir);
  }

  if (opts.images && opts.images.length > 0) {
    for (const img of opts.images) args.push("--image", img);
  }

  if (opts.outputSchema) {
    args.push("--output-schema", opts.outputSchema);
  }

  if (opts.ephemeral) {
    args.push("--ephemeral");
  }

  if (opts.includeMcp !== false) {
    args.push(...buildMcpOverrides());
  }

  return args;
}
