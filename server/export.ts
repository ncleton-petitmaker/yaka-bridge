/**
 * Export xlsx des évaluations FAE.
 *
 * Le format produit est aligné sur les fichiers OIF de référence :
 *   - "7ème édition du Fonds ... - Résultats des 296 projets déjà évalués.xlsx"
 *     pour l'onglet "Classement général" (éligibilité 7e, 49 colonnes).
 *   - "6ème édition du Fonds ... - résultats notation 50 projets éligibles.xlsx"
 *     pour l'onglet "Notation" (50 colonnes, 42 questions + coup de cœur).
 *
 * Onglets bonus (ajoutés pour la traçabilité IA, sans remplacer les habitudes
 * OIF) : "Synthèses" et "Modifications humaines".
 */
import ExcelJS from "exceljs";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { Evaluation } from "../lib/types.js";

// =============================================================================
// Libellés exacts OIF (recopiés depuis les fichiers de référence)
// =============================================================================

const ELIG_HEADERS = [
  "N° réponse",
  "réference",
  "Nom",
  "Prénom",
  "Catégorie",
  "L’organisation porteuse est une organisation de la société civile (OSC).",
  "L’organisation porteuse est enregistrée et officiellement reconnue par les autorités d’un des 53 États et gouvernements membres de plein droit de l’OIF.",
  "L’organisation justifie d’au moins deux années d’existence légale.",
  "L’organisation a fourni un rapport d’activités pour l'année 2025 ou 2024 en français, officiel (signé), complet (description de l’organisation, des activités de gouvernance et des activités opérationnelles) et vérifiable (photos).",
  "L'organisation dispose d'un organigramme (indice de gouvernance fonctionnelle, transparente et démocratique).",
  "L’organisation a fourni un rapport financier pour l'année 2025 ou 2024 en français, officiel (signé), complet (recettes, dépenses, excédent ou déficit) et vérifiable (mention de la devise).",
  "L’organisation dispose d’une capacité financière suffisante, son budget annuel justifie le montant de la subvention sollicitée conformément aux règles de calcul (maximum 1,5 fois le budget annuel et dans la limite de 100 000€).",
  "L’organisation a tenu une Assemblée générale pour l’adoption de ses rapports d’activités et financiers, dispose d’un procès-verbal et rend ces documents accessibles aux membres et, le cas échéant, au public (indice de gouvernance fonctionnelle, transparente et démocratique).",
  "L'organisation dispose d'un conseil d'administration (indice de gouvernance fonctionnelle, transparente et démocratique).",
  "L’organisation met en œuvre des activités sur le territoire d’un ou plusieurs des 53 États et gouvernements membres de plein droit de l’OIF.",
  "Le projet est mis en œuvre sur le territoire d’un ou plusieurs des 53 États et gouvernements membres de plein droit de l’OIF.",
  "La subvention demandée est égale ou inférieure à 80% du coût total du projet.",
  "Le projet a une durée totale comprise entre 24 et 36 mois.",
  "Le projet a une durée de mise en œuvre opérationnelle comprise entre 12 et 18 mois.",
  "La phase de suivi et d'accompagnement post-activités du projet a une durée comprise entre 12 et 18 mois.",
  "Le projet n'a pas démarré.",
  "Le projet n’est pas la continuité d’un projet déjà en cours ou la suite d’un projet passé.",
  "Le résumé, la description, le contexte, les objectifs, les résultats attendus et les activités du projet ne contiennent pas de référence explicite à des actions de prosélytisme religieux ou de propagande politique.",
  "Le projet ne prévoit pas de micro-crédit, dotation ou fonds remboursables à taux zéro et à intérêt.",
  "Le projet bénéficie-t-il prioritairement et directement à des femmes et jeunes femmes en situation de vulnérabilité ?",
  "Le projet est-il en cohérence avec l’objectif général du Fonds et contribue-t-il à la réalisation d’au moins deux objectifs spécifiques ?",
  "Le projet est-il éligible ?",
  "Si non pourquoi, choix multiple (Candidature éligible en %)",
  "Si non pourquoi, choix multiple (Etre une OSC en %)",
  "Si non pourquoi, choix multiple (Etre légalement enregistrée en %)",
  "Si non pourquoi, choix multiple (Etre enregistrée dans un Etat membre  en %)",
  "Si non pourquoi, choix multiple (Avoir deux années d’existence en %)",
  "Si non pourquoi, choix multiple (Rapport d’activité  en %)",
  "Si non pourquoi, choix multiple (Rapport financier en %)",
  "Si non pourquoi, choix multiple (Etre une organisation avec gouvernance démocratique  en %)",
  "Si non pourquoi, choix multiple (Capacités financières  en %)",
  "Si non pourquoi, choix multiple (Etre cohérent avec les objectifs du Fonds  en %)",
  "Si non pourquoi, choix multiple (Bénéficier prioritairement aux femmes en %)",
  "Si non pourquoi, choix multiple (Intégrer les enjeux d’égalité en %)",
  "Si non pourquoi, choix multiple (Etre mis en œuvre dans un Etat membre de plein droit en %)",
  "Si non pourquoi, choix multiple (Ne pas avoir débuté en %)",
  "Si non pourquoi, choix multiple (Exclure le microcrédit ou toute dotation remboursable même à taux zéro en %)",
  "Si non pourquoi, choix multiple (Avoir une durée comprise entre 24 et 36 mois  en %)",
  "Si non pourquoi, choix multiple (Poursuivre but religieux ou politique ou idéologique en %)",
  "Si non pourquoi, choix multiple (Subvention demandée de plus de 80% en %)",
  "Si non pourquoi, choix multiple (Cofinancement à hauteur de 20% en %)",
  "Moyenne générale",
  "Examinateurs attribués",
  "Examinations terminées",
] as const;

