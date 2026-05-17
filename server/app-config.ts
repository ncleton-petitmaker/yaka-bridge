/**
 * Lecture et écriture persistante de la config app dans data/.claude/app-config.json
 * Pour l'instant : juste le modèle Claude Code à utiliser pour les runs.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

export interface AppConfig {
  model: string;
  /** Dossier qui contient les sous-dossiers candidates à évaluer. Si vide, on scanne data/candidatures-* */
  inputDir?: string;
  /** Dossier où écrire les évaluations JSON. Si vide, on écrit dans data/evaluations/ */
  outputDir?: string;
  /** Dossier partagé sur serveur OIF qui contient _global/, _perso/, _propositions/.
   *  Si vide, fallback sur data/.claude/skills/ local. */
  sharedSkillsDir?: string;
  /** Identité de l'utilisatrice connectée (Alice, Bob, etc.) */
  currentUser?: string;
  /** Rôle admin : peut promouvoir/rejeter les propositions et éditer les skills globaux */
  isAdmin?: boolean;
  /** Si true et l'admin est connecté : auto-promotion immédiate des nouvelles propositions de règles */
  autoApprove?: boolean;
  /** Si true : après éligibilité positive, lance automatiquement la notation sans attendre un clic */
  autoNotation?: boolean;
  /** Dossier où le journal RGPD audit-log.jsonl est centralisé (serveur partagé OIF).
   *  Si vide, fallback sur data/.claude/ local au poste. */
  auditLogDir?: string;
  /** Mode de partage : "shared" = via dossier synchronisé (OneDrive/SMB/Dropbox),
   *  "manual" = autonome, échange par packs ZIP. Si vide, on infère depuis sharedSkillsDir. */
  storageMode?: "shared" | "manual";
  /** Nombre max d'évaluations en parallèle côté daemon (config admin, s'applique à tous via le NAS partagé). Défaut : 5. */
  maxConcurrentEvaluations?: number;
  lastUpdated?: string;
}

const DEFAULT_CONFIG: AppConfig = {
  // Alias "sonnet" : Claude Code CLI résout automatiquement vers la dernière
  // version de la famille Sonnet (4.6 aujourd'hui, 4.7/4.8/5.0 plus tard sans
  // modification du code). Meilleur rapport qualité/coût pour les 296 dossiers
  // - équivalent à un évaluateur humain expert d'après les calibrages 6e
  // (cf docs/METHODOLOGIE-CALIBRAGE.md).
  model: "sonnet",
  maxConcurrentEvaluations: 5,
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
 * Liste des modèles disponibles côté UI.
 * On garde "default" qui laisse Claude CLI choisir selon sa config locale.
 */
export const AVAILABLE_MODELS = [
  {
    id: "sonnet",
    label: "Sonnet (dernière version)",
    description:
      "Recommandé. Met automatiquement à jour vers la version la plus récente de Sonnet (4.6 aujourd'hui, futures versions automatiquement). Équilibre qualité/coût, équivalent à un évaluateur humain expert.",
  },
  {
    id: "opus",
    label: "Opus (dernière version)",
    description:
      "Meilleure qualité, plus lent et coûteux. Met automatiquement à jour vers la dernière version d'Opus.",
  },
  {
    id: "haiku",
    label: "Haiku (dernière version)",
    description:
      "Rapide et économique, qualité réduite. Met automatiquement à jour vers la dernière version de Haiku.",
  },
  {
    id: "default",
    label: "Par défaut (config CLI)",
    description:
      "Utilise le modèle configuré dans claude config (souvent Opus pour Pro/Max).",
  },
  {
    id: "claude-opus-4-7",
    label: "Opus 4.7 (version épinglée)",
    description: "Version Opus 4.7 spécifiquement. Ne se met pas à jour automatiquement. ~$2.50 par dossier.",
  },
  {
    id: "claude-sonnet-4-6",
    label: "Sonnet 4.6 (version épinglée)",
    description: "Version Sonnet 4.6 spécifiquement. Ne se met pas à jour automatiquement. ~$0.50 par dossier.",
  },
  {
    id: "claude-haiku-4-5",
    label: "Haiku 4.5 (version épinglée)",
    description: "Version Haiku 4.5 spécifiquement. Ne se met pas à jour automatiquement. ~$0.10 par dossier.",
  },
] as const;
