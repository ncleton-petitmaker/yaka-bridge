/**
 * Lecture et écriture persistante de la config app dans `<dataDir>/.claude/app-config.json`.
 *
 * Le template ne fixe que les champs structurels (modèle, user, paths
 * autorisés en écriture). Les apps métier étendent ce type avec leurs propres
 * settings en redéfinissant ce fichier ou en ajoutant un sous-module.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

export interface AppConfig {
  /** Modèle Claude Code à utiliser (alias "sonnet"/"opus"/"haiku" ou ID complet). */
  model: string;
  /**
   * Dossier(s) supplémentaires que Claude est autorisé à lire/écrire au-delà
   * de `dataDir`. Listés à la fois dans `--add-dir` côté Claude CLI et dans
   * la whitelist du hook restrict-write-paths.
   */
  inputDir?: string;
  outputDir?: string;
  /** Dossier où le journal d'audit chaîné est écrit. */
  auditLogDir?: string;
  /** Identité de l'utilisateur connecté (slugifié côté audit-log). */
  currentUser?: string;
  /** Rôle admin (autorisé à modifier les skills globaux par exemple). */
  isAdmin?: boolean;
  /** Nombre max de runs Claude en parallèle. Défaut : 5. */
  maxConcurrentRuns?: number;
  lastUpdated?: string;
}

const DEFAULT_CONFIG: AppConfig = {
  // Alias "sonnet" : Claude Code CLI résout vers la dernière version Sonnet.
  // Pour épingler une version, utiliser un ID complet (ex "claude-sonnet-4-6").
  model: "sonnet",
  maxConcurrentRuns: 5,
};

export function configPath(dataDir: string): string {
  return resolve(dataDir, ".claude", "app-config.json");
}

export function loadAppConfig(dataDir: string): AppConfig {
  const p = configPath(dataDir);
  if (!existsSync(p)) return { ...DEFAULT_CONFIG };
  try {
    const raw = readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveAppConfig(dataDir: string, partial: Partial<AppConfig>): AppConfig {
  const cur = loadAppConfig(dataDir);
  const next: AppConfig = {
    ...cur,
    ...partial,
    lastUpdated: new Date().toISOString(),
  };
  const p = configPath(dataDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(next, null, 2), "utf8");
  return next;
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
    description: "Utilise le modèle configuré dans `claude config`.",
  },
] as const;