const NOTE_HEADERS = [
  "N° réponse",
  "réference",
  "Nom",
  "Prénom",
  "Catégorie",
  "L’organisation est accréditée auprès de la Conférence des OING de la Francophonie et/ou membre du Réseau francophone pour l’égalité femme-homme (RF EFH). (/2)",
  "L’organisation a déjà été lauréate du Fonds « La Francophonie avec Elles » ?  (/2)",
  "L’organisation est implantée localement c’est-à-dire dispose de son siège social dans le pays de mise en œuvre du projet. (/4)",
  "L’organisation est de taille et de ressources modestes. (/4)",
  "L’organisation est une organisation de jeunes. (/2)",
  "L’organisation est une organisation de femmes. (/2)",
  "L’organisation dispose d’une expérience, d’une expertise et d’une plus-value dans les activités en lien avec le Fonds « La Francophonie avec Elles » et/ou en matière d'égalité entre les femmes et les hommes dans le pays ou la région d'intervention. (/3)",
  "L’organisation nécessiterait un renforcement de capacités : capacités organisationnelles et institutionnelles ; capacités financières et techniques ; capacités pour rayonner. (/3)",
  "Le projet est mis en œuvre dans l’un des pays sous-représentés : (/4)",
  "La thématique du projet est spécifique à sa région de mis en œuvre. (/3)",
  "Le projet est mis en œuvre dans des régions rurales et/ou montagneuses y compris les régions côtières/littorales et zones arides.  (/2)",
  "Le contexte et l’état des lieux des besoins des femmes et des filles est clair et détaillé, est appuyé par des chiffres et des études et fait suite à la consultation des femmes et des filles.  (/3)",
  "Des organisations de la société civile sont partenaires dans la mise en œuvre du projet.  (/1)",
  "Le rôle des organisation(s) de la société civile partenaires est bien défini dans la mise en œuvre du projet.  (/2)",
  "Les pouvoirs publics locaux sont impliqués dans la mise en œuvre du projet.  (/1)",
  "Le rôle des pouvoirs publics locaux est bien défini dans la mise en œuvre du projet.  (/2)",
  "L’organisation décrit clairement le projet et la manière dont celui-ci apporte une réponse aux besoins identifiés dans l’état des lieux.  (/3)",
  "Les bénéficiaires directs reflètent le groupe cible défini dans l’état des lieux des besoins.  (/2)",
  "Le projet bénéficie majoritairement aux femmes, notamment celles qui sont à l'intersection de plusieurs facteurs de discrimination (jeunes femmes, femmes âgées, femmes migrantes, réfugiées, déplacées, filles mères, mères célibataires, femmes vivant avec le VIH, femmes en situation de rue, femmes en situation de handicap, femmes des minorités sexuelles et de genre).  (/3)",
  "Le projet vise clairement à renforcer l'employabilité et/ou l'entrepreneuriat des femmes (dimension autonomisation économique).  (/3)",
  "L’objectif global et les objectifs spécifiques définis répondent au ou aux secteur(s) d’activité choisi(s).  (/2)",
  "Les résultats permettent l’atteinte des objectifs spécifiques et décrivent précisément des changements mesurables.  (/2)",
  "Les activités proposées sont précises, réalisables et permettent d'atteindre les résultats attendus.  (/2)",
  "Le projet est bien construit et décrit clairement la théorie du changement (/3)",
  "L’association prend des mesures pour favoriser l’adhésion de l’entourage masculin, si les femmes en expriment le besoin et y consentent  (/1)",
  "Est-ce que les activités prennent-elles en compte, de manière claire, les besoins des jeunes ?  (/1)",
  "Les activités intègrent l'usage des technologies numériques  (/2)",
  "Les activités intègrent la lutte contre le changement climatique. (/2)",
  "Les activités prennent en compte les externalités négatives qui pourraient entraver la participation des femmes bénéficiaires (garde d'enfants, prise en charge des transports, etc.).  (/3)",
  "Les indicateurs sont cohérents avec les activités prévues et sont pertinents et réalisables (/2)",
  "Les actions de visibilité envisagées dans le cadre du projet mettent-elles en valeur le soutien de l'OIF et promeuvent-elles l'action de l’organisation porteuse de projet ?  (/2)",
  "La logique d’intervention, les mécanismes de mise en œuvre sont présentés.  (/3)",
  "Les actions et mécanismes de suivi sont présentés.  (/3)",
  "L’organisation démontre que le projet est réalisable et viable.  (/3)",
  "L’organisation a prévu une stratégie de pérennisation du projet à l’issue du financement (/3)",
  "L’usage de la langue française est encouragé tout en valorisant les langues locales.  (/1)",
  "Le budget est-il suffisamment détaillé ?  (/2)",
  "Les lignes budgétaires sont-elles cohérentes et réalistes par rapport aux activités prévues dans le projet, et sont-elles suffisamment détaillées pour permettre une évaluation précise de leur pertinence et de leur adéquation aux objectifs du projet ?  (/2)",
  "Le projet intègre-t-il une ligne budgétaire (15 à 20% du budget) dédiée aux activités de la phase de suivi-accompagnement ? (/2)",
  "Le ratio entre le coût du projet et le nombre de bénéficiaires est cohérent et raisonnable (/2)",
  "Les frais de fonctionnement ne dépassent pas 20% du coût total du projet. (/1)",
  "Coup de cœur : La note \"Coup de cœur\" récompense un projet qui se distingue par son originalité ou son caractère innovant ou son fort potentiel d'impact ou d'inspiration (/3)",
  "Moyenne générale",
  "Examinateurs attribués",
  "Examinations terminées",
] as const;

