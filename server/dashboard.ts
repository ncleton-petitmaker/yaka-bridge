/**
 * Statistiques d'avancement par évaluateur, pour l'onglet Dashboard admin.
 *
 * Modèle : pas de bucket pré-attribué dans OIF-Eval. Le "bucket" d'un
 * évaluateur = l'ensemble des dossiers qu'il a touchés (review.evaluateur
 * ou review.validee_par renseigné).
 *
 * Statuts par dossier :
 *   - a_faire     : pas d'évaluation .json
 *   - en_review   : évaluation existe, pas validée
 *   - valide      : review.validee_par renseigné
 *   - ineligible  : verdict = INELIGIBLE
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { listDossiers, type DossierEntry } from "./dossiers.js";

export interface OperatorStats {
  operator: string;
  /** Dossiers touchés par cet opérateur (started + validated + ineligibles). */
  bucketSize: number;
  /** Validés (review.validee_par renseigné). */
  validated: number;
  /** Inéligibles (verdict = INELIGIBLE, qu'ils soient validés ou non). */
  ineligibles: number;
  /** En cours : évaluation existe, pas encore validée. */
  inProgress: number;
  /** % avancement personnel : (validated + ineligibles) / bucketSize. */
  percentDone: number;
  /** Date de la dernière action (validation ou modification du fichier). */
  lastActivity?: string;
}

export interface DashboardSummary {
  /** Total dossiers dans le pool (inputDir). */
  poolTotal: number;
  /** Dossiers déjà touchés (en_review + valide + ineligible) tous opérateurs confondus. */
  totalTouched: number;
  /** Dossiers validés (validee_par renseigné) tous opérateurs confondus. */
  totalValidated: number;
  /** Dossiers inéligibles. */
  totalIneligibles: number;
  /** Dossiers en cours (touchés mais pas validés). */
  totalInProgress: number;
  /** Dossiers jamais touchés. */
  totalNotStarted: number;
  /** % global d'avancement. */
  percentGlobal: number;
  /** Stats par opérateur, triées par % décroissant. */
  operators: OperatorStats[];
  /** Dossiers touchés sans owner identifié (cas anormal — bug ou ancien fichier). */
  unassigned: number;
}

interface EvalFileMetadata {
  evaluator: string | null;
  validated: boolean;
  ineligible: boolean;
  validatedAt?: string;
  mtime: string;
}

function readEvalFileMetadata(
  evalPath: string,
  fallbackOwner: string | null
): EvalFileMetadata | null {
  if (!existsSync(evalPath)) return null;
  let stat;
  try {
    stat = statSync(evalPath);
  } catch {
    return null;
  }
  let parsed: {
    verdict?: string;
    phase_eligibilite?: { verdict?: string };
    review?: {
      evaluateur?: string;
      lance_par?: string;
      validee_par?: string;
      validee_le?: string;
    };
  };
  try {
    parsed = JSON.parse(readFileSync(evalPath, "utf8"));
  } catch {
    return {
      evaluator: fallbackOwner,
      validated: false,
      ineligible: false,
      mtime: stat.mtime.toISOString(),
    };
  }
  // Priorité owner :
  // 1. review.evaluateur (renseigné lors d'une review humaine)
  // 2. review.validee_par (humain qui a validé)
  // 3. review.lance_par (futur : qui a lancé l'éval IA)
  // 4. fallback : utilisateur courant config (cas solo OIF-Eval)
  const owner =
    parsed.review?.evaluateur ??
    parsed.review?.validee_par ??
    parsed.review?.lance_par ??
    fallbackOwner;
  // Verdict est dans phase_eligibilite.verdict (schéma OIF-Eval).
  // Garde le fallback parsed.verdict pour la compat anciens JSON.
  const verdict = parsed.phase_eligibilite?.verdict ?? parsed.verdict;
  return {
    evaluator: owner,
    validated: Boolean(parsed.review?.validee_par),
    ineligible: verdict === "INELIGIBLE",
    validatedAt: parsed.review?.validee_le,
    mtime: stat.mtime.toISOString(),
  };
}

export interface DossierSummary {
  id: string;
  status: DossierEntry["status"];
  evaluator: string | null;
  validatedAt?: string;
  mtime?: string;
}

/**
 * Liste tous les dossiers avec leur statut + l'évaluateur owner (si applicable).
 */
