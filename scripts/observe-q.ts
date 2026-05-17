#!/usr/bin/env tsx
/**
 * Outil de diagnostic : deep-dive sur 1 question pour 1 dossier.
 *
 * Affiche :
 *   - La note IA (score, statut, source, justification)
 *   - La note humaine du gold standard
 *   - Le delta
 *   - Le texte de la règle skill pour cette question
 *   - Une analyse cause de la divergence
 *
 * Usage :
 *   npx tsx scripts/observe-q.ts --dossier fc40154ab4 --q 4
 *   npx tsx scripts/observe-q.ts --dossier 29e0252257 --q 31
 *
 * Options :
 *   --dossier <id>     ID du dossier (10 chars hex, ou référence complète avec préfixe)
 *   --q <N>            Numéro de question (1-49)
 *   --all-deltas       Affiche TOUTES les questions avec delta != 0 (sans --q)
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = resolve(ROOT, "data");
const VERITE_PATH =
  process.env.FAE_VERITE_TERRAIN ??
  "/Users/nicolascleton/Documents/Memoire/memoireclients/OIF/00-Inbox/OIF/_verite-terrain-6e.jsonl";

const SKILL_PATH = resolve(
  DATA_DIR,
  ".claude/skills/campaigns/fae-7e/skills/evaluer-notation.skill.md"
);
const MAPPING_PATH = resolve(DATA_DIR, "calibrage/mapping-6e-7e.json");

// ============================================================
// Args
// ============================================================

const args = process.argv.slice(2);
const dossierArg = args[args.indexOf("--dossier") + 1] ?? null;
const qArg = args.indexOf("--q") >= 0 ? Number(args[args.indexOf("--q") + 1]) : null;
const allDeltas = args.includes("--all-deltas");

if (!dossierArg) {
  console.error("Usage: npx tsx scripts/observe-q.ts --dossier <id> [--q <N>] [--all-deltas]");
  process.exit(1);
}

// ============================================================
// Types
// ============================================================

interface IaQuestion {
  id: number;
  intitule: string;
  bareme_max: number;
  score: number | null;
  statut?: string;
  source?: string;
  justification?: string;
  hors_ia?: boolean;
}

interface IaEvaluation {
  dossier_id: string;
  phase_notation?: {
    questions: IaQuestion[];
    score_total_ia: number;
  };
}

interface VeriteEvaluation {
  evaluateur: string;
  score: number;
  score_max: number | null;
  criteres_notation: Record<string, string | number>;
}

interface VeriteEntry {
  reference: string;
  nom?: string;
  prenom?: string;
  notation?: {
    score_moyenne?: number;
    evaluations?: VeriteEvaluation[];
  };
}

// ============================================================
// Chargement
// ============================================================

function loadEvaluation(id: string): IaEvaluation | null {
  const candidates = [
    resolve(DATA_DIR, "evaluations", `${id}.json`),
  ];
  // Try resolving short id (10 hex chars) from file list
  const evalDir = resolve(DATA_DIR, "evaluations");
  if (existsSync(evalDir)) {
    for (const f of readdirSync(evalDir)) {
      if (f.endsWith(".json") && f.includes(id)) {
        candidates.push(resolve(evalDir, f));
      }
    }
  }
  for (const p of candidates) {
    if (existsSync(p)) {
      try { return JSON.parse(readFileSync(p, "utf8")) as IaEvaluation; } catch { /* skip */ }
    }
  }
  return null;
}

function loadVerite(): Map<string, VeriteEntry> {
  const map = new Map<string, VeriteEntry>();
  if (!existsSync(VERITE_PATH)) return map;
  for (const line of readFileSync(VERITE_PATH, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as VeriteEntry;
      if (e.reference) map.set(e.reference, e);
    } catch { /* skip */ }
  }
  return map;
}

function extractReference(id: string): string | null {
  const m = id.match(/([0-9a-f]{10})$/);
  return m ? m[1] : null;
}

function normalizeLabel(s: string): string {
  if (!s) return "";
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/['']/g, " ")
    .toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

function keywords(s: string): Set<string> {
  const STOP = new Set(["le","la","les","de","des","du","et","ou","un","une",
    "a","au","aux","en","dans","que","qui","ce","cet","cette","ces","se","est","sont","pour","par"]);
  return new Set(normalizeLabel(s).split(/\s+/).filter((w) => w.length >= 4 && !STOP.has(w)));
}

function similarity(a: string, b: string): number {
  const ka = keywords(a); const kb = keywords(b);
  if (ka.size === 0 || kb.size === 0) return 0;
  let inter = 0;
  for (const w of ka) if (kb.has(w)) inter++;
  const union = ka.size + kb.size - inter;
  return union > 0 ? inter / union : 0;
}