// =============================================================================
// Helpers de conversion statut/score
// =============================================================================

function statutToText(s: string | undefined): string {
  if (!s) return "";
  switch (s) {
    case "OUI": return "Oui";
    case "NON": return "Non";
    case "NON_TROUVE": return "Non précisé";
    case "AMBIGU": return "À vérifier";
    case "SANS_OBJET": return "Sans objet";
    default: return s;
  }
}

function verdictToText(v: string | undefined): string {
  switch (v) {
    case "ELIGIBLE": return "Oui";
    case "INELIGIBLE": return "Non";
    case "ELIGIBILITE_INCERTAINE": return "À vérifier";
    default: return "";
  }
}

/** Extrait le suffixe hex de l'ID (= "réference" OIF). */
function refFromId(id: string): string {
  const m = id.match(/[0-9a-f]{10}$/i);
  return m ? m[0] : id.slice(-10);
}

/** Sépare le nom du dossier en "Nom Prénom" basé sur des heuristiques. */
function namePartsFromId(id: string): { nom: string; prenom: string } {
  // Format type : "Ayewomu-Cyrille-DJOWAMON-bd789223f2"
  // Heuristique : enlever le suffixe hex, splitter par tirets
  const noHex = id.replace(/-[0-9a-f]{10}$/i, "");
  const parts = noHex.split("-").filter(Boolean);
  if (parts.length === 0) return { nom: "", prenom: "" };
  // Si dernier mot tout en MAJ -> nom de famille. Sinon dernier mot = nom.
  const last = parts[parts.length - 1];
  const isAllCaps = last === last.toUpperCase() && last.length > 1;
  if (isAllCaps && parts.length >= 2) {
    return { nom: last, prenom: parts.slice(0, -1).join(" ") };
  }
  return { nom: last, prenom: parts.slice(0, -1).join(" ") };
}

