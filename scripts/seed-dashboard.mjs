#!/usr/bin/env node
/**
 * Seed de données fictives pour tester l'onglet Dashboard.
 *
 * Crée des évaluations synthétiques attribuées à 6 évaluateurs fictifs,
 * avec un mix de statuts (validé / en cours / inéligible).
 *
 * - Utilise les vrais IDs de dossiers présents dans candidatures-6e qui n'ont
 *   pas encore d'évaluation existante (pour que le dashboard les voie).
 * - Marque les fichiers avec le champ JSON "_seed": true pour pouvoir les
 *   identifier et les nettoyer via --clean sans toucher aux vraies évaluations.
 *
 * Usage :
 *   node scripts/seed-dashboard.mjs              # crée les fakes
 *   node scripts/seed-dashboard.mjs --clean      # supprime les fakes
 *   node scripts/seed-dashboard.mjs --count 60   # nombre de fakes (défaut: 50)
 */
import {
  readdirSync,
  readFileSync,
  existsSync,
  writeFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();
const DATA_DIR = resolve(ROOT, "data");
const SOURCE_DOSSIERS = resolve(DATA_DIR, "candidatures-6e");
const EVAL_DIR = resolve(DATA_DIR, "evaluations");

const args = process.argv.slice(2);
const isClean = args.includes("--clean");
const countArg = args.indexOf("--count");
const COUNT = countArg >= 0 ? parseInt(args[countArg + 1], 10) : 50;

const FAKE_OPERATORS = [
  "Alice Dupont",
  "Bob Martin",
  "Camille Lefèvre",
  "Diane Konaté",
  "Elsa Mbembe",
  "Fanny Traoré",
];

if (isClean) {
  cleanFakes();
  process.exit(0);
}

if (!existsSync(SOURCE_DOSSIERS)) {
  console.error(`Erreur : ${SOURCE_DOSSIERS} introuvable.`);
  console.error("Le seed a besoin de dossiers réels dans candidatures-6e.");
  process.exit(1);
}

main();

function main() {
  const allDossierIds = readdirSync(SOURCE_DOSSIERS)
    .filter((f) => {
      try {
        return statSync(resolve(SOURCE_DOSSIERS, f)).isDirectory();
      } catch {
        return false;
      }
    })
    .filter((f) => !f.startsWith("."));

  // On exclut les dossiers qui ont déjà une évaluation existante (réelle ou fake)
  // pour ne pas écraser des données utiles.
  const dossierIds = allDossierIds
    .filter((id) => !existsSync(resolve(EVAL_DIR, `${id}.json`)))
    .slice(0, COUNT);

  if (dossierIds.length === 0) {
    console.error(
      "Aucun dossier candidat sans évaluation trouvé dans candidatures-6e/"
    );
    process.exit(1);
  }

  console.log(
    `Génération de ${dossierIds.length} évaluations fictives pour ${FAKE_OPERATORS.length} évaluateurs (sur ${allDossierIds.length} dossiers disponibles).`
  );

  let created = 0;
  for (let i = 0; i < dossierIds.length; i++) {
    const dossierId = dossierIds[i];
    const evalPath = resolve(EVAL_DIR, `${dossierId}.json`);

    const operator = FAKE_OPERATORS[i % FAKE_OPERATORS.length];
    const profile = pickProfile(i, dossierIds.length);
    const evaluation = buildEval(dossierId, operator, profile);
    writeFileSync(evalPath, JSON.stringify(evaluation, null, 2), "utf8");
    created += 1;
  }

  console.log(`✓ ${created} évaluations créées.`);
  console.log("\nÉvaluateurs fictifs :");
  for (const op of FAKE_OPERATORS) console.log(`  - ${op}`);
  console.log("\nPour nettoyer : node scripts/seed-dashboard.mjs --clean");
}

function cleanFakes() {
  if (!existsSync(EVAL_DIR)) {
    console.log("Pas de dossier evaluations/ à nettoyer.");
    return;
  }
  const files = readdirSync(EVAL_DIR).filter((f) => f.endsWith(".json"));
  let removed = 0;
  for (const f of files) {
    const path = resolve(EVAL_DIR, f);
    try {
      const data = JSON.parse(readFileSync(path, "utf8"));
      if (data._seed === true) {
        unlinkSync(path);
        removed += 1;
      }
    } catch {
      // Skip un-parseable files
    }
  }
  console.log(`✓ ${removed} fichier${removed > 1 ? "s" : ""} de seed supprimé${removed > 1 ? "s" : ""}.`);
}

/**
 * Distribue les statuts : ~55% validés, ~25% en cours, ~15% inéligibles, ~5% validés inéligibles.
 */
function pickProfile(index, total) {
  const r = (index * 9301 + 49297) % 233280; // PRNG déterministe pour reproductibilité
  const ratio = r / 233280;
  if (ratio < 0.55) return "validated";
  if (ratio < 0.80) return "in_progress";
  if (ratio < 0.95) return "ineligible_validated";
  return "ineligible_pending";
}

function buildEval(dossierId, operator, profile) {
  const today = new Date();
  const startedAt = new Date(today.getTime() - rand(1, 7) * 86400000);
  const endedAt = new Date(startedAt.getTime() + rand(15, 60) * 60000);
  const validatedAt = new Date(endedAt.getTime() + rand(10, 240) * 60000);

  const isIneligible =
    profile === "ineligible_validated" || profile === "ineligible_pending";
  const isValidated =
    profile === "validated" || profile === "ineligible_validated";

  const evaluation = {
    dossier_id: dossierId,
    evaluateur_ia: {
      modele: "claude-sonnet-4-6",
      version_skill_eligibilite: "0.2.0-7e-cal1",
      version_skill_notation: "0.2.0-7e-cal1",
    },
    horodatage: {
      debut: startedAt.toISOString(),
      fin: endedAt.toISOString(),
    },
    verdict: isIneligible ? "INELIGIBLE" : "ELIGIBLE",
    phase_eligibilite: {
      verdict: isIneligible ? "INELIGIBLE" : "ELIGIBLE",
      criteres: buildCriteres(isIneligible),
    },
    phase_notation: isIneligible ? null : buildNotation(),
    review: {
      evaluateur: operator,
      ...(isValidated
        ? {
            validee_par: operator,
            validee_le: validatedAt.toISOString(),
            commentaire: pickCommentaire(),
          }
        : {}),
      overrides_ia: [],
      overrides_eligibilite: [],
    },
    _seed: true, // marqueur pour identifier les fakes
  };

  return evaluation;
}

function buildCriteres(isIneligible) {
  const criteres = [];
  for (let i = 1; i <= 14; i++) {
    let statut = "OUI";
    if (isIneligible && (i === 4 || i === 9)) statut = "NON";
    criteres.push({
      id: `ELG-${i}`,
      intitule: `Critère d'éligibilité ${i} (fake)`,
      statut,
      source: "Données de test générées par seed-dashboard.mjs",
      justification:
        statut === "OUI"
          ? `Critère vérifié dans le dossier de test.`
          : `Critère non rempli (donnée fictive pour test dashboard).`,
      verification_externe_requise: null,
    });
  }
  return criteres;
}

function buildNotation() {
  const questions = [];
  const horsIa = [15, 16, 18, 23, 24, 26, 27, 33, 38, 39, 40, 42, 43, 47, 48, 49];
  for (let q = 1; q <= 49; q++) {
    if (horsIa.includes(q)) {
      questions.push({
        id: `Q${q}`,
        score: null,
        statut: "HORS_IA",
        commentaire: "Question réservée au membre de l'équipe humaine.",
        hors_ia: true,
      });
    } else {
      const score = rand(1, 4);
      questions.push({
        id: `Q${q}`,
        score,
        statut: "OK",
        commentaire: `Réponse fictive Q${q} (score ${score}/4) pour test dashboard.`,
        hors_ia: false,
      });
    }
  }
  const totalScore = questions
    .filter((q) => typeof q.score === "number")
    .reduce((s, q) => s + (q.score ?? 0), 0);
  return {
    questions,
    score_total: totalScore,
    bareme_total_max: 33 * 4,
  };
}

function pickCommentaire() {
  const samples = [
    "Validation globale conforme à la grille 7e.",
    "Quelques points de vigilance sur le budget, mais dossier solide.",
    "Capacité financière à confirmer en comité.",
    "Bon alignement avec les priorités FAE.",
    "Document complet, validation rapide.",
  ];
  return samples[Math.floor(Math.random() * samples.length)];
}

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
