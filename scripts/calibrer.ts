#!/usr/bin/env tsx
/**
 * Calibrage des skills FAE 7e contre une vérité-terrain humaine.
 *
 * Modes :
 *   --import <importId>    Calibre depuis un bundle utilisateur importé.
 *                          Charge data/calibrage/imports/<importId>/_import.json,
 *                          lance les évaluations IA sur les PDF du bundle, et
 *                          compare aux scores humains lus dans l'xlsx.
 *                          Émet "PROGRESS {...}" sur stdout à chaque dossier.
 *   --compare              Compare les évaluations DÉJÀ présentes vs verite-terrain.
 *   --evaluer --max N      Lance N nouvelles évaluations (séquentiel, ancien comportement).
 *   --stratified --max 20  Sélection stratifiée 6e + lancement batch (mode debug legacy).
 *   --report-only          Régénère le rapport sans relancer d'évaluations.
 *
 * Sortie : data/calibrage/rapport-<timestamp>.md + .json
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CalibrageImport,
  CalibrageProgress,
  ColonneXlsx,
} from "../lib/calibrage-import-types.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = resolve(ROOT, "data");
const DAEMON_URL = process.env.FAE_DAEMON_URL ?? "http://localhost:7456";
const VERITE_PATH =
  process.env.FAE_VERITE_TERRAIN ??
  "/Users/nicolascleton/Documents/Memoire/memoireclients/OIF/00-Inbox/OIF/_verite-terrain-6e.jsonl";

const args = process.argv.slice(2);
const compareOnly = args.includes("--compare");
const stratified = args.includes("--stratified");
const reportOnly = args.includes("--report-only");
const importIdx = args.indexOf("--import");
const IMPORT_ID = importIdx >= 0 ? args[importIdx + 1] : null;
const doEvaluer =
  args.includes("--evaluer") ||
  stratified ||
  Boolean(IMPORT_ID) ||
  (!compareOnly && !reportOnly && args.includes("--max"));
const maxIdx = args.indexOf("--max");
const MAX_NEW = maxIdx >= 0 ? Number(args[maxIdx + 1]) : 0;
const modelIdx = args.indexOf("--model");
const MODEL_OVERRIDE = modelIdx >= 0 ? args[modelIdx + 1] : null;
const ELIGIBILITE_ONLY = args.includes("--eligibilite-only");
// DEBUG - à retirer avant livraison
const compatMode = args.includes("--compat");
const compatExcludedQIds: Set<number> = (() => {
  if (!compatMode) return new Set();
  try {
    const mappingPath = new URL("../data/calibrage/mapping-6e-7e.json", import.meta.url).pathname;
    const mapping = JSON.parse(readFileSync(mappingPath, "utf8"));
    return new Set<number>((mapping.exclusions_delta ?? []).map((e: { q_skill_7e: number }) => e.q_skill_7e));
  } catch {
    return new Set();
  }
})();

// ============================================================
// Helpers progression (mode --import)
// ============================================================

/**
 * Émet une ligne PROGRESS sur stdout, parsée par le daemon (calibrage-runs.ts)
 * en event SSE structuré pour la barre de progression UI.
 */
function emitProgress(p: CalibrageProgress): void {
  console.log(`PROGRESS ${JSON.stringify(p)}`);
}

// ============================================================
// Types
// ============================================================

interface VeriteEntry {
  reference: string;
  edition: string;
  nom?: string;
  prenom?: string;
  eligibilite?: {
    categorie_finale?: "eligible" | "ineligible";
    criteres?: Record<string, "OUI" | "NON">;
    nb_criteres_oui?: number;
    nb_criteres_non?: number;
  };
  notation?: {
    score_moyenne?: number;
    score_min?: number;
    score_max?: number;
    nb_evaluations?: number;
    evaluations?: {
      evaluateur: string;
      score: number;
      score_max: number | null;
      criteres_notation: Record<string, string | number>;
    }[];
  };
}

interface IaEvaluation {
  dossier_id: string;
  evaluateur_ia?: { modele?: string };
  horodatage?: { debut: string; fin: string };
  phase_eligibilite: {
    verdict: "ELIGIBLE" | "INELIGIBLE" | "ELIGIBILITE_INCERTAINE";
    criteres: {
      id: string; // ELG-X
      intitule: string;
      statut: "OUI" | "NON" | "AMBIGU" | "NON_TROUVE";
      source?: string;
      justification?: string;
    }[];
    motifs_rejet_declenches?: string[];
  };
  phase_notation?: {
    questions: {
      id: number;
      intitule: string;
      bareme_max: number;
      score: number | null;
      hors_ia?: boolean;
      statut?: string;
    }[];
    score_total_ia: number;
    score_max_ia: number;
  };
}

/** Comparaison enrichie d'un dossier IA vs gold standard humain. */
interface DossierComparison {
  id: string;
  reference: string | null;
  nom: string;

  // Eligibilité
  verdict_ia?: string;
  verdict_humain?: "ELIGIBLE" | "INELIGIBLE";
  match_eligibilite?: boolean;

  // ELG critère par critère (matching positionnel ordre = ELG-1, ELG-2...)
  elg_diff: {
    id: string;
    intitule: string;
    statut_ia: string;
    statut_humain: "OUI" | "NON" | "?";
    match: boolean;
    justification_ia?: string;
  }[];
  elg_match_count: number;
  elg_total_count: number;

  // Notation totale
  score_ia?: number;
  score_humain_moyen?: number;
  score_humain_min?: number;
  score_humain_max?: number;
  delta_score?: number;
  nb_evaluateurs?: number;
  score_ia_matchees?: number;
  score_humain_ia_matchees?: number;
  delta_ia_matchees?: number;

  // Notation question par question (matching fuzzy par libellé)
  q_diff: {
    id: number;
    intitule: string;
    bareme_max: number;
    score_ia: number | null;
    score_humain_moyen: number | null;
    delta: number | null;
    matched_libelle?: string;
    hors_ia?: boolean;
    /**
     * Barème max côté xlsx pour cette Q (ex: 3) si différent du skill (ex: 2).
     * Indispensable pour normaliser les notes humaines en pourcentage du
     * référentiel xlsx (le vrai référentiel humain).
     */
    bareme_xlsx_max?: number | null;
    /**
     * Δ normalisé en points de pourcentage : `(score_ia / bareme_skill -
     * score_humain / bareme_xlsx) * 100`. Permet de comparer une note IA /2
     * à une note humaine /3 sans biais artificiel.
     */
    delta_pct?: number | null;
  }[];

  // Méta
  has_eval: boolean;
  has_verite: boolean;
  duree_evaluation_s?: number;
  modele_ia?: string;
  erreur?: string;

  /**
   * Coût + tokens du run Claude qui a produit cette évaluation. Présent
   * uniquement en mode --import et seulement si le daemon a encore le run en
   * mémoire au moment du calcul du rapport.
   */
  cout?: {
    input_tokens: number;
    output_tokens: number;
    cache_read: number;
    cache_create_5m: number;
    cache_create_1h: number;
    cost_usd: number;
    model: string;
    duration_ms: number;
  };
}

// ============================================================
// Chargement
// ============================================================

function loadVerite(): Map<string, VeriteEntry> {
  const map = new Map<string, VeriteEntry>();
  if (!existsSync(VERITE_PATH)) {
    console.error(`✗ vérité-terrain introuvable: ${VERITE_PATH}`);
    return map;
  }
  for (const line of readFileSync(VERITE_PATH, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as VeriteEntry;
      if (e.reference) map.set(e.reference, e);
    } catch {
      // skip
    }
  }
  return map;
}

function extractReference(id: string): string | null {
  const m = id.match(/-([0-9a-f]{10})$/);
  return m ? m[1] : null;
}

function listDossiers6e(): string[] {
  const dir = resolve(DATA_DIR, "candidatures-6e");
  if (!existsSync(dir)) return [];
  return readdirSync(dir);
}

/**
 * outputDir résolu une fois au démarrage. On regarde d'abord la config daemon
 * (NAS partagé), puis fallback data/evaluations local. Permet au script de
 * voir les JSON même quand l'app est configurée sur un dossier partagé.
 */
let RESOLVED_OUTPUT_DIR: string | null = null;
async function resolveOutputDir(): Promise<string> {
  if (RESOLVED_OUTPUT_DIR) return RESOLVED_OUTPUT_DIR;
  try {
    const r = await fetch(`${DAEMON_URL}/api/app-config`);
    if (r.ok) {
      const j = (await r.json()) as { config?: { outputDir?: string } };
      if (j.config?.outputDir) {
        RESOLVED_OUTPUT_DIR = j.config.outputDir;
        return RESOLVED_OUTPUT_DIR;
      }
    }
  } catch {
    // ignore - daemon down ou non joignable
  }
  RESOLVED_OUTPUT_DIR = resolve(DATA_DIR, "evaluations");
  return RESOLVED_OUTPUT_DIR;
}

function loadEvaluation(id: string): IaEvaluation | null {
  const candidates = [
    RESOLVED_OUTPUT_DIR ? resolve(RESOLVED_OUTPUT_DIR, `${id}.json`) : null,
    resolve(DATA_DIR, "evaluations", `${id}.json`),
  ].filter((p): p is string => Boolean(p));
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      return JSON.parse(readFileSync(p, "utf8")) as IaEvaluation;
    } catch {
      return null;
    }
  }
  return null;
}

// ============================================================
// Sélection stratifiée
// ============================================================

interface StratifiedSelection {
  haut: { id: string; reference: string; score: number }[];
  moyenHaut: { id: string; reference: string; score: number }[];
  moyenBas: { id: string; reference: string; score: number }[];
  bas: { id: string; reference: string; score: number }[];
  inelig: { id: string; reference: string; score: number }[];
}

/**
 * Sélection stratifiée adaptée à la distribution réelle du gold standard 6e
 * (la majorité des éligibles ont 50-75). On prend tous les hauts (rares),
 * puis on étale sur les moyens, et on garde quelques bas + inéligibles.
 * Évite de demander plus de dossiers qu'il n'y en a dans une strate.
 */
function selectStratifiedSample(
  dossiers: string[],
  verite: Map<string, VeriteEntry>,
  excludeIds: Set<string>
): StratifiedSelection {
  const all = dossiers
    .filter((id) => !excludeIds.has(id))
    .map((id) => {
      const ref = extractReference(id);
      const v = ref ? verite.get(ref) : undefined;
      return { id, reference: ref, v };
    })
    .filter((x): x is { id: string; reference: string; v: VeriteEntry } =>
      Boolean(x.reference && x.v)
    );

  const eligibles = all.filter(
    (x) => x.v.eligibilite?.categorie_finale === "eligible"
  );
  const ineligibles = all.filter(
    (x) => x.v.eligibilite?.categorie_finale === "ineligible"
  );

  const eligWithScore = eligibles
    .filter((x) => typeof x.v.notation?.score_moyenne === "number")
    .map((x) => ({
      id: x.id,
      reference: x.reference,
      score: x.v.notation!.score_moyenne!,
    }))
    .sort((a, b) => b.score - a.score);

  // Strates fines pour mieux étaler sur la distribution réelle
  const haut = eligWithScore.filter((x) => x.score > 75).slice(0, 6);
  const moyenHaut = eligWithScore.filter((x) => x.score >= 65 && x.score <= 75).slice(0, 5);
  const moyenBas = eligWithScore.filter((x) => x.score >= 50 && x.score < 65).slice(0, 5);
  const bas = eligWithScore.filter((x) => x.score < 50 && x.score > 0).slice(0, 2);
  const inelig = ineligibles
    .map((x) => ({
      id: x.id,
      reference: x.reference,
      score: x.v.notation?.score_moyenne ?? 0,
    }))
    .slice(0, 2);

  return { haut, moyenHaut, moyenBas, bas, inelig };
}