/** Extrait le texte de la section QN du skill. */
function extractSkillSection(qNum: number): string {
  if (!existsSync(SKILL_PATH)) return "(skill introuvable)";
  const content = readFileSync(SKILL_PATH, "utf8");
  // Match "### QN " or "### QN ["
  const headRe = new RegExp(`\\n### Q${qNum}[\\s\\[]`, "m");
  const nextRe = /\n### Q\d+[\s\[]/m;
  const startMatch = headRe.exec(content);
  if (!startMatch) return `(section Q${qNum} non trouvée dans le skill)`;
  const startIdx = startMatch.index + 1;
  const afterStart = content.slice(startIdx);
  const nextMatch = nextRe.exec(afterStart);
  const section = nextMatch ? afterStart.slice(0, nextMatch.index) : afterStart.slice(0, 800);
  return section.trim();
}

/** Diagnose la cause probable du delta. */
function diagnoseCause(qNum: number, scoreIa: number | null, scoreHumain: number | null, justification: string): string {
  const delta = (scoreIa ?? 0) - (scoreHumain ?? 0);
  if (delta === 0) return "Aucun - scores identiques.";

  const causes: string[] = [];

  if (scoreIa === 0 && justification?.toLowerCase().includes("non_trouve")) {
    causes.push("SOURCE_MANQUEE - IA a mis NON_TROUVE, peut-être n'a pas lu le bon fichier (xlsx budget ?)");
  }
  if (qNum === 4 && scoreIa === 0) {
    causes.push("DEVISE_NON_CONVERTIE - Q4 budget : IA n'a peut-être pas converti la devise en EUR");
  }
  if (qNum === 37) {
    causes.push("ARTEFACT_MAPPING - Q37 : barème xlsx 6e est /3 mais skill 7e est /1. Delta peut être un artefact.");
  }
  if (delta < 0 && Math.abs(delta) >= 1) {
    causes.push("IA sous-note - possibles causes : SEUIL_FLOU (palier textuel vague), GENERALITE_REJETEE (IA trop stricte sur formulations approximatives)");
  }
  if (delta > 0 && delta >= 1) {
    causes.push("IA sur-note - possibles causes : GENERALITE_TOLEREE (IA trop généreuse), CRITERE_ABSENT (critère discriminant manquant dans le skill)");
  }
  if (justification?.toLowerCase().includes("ambigu")) {
    causes.push("AMBIGU - IA a marqué ambigu, le score médian a peut-être divergé de la note humaine");
  }

  return causes.length > 0 ? causes.join("\n  ") : `delta = ${delta > 0 ? "+" : ""}${delta} - cause non déterminée automatiquement, analyser justification manuellement.`;
}

// ============================================================
// Récupération score humain
// ============================================================

function getHumanScore(
  intituleIa: string,
  evaluations: VeriteEvaluation[]
): { scoreMoyen: number | null; details: string } {
  const scores: number[] = [];
  const matchesFound: string[] = [];

  for (const ev of evaluations) {
    if (ev.evaluateur === "Classement général") continue;
    let bestKey: string | undefined;
    let bestSim = 0;
    for (const key of Object.keys(ev.criteres_notation)) {
      const sim = similarity(intituleIa, key);
      if (sim > bestSim) { bestSim = sim; bestKey = key; }
    }
    if (bestKey && bestSim >= 0.25) {
      const raw = ev.criteres_notation[bestKey];
      const num = typeof raw === "number" ? raw : Number(String(raw).split("/")[0].trim());
      if (!Number.isNaN(num)) {
        scores.push(num);
        matchesFound.push(`  ${ev.evaluateur}: ${num} (libellé xlsx: "${bestKey}", similarité: ${bestSim.toFixed(2)})`);
      }
    }
  }

  if (scores.length === 0) return { scoreMoyen: null, details: "  Aucune correspondance trouvée dans la vérité-terrain (similarité < 0.25)" };
  const moy = scores.reduce((a, b) => a + b, 0) / scores.length;
  return { scoreMoyen: Number(moy.toFixed(2)), details: matchesFound.join("\n") };
}

// ============================================================
// Affichage d'une question
// ============================================================