/** Récupère le statut d'un critère ELG en tenant compte des overrides. */
function elgStatut(e: Evaluation, id: string): string {
  const overrides = e.review?.overrides_eligibilite ?? [];
  const ov = overrides.find((o) => o.critere_id === id);
  if (ov) return ov.statut_human ?? "";
  const c = e.phase_eligibilite.criteres.find((x) => x.id === id);
  return c?.statut ?? "";
}

/** Récupère le score d'une question en tenant compte des overrides. */
function qScore(e: Evaluation, qid: number): number | "" {
  if (!e.phase_notation) return "";
  const overrides = e.review?.overrides_ia ?? [];
  const ov = overrides.find((o) => o.question_id === qid);
  if (ov && typeof ov.score_human === "number") return ov.score_human;
  const q = e.phase_notation.questions.find((x) => x.id === qid);
  if (!q) return "";
  // Question HORS_IA : on prend la note humaine si disponible
  if (q.hors_ia || q.statut === "HORS_IA") {
    const review = e.review?.questions_hors_ia?.find((x) => x.question_id === qid);
    return review ? review.score : "";
  }
  return typeof q.score === "number" ? q.score : "";
}

// =============================================================================
// Onglet "Classement général" (éligibilité, format 7e OIF)
// =============================================================================

function buildEligRow(id: string, idx: number, e: Evaluation | null): unknown[] {
  const { nom, prenom } = namePartsFromId(id);
  const baseRow: unknown[] = [
    idx,
    refFromId(id),
    nom,
    prenom,
    "7ème édition du Fonds « La Francophonie avec Elles »",
  ];
  if (!e) {
    // Pas d'éval : lignes essentiellement vides, mais le dossier est listé
    return [...baseRow, ...Array(ELIG_HEADERS.length - baseRow.length).fill("")];
  }

  const rej = new Set(e.phase_eligibilite.motifs_rejet_declenches ?? []);

  // 22 cols statut (col 6 à 27)
  const elgCols = [
    elgStatut(e, "ELG-1"),                           // OSC
    elgStatut(e, "ELG-2"),                           // Etat membre
    elgStatut(e, "ELG-3"),                           // 2 ans
    elgStatut(e, "ELG-5"),                           // Rapport activités
    elgStatut(e, "ELG-8"),                           // Organigramme
    elgStatut(e, "ELG-6"),                           // Rapport financier
    elgStatut(e, "ELG-4"),                           // Capacité financière
    elgStatut(e, "ELG-7"),                           // AG / PV
    elgStatut(e, "ELG-8"),                           // CA (lié à organigramme)
    elgStatut(e, "ELG-10"),                          // Activités sur OIF
    elgStatut(e, "ELG-11"),                          // Projet sur OIF
    elgStatut(e, "ELG-14"),                          // Subv ≤ 80%
    elgStatut(e, "ELG-14"),                          // Durée 24-36
    elgStatut(e, "ELG-14"),                          // Phase op
    elgStatut(e, "ELG-14"),                          // Phase suivi
    elgStatut(e, "ELG-12"),                          // Pas démarré
    elgStatut(e, "ELG-12"),                          // Pas continuité
    elgStatut(e, "ELG-13"),                          // Pas prosélytisme
    elgStatut(e, "ELG-13"),                          // Pas micro-crédit
    e.phase_notation
      ? (qScore(e, 17) !== "" && (qScore(e, 17) as number) > 0 ? "Oui" : "Non")
      : "",                                           // Femmes vulnérables (Q17)
    "",                                               // Cohérence objectifs Fonds (jugement humain)
    verdictToText(e.phase_eligibilite.verdict),       // Éligible ?
  ].map(statutToText);

  // 19 cols motifs % (col 28 à 46)
  const pct = (cond: boolean) => (cond ? 100 : 0);
  const motifCols = [
    pct(e.phase_eligibilite.verdict !== "ELIGIBLE"),  // Candidature éligible %
    pct(rej.has("REJ-1")),                            // OSC
    pct(rej.has("REJ-13")),                           // Légalement enregistrée
    pct(rej.has("REJ-3")),                            // Etat membre
    pct(rej.has("REJ-2")),                            // 2 ans
    pct(elgStatut(e, "ELG-5") === "NON"),             // Rapport activité
    pct(elgStatut(e, "ELG-6") === "NON"),             // Rapport financier
    pct(elgStatut(e, "ELG-9") === "NON"),             // Gouvernance démocratique
    pct(elgStatut(e, "ELG-4") === "NON"),             // Capacités financières
    pct(elgStatut(e, "ELG-10") === "NON"),            // Cohérent objectifs
    0,                                                 // Bénéficier femmes (humain)
    0,                                                 // Intégrer égalité (humain)
    pct(rej.has("REJ-9")),                            // Mise en œuvre OIF
    pct(rej.has("REJ-6")),                            // Pas débuté
    pct(rej.has("REJ-4")),                            // Microcrédit
    pct(rej.has("REJ-7")),                            // Durée 24-36
    pct(rej.has("REJ-5")),                            // But religieux/politique
    pct(rej.has("REJ-8")),                            // Subv > 80%
    pct(rej.has("REJ-8")),                            // Cofinancement 20%
  ];

  // 3 cols meta finale
  const isValidated = Boolean(e.review?.validee_par);
  const tail = [
    "",                                                 // Moyenne générale (laissée vide pour éligibilité)
    1,                                                  // Examinateurs attribués
    isValidated ? 1 : 0,                                // Examinations terminées
  ];

  return [...baseRow, ...elgCols, ...motifCols, ...tail];
}