// ============================================================
// Lancement (batch via /api/runs/batch)
// ============================================================

async function pollRunStatus(runId: string): Promise<string> {
  const r = await fetch(`${DAEMON_URL}/api/runs/${runId}`);
  if (!r.ok) return "unknown";
  const j = (await r.json()) as { status?: string };
  return j.status ?? "unknown";
}

/**
 * Attend qu'au moins un slot d'évaluation soit libre côté daemon
 * (MAX_CONCURRENT_EVALUATIONS). Renvoie true si un slot devient libre dans
 * `timeoutMs`, false si timeout. Affiche un message d'attente si on doit
 * patienter plus de 5s pour aider l'utilisateur à comprendre ce qui se passe.
 */
async function waitForFreeSlot(timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  let warned = false;
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${DAEMON_URL}/api/runs/concurrency`);
      if (r.ok) {
        const j = (await r.json()) as {
          running: number;
          max: number;
          canStart: number;
        };
        if (j.canStart >= 1) return true;
        if (!warned) {
          console.log(
            `  ⏳ ${j.running}/${j.max} slots occupés côté daemon, attente d'un slot libre...`
          );
          warned = true;
        }
      }
    } catch {
      // ignore, on retry
    }
    await new Promise((res) => setTimeout(res, 5000));
  }
  return false;
}

