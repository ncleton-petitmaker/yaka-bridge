/**
 * Métadonnées de grille par campagne : liste des questions hors-IA,
 * barème total max, blocs/sections, etc.
 *
 * Storage : `campaigns/<id>/grid-metadata.json`. Si absent (ancienne campagne
 * non migrée), fallback sur les valeurs hardcodées de la 7e.
 *
 * À l'init d'une campagne fae-7e (migration boot), on écrit le metadata
 * historique. Pour les nouvelles campagnes (clone, import, regen), on copie
 * depuis la source ou on déduit du skill evaluer-notation.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { campaignDir, readIndex } from "./campaigns.js";

export interface GridMetadata {
  /** Numéros (1-indexed) des questions de notation à NE PAS scorer par l'IA */
  questionsHorsIa: number[];
  /** Total max théorique de tous les barèmes additionnés */
  baremeTotalMax: number;
  /** Version du schema de cette grille metadata */
  version: number;
  /** Source : "init" (fae-7e d'origine), "clone" (cloné), "import" (zip), "regen" (skill) */
  source?: string;
  generatedAt?: string;
}

const HORS_IA_FAE_7E = [15, 16, 18, 23, 24, 26, 27, 33, 38, 39, 40, 42, 43, 47, 48, 49];
const BAREME_TOTAL_MAX_FAE_7E = 105;

export const FAE_7E_DEFAULT: GridMetadata = {
  questionsHorsIa: HORS_IA_FAE_7E,
  baremeTotalMax: BAREME_TOTAL_MAX_FAE_7E,
  version: 1,
  source: "init",
  generatedAt: "2026-05-08T00:00:00.000Z",
};

function metadataPath(
  dataDir: string,
  campaignId: string,
  sharedSkillsDir?: string
): string {
  return resolve(
    campaignDir(dataDir, campaignId, sharedSkillsDir),
    "grid-metadata.json"
  );
}

/**
 * Lit la metadata de la campagne. Si fichier absent, retourne null pour qu'on
 * sache appliquer un fallback (utile pour les campagnes pré-V2).
 */
export function readGridMetadata(
  dataDir: string,
  campaignId: string,
  sharedSkillsDir?: string
): GridMetadata | null {
  const p = metadataPath(dataDir, campaignId, sharedSkillsDir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as GridMetadata;
  } catch {
    return null;
  }
}

/**
 * Écrit la metadata. Crée le dossier campagne au besoin.
 */
export function writeGridMetadata(
  dataDir: string,
  campaignId: string,
  meta: GridMetadata,
  sharedSkillsDir?: string
): void {
  const p = metadataPath(dataDir, campaignId, sharedSkillsDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(meta, null, 2), "utf8");
}

/**
 * Renvoie la metadata de la campagne demandée, ou de la campagne active si
 * non précisée. Fallback FAE_7E_DEFAULT si rien ne marche.
 */
export function resolveGridMetadata(
  dataDir: string,
  campaignId?: string,
  sharedSkillsDir?: string
): GridMetadata {
  const idx = readIndex(dataDir, sharedSkillsDir);
  const id = campaignId ?? idx?.activeId;
  if (id) {
    const meta = readGridMetadata(dataDir, id, sharedSkillsDir);
    if (meta) return meta;
  }
  return FAE_7E_DEFAULT;
}

/**
 * Init/migration : si la campagne n'a pas de grid-metadata.json, on l'écrit
 * avec les valeurs par défaut FAE_7E_DEFAULT. Idempotent.
 * Sinon on ne touche pas.
 */
export function ensureGridMetadata(
  dataDir: string,
  campaignId: string,
  defaults?: Partial<GridMetadata>,
  sharedSkillsDir?: string
): GridMetadata {
  const existing = readGridMetadata(dataDir, campaignId, sharedSkillsDir);
  if (existing) return existing;
  const meta: GridMetadata = {
    ...FAE_7E_DEFAULT,
    ...defaults,
    generatedAt: new Date().toISOString(),
  };
  writeGridMetadata(dataDir, campaignId, meta, sharedSkillsDir);
  return meta;
}

/**
 * Regénère la metadata depuis le skill evaluer-notation.skill.md d'une
 * campagne (parse le marqueur [HORS IA] dans les libellés). Utile après
 * une régénération automatique des skills par Claude.
 */
export function rebuildGridMetadataFromSkill(
  dataDir: string,
  campaignId: string,
  sharedSkillsDir?: string
): GridMetadata | null {
  const skillPath = resolve(
    campaignDir(dataDir, campaignId, sharedSkillsDir),
    "skills",
    "evaluer-notation.skill.md"
  );
  if (!existsSync(skillPath)) return null;
  const content = readFileSync(skillPath, "utf8");
  const horsIa = new Set<number>();
  let baremeTotalMax = 0;
  const lines = content.split("\n");
  for (const line of lines) {
    // Match exemple : "### Q15 - ..." ou "## Q15..." ou "Q15 [HORS IA]" etc
    const m = line.match(/Q\s?(\d+)/i);
    if (!m) continue;
    const qid = Number(m[1]);
    if (Number.isNaN(qid) || qid <= 0 || qid > 200) continue;
    if (/HORS\s?-?\s?IA|hors\s?-?\s?IA/i.test(line)) {
      horsIa.add(qid);
    }
    // Tente d'extraire le max du barème "(0-3)" ou "max 3" ou "0-3 points"
    const baremeM = line.match(/0\s?-\s?(\d+)\s*(?:points?|pts?|\)|\s)/i);
    if (baremeM) {
      const max = Number(baremeM[1]);
      if (!Number.isNaN(max) && max > 0 && max < 50) {
        baremeTotalMax += max;
      }
    }
  }
  if (horsIa.size === 0 && baremeTotalMax === 0) return null;
  return {
    questionsHorsIa: Array.from(horsIa).sort((a, b) => a - b),
    baremeTotalMax: baremeTotalMax || FAE_7E_DEFAULT.baremeTotalMax,
    version: 1,
    source: "regen-from-skill",
    generatedAt: new Date().toISOString(),
  };
}