// =============================================================================
// Onglet "Notation" (format 6e OIF)
// =============================================================================

/** Mapping colonne_notation_xlsx → question_id_7e (basé sur l'ordre 6e). */
const NOTE_Q_MAP: (number | null)[] = [
  // Col 6 à 47 = 42 questions + coup de cœur
  2,    // Accréditation Francophonie       → Q2
  3,    // Lauréate édition précédente      → Q3
  1,    // Implantation locale              → Q1
  4,    // Taille modeste                   → Q4
  5,    // Org. de jeunes                   → Q5
  6,    // Org. de femmes                   → Q6
  7,    // Expérience FAE/EFH               → Q7
  null, // Renforcement capacités (n'existe pas en 7e)
  8,    // Pays prioritaires                → Q8
  16,   // Thématique spécifique région     → Q16 (HORS IA)
  9,    // Régions rurales                  → Q9
  10,   // Contexte/état des lieux          → Q10
  11,   // OSC partenaires                  → Q11
  12,   // Rôle OSC                         → Q12
  13,   // Pouvoirs publics                 → Q13
  14,   // Rôle pouvoirs publics            → Q14
  15,   // Description projet (HORS IA)     → Q15
  18,   // Bénéficiaires (HORS IA)          → Q18
  17,   // Femmes intersectionnelles        → Q17
  23,   // Insertion durable (HORS IA)      → Q23
  21,   // Cohérence résultats/objectifs    → Q21
  24,   // Résultats permettent (HORS IA)   → Q24
  26,   // Activités précises (HORS IA)     → Q26
  27,   // Théorie du changement (HORS IA)  → Q27
  30,   // Adhésion entourage masculin      → Q30
  25,   // Besoins des jeunes               → Q25
  28,   // Technologies numériques          → Q28
  29,   // Changement climatique            → Q29
  31,   // Obstacles femmes                 → Q31
  40,   // Indicateurs (HORS IA)            → Q40
  35,   // Visibilité organisation          → Q35 et Q36 et Q37
  37,   // Logique d'intervention           → Q37 (visibilité OIF)
  33,   // Suivi (HORS IA)                  → Q33
  38,   // Viabilité (HORS IA)              → Q38
  39,   // Pérennisation (HORS IA)          → Q39
  34,   // Français + langues locales       → Q34
  43,   // Budget détaillé (HORS IA)        → Q43
  47,   // Lignes budgétaires (HORS IA)     → Q47
  46,   // Ligne suivi 15-20%               → Q46
  48,   // Coût/bénéficiaire (HORS IA)      → Q48
  44,   // Frais fonct. ≤20%                → Q44
  49,   // Coup de cœur (HORS IA)           → Q49
];

