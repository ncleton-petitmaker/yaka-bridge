#!/usr/bin/env tsx
/**
 * Boucle de calibrage 3 dossiers.
 *
 * Workflow :
 *   1. Sélectionne les dossiers (aléatoire ou --ids explicites)
 *   2. Relance les évaluations IA (--force pour effacer les anciens JSON)
 *   3. Attend la fin des runs (poll daemon)
 *   4. Compare vs vérité-terrain humaine (questions IA uniquement, hors_ia exclues)
 *   5. Identifie les 5 questions avec le plus grand |Δ|
 *   6. Pour chaque question : génère une proposition de règle améliorée
 *   7. Écrit les propositions dans propositions/
 *
 * Usage :
 *   npx tsx scripts/calibrage-loop.ts --random 3
 *   npx tsx scripts/calibrage-loop.ts --random 3 --force
 *   npx tsx scripts/calibrage-loop.ts --ids fc40154ab4,7348c0158c,8c60fb020e
 *   npx tsx scripts/calibrage-loop.ts --ids fc40154ab4 --report-only
 *   npx tsx scripts/calibrage-loop.ts --ids fc40154ab4 --q 31
 *
 * Options :
 *   --random <N>          Pioche N dossiers aléatoires dans candidatures-6e/ (recommandé : 3)
 *   --ids <id1,id2,id3>   IDs explicites (alternatif à --random)
 *   --force               Efface les évaluations existantes avant de relancer
 *   --report-only         Génère le rapport sans relancer d'évaluations
 *   --q <N>               Focus sur une seule question dans l'analyse
 *   --no-proposals        Ne génère pas de fichiers de propositions
 *
 * Note : seules les questions IA-évaluables (hors_ia=false) sont incluses dans le
 * calcul des deltas et du score de comparaison. Les 16 questions hors_ia sont ignorées.
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = resolve(ROOT, "data");
const DAEMON_URL = process.env.FAE_DAEMON_URL ?? "http://localhost:7456";
const VERITE_PATH =
  process.env.FAE_VERITE_TERRAIN ??
  "/Users/nicolascleton/Documents/Memoire/memoireclients/OIF/00-Inbox/OIF/_verite-terrain-6e.jsonl";

const SKILL_PATH = resolve(
  DATA_DIR,
  ".claude/skills/campaigns/fae-7e/skills/evaluer-notation.skill.md"
);
const PROPS_DIR = resolve(
  DATA_DIR,
  ".claude/skills/campaigns/fae-7e/propositions"
);

// ============================================================
// Args
// ============================================================

const args = process.argv.slice(2);
const idsArg = args.indexOf("--ids") >= 0 ? args[args.indexOf("--ids") + 1] : null;
const randomArg = args.indexOf("--random") >= 0 ? Number(args[args.indexOf("--random") + 1]) : null;
const forceReeval = args.includes("--force");
const reportOnly = args.includes("--report-only");
const noProposals = args.includes("--no-proposals");
const focusQ = args.indexOf("--q") >= 0 ? Number(args[args.indexOf("--q") + 1]) : null;

if (!idsArg && !randomArg) {
  console.error("Usage:");
  console.error("  npx tsx scripts/calibrage-loop.ts --random 3 [--force]");
  console.error("  npx tsx scripts/calibrage-loop.ts --ids fc40154ab4,7348c0158c [--force] [--report-only]");
  process.exit(1);
}

/**
 * Pioche N IDs aléatoires parmi les dossiers candidatures-6e/ qui ont
 * une entrée dans la vérité-terrain (sinon inutile de les évaluer).
 */
function pickRandomDossiers(n: number, veriteMap: Map<string, VeriteEntry>): string[] {
  const corpus6eDir = resolve(DATA_DIR, "candidatures-6e");
  if (!existsSync(corpus6eDir)) {
    console.error("✗ candidatures-6e/ introuvable");
    process.exit(1);
  }
  // Chaque entrée est du style "Prenom-Nom-<ref10hex>" ou "<ref10hex>"
  const all = readdirSync(corpus6eDir).filter((entry) => {
    const ref = entry.match(/([0-9a-f]{10})$/)?.[1];
    return ref && veriteMap.has(ref);
  });
  if (all.length === 0) {
    console.error("✗ Aucun dossier candidatures-6e/ trouvé avec entrée dans la vérité-terrain");
    process.exit(1);
  }
  // Shuffle Fisher-Yates
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all.slice(0, Math.min(n, all.length)).map((entry) => {
    // Retourne le répertoire complet (sera résolu dans findCandidatureDir)
    // mais on extrait l'ID pour le nom du fichier d'évaluation
    return entry.match(/([0-9a-f]{10})$/)?.[1] ?? entry;
  });
}

