/**
 * Détection et configuration de l'agent Codex CLI (OpenAI) en local.
 * L'app est agentic-first : tous les runs (OCR factures, classification
 * d'emails, copilote) passent par `codex exec --json` authentifié en OAuth
 * ChatGPT (`codex login`), donc zéro clé API à gérer.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const CANDIDATES_BIN = ["codex"] as const;

let cachedCodexBin: string | null = null;

/**
 * Construit un PATH enrichi avec les emplacements typiques de Codex CLI,
 * indispensable car le daemon est spawné par Electron avant que l'utilisateur
 * installe Codex. Son `process.env.PATH` ne contient donc pas forcément les
 * dossiers d'install npm/homebrew.
 */
export function buildEnrichedPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  const appData = process.env.APPDATA || (home ? path.join(home, "AppData", "Roaming") : "");
  const localAppData = process.env.LOCALAPPDATA || (home ? path.join(home, "AppData", "Local") : "");
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const extras = [
    "/usr/local/bin",
    "/opt/homebrew/bin",
    home ? path.join(home, ".local", "bin") : null,
    home ? path.join(home, ".npm-global", "bin") : null,
    home ? path.join(home, ".codex", "bin") : null,
    appData ? path.join(appData, "npm") : null,
    localAppData ? path.join(localAppData, "Programs", "nodejs") : null,
    programFiles ? path.join(programFiles, "nodejs") : null,
    programFilesX86 ? path.join(programFilesX86, "nodejs") : null,
  ].filter(Boolean) as string[];
  return [process.env.PATH, process.env.Path, ...extras].filter(Boolean).join(path.delimiter);
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
  const appData = process.env.APPDATA || (home ? path.join(home, "AppData", "Roaming") : "");
  const localAppData = process.env.LOCALAPPDATA || (home ? path.join(home, "AppData", "Local") : "");
  const isWin = process.platform === "win32";
  const wingetCodex = isWin ? probeWingetCodexPackage() : null;
  if (wingetCodex) return wingetCodex;
  const candidates = isWin
    ? [
        appData ? path.join(appData, "npm", "codex.cmd") : null,
        appData ? path.join(appData, "npm", "codex.ps1") : null,
        localAppData ? path.join(localAppData, "Programs", "nodejs", "codex.cmd") : null,
        home ? path.join(home, ".local", "bin", "codex.exe") : null,
        home ? path.join(home, ".codex", "bin", "codex.exe") : null,
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

function probeWingetCodexPackage(): string | null {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return null;
  const pkgRoot = path.join(localAppData, "Microsoft", "WinGet", "Packages");
  let entries: string[] = [];
  try {
    entries = readdirSync(pkgRoot);
  } catch {
    return null;
  }
  const isCodexExe = (file: string) => {
    const lower = file.toLowerCase();
    if (!lower.endsWith(".exe")) return false;
    if (lower.includes("command-runner") || lower.includes("sandbox-setup")) return false;
    return lower === "codex.exe" || /^codex[-_]/.test(lower);
  };
  const findInDir = (dir: string, depth: number): string | null => {
    let files: Dirent[];
    try {
      files = readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const f of files) {
      if (f.isFile() && isCodexExe(f.name)) return path.join(dir, f.name);
    }
    if (depth <= 0) return null;
    for (const f of files) {
      if (!f.isDirectory()) continue;
      const found = findInDir(path.join(dir, f.name), depth - 1);
      if (found) return found;
    }
    return null;
  };
  const packages = entries
    .filter((entry) => /^OpenAI\.Codex/i.test(entry))
    .map((entry) => {
      const dir = path.join(pkgRoot, entry);
      let mtime = 0;
      try {
        mtime = statSync(dir).mtimeMs;
      } catch {
        // ignore
      }
      return { dir, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
  for (const { dir } of packages) {
    const found = findInDir(dir, 2);
    if (found) return found;
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
  /** URL du service web dont le MCP local doit proxifier le registry /api/actions. */
  mcpProxyBaseUrl?: string;
  /** Jeton Bearer utilisé par le proxy MCP pour appeler le service web. */
  mcpProxyAccessToken?: string;
  /** Conservé pour compatibilité d'API ; sans équivalent `codex exec`. */
  maxTurns?: number;
}

/**
 * Nom de la variable d'environnement utilisée pour résoudre le `dataDir` :
 * c'est elle qui contient le path racine d'écriture (skills, audit-log, etc.).
 */
const DATA_DIR_ENV_VAR = "PRIX_ACHATS_BE_DATA_DIR";
const MCP_SERVER_NAME = "prix_achats_be";
const CODEX_AUTH_FILES = ["auth.json", "auth-v2.json", "credentials.json"] as const;

export function prepareIsolatedCodexHome(cwd: string): string {
  const isolatedUserHome = path.resolve(cwd, ".codex-bridge-home");
  const isolatedHome = path.join(isolatedUserHome, ".codex");
  mkdirSync(isolatedHome, { recursive: true });

  const currentCodexHome = process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(homedir(), ".codex");
  if (path.resolve(currentCodexHome) !== isolatedHome) {
    for (const file of CODEX_AUTH_FILES) {
      const src = path.join(currentCodexHome, file);
      if (!existsSync(src)) continue;
      try {
        copyFileSync(src, path.join(isolatedHome, file));
      } catch {
        // Si la copie échoue, Codex affichera l'erreur de login habituelle.
      }
    }
  }

  const configPath = path.join(isolatedHome, "config.toml");
  if (!existsSync(configPath)) {
    writeFileSync(configPath, "# Config isolee par Bridge. Les MCP sont passes par -c au lancement.\n", "utf8");
  }
  return isolatedHome;
}

export function isolatedUserHomeForCodexHome(codexHome: string): string {
  return path.dirname(codexHome);
}

/**
 * Construit les overrides `-c mcp_servers.*` qui exposent le serveur MCP
 * local au run Codex. Codex lit sa config MCP dans ~/.codex/config.toml :
 * on ne veut pas toucher la config globale de l'utilisateur, donc on passe
 * tout en overrides CLI (valeurs TOML : les strings JSON sont des strings
 * TOML valides, les arrays JSON des arrays TOML valides).
 */
function buildMcpOverrides(opts: BuildArgsOptions = {}): string[] {
  const dataDir =
    process.env[DATA_DIR_ENV_VAR] ?? path.resolve(process.cwd(), "data");
  const packagedMcp = resolvePackagedMcpPath();
  const devMcp = path.resolve(process.cwd(), "server", "mcp.ts");
  const isPackaged = Boolean(packagedMcp);

  const command = isPackaged ? process.execPath : "npx";
  const cmdArgs = isPackaged && packagedMcp ? [packagedMcp] : ["tsx", devMcp];
  const env: Record<string, string> = { [DATA_DIR_ENV_VAR]: dataDir };
  if (opts.mcpProxyBaseUrl) {
    env.BRIDGE_MCP_PROXY_BASE_URL = opts.mcpProxyBaseUrl;
  }
  if (opts.mcpProxyAccessToken) {
    env.BRIDGE_MCP_PROXY_ACCESS_TOKEN = opts.mcpProxyAccessToken;
  }
  if (isPackaged) {
    env.ELECTRON_RUN_AS_NODE = process.env.ELECTRON_RUN_AS_NODE ?? "1";
  }

  const envToml = `{${Object.entries(env)
    .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
    .join(", ")}}`;

  return [
    "-c", `mcp_servers.${MCP_SERVER_NAME}.command=${JSON.stringify(command)}`,
    "-c", `mcp_servers.${MCP_SERVER_NAME}.args=${JSON.stringify(cmdArgs)}`,
    "-c", `mcp_servers.${MCP_SERVER_NAME}.env=${envToml}`,
    ...(opts.allowedTools?.length
      ? ["-c", `mcp_servers.${MCP_SERVER_NAME}.enabled_tools=${JSON.stringify(opts.allowedTools)}`]
      : []),
    "-c", `mcp_servers.${MCP_SERVER_NAME}.enabled=true`,
    "-c", `mcp_servers.${MCP_SERVER_NAME}.required=true`,
    "-c", `mcp_servers.${MCP_SERVER_NAME}.startup_timeout_sec=20`,
    "-c", `mcp_servers.${MCP_SERVER_NAME}.tool_timeout_sec=120`,
    "-c", `mcp_servers.${MCP_SERVER_NAME}.default_tools_approval_mode="approve"`,
  ];
}

function resolvePackagedMcpPath(): string | null {
  const candidates = [
    process.env.BRIDGE_MCP_PATH,
    path.resolve(process.cwd(), "dist", "mcp.cjs"),
    path.resolve(process.cwd(), "mcp.cjs"),
    typeof __dirname !== "undefined" ? path.resolve(__dirname, "mcp.cjs") : null,
    typeof __dirname !== "undefined" ? path.resolve(__dirname, "..", "mcp.cjs") : null,
  ].filter(Boolean) as string[];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
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
    "--ignore-user-config",
    "--ignore-rules",
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
    args.push(...buildMcpOverrides(opts));
  }

  return args;
}