async function batchAndWait(ids: string[]): Promise<{
  succeeded: string[];
  failed: { id: string; reason: string }[];
}> {
  const succeeded: string[] = [];
  const failed: { id: string; reason: string }[] = [];

  if (MODEL_OVERRIDE) console.log(`  Modèle override : ${MODEL_OVERRIDE}`);
  if (ELIGIBILITE_ONLY) console.log(`  Mode : éligibilité uniquement`);

  // Vagues de 3 (limite MAX_CONCURRENT_EVALUATIONS daemon, anti rate-limit)
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += 5) chunks.push(ids.slice(i, i + 5));

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    console.log(
      `\n[Vague ${ci + 1}/${chunks.length}] Lancement de ${chunk.length} évaluations en parallèle...`
    );
    const batchBody: Record<string, unknown> = { dossier_ids: chunk };
    if (MODEL_OVERRIDE) batchBody.model = MODEL_OVERRIDE;
    if (ELIGIBILITE_ONLY) batchBody.eligibilite_only = true;
    const r = await fetch(`${DAEMON_URL}/api/runs/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(batchBody),
    });
    if (!r.ok) {
      const txt = await r.text();
      console.error(`  ✗ batch échec: ${r.status} ${txt}`);
      for (const id of chunk) failed.push({ id, reason: `batch ${r.status}` });
      continue;
    }
    const j = (await r.json()) as {
      launched: { dossier_id: string; run_id: string }[];
      skipped: { dossier_id: string; reason: string }[];
    };
    for (const s of j.skipped) {
      failed.push({ id: s.dossier_id, reason: s.reason });
      console.log(`  ⚠ skipped ${s.dossier_id}: ${s.reason}`);
    }
    const launched = j.launched;
    console.log(`  → ${launched.length} runs lancés. Attente fin de vague...`);

    // Poll les runIds individuellement jusqu'à ce que TOUS soient en status terminal
    const start = Date.now();
    const TIMEOUT_MS = 25 * 60_000;
    const finalStatuses = new Map<string, string>();
    while (finalStatuses.size < launched.length) {
      await new Promise((r) => setTimeout(r, 8000));
      for (const l of launched) {
        if (finalStatuses.has(l.run_id)) continue;
        const status = await pollRunStatus(l.run_id);
        if (["succeeded", "failed", "cancelled"].includes(status)) {
          finalStatuses.set(l.run_id, status);
        }
      }
      const elapsed = Math.round((Date.now() - start) / 1000);
      const remaining = launched.length - finalStatuses.size;
      process.stdout.write(
        `\r  ⏳ ${remaining} restants, ${elapsed}s écoulés...`
      );
      if (Date.now() - start > TIMEOUT_MS) {
        console.log(`\n  ✗ timeout après 25 min, abandon de la vague`);
        break;
      }
    }
    console.log("");

    // Vérifie quels dossiers ont produit un JSON valide
    for (const l of launched) {
      const ev = loadEvaluation(l.dossier_id);
      const status = finalStatuses.get(l.run_id) ?? "timeout";
      if (ev) {
        succeeded.push(l.dossier_id);
        console.log(`  ✓ ${l.dossier_id} (status=${status})`);
      } else {
        failed.push({ id: l.dossier_id, reason: `status=${status} sans JSON` });
        console.log(`  ✗ ${l.dossier_id} (status=${status}, pas de JSON)`);
      }
    }
  }

  return { succeeded, failed };
}

// ============================================================
// Comparaison enrichie
// ============================================================

/** Normalise un libellé pour comparaison fuzzy. */
function normalizeLabel(s: string): string {
  if (!s) return "";
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['']/g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP_WORDS = new Set([
  "le", "la", "les", "de", "des", "du", "et", "ou", "un", "une",
  "a", "au", "aux", "en", "dans", "que", "qui", "ce", "cet", "cette",
  "ces", "se", "il", "elle", "on", "est", "sont", "pour", "par",
  "sur", "vers", "avec", "sans", "ne", "pas", "plus", "moins",
  "selon", "etant", "etre",
]);

function keywords(s: string): Set<string> {
  return new Set(
    normalizeLabel(s)
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !STOP_WORDS.has(w))
  );
}

/** Score de similarité Jaccard entre 2 libellés. */
function similarity(a: string, b: string): number {
  const ka = keywords(a);
  const kb = keywords(b);
  if (ka.size === 0 || kb.size === 0) return 0;
  let inter = 0;
  for (const w of ka) if (kb.has(w)) inter++;
  const union = ka.size + kb.size - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * Pour chaque question IA, cherche la meilleure correspondance dans le dict
 * humain (score >= seuil). Renvoie le score humain moyen sur tous les
 * évaluateurs ayant noté cette question.
 */
type Evaluations = NonNullable<NonNullable<VeriteEntry["notation"]>["evaluations"]>;

function matchHumanScore(
  intituleIa: string,
  evaluations: Evaluations = []
): { matchedLibelle?: string; scoreMoyen: number | null } {
  const scores: number[] = [];
  let bestLibelle: string | undefined;
  let bestSim = 0;

  for (const ev of evaluations ?? []) {
    if (ev.evaluateur === "Classement général") continue;
    let bestKey: string | undefined;
    let bestKeySim = 0;
    for (const key of Object.keys(ev.criteres_notation)) {
      const sim = similarity(intituleIa, key);
      if (sim > bestKeySim) {
        bestKeySim = sim;
        bestKey = key;
      }
    }
    if (bestKey && bestKeySim >= 0.25) {
      const raw = ev.criteres_notation[bestKey];
      const num = typeof raw === "number" ? raw : Number(String(raw).split("/")[0].trim());
      if (!Number.isNaN(num)) {
        scores.push(num);
      }
      if (bestKeySim > bestSim) {
        bestSim = bestKeySim;
        bestLibelle = bestKey;
      }
    }
  }

  if (scores.length === 0) return { matchedLibelle: bestLibelle, scoreMoyen: null };
  const moy = scores.reduce((a, b) => a + b, 0) / scores.length;
  return { matchedLibelle: bestLibelle, scoreMoyen: Number(moy.toFixed(2)) };
}

function compareDetailed(
  id: string,
  ia: IaEvaluation | null,
  v: VeriteEntry | null
): DossierComparison {
  const ref = extractReference(id);
  const nom =
    [v?.prenom, v?.nom].filter(Boolean).join(" ") || id.split("-").slice(0, 2).join(" ");

  const result: DossierComparison = {
    id,
    reference: ref,
    nom,
    elg_diff: [],
    elg_match_count: 0,
    elg_total_count: 0,
    q_diff: [],
    has_eval: !!ia,
    has_verite: !!v,
  };

  if (!ia || !v) {
    if (ia) result.verdict_ia = ia.phase_eligibilite.verdict;
    if (v) {
      result.verdict_humain =
        v.eligibilite?.categorie_finale === "eligible" ? "ELIGIBLE" : "INELIGIBLE";
    }
    return result;
  }

  // Métadonnées
  result.modele_ia = ia.evaluateur_ia?.modele;
  if (ia.horodatage) {
    const dur =
      new Date(ia.horodatage.fin).getTime() -
      new Date(ia.horodatage.debut).getTime();
    if (dur > 0) result.duree_evaluation_s = Math.round(dur / 1000);
  }

  // Verdict
  result.verdict_ia = ia.phase_eligibilite.verdict;
  result.verdict_humain =
    v.eligibilite?.categorie_finale === "eligible" ? "ELIGIBLE" : "INELIGIBLE";
  result.match_eligibilite =
    result.verdict_ia === result.verdict_humain ||
    (result.verdict_ia === "ELIGIBILITE_INCERTAINE" &&
      result.verdict_humain === "ELIGIBLE");

  // ELG critère par critère (matching positionnel ordre = ELG-1..14)
  const humCriteres = Object.entries(v.eligibilite?.criteres ?? {});
  for (let i = 0; i < ia.phase_eligibilite.criteres.length; i++) {
    const cIa = ia.phase_eligibilite.criteres[i];
    const human = humCriteres[i];
    let statutHumain: "OUI" | "NON" | "?" = "?";
    if (human) {
      statutHumain = human[1] === "OUI" ? "OUI" : "NON";
    }
    // Match si IA = OUI/AMBIGU et humain = OUI, ou IA = NON et humain = NON
    const iaPositif = cIa.statut === "OUI" || cIa.statut === "AMBIGU";
    const iaNegatif = cIa.statut === "NON";
    const match =
      (iaPositif && statutHumain === "OUI") ||
      (iaNegatif && statutHumain === "NON");
    if (statutHumain !== "?") {
      result.elg_total_count++;
      if (match) result.elg_match_count++;
    }
    result.elg_diff.push({
      id: cIa.id,
      intitule: cIa.intitule,
      statut_ia: cIa.statut,
      statut_humain: statutHumain,
      match,
      justification_ia: cIa.justification,
    });
  }

  // Notation totale
  if (ia.phase_notation) {
    result.score_ia = ia.phase_notation.score_total_ia;
  }
  result.score_humain_moyen = v.notation?.score_moyenne;
  result.score_humain_min = v.notation?.score_min;
  result.score_humain_max = v.notation?.score_max;
  result.nb_evaluateurs = v.notation?.nb_evaluations;
  if (
    typeof result.score_ia === "number" &&
    typeof result.score_humain_moyen === "number"
  ) {
    result.delta_score = Number(
      (result.score_ia - result.score_humain_moyen).toFixed(2)
    );
  }

  // Notation question par question
  if (ia.phase_notation) {
    for (const q of ia.phase_notation.questions) {
      const { matchedLibelle, scoreMoyen } = matchHumanScore(
        q.intitule,
        v.notation?.evaluations
      );
      const delta =
        q.score !== null && scoreMoyen !== null
          ? Number((q.score - scoreMoyen).toFixed(2))
          : null;
      result.q_diff.push({
        id: q.id,
        intitule: q.intitule,
        bareme_max: q.bareme_max,
        score_ia: q.score,
        score_humain_moyen: scoreMoyen,
        delta,
        matched_libelle: matchedLibelle,
        hors_ia: q.hors_ia,
      });
    }

    // Score IA comparable : somme sur les questions IA-évaluables matchées uniquement.
    // Corrige le biais du delta_score brut qui compare score_ia/67 vs score_humain/105.
    let scoreIaMatchees = 0;
    let scoreHumainIaMatchees = 0;
    let nIaMatchees = 0;
    for (const q of result.q_diff) {
      if (q.hors_ia) continue;
      if (q.score_ia === null || q.score_humain_moyen === null) continue;
      scoreIaMatchees += q.score_ia;
      scoreHumainIaMatchees += q.score_humain_moyen;
      nIaMatchees++;
    }
    if (nIaMatchees > 0) {
      result.score_ia_matchees = Number(scoreIaMatchees.toFixed(2));
      result.score_humain_ia_matchees = Number(scoreHumainIaMatchees.toFixed(2));
      result.delta_ia_matchees = Number((scoreIaMatchees - scoreHumainIaMatchees).toFixed(2));
    }
  }

  return result;
}

// ============================================================
// Génération du rapport markdown
// ============================================================

function fmtDelta(d: number | null | undefined): string {
  if (d == null) return "—";
  if (d === 0) return "0";
  return d > 0 ? `+${d}` : `${d}`;
}

function emojiDelta(d: number | null | undefined, threshold = 5): string {
  if (d == null) return "·";
  const abs = Math.abs(d);
  if (abs <= threshold) return "🟢";
  if (abs <= 15) return "🟡";
  return "🔴";
}

/**
 * Génère un rapport JSON structuré pour consommation programmatique
 * (UI Paramètres > Rapport de calibrage, skill ameliorer-mes-regles batch).
 *
 * Mêmes calculs que generateReport mais sortie typée et complète
 * (pas de troncature de top 15, on garde toutes les questions).
 */
function generateJsonReport(comparisons: DossierComparison[], stats: {
  modele: string;
  totalDossiers: number;
  /** Colonnes du xlsx avec leur barème, fournies en mode --import. */
  colonnes?: ColonneXlsx[];
  /** Nombre de Q définies dans le skill (typiquement 49). Optionnel. */
  qSkillTotal?: number;
  /** Nombre de Q hors_ia dans le skill (typiquement 16). Optionnel. */
  qHorsIaTotal?: number;
}) {
  const reportWarnings: string[] = [];

  const evalues = comparisons.filter((c) => c.has_eval && c.has_verite);
  const matchElig = evalues.filter((c) => c.match_eligibilite).length;
  const matchPct = evalues.length ? (matchElig / evalues.length) * 100 : 0;

  const deltas = evalues
    .filter((c) => typeof c.delta_score === "number")
    .map((c) => c.delta_score!);
  const deltaMoyen =
    deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;
  const deltaAbsMoyen =
    deltas.length
      ? deltas.map(Math.abs).reduce((a, b) => a + b, 0) / deltas.length
      : 0;

  // Δ score moyen NORMALISÉ en pts de % : pour chaque dossier on calcule
  // (ia_total / max_skill - hum_total / max_xlsx) * 100, puis on moyenne.
  // C'est le seul indicateur exploitable quand le score humain xlsx est
  // exprimé dans un barème global différent du barème IA skill.
  // On dérive max_skill et max_xlsx au niveau dossier en sommant les barèmes
  // des Q effectivement comparées (les Q non couvertes sont exclues des deux
  // côtés, donc le ratio reste cohérent).
  // Δ normalisé toutes questions (pour rétrocompat delta_score_moyen_pct)
  const dossierPcts: number[] = [];
  // Δ normalisé questions IA uniquement (hors_ia exclues) — pour similitude_ia_pct
  const dossierIaPcts: number[] = [];
  for (const c of evalues) {
    let iaSum = 0, iaMax = 0, humSum = 0, humMax = 0;
    let iaIaSum = 0, iaIaMax = 0, humIaSum = 0, humIaMax = 0;
    for (const q of c.q_diff) {
      if (q.score_ia == null || q.score_humain_moyen == null) continue;
      if (q.bareme_max <= 0) continue;
      const baremeXlsx = q.bareme_xlsx_max ?? q.bareme_max;
      if (baremeXlsx <= 0) continue;
      if (compatExcludedQIds.has(q.id)) continue; // DEBUG compat
      iaSum += q.score_ia;
      iaMax += q.bareme_max;
      humSum += q.score_humain_moyen;
      humMax += baremeXlsx;
      // Périmètre IA uniquement
      if (!q.hors_ia) {
        iaIaSum += q.score_ia;
        iaIaMax += q.bareme_max;
        humIaSum += q.score_humain_moyen;
        humIaMax += baremeXlsx;
      }
    }
    if (iaMax > 0 && humMax > 0) {
      dossierPcts.push((iaSum / iaMax - humSum / humMax) * 100);
    }
    if (iaIaMax > 0 && humIaMax > 0) {
      dossierIaPcts.push((iaIaSum / iaIaMax - humIaSum / humIaMax) * 100);
    }
  }
  const deltaMoyenPct = dossierPcts.length
    ? dossierPcts.reduce((a, b) => a + b, 0) / dossierPcts.length
    : 0;
  const deltaAbsMoyenPct = dossierPcts.length
    ? dossierPcts.map(Math.abs).reduce((a, b) => a + b, 0) / dossierPcts.length
    : 0;
  // Indicateurs IA-only
  const deltaIaAbsMoyenPct = dossierIaPcts.length
    ? dossierIaPcts.map(Math.abs).reduce((a, b) => a + b, 0) / dossierIaPcts.length
    : 0;
  const similitudeIaPct = dossierIaPcts.length
    ? Math.max(0, Number((100 - deltaIaAbsMoyenPct).toFixed(1)))
    : undefined;

  // Distribution en % (plus interprétable que les pts bruts) : < 5 = match
  // serré, 5-15 = écart modéré, > 15 = écart majeur. Si aucun dossier n'a
  // de delta_pct calculable, on fallback sur les deltas bruts pour ne pas
  // afficher 0/0/0 au tableau de bord.
  const dist =
    dossierPcts.length > 0
      ? {
          petit: dossierPcts.filter((d) => Math.abs(d) < 5).length,
          moyen: dossierPcts.filter(
            (d) => Math.abs(d) >= 5 && Math.abs(d) <= 15
          ).length,
          grand: dossierPcts.filter((d) => Math.abs(d) > 15).length,
        }
      : {
          petit: deltas.filter((d) => Math.abs(d) < 5).length,
          moyen: deltas.filter((d) => Math.abs(d) >= 5 && Math.abs(d) <= 15)
            .length,
          grand: deltas.filter((d) => Math.abs(d) > 15).length,
        };
  const dureeMoy =
    evalues
      .filter((c) => typeof c.duree_evaluation_s === "number")
      .reduce((s, c) => s + c.duree_evaluation_s!, 0) /
    Math.max(
      1,
      evalues.filter((c) => typeof c.duree_evaluation_s === "number").length
    );

  // Biais ELG
  const elgStats = new Map<
    string,
    { id: string; intitule: string; total: number; desaccords: number; iaOuiHumNon: number; iaNonHumOui: number; iaAmbigu: number; iaNonTrouve: number }
  >();
  for (const c of evalues) {
    for (const e of c.elg_diff) {
      if (e.statut_humain === "?") continue;
      const cur =
        elgStats.get(e.id) ??
        {
          id: e.id,
          intitule: e.intitule,
          total: 0,
          desaccords: 0,
          iaOuiHumNon: 0,
          iaNonHumOui: 0,
          iaAmbigu: 0,
          iaNonTrouve: 0,
        };
      cur.total++;
      if (!e.match) cur.desaccords++;
      if (e.statut_ia === "OUI" && e.statut_humain === "NON") cur.iaOuiHumNon++;
      if (e.statut_ia === "NON" && e.statut_humain === "OUI") cur.iaNonHumOui++;
      if (e.statut_ia === "AMBIGU") cur.iaAmbigu++;
      if (e.statut_ia === "NON_TROUVE") cur.iaNonTrouve++;
      elgStats.set(e.id, cur);
    }
  }
  const biais_elg = Array.from(elgStats.values())
    .sort((a, b) => b.desaccords - a.desaccords)
    .map((e) => {
      const pcts: string[] = [];
      if (e.iaOuiHumNon > 0) pcts.push(`IA trop permissive (${e.iaOuiHumNon}/${e.total})`);
      if (e.iaNonHumOui > 0) pcts.push(`IA trop stricte (${e.iaNonHumOui}/${e.total})`);
      if (e.iaAmbigu > 0) pcts.push(`IA trop souvent AMBIGU (${e.iaAmbigu}/${e.total})`);
      if (e.iaNonTrouve > 0) pcts.push(`Documents non trouvés (${e.iaNonTrouve}/${e.total})`);
      return {
        id: e.id,
        intitule: e.intitule,
        desaccords: e.desaccords,
        total: e.total,
        ia_oui_hum_non: e.iaOuiHumNon,
        ia_non_hum_oui: e.iaNonHumOui,
        ia_ambigu: e.iaAmbigu,
        ia_non_trouve: e.iaNonTrouve,
        pattern: pcts.length ? pcts.join(", ") : "Aucun désaccord",
      };
    });

  // Biais Q
  // On agrège aussi les barèmes xlsx (qui peuvent différer du skill) pour
  // pouvoir normaliser en % côté output. Si une Q a plusieurs barèmes xlsx
  // différents (improbable, sauf bug de mapping), on conserve le plus fréquent.
  const qStats = new Map<
    number,
    {
      id: number;
      intitule: string;
      bareme_max: number;
      hors_ia: boolean;
      n: number;
      deltaSum: number;
      deltaAbsSum: number;
      iaSum: number;
      humSum: number;
      /** Sommes ia_pct et hum_pct par dossier (chacun normalisé sur son barème). */
      iaPctSum: number;
      humPctSum: number;
      deltaPctSum: number;
      deltaAbsPctSum: number;
      /** Histogramme des barèmes xlsx vus pour cette Q (pour reporter le plus fréquent). */
      baremeXlsxCounts: Map<number, number>;
    }
  >();
  for (const c of evalues) {
    for (const q of c.q_diff) {
      if (q.delta == null || q.score_ia === null || q.score_humain_moyen === null) continue;
      if (compatExcludedQIds.has(q.id)) continue; // DEBUG compat
      const cur =
        qStats.get(q.id) ??
        {
          id: q.id,
          intitule: q.intitule,
          bareme_max: q.bareme_max,
          hors_ia: !!q.hors_ia,
          n: 0,
          deltaSum: 0,
          deltaAbsSum: 0,
          iaSum: 0,
          humSum: 0,
          iaPctSum: 0,
          humPctSum: 0,
          deltaPctSum: 0,
          deltaAbsPctSum: 0,
          baremeXlsxCounts: new Map<number, number>(),
        };
      cur.n++;
      cur.deltaSum += q.delta;
      cur.deltaAbsSum += Math.abs(q.delta);
      cur.iaSum += q.score_ia;
      cur.humSum += q.score_humain_moyen;
      const baremeXlsx = q.bareme_xlsx_max ?? q.bareme_max;
      if (baremeXlsx > 0) {
        cur.baremeXlsxCounts.set(
          baremeXlsx,
          (cur.baremeXlsxCounts.get(baremeXlsx) ?? 0) + 1
        );
      }
      if (q.bareme_max > 0 && baremeXlsx > 0) {
        const iaPct = (q.score_ia / q.bareme_max) * 100;
        const humPct = (q.score_humain_moyen / baremeXlsx) * 100;
        cur.iaPctSum += iaPct;
        cur.humPctSum += humPct;
        cur.deltaPctSum += iaPct - humPct;
        cur.deltaAbsPctSum += Math.abs(iaPct - humPct);
      }
      qStats.set(q.id, cur);
    }
  }
  const biais_q = Array.from(qStats.values())
    .filter((q) => q.n >= 2)
    .filter((q) => {
      // Filet de sécurité strict (1.01) : on vérifie la moyenne humaine contre
      // le barème xlsx (vrai référentiel humain) et la moyenne IA contre le
      // barème skill. Tout dépassement traduit un bug de mapping xlsx -> Q ou
      // un bug IA, on exclut la Q du rapport et on warn.
      const humAvg = q.humSum / q.n;
      const iaAvg = q.iaSum / q.n;
      // Barème xlsx le plus fréquent observé pour cette Q.
      let bestBaremeXlsx = q.bareme_max;
      let bestCount = -1;
      for (const [b, c] of q.baremeXlsxCounts.entries()) {
        if (c > bestCount) {
          bestCount = c;
          bestBaremeXlsx = b;
        }
      }
      const capHum = bestBaremeXlsx * 1.01;
      const capIa = q.bareme_max * 1.01;
      if (bestBaremeXlsx > 0 && humAvg > capHum) {
        reportWarnings.push(
          `Q${q.id} (${q.intitule.slice(0, 40)}) : moyenne humaine ${humAvg.toFixed(2)} > barème xlsx ${bestBaremeXlsx}, Q exclue du rapport (mapping suspect).`
        );
        return false;
      }
      if (q.bareme_max > 0 && iaAvg > capIa) {
        reportWarnings.push(
          `Q${q.id} (${q.intitule.slice(0, 40)}) : moyenne IA ${iaAvg.toFixed(2)} > barème skill ${q.bareme_max}, Q exclue du rapport (bug IA suspect).`
        );
        return false;
      }
      return true;
    })
    .map((q) => {
      // Détermine le barème xlsx représentatif (le plus fréquent observé).
      let bestBaremeXlsx: number | null = null;
      let bestCount = -1;
      for (const [b, c] of q.baremeXlsxCounts.entries()) {
        if (c > bestCount) {
          bestCount = c;
          bestBaremeXlsx = b;
        }
      }
      return {
        id: q.id,
        intitule: q.intitule,
        bareme_max: q.bareme_max,
        hors_ia: q.hors_ia,
        n: q.n,
        delta_moyen: Number((q.deltaSum / q.n).toFixed(3)),
        delta_abs_moyen: Number((q.deltaAbsSum / q.n).toFixed(3)),
        ia_avg: Number((q.iaSum / q.n).toFixed(3)),
        humain_avg: Number((q.humSum / q.n).toFixed(3)),
        bareme_xlsx_max: bestBaremeXlsx,
        ia_pct: Number((q.iaPctSum / q.n).toFixed(2)),
        humain_pct: Number((q.humPctSum / q.n).toFixed(2)),
        delta_pct: Number((q.deltaPctSum / q.n).toFixed(2)),
        delta_abs_pct: Number((q.deltaAbsPctSum / q.n).toFixed(2)),
      };
    })
    // Tri par |Δ pts %| décroissant (priorité visuelle à ce qui dérive le
    // plus en valeur normalisée, pas en points bruts qui dépendent du barème).
    .sort((a, b) => Math.abs(b.delta_pct) - Math.abs(a.delta_pct));

  // Recommandations
  const recoElg = biais_elg
    .filter((e) => e.desaccords >= Math.max(1, Math.floor(e.total * 0.3)))
    .slice(0, 5)
    .map((e) => {
      let rec = "";
      if (e.ia_oui_hum_non >= e.ia_non_hum_oui && e.ia_oui_hum_non > 0) {
        rec = `Durcir le critère, l'IA accepte trop facilement (${e.ia_oui_hum_non}/${e.total} cas où IA OUI mais humain NON).`;
      } else if (e.ia_non_hum_oui > 0) {
        rec = `Assouplir le critère, l'IA est trop stricte (${e.ia_non_hum_oui}/${e.total} cas où IA NON mais humain OUI).`;
      }
      if (e.ia_ambigu > 1) {
        rec += ` ${rec ? "Aussi : " : ""}L'IA met AMBIGU dans ${e.ia_ambigu}/${e.total} cas, préciser dans le skill comment trancher.`;
      }
      if (e.ia_non_trouve > 1) {
        rec += ` ${rec ? "Aussi : " : ""}Documents non trouvés ${e.ia_non_trouve}/${e.total} fois, peut-être l'info est-elle dans un autre fichier.`;
      }
      return { id: e.id, intitule: e.intitule, recommandation: rec.trim() };
    });
  // Recos notation : on priorise par |Δ pts %| (écart relatif), pas par pts
  // bruts qui sont biaisés par le barème. Seuil 10 pts de % ~ "écart visible".
  const recoQ = biais_q
    .filter((q) => Math.abs(q.delta_pct) >= 10)
    .slice(0, 5)
    .map((q) => {
      const sens = q.delta_pct > 0 ? "sur-note" : "sous-note";
      const pctAbs = Math.abs(q.delta_pct).toFixed(0);
      return {
        id: q.id,
        intitule: q.intitule,
        recommandation: `L'IA ${sens} en moyenne de ${pctAbs} pts de % (IA ${q.ia_pct.toFixed(0)}% vs humain ${q.humain_pct.toFixed(0)}%, n=${q.n}). À ajuster dans evaluer-notation.skill.md.`,
      };
    });

  // Couverture : combien de Q du skill sont dans le rapport vs hors-IA vs absentes.
  const qSkillTotal = stats.qSkillTotal ?? 49;
  const qHorsIaTotal = stats.qHorsIaTotal ?? 0;
  const qDansRapport = biais_q.length;
  const qNonMatchees = Math.max(0, qSkillTotal - qDansRapport - qHorsIaTotal);
  const coverage =
    stats.colonnes !== undefined
      ? { qSkillTotal, qDansRapport, qHorsIa: qHorsIaTotal, qNonMatchees }
      : undefined;

  // ============================================================
  // Bloc coûts (mode --import : présent uniquement si au moins un dossier a
  // un `cout` attaché par fetchRunUsage). Agrégat tokens, coût total, ratio
  // de hit cache, et projections prod 296/2000 dossiers en parallélisme 3.
  // ============================================================
  const dossiersAvecCout = evalues.filter((c) => c.cout && c.cout.cost_usd > 0);
  let coutsBlock:
    | NonNullable<ReturnType<typeof buildCoutsBlock>>
    | undefined = undefined;
  if (dossiersAvecCout.length > 0) {
    coutsBlock = buildCoutsBlock(dossiersAvecCout, dureeMoy);
  }

  // Avertissement Q46 : règle changée entre 6e et 7e (seuil suivi-accompagnement
  // 15-20% en 6e vs 10-12% en 7e). Le Δ observé sur Q46 en calibrage 6e est
  // un artefact de règle, pas un vrai écart IA.
  const q46InReport = biais_q.find((q) => q.id === 46);
  if (q46InReport && Math.abs(q46InReport.delta_pct) > 5) {
    reportWarnings.push(
      `Q46 (suivi-accompagnement) : Δ de ${q46InReport.delta_pct.toFixed(1)} pp détecté. ` +
        `ATTENDU : le seuil a changé entre 6e (15-20%) et 7e (10-12%). ` +
        `Ce Δ est un artefact de règle, pas un échec de calibrage.`
    );
  }

  let alerte: string | undefined;
  if (coverage && qNonMatchees > 5) {
    alerte = `ATTENTION : ${qNonMatchees} questions du skill ne sont pas couvertes par le xlsx humain (matching insuffisant). Le calibrage est partiel.`;
  }

  // Logge la synthèse pour les ops
  console.log(
    `Rapport généré : ${qDansRapport}/${qSkillTotal} Q couvertes, ${reportWarnings.length} warnings`
  );

  return {
    meta: {
      timestamp: new Date().toISOString(),
      modele_ia: stats.modele,
      nb_dossiers: evalues.length,
      duree_moyenne_s: Math.round(dureeMoy),
      // v2 = format avec deltas en % (introduit après le bug Q37 / barème
      // mismatch xlsx-skill détecté sur le calibrage 6e du 2026-05-09). Les
      // anciens rapports v1 restent lisibles via le fallback UI.
      rapport_version: 2,
    },
    synthese: {
      accord_eligibilite: {
        ok: matchElig,
        total: evalues.length,
        pct: Number(matchPct.toFixed(1)),
      },
      delta_score_moyen: Number(deltaMoyen.toFixed(2)),
      delta_score_abs_moyen: Number(deltaAbsMoyen.toFixed(2)),
      delta_score_moyen_pct: Number(deltaMoyenPct.toFixed(2)),
      delta_score_abs_moyen_pct: Number(deltaAbsMoyenPct.toFixed(2)),
      delta_distribution: dist,
      similitude_ia_pct: similitudeIaPct,
      delta_ia_abs_moyen_pct: Number(deltaIaAbsMoyenPct.toFixed(2)),
    },
    biais_elg,
    biais_q,
    dossiers: evalues,
    recommandations: { elg: recoElg, notation: recoQ },
    coverage,
    couts: coutsBlock,
    alerte,
    warnings: reportWarnings.length > 0 ? reportWarnings : undefined,
  };
}