function buildNoteRow(id: string, idx: number, e: Evaluation | null): unknown[] {
  const { nom, prenom } = namePartsFromId(id);
  const baseRow: unknown[] = [
    idx,
    refFromId(id),
    nom,
    prenom,
    "7ème édition du Fonds « La Francophonie avec Elles »",
  ];
  if (!e || !e.phase_notation) {
    return [...baseRow, ...Array(NOTE_HEADERS.length - baseRow.length).fill("")];
  }
  const qCols = NOTE_Q_MAP.map((qid) => (qid === null ? "" : qScore(e, qid)));
  const moyenne = e.review?.score_final_total ?? "";
  const isValidated = Boolean(e.review?.validee_par);
  const tail = [moyenne, 1, isValidated ? 1 : 0];
  return [...baseRow, ...qCols, ...tail];
}

// =============================================================================
// Build complet
// =============================================================================

export async function buildExportXlsx(
  dataDir: string,
  dossierIds: string[],
  opts: { outputDir?: string } = {}
): Promise<Buffer> {
  const evalDir = opts.outputDir
    ? resolve(opts.outputDir)
    : resolve(dataDir, "evaluations");

  const wb = new ExcelJS.Workbook();
  wb.creator = "OIF-Eval";
  wb.created = new Date();

  // -- Onglet 1 : Classement général (éligibilité 7e) --
  const ws1 = wb.addWorksheet("Classement général");
  ws1.addRow(ELIG_HEADERS as unknown as string[]);
  ws1.getRow(1).font = { bold: true };
  ws1.getRow(1).alignment = { wrapText: true, vertical: "top" };
  ws1.getRow(1).height = 60;
  ws1.views = [{ state: "frozen", xSplit: 5, ySplit: 1 }];
  // Largeurs
  ws1.getColumn(1).width = 10;
  ws1.getColumn(2).width = 14;
  ws1.getColumn(3).width = 18;
  ws1.getColumn(4).width = 18;
  ws1.getColumn(5).width = 24;
  for (let c = 6; c <= ELIG_HEADERS.length; c++) ws1.getColumn(c).width = 14;

  // -- Onglet 2 : Notation (format 6e étendu 7e) --
  const ws2 = wb.addWorksheet("Notation");
  ws2.addRow(NOTE_HEADERS as unknown as string[]);
  ws2.getRow(1).font = { bold: true };
  ws2.getRow(1).alignment = { wrapText: true, vertical: "top" };
  ws2.getRow(1).height = 60;
  ws2.views = [{ state: "frozen", xSplit: 5, ySplit: 1 }];
  ws2.getColumn(1).width = 10;
  ws2.getColumn(2).width = 14;
  ws2.getColumn(3).width = 18;
  ws2.getColumn(4).width = 18;
  ws2.getColumn(5).width = 24;
  for (let c = 6; c <= NOTE_HEADERS.length; c++) ws2.getColumn(c).width = 8;

  // -- Onglet 3 : Synthèses (bonus, qualitatif OIF-Eval) --
  const ws3 = wb.addWorksheet("Synthèses");
  ws3.columns = [
    { header: "réference", key: "ref", width: 14 },
    { header: "Dossier", key: "id", width: 30 },
    { header: "Points forts (IA)", key: "forts", width: 60 },
    { header: "Points de vigilance (IA)", key: "vig", width: 60 },
    { header: "Vérifications externes", key: "ve", width: 50 },
    { header: "Commentaires internes", key: "ci", width: 80 },
  ];
  ws3.getRow(1).font = { bold: true };

  // -- Onglet 4 : Modifications humaines (bonus, audit overrides) --
  const ws4 = wb.addWorksheet("Modifications humaines");
  ws4.columns = [
    { header: "réference", key: "ref", width: 14 },
    { header: "Dossier", key: "id", width: 30 },
    { header: "Type", key: "type", width: 12 },
    { header: "Critère/Question", key: "qref", width: 14 },
    { header: "Note IA", key: "ia", width: 12 },
    { header: "Note humaine", key: "human", width: 14 },
    { header: "Raison", key: "raison", width: 60 },
    { header: "Modifié par", key: "par", width: 18 },
    { header: "Modifié le", key: "le", width: 22 },
  ];
  ws4.getRow(1).font = { bold: true };
  ws4.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFFFE9C4" },
  };

  // Trace des cellules à colorer (overrides) pour les onglets 1 et 2
  const overrideCells: { ws: ExcelJS.Worksheet; row: number; col: number }[] = [];

  let idx = 0;
  for (const id of dossierIds) {
    idx += 1;
    const evalPath = resolve(evalDir, `${id}.json`);
    let e: Evaluation | null = null;
    if (existsSync(evalPath)) {
      try {
        e = JSON.parse(readFileSync(evalPath, "utf8"));
      } catch {
        e = null;
      }
    }

    // Onglet 1
    const r1 = ws1.addRow(buildEligRow(id, idx, e));
    if (e?.review?.overrides_eligibilite?.length) {
      // marque toute la ligne éligibilité avec un fond très léger
      for (let c = 6; c <= 27; c++) {
        overrideCells.push({ ws: ws1, row: r1.number, col: c });
      }
    }

    // Onglet 2
    const r2 = ws2.addRow(buildNoteRow(id, idx, e));
    if (e?.review?.overrides_ia?.length) {
      for (let c = 6; c <= 47; c++) {
        overrideCells.push({ ws: ws2, row: r2.number, col: c });
      }
    }

    // Onglet 3 (synthèses)
    if (e) {
      ws3.addRow({
        ref: refFromId(id),
        id,
        forts: (e.synthese?.points_forts ?? []).map((s, i) => `${i + 1}. ${s}`).join("\n"),
        vig: (e.synthese?.points_vigilance ?? []).map((s, i) => `${i + 1}. ${s}`).join("\n"),
        ve: (e.synthese?.verifications_externes ?? []).map((s, i) => `${i + 1}. ${s}`).join("\n"),
        ci: (e.commentaires_internes ?? []).map((s) => `- ${s}`).join("\n"),
      });
    } else {
      ws3.addRow({ ref: refFromId(id), id, forts: "(non évalué)", vig: "", ve: "", ci: "" });
    }

    // Onglet 4 (modifications humaines)
    if (e) {
      for (const ov of e.review?.overrides_ia ?? []) {
        ws4.addRow({
          ref: refFromId(id),
          id,
          type: "Notation",
          qref: `Q${ov.question_id}`,
          ia: ov.score_ia ?? "",
          human: ov.score_human,
          raison: ov.raison,
          par: ov.par,
          le: ov.le.slice(0, 19).replace("T", " "),
        });
      }
      for (const ov of e.review?.overrides_eligibilite ?? []) {
        ws4.addRow({
          ref: refFromId(id),
          id,
          type: "Éligibilité",
          qref: ov.critere_id,
          ia: ov.statut_ia ?? "",
          human: ov.statut_human,
          raison: ov.raison,
          par: ov.par,
          le: ov.le.slice(0, 19).replace("T", " "),
        });
      }
    }
  }

  // Coloration des overrides (fond ambre clair)
  for (const { ws, row, col } of overrideCells) {
    const cell = ws.getRow(row).getCell(col);
    if (!cell.value) continue;
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFFFE9C4" },
    };
  }

  // Wrap text sur Synthèses
  ws3.eachRow({ includeEmpty: false }, (row) => {
    row.alignment = { vertical: "top", wrapText: true };
  });
  ws4.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber > 1) row.alignment = { vertical: "top", wrapText: true };
  });

  const ab = await wb.xlsx.writeBuffer();
  return Buffer.from(ab);
}
