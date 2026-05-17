/**
 * Migration au boot : passe d'une arbo plate (_global/, _propositions/, _snapshots/, schemas/)
 * à l'arbo campagnes (campaigns/<id>/{skills,propositions,snapshots,schema.json,manifest.json}).
 *
 * Idempotent : si campaigns/_index.json existe, ne touche à rien.
 * Lock fichier pour éviter qu'au démarrage simultané de plusieurs instances
 * sur un dossier partagé, deux migrations s'écrasent.
 */
import {
  existsSync,
  readdirSync,
  cpSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  campaignsRoot,
  campaignDir,
  indexPath,
  buildManifest,
  writeIndex,
  writeManifest,
} from "./campaigns.js";
import { ensureGridMetadata } from "./grid-metadata.js";
import type { CampaignsIndex } from "../lib/campaign-types.js";

const DEFAULT_CAMPAIGN_ID = "fae-7e";
const DEFAULT_CAMPAIGN_LABEL = "FAE 7e édition";
const LAYOUT_VERSION = 1;

function legacyRoot(dataDir: string, sharedSkillsDir?: string): string {
  // Avant migration, les skills _global/ etc. étaient soit dans le dossier partagé
  // (sharedSkillsDir) soit dans data/.claude/skills/ local
  return sharedSkillsDir
    ? resolve(sharedSkillsDir)
    : resolve(dataDir, ".claude", "skills");
}

function lockPath(dataDir: string, sharedSkillsDir?: string): string {
  return resolve(campaignsRoot(dataDir, sharedSkillsDir), ".migration.lock");
}