function displayQuestion(
  qNum: number,
  iaQ: IaQuestion | undefined,
  veriteEntry: VeriteEntry | null
): void {
  const line = "=".repeat(60);
  console.log(`\n${line}`);
  console.log(`Q${qNum} - ${iaQ?.intitule ?? "?"}`);
  console.log(line);

  // IA
  console.log("\n--- NOTE IA ---");
  if (!iaQ) {
    console.log("  Question introuvable dans l'évaluation IA.");
  } else if (iaQ.hors_ia) {
    console.log("  Question HORS IA (réservée humain).");
  } else {
    console.log(`  Score    : ${iaQ.score ?? "null"} / ${iaQ.bareme_max}`);
    console.log(`  Statut   : ${iaQ.statut ?? "?"}`);
    console.log(`  Source   : ${iaQ.source || "(aucune)"}`);
    console.log(`  Justif   : ${iaQ.justification || "(aucune)"}`);
  }

  // Humain
  console.log("\n--- NOTE HUMAINE (vérité-terrain) ---");
  let scoreHumain: number | null = null;
  if (!veriteEntry?.notation?.evaluations?.length) {
    console.log("  Pas de vérité-terrain pour ce dossier.");
  } else if (iaQ) {
    const { scoreMoyen, details } = getHumanScore(iaQ.intitule, veriteEntry.notation.evaluations);
    scoreHumain = scoreMoyen;
    if (scoreMoyen !== null) {
      console.log(`  Score moyen humain : ${scoreMoyen}`);
      console.log(`  Détail par évaluateur :\n${details}`);
    } else {
      console.log("  Aucune correspondance trouvée.");
      console.log(details);
    }
  }

  // Delta
  console.log("\n--- DELTA ---");
  if (iaQ && !iaQ.hors_ia && scoreHumain !== null) {
    const delta = (iaQ.score ?? 0) - scoreHumain;
    const sign = delta > 0 ? "+" : "";
    console.log(`  Δ = ${sign}${delta.toFixed(2)} (IA ${iaQ.score ?? "null"} vs humain ${scoreHumain})`);

    if (delta !== 0) {
      console.log("\n--- ANALYSE CAUSE ---");
      console.log(`  ${diagnoseCause(qNum, iaQ.score, scoreHumain, iaQ.justification ?? "")}`);
    }
  } else if (iaQ?.hors_ia) {
    console.log("  Question hors IA - pas de delta à calculer.");
  } else {
    console.log("  Impossible de calculer le delta (données manquantes).");
  }

  // Règle skill
  console.log("\n--- RÈGLE SKILL ---");
  console.log(extractSkillSection(qNum));
}

// ============================================================
// Main
// ============================================================

const veriteMap = loadVerite();
const eval_ = loadEvaluation(dossierArg);

if (!eval_) {
  console.error(`✗ Évaluation introuvable pour dossier "${dossierArg}"`);
  console.error(`  Cherché dans : data/evaluations/${dossierArg}.json`);
  console.error("  Lancez d'abord une évaluation via l'interface ou calibrage-loop.ts");
  process.exit(1);
}

const ref = extractReference(eval_.dossier_id ?? dossierArg);
const veriteEntry = ref ? veriteMap.get(ref) ?? null : null;

const nomDossier = veriteEntry
  ? `${veriteEntry.prenom ?? ""} ${veriteEntry.nom ?? ""}`.trim() || dossierArg
  : dossierArg;

console.log(`\nDossier : ${eval_.dossier_id} - ${nomDossier}`);
console.log(`Référence 6e : ${ref ?? "(non trouvée)"}`);
console.log(`Vérité-terrain : ${veriteEntry ? "trouvée" : "introuvable"}`);

if (!eval_.phase_notation) {
  console.error("✗ Ce dossier n'a pas de phase_notation (inéligible ou évaluation incomplète).");
  process.exit(1);
}

const questions = eval_.phase_notation.questions;

if (allDeltas) {
  // Affiche toutes les questions avec delta != 0
  console.log("\n\n=== MODE ALL-DELTAS ===");
  console.log("Questions avec Δ ≠ 0 :\n");
  const rows: { q: number; intitule: string; scoreIa: number | null; scoreHumain: number | null; delta: number }[] = [];

  for (const q of questions) {
    if (q.hors_ia) continue;
    let scoreHumain: number | null = null;
    if (veriteEntry?.notation?.evaluations?.length) {
      const { scoreMoyen } = getHumanScore(q.intitule, veriteEntry.notation.evaluations);
      scoreHumain = scoreMoyen;
    }
    if (scoreHumain !== null) {
      const delta = (q.score ?? 0) - scoreHumain;
      if (Math.abs(delta) >= 0.1) {
        rows.push({ q: q.id, intitule: q.intitule, scoreIa: q.score, scoreHumain, delta });
      }
    }
  }

  rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  for (const r of rows) {
    const sign = r.delta > 0 ? "+" : "";
    console.log(`  Q${String(r.q).padStart(2)} ${r.intitule.slice(0, 40).padEnd(40)} | IA:${String(r.scoreIa).padStart(4)} vs H:${String(r.scoreHumain).padStart(5)} | Δ ${sign}${r.delta.toFixed(2)}`);
  }

  if (rows.length === 0) {
    console.log("  Aucun delta trouvé - scores IA = scores humains pour toutes les questions matchées.");
  }
} else if (qArg !== null) {
  const iaQ = questions.find((q) => q.id === qArg);
  displayQuestion(qArg, iaQ, veriteEntry);
} else {
  console.error("Usage: --q <N> pour une question, ou --all-deltas pour toutes.");
  process.exit(1);
}
