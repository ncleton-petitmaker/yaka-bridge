/**
 * Charge la vérité-terrain humaine de la 6e édition (verdicts + notations).
 * Source : `_verite-terrain-6e.jsonl` du vault mémoire client OIF.
 * Permet à l'UI d'afficher la notation humaine à côté de la notation IA pour comparaison.
 */
import { readFileSync, existsSync } from "node:fs";

export interface VeriteEntry {
  reference: string;
  edition: string;
  nom?: string;
  prenom?: string;
  organisation?: string;
  eligibilite?: {
    verdict_consolide?: boolean;
    nb_criteres_oui?: number;
    nb_criteres_non?: number;
    nb_criteres_total?: number;
    criteres?: Record<string, "OUI" | "NON" | string>;
    categorie_finale?: "eligible" | "ineligible";
  };
  notation?: {
    nb_evaluations?: number;
    score_min?: number;
    score_max?: number;
    score_moyenne?: number;
    score_max_possible?: number | null;
    evaluations?: Array<Record<string, unknown>>;
  };
  dossier?: {
    path?: string;
    abs_path?: string;
    nb_fichiers?: number;
  };
}

const VERITE_PATH =
  process.env.FAE_VERITE_TERRAIN ??
  "/Users/nicolascleton/Documents/Memoire/memoireclients/OIF/00-Inbox/OIF/_verite-terrain-6e.jsonl";

let cache: Map<string, VeriteEntry> | null = null;

function loadAll(): Map<string, VeriteEntry> {
  if (cache) return cache;
  const map = new Map<string, VeriteEntry>();
  if (!existsSync(VERITE_PATH)) {
    console.warn(`[verite] fichier introuvable: ${VERITE_PATH}`);
    cache = map;
    return map;
  }
  const raw = readFileSync(VERITE_PATH, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as VeriteEntry;
      if (e.reference) map.set(e.reference, e);
    } catch {}
  }
  cache = map;
  console.log(`[verite] ${map.size} entrées chargées depuis ${VERITE_PATH}`);
  return map;
}

/** Extrait la référence (10 chars hex) depuis un id de dossier qui finit par `-<ref>`. */
export function extractReference(dossierId: string): string | null {
  const match = dossierId.match(/-([0-9a-f]{10})$/);
  return match ? match[1] : null;
}

export function getVerite(dossierId: string): VeriteEntry | null {
  const all = loadAll();
  const ref = extractReference(dossierId);
  if (!ref) return null;
  return all.get(ref) ?? null;
}

export function getVeriteSummary(dossierId: string): {
  reference: string | null;
  verdict_humain?: "ELIGIBLE" | "INELIGIBLE";
  score_humain?: number;
  score_min?: number;
  score_max?: number;
  nb_evaluateurs?: number;
} | null {
  const e = getVerite(dossierId);
  if (!e) return { reference: extractReference(dossierId) };
  const verdict_humain =
    e.eligibilite?.categorie_finale === "eligible"
      ? "ELIGIBLE"
      : e.eligibilite?.categorie_finale === "ineligible"
      ? "INELIGIBLE"
      : undefined;
  return {
    reference: e.reference,
    verdict_humain,
    score_humain: e.notation?.score_moyenne,
    score_min: e.notation?.score_min,
    score_max: e.notation?.score_max,
    nb_evaluateurs: e.notation?.nb_evaluations,
  };
}
