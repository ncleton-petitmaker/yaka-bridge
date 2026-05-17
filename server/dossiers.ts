/**
 * Liste des dossiers de candidature présents dans data/candidatures-*.
 * Renvoie un statut par dossier basé sur la présence d'un JSON dans data/evaluations/.
 */
import { readdirSync, statSync, existsSync } from "node:fs";
import { resolve, join, basename } from "node:path";

export type DossierStatus = "a_faire" | "en_review" | "eligibilite_ok" | "valide" | "ineligible";

export interface DossierEntry {
  id: string;
  path: string;
  files: string[];
  status: DossierStatus;
  evaluationPath?: string;
  /** true si un run Claude est actuellement en cours sur ce dossier (affichage spinner UI). */
  running?: boolean;
}

function safeReaddir(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

function deduceStatusFromEvalJson(jsonPath: string): DossierStatus {
  try {
    const content = require("node:fs").readFileSync(jsonPath, "utf8");
    const parsed = JSON.parse(content);
    const verdict = parsed.phase_eligibilite?.verdict ?? parsed.verdict;
    if (verdict === "INELIGIBLE") return "ineligible";
    if (verdict === "ELIGIBLE" || verdict === "ELIGIBILITE_INCERTAINE") {
      if (!parsed.phase_notation) return "eligibilite_ok";
    }
    if (parsed.review?.validee_par) return "valide";
    // Auto-promotion en "valide" : toutes les questions de notation ont une
    // note (score IA non-null OU override humain).
    const questions = parsed.phase_notation?.questions ?? [];
    const overrides = parsed.review?.overrides_ia ?? [];
    if (questions.length > 0) {
      const overrideIds = new Set<number>(
        overrides.map((o: { question_id: number }) => o.question_id)
      );
      const allScored = questions.every(
        (q: { id: number; score: number | null }) =>
          q.score !== null || overrideIds.has(q.id)
      );
      if (allScored) return "valide";
    }
    return "en_review";
  } catch {
    return "en_review";
  }
}

export function listDossiers(
  dataDir: string,
  opts: { inputDir?: string; outputDir?: string } = {}
): DossierEntry[] {
  const out: DossierEntry[] = [];
  const evalDir = opts.outputDir
    ? resolve(opts.outputDir)
    : resolve(dataDir, "evaluations");

  function scanContainer(containerPath: string) {
    for (const sub of safeReaddir(containerPath)) {
      const subPath = join(containerPath, sub);
      let stat;
      try {
        stat = statSync(subPath);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      const files = safeReaddir(subPath).filter(
        (f) => !f.startsWith(".") && f !== "Thumbs.db"
      );
      // Ignore les sous-dossiers vides ou techniques
      if (files.length === 0) continue;
      const evalJson = join(evalDir, `${sub}.json`);
      const hasEval = existsSync(evalJson);
      out.push({
        id: sub,
        path: subPath,
        files,
        status: hasEval ? deduceStatusFromEvalJson(evalJson) : "a_faire",
        evaluationPath: hasEval ? evalJson : undefined,
      });
    }
  }

  if (opts.inputDir) {
    // Mode 'serveur partagé' : scanne directement le inputDir, ses sous-dossiers
    // sont les candidates.
    scanContainer(resolve(opts.inputDir));
  } else {
    // Mode défaut : scanne les sous-dossiers candidatures-* du DATA_DIR
    for (const entry of safeReaddir(dataDir)) {
      if (!entry.startsWith("candidatures")) continue;
      const dirPath = resolve(dataDir, entry);
      try {
        if (!statSync(dirPath).isDirectory()) continue;
      } catch {
        continue;
      }
      scanContainer(dirPath);
    }
  }

  return out.sort((a, b) => a.id.localeCompare(b.id));
}
