/**
 * Lecture et écriture persistante de la config app dans `<dataDir>/.claude/app-config.json`.
 *
 * Le template ne fixe que les champs structurels (modèle, Supabase, options
 * runtime). Les apps métier étendent ce type avec leurs propres
 * settings en redéfinissant ce fichier ou en ajoutant un sous-module.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

export type AgentProvider = "codex-cloud" | "codex-lmstudio";

export const DEFAULT_AGENT_PROVIDER: AgentProvider = "codex-cloud";
export const DEFAULT_LOCAL_MODEL = "openai/gpt-oss-20b";
export const LMSTUDIO_BASE_URL = "http://127.0.0.1:1234/v1";

export interface AppConfig {
  /** Provider agentique. ChatGPT Codex reste le défaut, LM Studio est opt-in. */
  agentProvider: AgentProvider;
  /** Modèle ChatGPT Codex à utiliser (alias "sonnet"/"opus"/"haiku" ou ID complet). */
  model: string;
  /** Modèle local exposé par LM Studio quand `agentProvider` vaut `codex-lmstudio`. */
  localModel?: string;
  /**
   * Dossier(s) supplémentaires que Codex est autorisé à lire/écrire au-delà
   * de `dataDir`. Listés à la fois dans `--add-dir` côté Codex CLI et dans
   * la whitelist du hook restrict-write-paths.
   */
  inputDir?: string;
  outputDir?: string;
  /** Dossier où le journal d'audit chaîné est écrit. */
  auditLogDir?: string;
  /** Provider de base de données. Le template impose Supabase par défaut. */
  databaseProvider: "supabase";
  /** URL du projet Supabase. Peut aussi venir de SUPABASE_URL. */
  supabaseUrl?: string;
  /** Clé anon publique Supabase. Peut aussi venir de SUPABASE_ANON_KEY. */
  supabaseAnonKey?: string;
  /** Nombre max de runs Codex en parallèle. Défaut : 5. */
  maxConcurrentRuns?: number;
  automations?: {
    gmailSupplierInvoices?: {
      enabled?: boolean;
      periodStart?: string;
      periodEnd?: string;
      supplierTypes?: string[];
      excludedSupplierTypes?: string[];
      gmailQuery?: string;
      pennylaneMcpServer?: string;
      schedule?: "manual" | "daily" | "weekly" | "monthly";
    };
  };
  lastUpdated?: string;
}

const DEFAULT_CONFIG: AppConfig = {
  agentProvider: DEFAULT_AGENT_PROVIDER,
  // Alias "sonnet" : Codex CLI résout vers la dernière version Sonnet.
  // Pour épingler une version, utiliser un ID complet (ex "claude-sonnet-4-6").
  model: "sonnet",
  localModel: DEFAULT_LOCAL_MODEL,
  databaseProvider: "supabase",
  maxConcurrentRuns: 5,
};

export function configPath(dataDir: string): string {
  return resolve(dataDir, ".claude", "app-config.json");
}

export function loadAppConfig(dataDir: string): AppConfig {
  const p = configPath(dataDir);
  if (!existsSync(p)) return normalizeAppConfig({});
  try {
    const raw = readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    return normalizeAppConfig(parsed);
  } catch {
    return normalizeAppConfig({});
  }
}

export function saveAppConfig(dataDir: string, partial: Partial<AppConfig>): AppConfig {
  const cur = loadAppConfig(dataDir);
  const next = normalizeAppConfig({
    ...cur,
    ...partial,
    lastUpdated: new Date().toISOString(),
  });
  const p = configPath(dataDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(next, null, 2), "utf8");
  return next;
}

function normalizeAppConfig(partial: Partial<AppConfig>): AppConfig {
  const merged = { ...DEFAULT_CONFIG, ...partial };
  return {
    ...merged,
    agentProvider: normalizeAgentProvider(merged.agentProvider),
    localModel: merged.localModel?.trim() || DEFAULT_LOCAL_MODEL,
  };
}

export function normalizeAgentProvider(value: unknown): AgentProvider {
  return value === "codex-lmstudio" ? "codex-lmstudio" : DEFAULT_AGENT_PROVIDER;
}

export function codexRunModelOptions(
  cfg: Pick<AppConfig, "agentProvider" | "model" | "localModel">,
  overrides: { agentProvider?: AgentProvider; model?: string; localModel?: string } = {}
): { agentProvider: AgentProvider; model?: string; localModel?: string; selectedModel: string } {
  const agentProvider = normalizeAgentProvider(overrides.agentProvider ?? cfg.agentProvider);
  if (agentProvider === "codex-lmstudio") {
    const selectedModel = overrides.localModel?.trim() || overrides.model?.trim() || cfg.localModel?.trim() || DEFAULT_LOCAL_MODEL;
    return { agentProvider, localModel: selectedModel, selectedModel };
  }
  const selectedModel = overrides.model?.trim() || cfg.model;
  return { agentProvider, model: selectedModel, selectedModel };
}

/**
 * Liste des modèles disponibles côté UI. À adapter par l'app si besoin.
 */
export const AVAILABLE_MODELS = [
  {
    id: "sonnet",
    label: "Sonnet (dernière version)",
    description:
      "Recommandé. Met automatiquement à jour vers la version la plus récente de Sonnet. Équilibre qualité/coût.",
  },
  {
    id: "opus",
    label: "Opus (dernière version)",
    description: "Meilleure qualité, plus lent et coûteux. Met à jour vers la dernière version d'Opus.",
  },
  {
    id: "haiku",
    label: "Haiku (dernière version)",
    description: "Rapide et économique, qualité réduite.",
  },
  {
    id: "default",
    label: "Par défaut (config CLI)",
    description: "Utilise le modèle configuré dans Codex CLI.",
  },
] as const;

export const AVAILABLE_AGENT_PROVIDERS = [
  {
    id: "codex-cloud",
    label: "ChatGPT Codex",
    description: "Défaut. Utilise Codex CLI connecté au compte ChatGPT.",
  },
  {
    id: "codex-lmstudio",
    label: "Codex local avec LM Studio",
    description: "Mode local optionnel via `codex exec --oss --local-provider lmstudio`.",
  },
] as const;