// IDs résolus plus bas (après chargement vérité-terrain pour --random)
let DOSSIER_IDS: string[] = idsArg
  ? idsArg.split(",").map((s) => s.trim()).filter(Boolean)
  : []; // sera rempli après loadVerite() si --random

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
  phase_eligibilite: {
    verdict: string;
  };
}

interface VeriteEvaluation {
  evaluateur: string;
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
// Helpers
// ============================================================

function loadVerite(): Map<string, VeriteEntry> {
  const map = new Map<string, VeriteEntry>();
  if (!existsSync(VERITE_PATH)) { console.warn("⚠ vérité-terrain introuvable"); return map; }
  for (const line of readFileSync(VERITE_PATH, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line) as VeriteEntry; if (e.reference) map.set(e.reference, e); } catch { /* skip */ }
  }
  return map;
}

function extractReference(id: string): string | null {
  const m = id.match(/([0-9a-f]{10})$/);
  return m ? m[1] : null;
}

function loadEvaluation(id: string): IaEvaluation | null {
  const p = resolve(DATA_DIR, "evaluations", `${id}.json`);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")) as IaEvaluation; } catch { return null; }
}

function normalizeLabel(s: string): string {
  if (!s) return "";
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/['']/g, " ")
    .toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

function keywords(s: string): Set<string> {
  const STOP = new Set(["le","la","les","de","des","du","et","ou","un","une","a","au","aux","en","dans","que","qui","ce","cet","cette","ces","se","est","sont","pour","par"]);
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

function getHumanScoreMoyen(intituleIa: string, evaluations: VeriteEvaluation[]): number | null {
  const scores: number[] = [];
  for (const ev of evaluations) {
    if (ev.evaluateur === "Classement général") continue;
    let bestSim = 0; let bestKey: string | undefined;
    for (const key of Object.keys(ev.criteres_notation)) {
      const sim = similarity(intituleIa, key);
      if (sim > bestSim) { bestSim = sim; bestKey = key; }
    }
    if (bestKey && bestSim >= 0.25) {
      const raw = ev.criteres_notation[bestKey];
      const num = typeof raw === "number" ? raw : Number(String(raw).split("/")[0].trim());
      if (!Number.isNaN(num)) scores.push(num);
    }
  }
  if (scores.length === 0) return null;
  return Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2));
}

function extractSkillSection(qNum: number): string {
  if (!existsSync(SKILL_PATH)) return "(skill introuvable)";
  const content = readFileSync(SKILL_PATH, "utf8");
  const headRe = new RegExp(`\\n### Q${qNum}[\\s\\[]`, "m");
  const nextRe = /\n### Q\d+[\s\[]/m;
  const startMatch = headRe.exec(content);
  if (!startMatch) return `(section Q${qNum} non trouvée)`;
  const startIdx = startMatch.index + 1;
  const afterStart = content.slice(startIdx);
  const nextMatch = nextRe.exec(afterStart);
  return (nextMatch ? afterStart.slice(0, nextMatch.index) : afterStart.slice(0, 1000)).trim();
}

async function pollRunStatus(runId: string): Promise<string> {
  try {
    const r = await fetch(`${DAEMON_URL}/api/runs/${runId}`);
    if (!r.ok) return "unknown";
    const j = await r.json() as { status: string };
    return j.status ?? "unknown";
  } catch { return "unknown"; }
}

// ============================================================
// Résolution dossier -> chemin candidature
// ============================================================

function findCandidatureDir(id: string): string | null {
  for (const corpus of ["candidatures-7e", "candidatures-6e", "candidatures-test"]) {
    const base = resolve(DATA_DIR, corpus);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) {
      if (entry.endsWith(id) || entry === id) return resolve(base, entry);
    }
  }
  return null;
}

// ============================================================
// Lancement évaluations
// ============================================================