/**
 * Agrège tokens + coûts + projections prod à partir des dossiers ayant un
 * `cout` non nul. Parallélisme prod = 3 (limite MAX_CONCURRENT_EVALUATIONS).
 *
 * Le modèle dominant est celui le plus fréquent (utile si un calibrage a
 * traversé plusieurs modèles, ce qui ne devrait pas arriver mais on
 * sécurise).
 */
function buildCoutsBlock(
  dossiers: DossierComparison[],
  dureeMoyenneSecondesGlobal: number
): {
  total_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read: number;
  total_cache_create: number;
  cache_hit_ratio: number;
  cost_par_dossier_moyen: number;
  cost_par_dossier_min: number;
  cost_par_dossier_max: number;
  duree_moyenne_s: number;
  modele_dominant: string;
  projections: {
    nb_dossiers_296: { cost_usd: number; duree_h: number };
    nb_dossiers_2000: { cost_usd: number; duree_h: number };
  };
} {
  const PARALLELISM = 3;
  const couts = dossiers.map((d) => d.cout!);
  const total_input = couts.reduce((s, c) => s + c.input_tokens, 0);
  const total_output = couts.reduce((s, c) => s + c.output_tokens, 0);
  const total_cache_read = couts.reduce((s, c) => s + c.cache_read, 0);
  const total_cache_create = couts.reduce(
    (s, c) => s + c.cache_create_5m + c.cache_create_1h,
    0
  );
  const total_usd = couts.reduce((s, c) => s + c.cost_usd, 0);

  // Ratio hit cache : cache_read / (input_non_caché + cache_read). Mesure le
  // gain réel du caching (1.0 = tout vient du cache, 0.0 = aucun cache utile).
  const cache_hit_ratio =
    total_input + total_cache_read > 0
      ? total_cache_read / (total_input + total_cache_read)
      : 0;

  const costs = couts.map((c) => c.cost_usd);
  const cost_min = Math.min(...costs);
  const cost_max = Math.max(...costs);
  const cost_moy = total_usd / couts.length;

  // Durée moyenne dossier : on prend celle du `cout` (durée run réel) si
  // disponible, sinon le fallback global passé en argument.
  const dureesS = couts
    .map((c) => c.duration_ms / 1000)
    .filter((d) => d > 0);
  const duree_moy_s =
    dureesS.length > 0
      ? dureesS.reduce((a, b) => a + b, 0) / dureesS.length
      : dureeMoyenneSecondesGlobal;

  // Modèle dominant
  const counts = new Map<string, number>();
  for (const c of couts) {
    counts.set(c.model, (counts.get(c.model) ?? 0) + 1);
  }
  let modele_dominant = "?";
  let bestCount = -1;
  for (const [m, n] of counts.entries()) {
    if (n > bestCount) {
      bestCount = n;
      modele_dominant = m;
    }
  }

  // Projections : à coût/dossier constant, parallélisme 3.
  function project(n: number) {
    const cost_usd = Number((cost_moy * n).toFixed(2));
    const duree_h = Number(((duree_moy_s * n) / PARALLELISM / 3600).toFixed(2));
    return { cost_usd, duree_h };
  }

  return {
    total_usd: Number(total_usd.toFixed(4)),
    total_input_tokens: total_input,
    total_output_tokens: total_output,
    total_cache_read,
    total_cache_create,
    cache_hit_ratio: Number(cache_hit_ratio.toFixed(4)),
    cost_par_dossier_moyen: Number(cost_moy.toFixed(4)),
    cost_par_dossier_min: Number(cost_min.toFixed(4)),
    cost_par_dossier_max: Number(cost_max.toFixed(4)),
    duree_moyenne_s: Math.round(duree_moy_s),
    modele_dominant,
    projections: {
      nb_dossiers_296: project(296),
      nb_dossiers_2000: project(2000),
    },
  };
}