export function listDossiersWithOwner(
  dataDir: string,
  opts: { inputDir?: string; outputDir?: string; fallbackOwner?: string } = {}
): DossierSummary[] {
  const dossiers = listDossiers(dataDir, opts);
  const evalDir = opts.outputDir
    ? resolve(opts.outputDir)
    : resolve(dataDir, "evaluations");
  const fb = opts.fallbackOwner ?? null;
  return dossiers.map((d): DossierSummary => {
    const evalPath = resolve(evalDir, `${d.id}.json`);
    const meta = readEvalFileMetadata(evalPath, fb);
    return {
      id: d.id,
      status: d.status,
      evaluator: meta?.evaluator ?? null,
      validatedAt: meta?.validatedAt,
      mtime: meta?.mtime,
    };
  });
}

/**
 * Statistiques agrégées : global + par opérateur.
 */
export function computeDashboard(
  dataDir: string,
  opts: { inputDir?: string; outputDir?: string; fallbackOwner?: string } = {}
): DashboardSummary {
  const all = listDossiersWithOwner(dataDir, opts);
  const total = all.length;
  let validated = 0;
  let ineligibles = 0;
  let inProgress = 0;
  let notStarted = 0;
  let unassigned = 0;
  const perOperator = new Map<string, OperatorStats>();

  function bumpOp(name: string, patch: (s: OperatorStats) => void) {
    let s = perOperator.get(name);
    if (!s) {
      s = {
        operator: name,
        bucketSize: 0,
        validated: 0,
        ineligibles: 0,
        inProgress: 0,
        percentDone: 0,
      };
      perOperator.set(name, s);
    }
    patch(s);
  }

  for (const d of all) {
    if (d.status === "a_faire") {
      notStarted += 1;
      continue;
    }
    if (d.status === "valide") validated += 1;
    if (d.status === "ineligible") ineligibles += 1;
    if (d.status === "en_review" || d.status === "eligibilite_ok") inProgress += 1;

    if (!d.evaluator) {
      unassigned += 1;
      continue;
    }
    bumpOp(d.evaluator, (s) => {
      s.bucketSize += 1;
      if (d.status === "valide") s.validated += 1;
      if (d.status === "ineligible") s.ineligibles += 1;
      if (d.status === "en_review" || d.status === "eligibilite_ok") s.inProgress += 1;
      if (d.validatedAt) {
        if (!s.lastActivity || d.validatedAt > s.lastActivity) {
          s.lastActivity = d.validatedAt;
        }
      } else if (d.mtime) {
        if (!s.lastActivity || d.mtime > s.lastActivity) {
          s.lastActivity = d.mtime;
        }
      }
    });
  }

  const totalTouched = validated + ineligibles + inProgress;

  const operators = Array.from(perOperator.values()).map((s) => {
    s.percentDone =
      s.bucketSize > 0
        ? Math.round(((s.validated + s.ineligibles) / s.bucketSize) * 100)
        : 0;
    return s;
  });
  operators.sort((a, b) => {
    if (b.percentDone !== a.percentDone) return b.percentDone - a.percentDone;
    return b.bucketSize - a.bucketSize;
  });

  return {
    poolTotal: total,
    totalTouched,
    totalValidated: validated,
    totalIneligibles: ineligibles,
    totalInProgress: inProgress,
    totalNotStarted: notStarted,
    percentGlobal:
      total > 0 ? Math.round(((validated + ineligibles) / total) * 100) : 0,
    operators,
    unassigned,
  };
}

/**
 * Liste les dossiers d'un évaluateur précis avec leurs statuts.
 */
export function listDossiersForOperator(
  dataDir: string,
  operator: string,
  opts: { inputDir?: string; outputDir?: string; fallbackOwner?: string } = {}
): DossierSummary[] {
  const all = listDossiersWithOwner(dataDir, opts);
  return all
    .filter(
      (d) =>
        d.evaluator &&
        d.evaluator.toLowerCase() === operator.toLowerCase()
    )
    .sort((a, b) => {
      // Validated last, in-progress first (more actionable)
      const order: Record<string, number> = { en_review: 0, eligibilite_ok: 1, ineligible: 2, valide: 3, a_faire: 4 };
      const oa = order[a.status] ?? 9;
      const ob = order[b.status] ?? 9;
      if (oa !== ob) return oa - ob;
      return a.id.localeCompare(b.id);
    });
}