async function launchEvaluations(ids: string[]): Promise<void> {
  if (forceReeval) {
    for (const id of ids) {
      const p = resolve(DATA_DIR, "evaluations", `${id}.json`);
      if (existsSync(p)) { unlinkSync(p); console.log(`  🗑 ${id}.json effacé`); }
    }
  }

  const toEval = ids.filter((id) => {
    const p = resolve(DATA_DIR, "evaluations", `${id}.json`);
    if (existsSync(p)) { console.log(`  ⏭ ${id} - évaluation déjà présente (--force pour relancer)`); return false; }
    return true;
  });

  if (toEval.length === 0) { console.log("  Aucune évaluation à lancer."); return; }

  const launched: { id: string; runId: string }[] = [];
  for (const id of toEval) {
    const dir = findCandidatureDir(id);
    if (!dir) { console.log(`  ✗ ${id} : dossier candidature non trouvé`); continue; }

    const evalJson = resolve(DATA_DIR, "evaluations", `${id}.json`);
    const fichiers = readdirSync(dir).map((f) => resolve(dir, f));
    const listeAlire = fichiers.filter((f) => {
      const n = f.toLowerCase();
      return !n.includes("rib") && !n.includes("kbis") && !n.includes("piece-inutile");
    });

    const prompt = `# Calibrage FAE 7e - dossier ${id}

Dossier candidat : \`${dir}/\`
JSON de sortie : \`${evalJson}\`

## Fichiers à lire (ne refais PAS de Glob)
${listeAlire.map((f) => `- ${f}`).join("\n")}

## Workflow
1. Read directement les fichiers ci-dessus, dans l'ordre.
2. Active le skill 'evaluer-eligibilite' (14 critères ELG).
3. Si verdict ELIGIBLE ou ELIGIBILITE_INCERTAINE, active 'evaluer-notation' (49 Q, 16 hors-IA mises à null).
4. Compose le JSON conforme au schéma evaluation-7e et Write directement dans le chemin output.

NE PAS : exécuter Bash, lancer Task/sub-agent, lister inutilement.`;

    try {
      const r = await fetch(`${DAEMON_URL}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: prompt, workdir: "." }),
      });
      if (!r.ok) { console.error(`  ✗ ${id} : POST /api/runs ${r.status}`); continue; }
      const j = await r.json() as { runId: string };
      launched.push({ id, runId: j.runId });
      console.log(`  → ${id} : run ${j.runId} démarré`);
    } catch (err) {
      console.error(`  ✗ ${id} : ${(err as Error).message}`);
    }
  }

  if (launched.length === 0) return;

  console.log(`\n  Attente de ${launched.length} run(s)...`);
  const start = Date.now();
  const TIMEOUT_MS = 25 * 60_000;
  const done = new Map<string, string>();

  while (done.size < launched.length && Date.now() - start < TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, 8000));
    for (const l of launched) {
      if (done.has(l.runId)) continue;
      const status = await pollRunStatus(l.runId);
      if (["succeeded", "failed", "cancelled"].includes(status)) {
        done.set(l.runId, status);
        const ok = existsSync(resolve(DATA_DIR, "evaluations", `${l.id}.json`));
        console.log(`  ${ok ? "✓" : "✗"} ${l.id} (${status}${ok ? "" : ", pas de JSON"})`);
      }
    }
    const remaining = launched.length - done.size;
    if (remaining > 0) process.stdout.write(`\r  ⏳ ${remaining} restants...`);
  }
  console.log("");
}

// ============================================================
// Analyse des deltas
// ============================================================

interface QDelta {
  q: number;
  intitule: string;
  baremeMax: number;
  scoreIa: number | null;
  scoreHumain: number | null;
  delta: number;
  dossier: string;
  justification?: string;
  statut?: string;
}

interface DossierResult {
  id: string;
  nom: string;
  /** Score IA : somme des 33 questions IA-évaluables (max 67). */
  scoreIa: number | null;
  /**
   * Score humain comparable : somme des notes humaines pour les mêmes questions
   * IA-évaluables uniquement (hors_ia exclues). Même périmètre que scoreIa.
   * NE PAS confondre avec score_moyenne (all-49) de la vérité-terrain.
   */
  scoreHumainIa: number | null;
  /** Nombre de questions IA matchées avec la vérité-terrain. */
  qMatchees: number;
  deltaTotal: number | null;
  qDeltas: QDelta[];
}

function analyzeDeltas(ids: string[], veriteMap: Map<string, VeriteEntry>): DossierResult[] {
  const results: DossierResult[] = [];

  for (const id of ids) {
    const ev = loadEvaluation(id);
    if (!ev) { console.log(`  ⚠ ${id} : pas d'évaluation - ignoré dans l'analyse`); continue; }

    const ref = extractReference(id);
    const v = ref ? veriteMap.get(ref) ?? null : null;
    const nom = v ? `${v.prenom ?? ""} ${v.nom ?? ""}`.trim() || id : id;

    const qDeltas: QDelta[] = [];
    let scoreHumainIaSum = 0;
    let scoreIaMatchSum = 0;
    let qMatchees = 0;

    if (ev.phase_notation && v?.notation?.evaluations) {
      for (const q of ev.phase_notation.questions) {
        if (q.hors_ia) continue; // exclure les 16 questions hors_ia
        const scoreHumain = getHumanScoreMoyen(q.intitule, v.notation.evaluations);
        if (scoreHumain === null) continue; // pas de correspondance dans la vérité-terrain
        const delta = (q.score ?? 0) - scoreHumain;
        qDeltas.push({
          q: q.id,
          intitule: q.intitule,
          baremeMax: q.bareme_max,
          scoreIa: q.score,
          scoreHumain,
          delta,
          dossier: id,
          justification: q.justification,
          statut: q.statut,
        });
        // Accumule sur le périmètre commun (questions matchées des 2 côtés)
        scoreHumainIaSum += scoreHumain;
        scoreIaMatchSum += q.score ?? 0;
        qMatchees++;
      }
    }

    const scoreIa = ev.phase_notation?.score_total_ia ?? null;
    // Score humain comparable = somme humaine sur les mêmes questions IA matchées
    const scoreHumainIa = qMatchees > 0 ? Number(scoreHumainIaSum.toFixed(2)) : null;
    // Delta sur le périmètre commun matchéFIX
    const deltaTotal = qMatchees > 0
      ? Number((scoreIaMatchSum - scoreHumainIaSum).toFixed(2))
      : null;

    results.push({ id, nom, scoreIa, scoreHumainIa, qMatchees, deltaTotal, qDeltas });
  }

  return results;
}

// ============================================================
// Top questions a plus fort delta absolu (agrégé sur dossiers)
// ============================================================

interface TopQ {
  q: number;
  intitule: string;
  baremeMax: number;
  deltaAbsMoyen: number;
  count: number;
  exemples: QDelta[];
}

function computeTopQ(results: DossierResult[], maxQ = 5): TopQ[] {
  const byQ = new Map<number, QDelta[]>();
  for (const r of results) {
    for (const d of r.qDeltas) {
      const arr = byQ.get(d.q) ?? [];
      arr.push(d);
      byQ.set(d.q, arr);
    }
  }

  const tops: TopQ[] = [];
  for (const [q, deltas] of byQ) {
    const abs = deltas.map((d) => Math.abs(d.delta));
    const moy = abs.reduce((a, b) => a + b, 0) / abs.length;
    if (moy >= 0.1) {
      tops.push({
        q,
        intitule: deltas[0].intitule,
        baremeMax: deltas[0].baremeMax,
        deltaAbsMoyen: Number(moy.toFixed(2)),
        count: deltas.length,
        exemples: deltas,
      });
    }
  }

  tops.sort((a, b) => b.deltaAbsMoyen - a.deltaAbsMoyen);
  return tops.slice(0, maxQ);
}

// ============================================================
// Génération propositions
// ============================================================

function generateProposal(top: TopQ, dossierIds: string[]): void {
  if (!existsSync(PROPS_DIR)) mkdirSync(PROPS_DIR, { recursive: true });

  const date = new Date().toISOString().slice(0, 10);
  const slug = top.intitule.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
  const filename = `${date}-q${top.q}-${slug}.md`;
  const path = resolve(PROPS_DIR, filename);

  if (existsSync(path)) {
    console.log(`  ⏭ Proposition déjà existante : ${filename}`);
    return;
  }

  const currentRule = extractSkillSection(top.q);

  const exemplesByDossier = top.exemples.map((e) =>
    `  Dossier ${e.dossier}: IA=${e.scoreIa ?? "null"} vs H=${e.scoreHumain} (Δ=${e.delta > 0 ? "+" : ""}${e.delta})`
  ).join("\n");

  // Déterminer la direction du biais
  const avgDelta = top.exemples.reduce((a, b) => a + b.delta, 0) / top.exemples.length;
  const biasDir = avgDelta > 0 ? "sur-note" : "sous-note";
  const biasAbs = Math.abs(avgDelta).toFixed(2);

  // Suggestion de règle selon la cause probable
  let suggestionNote = "";
  if (top.q === 4) {
    suggestionNote = "Vérifier que la conversion de devise BCE est appliquée. La table de taux est déjà injectée dans le skill v0.4.0-7e-cal3.";
  } else if (top.q === 37) {
    suggestionNote = "ARTEFACT MAPPING : Q37 barème skill 7e = /1, barème xlsx 6e = /3. Les deltas observés sont probablement des artefacts. Ne pas modifier le skill - corriger le calcul delta dans calibrer.ts.";
  } else if (biasDir === "sous-note" && top.baremeMax >= 2) {
    suggestionNote = "IA trop stricte. Envisager : décomposition binaire des critères (DeCE), exemples d'anchors pour les paliers intermédiaires, ou clarification des critères vagues.";
  } else if (biasDir === "sur-note" && top.baremeMax >= 2) {
    suggestionNote = "IA trop généreuse. Envisager : critères discriminants explicites, exemples d'anchors pour le palier 0, formulations interdites ('sensibilisation seule = 0', etc.).";
  }

  const content = `---
auteur: calibrage-loop-auto
date: ${date}
raison: "Δ absolu moyen = ${biasAbs} pts sur ${top.count} dossier(s) - IA ${biasDir}"
dossier_declencheur: ${dossierIds.join(", ")}
affecte: evaluer-notation.skill.md (Q${top.q})
statut: en_attente
---

# Proposition amélioration Q${top.q} - ${top.intitule}

## Diagnostic

- Question : Q${top.q} (barème /${top.baremeMax})
- Direction : IA **${biasDir}** en moyenne de **${biasAbs} pts**
- Dossiers analysés : ${top.count}

Détail par dossier :
${exemplesByDossier}

## Suggestion

${suggestionNote}

## Règle actuelle

\`\`\`
${currentRule}
\`\`\`

## Règle proposée

*(À compléter par l'admin ou via session de calibrage manuelle)*

Appliquer l'une de ces techniques :
- Décomposition binaire (DeCE) : remplacer les paliers textuels par N critères OUI/NON dont la somme = score.
- Anchor calibré : ajouter 2 exemples de passages réels avec note humaine.
- Critère discriminant explicite : nommer exactement ce qui fait passer de 0 à 1, de 1 à 2, etc.

---
*Généré automatiquement par calibrage-loop.ts*
`;

  writeFileSync(path, content, "utf8");
  console.log(`  ✓ Proposition créée : propositions/${filename}`);
}

// ============================================================
// Rapport console
// ============================================================

function printReport(results: DossierResult[], topQs: TopQ[]): void {
  const line = "=".repeat(70);
  console.log(`\n${line}`);
  console.log("RAPPORT DE CALIBRAGE");
  console.log(line);

  // Résumé par dossier
  console.log("\n--- Scores par dossier (périmètre : questions IA uniquement) ---");
  let totalDelta = 0; let count = 0;
  for (const r of results) {
    const d = r.deltaTotal !== null ? (r.deltaTotal > 0 ? `+${r.deltaTotal}` : `${r.deltaTotal}`) : "?";
    const emoji = r.deltaTotal !== null ? (Math.abs(r.deltaTotal) <= 8 ? "🟢" : Math.abs(r.deltaTotal) <= 15 ? "🟡" : "🔴") : "·";
    const hStr = r.scoreHumainIa !== null ? String(r.scoreHumainIa) : "?";
    console.log(`  ${emoji} ${r.nom.slice(0, 32).padEnd(32)} | IA:${String(r.scoreIa ?? "?").padStart(4)} vs H:${hStr.padStart(5)} (${r.qMatchees}Q) | Δ ${d}`);
    if (r.deltaTotal !== null) { totalDelta += r.deltaTotal; count++; }
  }
  if (count > 0) {
    const avg = (totalDelta / count).toFixed(2);
    const sign = Number(avg) > 0 ? "+" : "";
    console.log(`\n  Δ moyen : ${sign}${avg} pts (${count} dossier(s), questions IA matchées uniquement)`);
  }

  // Top questions
  console.log("\n--- Top questions à fort delta ---");
  if (topQs.length === 0) { console.log("  Aucun delta significatif trouvé."); }
  for (const tq of topQs) {
    const avgD = tq.exemples.reduce((a, b) => a + b.delta, 0) / tq.exemples.length;
    const sign = avgD > 0 ? "+" : "";
    console.log(`  Q${String(tq.q).padStart(2)} ${tq.intitule.slice(0, 42).padEnd(42)} | |Δ| moy=${tq.deltaAbsMoyen} | ${sign}${avgD.toFixed(2)} (${tq.count} dossier(s))`);
    for (const e of tq.exemples) {
      const ds = e.delta > 0 ? `+${e.delta}` : `${e.delta}`;
      console.log(`       ${e.dossier}: IA=${e.scoreIa ?? "null"} vs H=${e.scoreHumain} (Δ ${ds}) | ${e.statut ?? ""}`);
    }
  }

  console.log(`\n${line}`);

  // Cibles de calibrage
  const avgAbs = results.reduce((a, r) => a + Math.abs(r.deltaTotal ?? 0), 0) / (results.length || 1);
  console.log(`Δ absolu moyen : ${avgAbs.toFixed(2)} pts`);
  console.log(`Cible R1 : < 15 pts | Cible R2 : < 10 pts | Cible R3 : < 7 pts`);
  if (avgAbs <= 7) console.log("🎯 CIBLE ATTEINTE (< 7 pts) !");
  else if (avgAbs <= 10) console.log("🟡 Proche de la cible R3. Encore 1-2 ajustements.");
  else if (avgAbs <= 15) console.log("🟡 Cible R2 atteinte. Continuer sur les top-questions.");
  else console.log("🔴 Delta encore élevé. Appliquer les propositions générées.");
}

// ============================================================
// Main
// ============================================================

(async () => {
  const veriteMap = loadVerite();

  // Résolution des IDs (aléatoire ou explicites)
  if (randomArg) {
    const picked = pickRandomDossiers(randomArg, veriteMap);
    DOSSIER_IDS.push(...picked);
    console.log(`\n=== Calibrage FAE 7e - ${DOSSIER_IDS.length} dossier(s) tirés aléatoirement ===`);
  } else {
    console.log(`\n=== Calibrage FAE 7e - ${DOSSIER_IDS.length} dossier(s) ===`);
  }

  console.log(`IDs : ${DOSSIER_IDS.join(", ")}`);
  console.log(`Daemon : ${DAEMON_URL}`);
  console.log(`Vérité-terrain : ${veriteMap.size} entrées`);
  if (forceReeval) console.log("Mode --force : réévaluation forcée");
  if (reportOnly) console.log("Mode --report-only : pas de nouvelles évaluations");
  console.log("(Les 16 questions hors_ia sont exclues du calcul des deltas)");

  if (DOSSIER_IDS.length === 0) {
    console.error("✗ Aucun dossier sélectionné.");
    process.exit(1);
  }

  if (!reportOnly) {
    console.log("\n=== Lancement des évaluations ===");
    await launchEvaluations(DOSSIER_IDS);
  }

  console.log("\n=== Analyse des deltas ===");
  const results = analyzeDeltas(DOSSIER_IDS, veriteMap);

  const allTopQs = computeTopQ(results, 5);
  const topQs = focusQ ? allTopQs.filter((t) => t.q === focusQ) : allTopQs;

  printReport(results, topQs);

  if (!noProposals && allTopQs.length > 0) {
    console.log("\n=== Génération propositions ===");
    for (const tq of allTopQs) {
      generateProposal(tq, DOSSIER_IDS);
    }
    console.log(`\nPropositions à valider dans : OIF-Eval > Paramètres > Propositions`);
  }

  console.log("\nPour inspecter une question en détail :");
  console.log(`  npx tsx scripts/observe-q.ts --dossier ${DOSSIER_IDS[0]} --q <N>`);
  console.log(`  npx tsx scripts/observe-q.ts --dossier ${DOSSIER_IDS[0]} --all-deltas\n`);
})();