function generateReport(comparisons: DossierComparison[], stats: {
  modele: string;
  nbEvaluateurs?: number;
  totalDossiers: number;
  evalues: number;
}): string {
  const evalues = comparisons.filter((c) => c.has_eval && c.has_verite);
  const matchElig = evalues.filter((c) => c.match_eligibilite).length;
  const matchPct = evalues.length ? (matchElig / evalues.length) * 100 : 0;

  const deltas = evalues
    .filter((c) => typeof c.delta_score === "number")
    .map((c) => c.delta_score!);
  const deltaMoyen =
    deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;
  const deltaAbsMoyen =
    deltas.length
      ? deltas.map(Math.abs).reduce((a, b) => a + b, 0) / deltas.length
      : 0;
  const dist = {
    petit: deltas.filter((d) => Math.abs(d) < 5).length,
    moyen: deltas.filter((d) => Math.abs(d) >= 5 && Math.abs(d) <= 15).length,
    grand: deltas.filter((d) => Math.abs(d) > 15).length,
  };
  const dureeMoy =
    evalues
      .filter((c) => typeof c.duree_evaluation_s === "number")
      .reduce((s, c) => s + c.duree_evaluation_s!, 0) /
    Math.max(
      1,
      evalues.filter((c) => typeof c.duree_evaluation_s === "number").length
    );

  let md = `# Calibrage OIF-Eval 7e vs gold standard 6e\n\n`;
  md += `**Date** : ${new Date().toLocaleString("fr-FR")}\n`;
  md += `**Modèle IA** : \`${stats.modele}\`\n`;
  md += `**Corpus** : ${evalues.length} dossiers comparés (${stats.totalDossiers} candidatures 6e disponibles)\n`;
  if (dureeMoy > 0) md += `**Durée moyenne par évaluation** : ${Math.round(dureeMoy)}s\n`;
  md += `\n---\n\n`;

  // 1. Synthèse corpus
  md += `## 1. Synthèse corpus\n\n`;
  md += `| Métrique | Valeur | Commentaire |\n`;
  md += `|---|---|---|\n`;
  md += `| Accord verdict éligibilité | **${matchElig}/${evalues.length}** (${matchPct.toFixed(1)}%) | Cible OIF ≥ 85% |\n`;
  md += `| Δ score moyen (IA − humain) | **${fmtDelta(Number(deltaMoyen.toFixed(2)))}** pts | Idéal proche 0 (biais nul) |\n`;
  md += `| Δ score absolu moyen | **${deltaAbsMoyen.toFixed(2)}** pts | Cible < 10 pts (précision) |\n`;
  md += `| Distribution \\|Δ\\| < 5 / 5-15 / > 15 | ${dist.petit} / ${dist.moyen} / ${dist.grand} | Majorité < 15 souhaitable |\n`;
  md += `| Vitesse | ${Math.round(dureeMoy)}s/dossier | vs ~30 min humain (60x plus rapide) |\n`;
  md += `\n`;

  // 2. Biais par critère ELG
  md += `## 2. Biais par critère ELG\n\n`;
  md += `Désaccord = IA et humain ne sont pas alignés. AMBIGU IA est compté comme alignement positif si humain met OUI.\n\n`;
  const elgStats = new Map<
    string,
    { id: string; intitule: string; total: number; desaccords: number; iaOuiHumNon: number; iaNonHumOui: number; iaAmbigu: number; iaNonTrouve: number }
  >();
  for (const c of evalues) {
    for (const e of c.elg_diff) {
      if (e.statut_humain === "?") continue;
      const cur =
        elgStats.get(e.id) ??
        {
          id: e.id,
          intitule: e.intitule,
          total: 0,
          desaccords: 0,
          iaOuiHumNon: 0,
          iaNonHumOui: 0,
          iaAmbigu: 0,
          iaNonTrouve: 0,
        };
      cur.total++;
      if (!e.match) cur.desaccords++;
      if (e.statut_ia === "OUI" && e.statut_humain === "NON") cur.iaOuiHumNon++;
      if (e.statut_ia === "NON" && e.statut_humain === "OUI") cur.iaNonHumOui++;
      if (e.statut_ia === "AMBIGU") cur.iaAmbigu++;
      if (e.statut_ia === "NON_TROUVE") cur.iaNonTrouve++;
      elgStats.set(e.id, cur);
    }
  }
  const elgArr = Array.from(elgStats.values()).sort(
    (a, b) => b.desaccords - a.desaccords
  );
  md += `| ELG | Intitulé | Désaccords | IA OUI / Hum NON | IA NON / Hum OUI | IA AMBIGU | IA NON_TROUVE |\n`;
  md += `|---|---|---|---|---|---|---|\n`;
  for (const e of elgArr) {
    md += `| ${e.id} | ${e.intitule.slice(0, 50)} | ${e.desaccords}/${e.total} | ${e.iaOuiHumNon} | ${e.iaNonHumOui} | ${e.iaAmbigu} | ${e.iaNonTrouve} |\n`;
  }
  md += `\n`;
  // Pinpoint des biais
  const elgPbs = elgArr.filter((e) => e.desaccords > 0);
  if (elgPbs.length > 0) {
    md += `**Biais ELG identifiés** :\n`;
    for (const e of elgPbs.slice(0, 5)) {
      const pcts: string[] = [];
      if (e.iaOuiHumNon > 0) pcts.push(`IA trop permissive (${e.iaOuiHumNon}/${e.total})`);
      if (e.iaNonHumOui > 0) pcts.push(`IA trop stricte (${e.iaNonHumOui}/${e.total})`);
      if (e.iaAmbigu > 0) pcts.push(`IA trop souvent AMBIGU (${e.iaAmbigu}/${e.total})`);
      if (e.iaNonTrouve > 0) pcts.push(`Documents non trouvés (${e.iaNonTrouve}/${e.total})`);
      md += `- **${e.id}** ${e.intitule.slice(0, 40)} : ${pcts.join(", ")}\n`;
    }
    md += `\n`;
  } else {
    md += `**Aucun biais ELG significatif détecté.**\n\n`;
  }

  // 3. Biais par question (notation)
  md += `## 3. Biais par question (notation)\n\n`;
  md += `Δ moyen = différence moyenne (IA − humain) sur les dossiers où le matching libellé a fonctionné.\n\n`;
  const qStats = new Map<
    number,
    {
      id: number;
      intitule: string;
      bareme_max: number;
      hors_ia: boolean;
      n: number;
      deltaSum: number;
      deltaAbsSum: number;
      iaSum: number;
      humSum: number;
    }
  >();
  for (const c of evalues) {
    for (const q of c.q_diff) {
      if (q.delta == null || q.score_ia === null || q.score_humain_moyen === null) continue;
      const cur =
        qStats.get(q.id) ??
        {
          id: q.id,
          intitule: q.intitule,
          bareme_max: q.bareme_max,
          hors_ia: !!q.hors_ia,
          n: 0,
          deltaSum: 0,
          deltaAbsSum: 0,
          iaSum: 0,
          humSum: 0,
        };
      cur.n++;
      cur.deltaSum += q.delta;
      cur.deltaAbsSum += Math.abs(q.delta);
      cur.iaSum += q.score_ia;
      cur.humSum += q.score_humain_moyen;
      qStats.set(q.id, cur);
    }
  }
  const qArr = Array.from(qStats.values())
    .filter((q) => q.n >= 2)
    .map((q) => ({
      ...q,
      deltaMoyen: q.deltaSum / q.n,
      deltaAbsMoyen: q.deltaAbsSum / q.n,
      iaAvg: q.iaSum / q.n,
      humAvg: q.humSum / q.n,
    }))
    .sort((a, b) => Math.abs(b.deltaMoyen) - Math.abs(a.deltaMoyen));

  md += `**Top 15 questions où l'IA diverge le plus de l'humain (par |Δ moyen|) :**\n\n`;
  md += `| Q | Intitulé | Barème | IA moy. | Humain moy. | Δ moyen | n |\n`;
  md += `|---|---|---|---|---|---|---|\n`;
  for (const q of qArr.slice(0, 15)) {
    const tag = q.hors_ia ? " *(hors-IA)*" : "";
    md += `| Q${q.id} | ${q.intitule.slice(0, 50)}${tag} | /${q.bareme_max} | ${q.iaAvg.toFixed(2)} | ${q.humAvg.toFixed(2)} | ${fmtDelta(Number(q.deltaMoyen.toFixed(2)))} | ${q.n} |\n`;
  }
  md += `\n`;

  // 4. Détail par dossier
  md += `## 4. Détail par dossier\n\n`;
  for (const c of evalues.sort(
    (a, b) => Math.abs(b.delta_score ?? 0) - Math.abs(a.delta_score ?? 0)
  )) {
    md += `### ${emojiDelta(c.delta_score)} \`${c.id}\` — ${c.nom}\n\n`;
    md += `- **Verdict** : IA ${c.verdict_ia ?? "—"} vs humain ${c.verdict_humain ?? "—"} ${c.match_eligibilite ? "✓" : "✗"}\n`;
    md += `- **Score** : IA ${c.score_ia ?? "—"} vs humain ${c.score_humain_moyen?.toFixed(1) ?? "—"}`;
    if (c.score_humain_min != null && c.score_humain_max != null) {
      md += ` (plage humaine ${c.score_humain_min}-${c.score_humain_max})`;
    }
    if (c.nb_evaluateurs) md += ` sur ${c.nb_evaluateurs} évaluateurs`;
    md += ` — Δ ${fmtDelta(c.delta_score)}\n`;
    md += `- **ELG** : ${c.elg_match_count}/${c.elg_total_count} en accord`;
    if (c.duree_evaluation_s) md += ` — durée IA ${c.duree_evaluation_s}s`;
    md += `\n\n`;
    // ELG en désaccord uniquement
    const elgKo = c.elg_diff.filter((e) => !e.match && e.statut_humain !== "?");
    if (elgKo.length > 0) {
      md += `**ELG en désaccord (${elgKo.length}) :**\n\n`;
      for (const e of elgKo) {
        md += `- **${e.id}** ${e.intitule.slice(0, 50)} : IA \`${e.statut_ia}\` vs humain \`${e.statut_humain}\`\n`;
        if (e.justification_ia) {
          md += `  > ${e.justification_ia.slice(0, 200).replace(/\n/g, " ")}\n`;
        }
      }
      md += `\n`;
    }
    // Top 5 Q en désaccord
    const qKo = c.q_diff
      .filter((q) => q.delta != null && Math.abs(q.delta) >= 1)
      .sort((a, b) => Math.abs(b.delta!) - Math.abs(a.delta!))
      .slice(0, 5);
    if (qKo.length > 0) {
      md += `**Top 5 questions en désaccord :**\n\n`;
      for (const q of qKo) {
        const tag = q.hors_ia ? " *(hors-IA)*" : "";
        md += `- Q${q.id} ${q.intitule.slice(0, 50)}${tag} : IA ${q.score_ia}/${q.bareme_max} vs humain ${q.score_humain_moyen?.toFixed(1)} (Δ ${fmtDelta(q.delta)})\n`;
      }
      md += `\n`;
    }
    md += `---\n\n`;
  }

  // 5. Recommandations
  md += `## 5. Recommandations d'ajustement skills\n\n`;
  if (elgPbs.length > 0) {
    md += `Pour \`evaluer-eligibilite.skill.md\` :\n`;
    for (const e of elgPbs.slice(0, 3)) {
      if (e.iaOuiHumNon >= e.iaNonHumOui && e.iaOuiHumNon > 0) {
        md += `- **${e.id}** : durcir le critère, l'IA accepte trop facilement (${e.iaOuiHumNon}/${e.total} cas où IA OUI mais humain NON)\n`;
      } else if (e.iaNonHumOui > 0) {
        md += `- **${e.id}** : assouplir le critère, l'IA est trop stricte (${e.iaNonHumOui}/${e.total} cas où IA NON mais humain OUI)\n`;
      }
      if (e.iaAmbigu > 1) {
        md += `  - L'IA met AMBIGU dans ${e.iaAmbigu}/${e.total} cas : préciser dans le skill comment trancher\n`;
      }
    }
    md += `\n`;
  }
  const qToFix = qArr.filter((q) => Math.abs(q.deltaMoyen) >= 1).slice(0, 5);
  if (qToFix.length > 0) {
    md += `Pour \`evaluer-notation.skill.md\` :\n`;
    for (const q of qToFix) {
      const sens = q.deltaMoyen > 0 ? "sur-note" : "sous-note";
      md += `- **Q${q.id}** : l'IA ${sens} en moyenne de ${Math.abs(q.deltaMoyen).toFixed(1)} pts (n=${q.n})\n`;
    }
    md += `\n`;
  }
  md += `**Workflow ajustement** : depuis Paramètres → Campagnes → Nouvelle campagne → cloner fae-7e → Adapter via chat → joindre un référentiel mis à jour, ou éditer directement les skills.\n`;

  return md;
}

