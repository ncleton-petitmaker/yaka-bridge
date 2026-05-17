/**
 * Lecture des rapports de calibrage générés par scripts/calibrer.ts.
 *
 * Chaque calibrage produit 2 fichiers parallèles dans data/calibrage/ :
 *   - rapport-<timestamp>.md   : version humaine
 *   - rapport-<timestamp>.json : version structurée pour UI/skill
 *
 * Les anciens rapports n'ont peut-être que le .md (générés avant l'ajout du JSON).
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { resolve, basename } from "node:path";
import type {
  CalibrageReportJson,
  CalibrageReportSummary,
} from "../lib/calibrage-types.js";

function reportsDir(dataDir: string): string {
  return resolve(dataDir, "calibrage");
}

/** Liste tous les rapports avec un résumé pour la liste UI. */
export function listReports(dataDir: string): CalibrageReportSummary[] {
  const dir = reportsDir(dataDir);
  if (!existsSync(dir)) return [];
  const out: CalibrageReportSummary[] = [];
  const files = readdirSync(dir);
  for (const f of files) {
    if (!f.startsWith("rapport-") || !f.endsWith(".md")) continue;
    const mdPath = resolve(dir, f);
    const stat = statSync(mdPath);
    const jsonName = f.replace(/\.md$/, ".json");
    const jsonPath = resolve(dir, jsonName);
    const has_json = existsSync(jsonPath);

    let summary: CalibrageReportSummary = {
      filename: f,
      has_json,
      size_bytes: stat.size,
    };

    if (has_json) {
      try {
        const j = JSON.parse(
          readFileSync(jsonPath, "utf8")
        ) as CalibrageReportJson;
        const totalTokens = j.couts
          ? j.couts.total_input_tokens +
            j.couts.total_output_tokens +
            j.couts.total_cache_read +
            j.couts.total_cache_create
          : undefined;
        summary = {
          ...summary,
          timestamp: j.meta.timestamp,
          modele_ia: j.meta.modele_ia,
          nb_dossiers: j.meta.nb_dossiers,
          accord_pct: j.synthese.accord_eligibilite.pct,
          delta_score_moyen: j.synthese.delta_score_moyen,
          delta_score_abs_moyen: j.synthese.delta_score_abs_moyen,
          similitude_ia_pct: j.synthese.similitude_ia_pct,
          duree_moyenne_s: j.meta.duree_moyenne_s,
          total_cost_usd: j.couts?.total_usd,
          total_tokens: totalTokens,
        };
      } catch {
        // ignore
      }
    } else {
      // Fallback : timestamp depuis le nom de fichier
      const m = f.match(/rapport-(\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2})/);
      if (m) {
        const [d, mo, y, h, mi, s] = m[1].split("-");
        summary.timestamp = `${d}-${mo}-${y}T${h}:${mi}:${s}Z`;
      }
    }

    out.push(summary);
  }
  // Tri par timestamp décroissant (plus récent en premier)
  out.sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""));
  return out;
}

/** Lit le JSON structuré d'un rapport. Retourne null si absent. */
export function getReportJson(
  dataDir: string,
  filename: string
): CalibrageReportJson | null {
  const safe = basename(filename); // anti path-traversal
  if (!safe.startsWith("rapport-") || !safe.endsWith(".md")) return null;
  const jsonPath = resolve(reportsDir(dataDir), safe.replace(/\.md$/, ".json"));
  if (!existsSync(jsonPath)) return null;
  try {
    return JSON.parse(readFileSync(jsonPath, "utf8")) as CalibrageReportJson;
  } catch {
    return null;
  }
}

/** Lit le markdown raw d'un rapport. */
export function getReportMarkdown(
  dataDir: string,
  filename: string
): string | null {
  const safe = basename(filename);
  if (!safe.startsWith("rapport-") || !safe.endsWith(".md")) return null;
  const mdPath = resolve(reportsDir(dataDir), safe);
  if (!existsSync(mdPath)) return null;
  try {
    return readFileSync(mdPath, "utf8");
  } catch {
    return null;
  }
}

/** Chemin absolu d'un rapport JSON (pour passage à Claude en input du skill). */
export function getReportJsonPath(
  dataDir: string,
  filename: string
): string | null {
  const safe = basename(filename);
  if (!safe.startsWith("rapport-") || !safe.endsWith(".md")) return null;
  const jsonPath = resolve(reportsDir(dataDir), safe.replace(/\.md$/, ".json"));
  return existsSync(jsonPath) ? jsonPath : null;
}

/**
 * Supprime un rapport (md + json le cas échéant). Sécurisé :
 *   - basename pour bloquer toute tentative de path traversal,
 *   - n'accepte que les fichiers `rapport-*.md` du dossier de calibrage.
 *
 * Retourne true si au moins un fichier a été supprimé, false si rien n'a été
 * trouvé (404 côté API).
 */
export function deleteReport(dataDir: string, filename: string): boolean {
  const safe = basename(filename);
  if (!safe.startsWith("rapport-") || !safe.endsWith(".md")) return false;
  const dir = reportsDir(dataDir);
  const mdPath = resolve(dir, safe);
  const jsonPath = resolve(dir, safe.replace(/\.md$/, ".json"));
  let removed = false;
  if (existsSync(mdPath)) {
    try {
      unlinkSync(mdPath);
      removed = true;
    } catch {
      // ignore : on continue avec le json
    }
  }
  if (existsSync(jsonPath)) {
    try {
      unlinkSync(jsonPath);
      removed = true;
    } catch {
      // ignore
    }
  }
  return removed;
}