function tryAcquireLock(
  dataDir: string,
  sharedSkillsDir?: string
): boolean {
  const root = campaignsRoot(dataDir, sharedSkillsDir);
  mkdirSync(root, { recursive: true });
  const lock = lockPath(dataDir, sharedSkillsDir);
  if (existsSync(lock)) {
    try {
      const stat = statSync(lock);
      const ageMs = Date.now() - stat.mtimeMs;
      // Lock obsolète au-delà de 60s (autre process planté)
      if (ageMs > 60_000) {
        unlinkSync(lock);
      } else {
        return false;
      }
    } catch {
      return false;
    }
  }
  try {
    writeFileSync(lock, String(process.pid), { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

function releaseLock(dataDir: string, sharedSkillsDir?: string): void {
  const lock = lockPath(dataDir, sharedSkillsDir);
  try {
    if (existsSync(lock)) unlinkSync(lock);
  } catch {
    // pas bloquant
  }
}

export interface MigrationResult {
  status: "skipped_existing" | "skipped_no_legacy" | "skipped_locked" | "migrated";
  reason?: string;
  campaignId?: string;
  copiedDirs?: string[];
}

/**
 * Bootstrap idempotent. À appeler au démarrage du daemon.
 *
 * Si campaigns/_index.json existe : on ne touche à rien (déjà migré).
 * Sinon : on copie les sous-dossiers historiques vers campaigns/fae-7e/,
 * on écrit manifest.json + _index.json. On ne supprime PAS l'ancien layout
 * (laissé en place pour rollback manuel).
 */
export function ensureCampaignsLayout(
  dataDir: string,
  sharedSkillsDir?: string
): MigrationResult {
  // Cas 1 : déjà migré
  if (existsSync(indexPath(dataDir, sharedSkillsDir))) {
    return { status: "skipped_existing" };
  }

  // Cas 2 : rien à migrer (installation fraîche, le data-template a déjà
  // peut-être l'arbo nouvelle, ou rien du tout)
  const legacy = legacyRoot(dataDir, sharedSkillsDir);
  const legacyGlobal = resolve(legacy, "_global");
  const hasLegacy = existsSync(legacyGlobal) && readdirSync(legacyGlobal).length > 0;
  if (!hasLegacy) {
    // On crée tout de même un _index.json vide pour que les endpoints répondent
    // Mais sans campagne créée. Le user devra en créer une via le wizard.
    // En pratique pour OIF-Eval, le data-template inclut les skills 7e,
    // donc on est rarement dans ce cas, sauf installation totalement fraîche.
    return {
      status: "skipped_no_legacy",
      reason: `Aucun _global/ trouvé dans ${legacy}. Aucune migration possible. L'app va initialiser une campagne fae-7e vide.`,
    };
  }

  // Cas 3 : lock concurrent
  if (!tryAcquireLock(dataDir, sharedSkillsDir)) {
    return {
      status: "skipped_locked",
      reason: "Une autre instance fait déjà la migration. Attendez et redémarrez.",
    };
  }

  try {
    const target = campaignDir(dataDir, DEFAULT_CAMPAIGN_ID, sharedSkillsDir);
    mkdirSync(target, { recursive: true });

    const copied: string[] = [];

    // skills/ ← _global/
    cpSync(legacyGlobal, resolve(target, "skills"), { recursive: true });
    copied.push("skills");

    // propositions/ ← _propositions/
    const legacyProps = resolve(legacy, "_propositions");
    if (existsSync(legacyProps)) {
      cpSync(legacyProps, resolve(target, "propositions"), { recursive: true });
      copied.push("propositions");
    } else {
      mkdirSync(resolve(target, "propositions"), { recursive: true });
    }

    // snapshots/ ← _snapshots/
    const legacySnaps = resolve(legacy, "_snapshots");
    if (existsSync(legacySnaps)) {
      cpSync(legacySnaps, resolve(target, "snapshots"), { recursive: true });
      copied.push("snapshots");
    } else {
      mkdirSync(resolve(target, "snapshots"), { recursive: true });
    }

    // schema.json ← schemas/evaluation-7e.schema.json
    // Note : les schemas sont dans data/.claude/schemas/, pas sous skillsRoot
    const legacySchemaPath = resolve(
      dataDir,
      ".claude",
      "schemas",
      "evaluation-7e.schema.json"
    );
    if (existsSync(legacySchemaPath)) {
      const content = readFileSync(legacySchemaPath, "utf8");
      writeFileSync(resolve(target, "schema.json"), content, "utf8");
      copied.push("schema.json");
    }

    // historique.jsonl ← _historique.jsonl (s'il existe)
    const legacyHist = resolve(
      sharedSkillsDir ? resolve(sharedSkillsDir) : resolve(dataDir, ".claude"),
      "_historique.jsonl"
    );
    if (existsSync(legacyHist)) {
      const content = readFileSync(legacyHist, "utf8");
      writeFileSync(resolve(target, "historique.jsonl"), content, "utf8");
      copied.push("historique.jsonl");
    }

    // Manifest
    const manifest = buildManifest(
      dataDir,
      DEFAULT_CAMPAIGN_ID,
      null,
      sharedSkillsDir
    );
    writeManifest(dataDir, manifest, sharedSkillsDir);

    // Grid metadata (questions hors-IA + barème max). FAE_7E_DEFAULT par défaut
    // pour la migration depuis l'ancienne arbo. Idempotent.
    ensureGridMetadata(dataDir, DEFAULT_CAMPAIGN_ID, undefined, sharedSkillsDir);

    // Index
    const index: CampaignsIndex = {
      campaigns: [
        {
          id: DEFAULT_CAMPAIGN_ID,
          label: DEFAULT_CAMPAIGN_LABEL,
          status: "active",
          createdAt: new Date().toISOString(),
          basedOn: null,
        },
      ],
      activeId: DEFAULT_CAMPAIGN_ID,
      layoutVersion: LAYOUT_VERSION,
      layoutV1Confirmed: false,
    };
    writeIndex(dataDir, index, sharedSkillsDir);

    return {
      status: "migrated",
      campaignId: DEFAULT_CAMPAIGN_ID,
      copiedDirs: copied,
    };
  } finally {
    releaseLock(dataDir, sharedSkillsDir);
  }
}

/**
 * Au 2e démarrage stable, on peut marquer la migration comme confirmée.
 * Permet en V2 de supprimer l'ancien layout en sécurité.
 */
export function confirmLayoutV1(
  dataDir: string,
  sharedSkillsDir?: string
): void {
  const idxPath = indexPath(dataDir, sharedSkillsDir);
  if (!existsSync(idxPath)) return;
  try {
    const idx = JSON.parse(readFileSync(idxPath, "utf8")) as CampaignsIndex;
    if (idx.layoutV1Confirmed) return;
    idx.layoutV1Confirmed = true;
    writeFileSync(idxPath, JSON.stringify(idx, null, 2), "utf8");
  } catch {
    // ignore
  }
}