// ============================================================
// Mode --import : calibrage depuis un bundle utilisateur
// ============================================================

interface ImportRunOpts {
  importId: string;
  importDir: string;
  bundle: CalibrageImport;
  modele: string;
}

/**
 * Lance les évaluations IA sur un bundle importé. Appelle /api/runs pour
 * chaque dossier (3 en parallèle max), poll les statuts, charge les JSON
 * d'évaluation produits, et émet la progression à chaque dossier terminé.
 *
 * Les PDF sont à : <importDir>/dossiers/<reference>/
 * Les JSON d'évaluation sont écrits à : <importDir>/evaluations/<reference>.json
 */
async function runImportEvaluations(opts: ImportRunOpts): Promise<{
  succeeded: string[];
  failed: { reference: string; reason: string }[];
  /** Map reference -> runId (utilisé pour récupérer le coût a posteriori). */
  runIdByRef: Map<string, string>;
}> {
  const { importDir, bundle } = opts;
  const succeeded: string[] = [];
  const failed: { reference: string; reason: string }[] = [];
  // Capture du runId Claude par référence pour pouvoir interroger
  // /api/runs/:runId/usage après coup et calculer le coût par dossier.
  const runIdByRef = new Map<string, string>();

  const evalDir = resolve(importDir, "evaluations");
  mkdirSync(evalDir, { recursive: true });

  // Filtre : ne garde que les dossiers avec PDF présent ET sans évaluation existante.
  // Permet de reprendre un run partiel (coupé par tokens/crash) sans tout refaire.
  const targets = bundle.dossiers.filter((d) => {
    if (!d.hasFolder) return false;
    const existingEval = resolve(evalDir, `${d.reference}.json`);
    if (existsSync(existingEval)) {
      console.log(`  ↪ ${d.reference} : évaluation déjà présente, skip`);
      succeeded.push(d.reference);
      return false;
    }
    return true;
  });
  const total = targets.length;
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  let done = 0;

  // Émet une progression initiale (0 / total) pour que la barre s'affiche tout
  // de suite côté UI.
  emitProgress({
    done: 0,
    total,
    lastDossier: null,
    startedAt,
    etaSeconds: null,
  });

  console.log(`Total sélectionné : ${total}`);

  // Vagues de 3 (limite MAX_CONCURRENT_EVALUATIONS daemon, anti rate-limit)
  const chunks: typeof targets[] = [];
  for (let i = 0; i < targets.length; i += 5) chunks.push(targets.slice(i, i + 5));

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    console.log(
      `\n[Vague ${ci + 1}/${chunks.length}] Lancement de ${chunk.length} évaluations en parallèle...`
    );

    // Démarre chaque run via /api/runs. On attend qu'un slot soit libre côté
    // daemon (MAX_CONCURRENT_EVALUATIONS) avant chaque POST, sinon le daemon
    // refuse avec un 429-like et le run est perdu silencieusement.
    const launched: { reference: string; runId: string }[] = [];
    for (const d of chunk) {
      // Attendre un slot libre (poll toutes les 5s, max 5 min)
      const slotOk = await waitForFreeSlot(5 * 60_000);
      if (!slotOk) {
        const reason = "timeout en attendant un slot libre côté daemon";
        console.error(`  ✗ ${d.reference} : ${reason}`);
        failed.push({ reference: d.reference, reason });
        continue;
      }

      const candidateDir = resolve(importDir, "dossiers", d.reference);
      const evalJson = resolve(evalDir, `${d.reference}.json`);

      // Pré-liste les fichiers utiles + flag les inutiles, économise un Glob
      // côté Claude et lui évite de Read le RIB (pas exploitable, gros tokens).
      // Normalisation accents pour matcher "Présentation" comme "presentation".
      const norm = (s: string) =>
        s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
      const PIECES_UTILES_KEYS = [
        "present", "formulaire", "recepisse", "rapport", "budget",
        "calendrier", "attestation", "statut", "projet", "narratif",
        "cadre", "logique", "financier", "activit", "document",
        "enregistrement", "agrement", "agreement", "convention",
      ];
      const PIECES_IGNORER_KEYS = ["rib", "releve", "kbis", "cheque"];
      const fichiersDossier = (() => {
        try {
          return readdirSync(candidateDir).filter((f) => !f.startsWith("."));
        } catch {
          return [];
        }
      })();
      const isUtile = (f: string) => {
        const n = norm(f);
        return PIECES_UTILES_KEYS.some((k) => n.includes(k));
      };
      const isInutile = (f: string) => {
        const n = norm(f);
        return PIECES_IGNORER_KEYS.some((k) => n.includes(k));
      };
      const aLire = fichiersDossier.filter((f) => isUtile(f) && !isInutile(f));
      const aIgnorer = fichiersDossier.filter((f) => isInutile(f));

      const listeAlire = aLire.length > 0 ? aLire : fichiersDossier;
      const composedPrompt = `# Évaluation FAE 7e - dossier ${d.reference}

Dossier candidat : \`${candidateDir}/\`
JSON de sortie : \`${evalJson}\`

## Fichiers à lire (pré-filtré, ne refais PAS de Glob)
${listeAlire.map((f) => `- ${f}`).join("\n")}
${aIgnorer.length > 0 ? `\n## Fichiers à IGNORER (RIB/KBIS, non exploitables)\n${aIgnorer.map((f) => `- ${f}`).join("\n")}` : ""}

## Workflow
1. Read directement les fichiers ci-dessus, dans l'ordre.
   - Si un fichier .xlsx est illisible via Read (format binaire), utilise Bash :
     \`python3 -c "import openpyxl; wb=openpyxl.load_workbook('CHEMIN', data_only=True); [print(s.title, *[[str(c.value or '') for c in r] for r in s.iter_rows()], sep=chr(10)) for s in wb.worksheets]"\`
2. Active le skill 'evaluer-eligibilite' (14 critères ELG).
3. Si verdict ELIGIBLE ou ELIGIBILITE_INCERTAINE, active 'evaluer-notation' (49 Q, 16 hors-IA mises à null).
4. Compose le JSON conforme au schéma evaluation-7e et Write directement dans le chemin output.

NE PAS : lancer Task/sub-agent, lister inutilement.`;

      try {
        const r = await fetch(`${DAEMON_URL}/api/runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: composedPrompt,
            workdir: ".",
          }),
        });
        if (!r.ok) {
          const txt = await r.text();
          const reason = `POST /api/runs ${r.status}: ${txt.slice(0, 200)}`;
          console.error(`  ✗ ${d.reference} : ${reason}`);
          failed.push({ reference: d.reference, reason });
          continue;
        }
        const j = (await r.json()) as { runId: string };
        console.log(`  → ${d.reference} : run ${j.runId} démarré`);
        launched.push({ reference: d.reference, runId: j.runId });
        runIdByRef.set(d.reference, j.runId);
      } catch (err) {
        const reason = (err as Error).message;
        console.error(`  ✗ ${d.reference} : ${reason}`);
        failed.push({ reference: d.reference, reason });
      }
    }

    console.log(`  → ${launched.length} runs lancés. Attente fin de vague...`);

    // Poll jusqu'à statut terminal pour chaque run
    const start = Date.now();
    const TIMEOUT_MS = 25 * 60_000;
    const finalStatuses = new Map<string, string>();
    while (finalStatuses.size < launched.length) {
      await new Promise((r) => setTimeout(r, 8000));
      for (const l of launched) {
        if (finalStatuses.has(l.runId)) continue;
        const status = await pollRunStatus(l.runId);
        if (["succeeded", "failed", "cancelled"].includes(status)) {
          finalStatuses.set(l.runId, status);
          // À chaque dossier qui termine, émet la progression
          done++;
          const evalPath = resolve(evalDir, `${l.reference}.json`);
          const ok = existsSync(evalPath);
          if (ok) {
            succeeded.push(l.reference);
            console.log(`  ✓ ${l.reference} (status=${status})`);
          } else {
            failed.push({
              reference: l.reference,
              reason: `status=${status} sans JSON`,
            });
            console.log(`  ✗ ${l.reference} (status=${status}, pas de JSON)`);
          }
          // ETA basé sur la cadence moyenne observée
          const elapsedSec = (Date.now() - startedAtMs) / 1000;
          const remaining = total - done;
          const etaSeconds =
            done > 0 ? Math.round((elapsedSec / done) * remaining) : null;
          // Cherche le label humain pour affichage
          const dossier = bundle.dossiers.find(
            (x) => x.reference === l.reference
          );
          const lastDossier = dossier
            ? `${dossier.prenom} ${dossier.nom}`.trim() || l.reference
            : l.reference;
          emitProgress({
            done,
            total,
            lastDossier,
            startedAt,
            etaSeconds,
          });
        }
      }
      if (Date.now() - start > TIMEOUT_MS) {
        console.log(`\n  ✗ timeout après 25 min, abandon de la vague`);
        break;
      }
    }
  }

  return { succeeded, failed, runIdByRef };
}

/**
 * Récupère le coût + tokens d'un run Claude via le daemon. Renvoie null si
 * le run n'est plus en mémoire (daemon redémarré, run trop ancien) ou si
 * aucun usage n'a été capturé.
 */
async function fetchRunUsage(
  runId: string
): Promise<{
  totals: {
    input_tokens: number;
    output_tokens: number;
    cache_read: number;
    cache_create_5m: number;
    cache_create_1h: number;
    cost_usd: number;
    last_model: string | null;
  };
  model: string | null;
} | null> {
  try {
    const r = await fetch(`${DAEMON_URL}/api/runs/${runId}/usage`);
    if (!r.ok) return null;
    const j = (await r.json()) as {
      totals: {
        input_tokens: number;
        output_tokens: number;
        cache_read: number;
        cache_create_5m: number;
        cache_create_1h: number;
        cost_usd: number;
        last_model: string | null;
      };
      model: string | null;
    };
    return j;
  } catch {
    return null;
  }
}

/**
 * Charge l'évaluation IA générée pour une référence dans le dossier d'import.
 */
function loadImportEvaluation(
  importDir: string,
  reference: string
): IaEvaluation | null {
  const p = resolve(importDir, "evaluations", `${reference}.json`);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as IaEvaluation;
  } catch {
    return null;
  }
}

/**
 * Lit le score humain pour une Q donnée en passant par le mapping
 * libellé colonne xlsx -> Q skill (`bundle.colonnes`). Retourne null si :
 *  - aucune colonne du xlsx n'est mappée à cette Q,
 *  - la cellule est vide,
 *  - la valeur dépasse barème_xlsx_max * 1.01 (filet de sécurité strict).
 *
 * Le clamp utilise le **barème xlsx** (vraie référence humaine) plutôt que le
 * barème skill : un humain peut très bien noter /3 sur une Q que le skill IA
 * note /2 (cas typique 6e vs 7e). La tolérance 1% absorbe les arrondis xlsx
 * sans laisser passer les valeurs aberrantes type "2.03/2".
 */
function getHumainScore(
  d: CalibrageImport["dossiers"][number],
  qId: number,
  colonnes: ColonneXlsx[]
): {
  score: number | null;
  matchedLibelle: string | null;
  baremeXlsxMax: number | null;
} {
  const col = colonnes.find((c) => c.matchedSkillQId === qId);
  if (!col)
    return { score: null, matchedLibelle: null, baremeXlsxMax: null };
  const raw = d.scoresHumains[`col_${col.positionXlsx}`];
  if (raw == null)
    return {
      score: null,
      matchedLibelle: col.libelleXlsx,
      baremeXlsxMax: col.baremeXlsxMax,
    };
  if (col.baremeXlsxMax != null && raw > col.baremeXlsxMax * 1.01) {
    return {
      score: null,
      matchedLibelle: col.libelleXlsx,
      baremeXlsxMax: col.baremeXlsxMax,
    };
  }
  return {
    score: raw,
    matchedLibelle: col.libelleXlsx,
    baremeXlsxMax: col.baremeXlsxMax,
  };
}

/**
 * Compare un dossier importé à son évaluation IA via le mapping libellé
 * colonne xlsx -> Q skill (cf. CalibrageImport.colonnes). Refuse l'ancien
 * format positionnel (manifest sans `colonnes`) pour éviter les valeurs
 * aberrantes : il faut ré-importer le ZIP pour reconstruire le mapping.
 */
function compareImportDossier(
  reference: string,
  ia: IaEvaluation | null,
  d: CalibrageImport["dossiers"][number],
  colonnes: ColonneXlsx[]
): DossierComparison {
  const nom = `${d.prenom} ${d.nom}`.trim() || reference;
  const result: DossierComparison = {
    id: reference,
    reference,
    nom,
    elg_diff: [],
    elg_match_count: 0,
    elg_total_count: 0,
    q_diff: [],
    has_eval: !!ia,
    has_verite: true,
  };
  // Verdict humain : si le dossier est présent dans un xlsx de NOTATION OIF,
  // il est forcément éligible (sinon il n'aurait pas été noté). On force donc
  // verdict_humain = ELIGIBLE pour tout dossier dont on a une note humaine.
  // L'ancienne heuristique (moyenne >= 50) produisait des faux INELIGIBLE pour
  // les dossiers dont la note moyenne tombait juste sous le seuil arbitraire.
  if (d.moyenneHumaine != null) {
    result.verdict_humain = "ELIGIBLE";
  }
  if (!ia) return result;

  result.modele_ia = ia.evaluateur_ia?.modele;
  if (ia.horodatage) {
    const dur =
      new Date(ia.horodatage.fin).getTime() -
      new Date(ia.horodatage.debut).getTime();
    if (dur > 0) result.duree_evaluation_s = Math.round(dur / 1000);
  }

  result.verdict_ia = ia.phase_eligibilite.verdict;
  if (result.verdict_humain) {
    result.match_eligibilite =
      result.verdict_ia === result.verdict_humain ||
      (result.verdict_ia === "ELIGIBILITE_INCERTAINE" &&
        result.verdict_humain === "ELIGIBLE");
  }

  // ELG : on n'a pas les statuts humains dans l'xlsx (juste les notes Q).
  // On laisse elg_diff vide et elg_total_count = 0 ; les biais ELG ne seront
  // pas calculables sur les imports utilisateur (c'est attendu).
  for (const cIa of ia.phase_eligibilite.criteres) {
    result.elg_diff.push({
      id: cIa.id,
      intitule: cIa.intitule,
      statut_ia: cIa.statut,
      statut_humain: "?",
      match: false,
      justification_ia: cIa.justification,
    });
  }

  // Notation totale : score IA vs moyenne humaine (lue dans l'xlsx)
  if (ia.phase_notation) {
    result.score_ia = ia.phase_notation.score_total_ia;
  }
  result.score_humain_moyen = d.moyenneHumaine ?? undefined;
  if (
    typeof result.score_ia === "number" &&
    typeof result.score_humain_moyen === "number"
  ) {
    result.delta_score = Number(
      (result.score_ia - result.score_humain_moyen).toFixed(2)
    );
  }

  // Notation question par question : on passe par le mapping libellé.
  // Une Q sans colonne mappée est filtrée (pas de q_diff entry).
  if (ia.phase_notation) {
    for (const q of ia.phase_notation.questions) {
      const { score: humScore, matchedLibelle, baremeXlsxMax } = getHumainScore(
        d,
        q.id,
        colonnes
      );
      if (humScore == null && matchedLibelle == null) {
        // Pas de colonne xlsx pour cette Q : on saute (évite faux delta).
        continue;
      }
      const delta =
        q.score !== null && humScore !== null
          ? Number((q.score - humScore).toFixed(2))
          : null;
      // Δ normalisé en points de % : compare IA et humain dans LEUR référentiel
      // respectif. Indispensable quand le barème xlsx (3) diffère du barème
      // skill (2) ; sans normalisation un delta brut de -1 est ininterprétable.
      let deltaPct: number | null = null;
      if (
        q.score !== null &&
        humScore !== null &&
        q.bareme_max > 0 &&
        baremeXlsxMax != null &&
        baremeXlsxMax > 0
      ) {
        const iaPct = (q.score / q.bareme_max) * 100;
        const humPct = (humScore / baremeXlsxMax) * 100;
        deltaPct = Number((iaPct - humPct).toFixed(2));
      }
      result.q_diff.push({
        id: q.id,
        intitule: q.intitule,
        bareme_max: q.bareme_max,
        score_ia: q.score,
        score_humain_moyen: humScore,
        delta,
        matched_libelle: matchedLibelle ?? undefined,
        hors_ia: q.hors_ia,
        bareme_xlsx_max: baremeXlsxMax,
        delta_pct: deltaPct,
      });
    }
  }
  return result;
}

// ============================================================
// Main
// ============================================================

(async () => {
  // Récupère le modèle actuel + outputDir (pour lire les JSON dans le NAS si configuré)
  let modele = "?";
  try {
    const cfg = await fetch(`${DAEMON_URL}/api/app-config`).then((r) => r.json());
    modele = cfg.config?.model ?? "?";
  } catch {
    // ignore
  }
  const outDir = await resolveOutputDir();
  console.log(`Modèle Claude actif : ${modele}`);
  console.log(`Output dir         : ${outDir}`);

  // ============================================================
  // Mode --import : aucun gold standard 6e nécessaire
  // ============================================================
  if (IMPORT_ID) {
    const importDir = resolve(DATA_DIR, "calibrage", "imports", basename(IMPORT_ID));
    const manifestPath = resolve(importDir, "_import.json");
    if (!existsSync(manifestPath)) {
      console.error(`✗ Bundle introuvable : ${manifestPath}`);
      process.exit(1);
    }
    const bundle = JSON.parse(readFileSync(manifestPath, "utf8")) as CalibrageImport;
    console.log(`Bundle ${bundle.importId} : ${bundle.totalDossiers} dossiers déclarés.`);

    // Garde anti-régression : on refuse les anciens manifests sans `colonnes`
    // pour éviter de produire un rapport aux chiffres aberrants. Solution :
    // ré-importer le ZIP qui passera par le nouveau parser.
    if (!bundle.colonnes || bundle.colonnes.length === 0) {
      console.error(
        `✗ Cet import est antérieur au fix mapping (pas de champ 'colonnes' dans _import.json). Ré-importer le ZIP pour générer un mapping libellé -> Q skill.`
      );
      process.exit(1);
    }

    let runIdByRef = new Map<string, string>();
    if (!reportOnly) {
      console.log(`\n=== Lancement des évaluations IA ===`);
      const result = await runImportEvaluations({
        importId: bundle.importId,
        importDir,
        bundle,
        modele,
      });
      runIdByRef = result.runIdByRef;
      console.log(
        `\nBatch terminé : ${result.succeeded.length} succès, ${result.failed.length} échecs`
      );
    }

    // Phase 2 : comparaison
    console.log(`\n=== Comparaison aux notes humaines ===`);
    const comparisons: DossierComparison[] = [];
    const colonnes = bundle.colonnes; // garanti non-null par la garde plus haut
    for (const d of bundle.dossiers) {
      const ia = loadImportEvaluation(importDir, d.reference);
      if (!ia && !d.hasFolder) continue;
      comparisons.push(compareImportDossier(d.reference, ia, d, colonnes));
    }
    const evaluables = comparisons.filter((c) => c.has_eval);
    console.log(
      `Comparaisons exploitables : ${evaluables.length} (sur ${comparisons.length} dossiers analysés)`
    );

    // Phase 2.5 : récupération des coûts par dossier via /api/runs/:id/usage.
    // On itère sur la map runIdByRef (peuplée à `runImportEvaluations`). Si un
    // run n'est plus en mémoire (daemon redémarré, --report-only), on saute
    // sans erreur : `cout` reste `undefined` côté rapport.
    if (runIdByRef.size > 0) {
      console.log(`\n=== Récupération des coûts par dossier ===`);
      let withCost = 0;
      for (const c of comparisons) {
        if (!c.has_eval || !c.reference) continue;
        const runId = runIdByRef.get(c.reference);
        if (!runId) continue;
        const usage = await fetchRunUsage(runId);
        if (!usage || usage.totals.cost_usd === 0) continue;
        c.cout = {
          input_tokens: usage.totals.input_tokens,
          output_tokens: usage.totals.output_tokens,
          cache_read: usage.totals.cache_read,
          cache_create_5m: usage.totals.cache_create_5m,
          cache_create_1h: usage.totals.cache_create_1h,
          cost_usd: usage.totals.cost_usd,
          model:
            usage.model ?? usage.totals.last_model ?? c.modele_ia ?? modele,
          duration_ms: (c.duree_evaluation_s ?? 0) * 1000,
        };
        withCost++;
      }
      console.log(
        `  ${withCost}/${comparisons.length} dossiers ont un coût attaché.`
      );
    }

    // Phase 3 : rapport (mêmes générateurs que le mode 6e)
    const reportDir = resolve(DATA_DIR, "calibrage");
    mkdirSync(reportDir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const reportPath = resolve(reportDir, `rapport-${stamp}-import.md`);
    const md = generateReport(comparisons, {
      modele,
      totalDossiers: bundle.totalDossiers,
      evalues: evaluables.length,
    });
    writeFileSync(reportPath, md);
    console.log(`\n✓ Rapport markdown : ${reportPath}`);

    // Pour la couverture, compte les Q définies dans le skill via une IA eval
    // de référence (la plus complète). Toutes les évaluations IA contiennent
    // les 49 questions donc n'importe laquelle suffit.
    let qSkillTotal = 49;
    let qHorsIaTotal = 0;
    const refEval = comparisons.find((c) => c.has_eval && c.q_diff.length > 0);
    if (refEval) {
      // q_diff est filtré aux Q matchées, donc on doit relire l'eval brute
      const ref = refEval.reference;
      if (ref) {
        const raw = loadImportEvaluation(importDir, ref);
        if (raw?.phase_notation?.questions) {
          qSkillTotal = raw.phase_notation.questions.length;
          qHorsIaTotal = raw.phase_notation.questions.filter((q) => q.hors_ia).length;
        }
      }
    }
    const jsonReport = generateJsonReport(comparisons, {
      modele,
      totalDossiers: bundle.totalDossiers,
      colonnes,
      qSkillTotal,
      qHorsIaTotal,
    });
    const jsonPath = reportPath.replace(/\.md$/, ".json");
    writeFileSync(jsonPath, JSON.stringify(jsonReport, null, 2));
    console.log(`✓ Rapport JSON     : ${jsonPath}`);

    // Synthèse rapide
    const matchElig = evaluables.filter((c) => c.match_eligibilite).length;
    const deltas = evaluables
      .filter((c) => typeof c.delta_score === "number")
      .map((c) => c.delta_score!);
    const dMoy = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;
    console.log(`\nSynthèse rapide :`);
    console.log(
      `  - Accord verdict éligibilité : ${matchElig}/${evaluables.length}`
    );
    console.log(`  - Δ score moyen IA-humain : ${dMoy.toFixed(2)} pts`);
    return;
  }

  // ============================================================
  // Mode legacy 6e : besoin du gold standard sur disque
  // ============================================================
  const verite = loadVerite();
  const dossiers = listDossiers6e();
  console.log(`Vérité-terrain : ${verite.size} entrées humaines.`);
  console.log(`Dossiers 6e dans data/ : ${dossiers.length}`);

  // Phase 1 : sélection + lancement (sauf en --report-only)
  let selectedIds: string[] = [];
  if (stratified && !reportOnly) {
    const existing = new Set(
      readdirSync(resolve(DATA_DIR, "evaluations"))
        .filter((f) => f.endsWith(".json") && !f.includes("AFDB"))
        .map((f) => f.replace(/\.json$/, ""))
    );
    const sample = selectStratifiedSample(dossiers, verite, existing);
    console.log(`\n=== Sélection stratifiée ===`);
    console.log(`Haut (>75)        : ${sample.haut.length}`);
    console.log(`Moyen-haut (65-75): ${sample.moyenHaut.length}`);
    console.log(`Moyen-bas (50-65) : ${sample.moyenBas.length}`);
    console.log(`Bas (<50)         : ${sample.bas.length}`);
    console.log(`Inéligibles       : ${sample.inelig.length}`);
    selectedIds = [
      ...sample.haut,
      ...sample.moyenHaut,
      ...sample.moyenBas,
      ...sample.bas,
      ...sample.inelig,
    ].map((s) => s.id);
    console.log(`Total sélectionné : ${selectedIds.length}`);
    if (MAX_NEW > 0 && selectedIds.length > MAX_NEW) {
      selectedIds = selectedIds.slice(0, MAX_NEW);
    }
    console.log(`\n=== Lancement de ${selectedIds.length} évaluations en batch ===`);
    const result = await batchAndWait(selectedIds);
    console.log(
      `\nBatch terminé : ${result.succeeded.length} succès, ${result.failed.length} échecs`
    );
    if (result.failed.length > 0) {
      console.log("Échecs :");
      for (const f of result.failed) console.log(`  - ${f.id} : ${f.reason}`);
    }
  } else if (doEvaluer && MAX_NEW > 0) {
    // Mode legacy --evaluer --max N
    const sans = dossiers.filter((id) => !loadEvaluation(id)).slice(0, MAX_NEW);
    selectedIds = sans;
    console.log(`\n=== Mode séquentiel : ${sans.length} évaluations ===`);
    for (let i = 0; i < sans.length; i++) {
      const id = sans[i];
      console.log(`[${i + 1}/${sans.length}] ${id}`);
      try {
        const r = await fetch(`${DAEMON_URL}/api/runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: `/evaluer ${id}`,
            workdir: ".",
            user: "calibrage",
          }),
        });
        const j = (await r.json()) as { runId: string };
        // Poll
        for (;;) {
          await new Promise((rr) => setTimeout(rr, 5000));
          const rr = await fetch(`${DAEMON_URL}/api/runs/${j.runId}`).then(
            (r) => r.json()
          );
          if (["succeeded", "failed", "cancelled"].includes(rr.status)) {
            console.log(`  status=${rr.status}`);
            break;
          }
        }
      } catch (e) {
        console.error(`  ✗ ${(e as Error).message}`);
      }
    }
  }

  // Phase 2 : comparaison enrichie
  console.log(`\n=== Comparaison enrichie ===`);
  const comparisons: DossierComparison[] = [];
  for (const id of dossiers) {
    const ref = extractReference(id);
    const ia = loadEvaluation(id);
    const v = ref ? verite.get(ref) ?? null : null;
    if (!ia && !v) continue;
    comparisons.push(compareDetailed(id, ia, v));
  }

  const evaluables = comparisons.filter((c) => c.has_eval && c.has_verite);
  console.log(
    `Comparaisons exploitables : ${evaluables.length} (sur ${comparisons.length} dossiers analysés)`
  );

  // Phase 3 : rapport
  const reportDir = resolve(DATA_DIR, "calibrage");
  mkdirSync(reportDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const reportPath = resolve(
    reportDir,
    `rapport-${stamp}${stratified ? "-stratified" : ""}.md`
  );
  const md = generateReport(comparisons, {
    modele,
    totalDossiers: dossiers.length,
    evalues: evaluables.length,
  });
  writeFileSync(reportPath, md);
  console.log(`\n✓ Rapport markdown : ${reportPath}`);

  // Export JSON parallèle pour l'UI Paramètres > Rapport de calibrage
  const jsonReport = generateJsonReport(comparisons, {
    modele,
    totalDossiers: dossiers.length,
  });
  const jsonPath = reportPath.replace(/\.md$/, ".json");
  writeFileSync(jsonPath, JSON.stringify(jsonReport, null, 2));
  console.log(`✓ Rapport JSON     : ${jsonPath}`);

  // Synthèse console
  const matchElig = evaluables.filter((c) => c.match_eligibilite).length;
  const deltas = evaluables
    .filter((c) => typeof c.delta_score === "number")
    .map((c) => c.delta_score!);
  const dMoy = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;
  console.log(
    `\nSynthèse rapide :`
  );
  console.log(
    `  - Accord verdict éligibilité : ${matchElig}/${evaluables.length} (${((matchElig / Math.max(1, evaluables.length)) * 100).toFixed(1)}%)`
  );
  console.log(`  - Δ score moyen IA-humain : ${dMoy.toFixed(2)} pts`);
  console.log(
    `  - |Δ| < 5 / 5-15 / > 15 : ${deltas.filter((d) => Math.abs(d) < 5).length} / ${deltas.filter((d) => Math.abs(d) >= 5 && Math.abs(d) <= 15).length} / ${deltas.filter((d) => Math.abs(d) > 15).length}`
  );
})();
