/**
 * Parser et stockage des bundles de calibrage importés par l'utilisateur.
 *
 * Format attendu d'un bundle ZIP :
 *   notes-humaines.xlsx (ou n'importe quel .xlsx à la racine)
 *   dossiers/
 *     <reference>/*.pdf
 *     ...
 *
 * Variante tolérée : sous-dossiers de références à plat (sans le wrapper
 * "dossiers/").
 *
 * On parse le xlsx (onglet "Classement général" ou premier onglet), on détecte
 * la colonne référence par regex hex 10 chars, on extrait Nom/Prénom et toutes
 * les colonnes notées entre "Catégorie" et "Moyenne générale".
 *
 * Mapping libellé -> Q skill : on charge le skill `evaluer-notation` de la
 * campagne active, on extrait les libellés des Q1..Q49, et on calcule un
 * score Jaccard pour matcher chaque colonne du xlsx à une Q. Cf. ColonneXlsx.
 *
 * Refus si < 70% des colonnes ne sont pas matchées (score >= 0.3) : ça veut
 * dire que le xlsx ne correspond pas à la grille de la campagne active.
 *
 * Validations :
 *   - xlsx présent
 *   - au moins 1 colonne reconnue comme référence
 *   - au moins 5 dossiers
 *   - mapping libellé -> Q >= 70%
 *
 * Sécurité : path.basename() sur tous les noms de fichiers extraits du ZIP
 * pour bloquer le path traversal.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve, basename } from "node:path";
import JSZip from "jszip";
import ExcelJS from "exceljs";
import type {
  CalibrageImport,
  CalibrageImportDossier,
  ColonneXlsx,
} from "../lib/calibrage-import-types.js";
import { getActiveCampaignId, campaignDir } from "./campaigns.js";

const HEX10 = /^[0-9a-f]{10}$/i;

// Extensions de fichiers extraits depuis le ZIP vers chaque dossier candidat.
// Inclut tous les formats officiels OIF (formulaire PDF, budget xlsx, calendrier
// docx, récépissé jpg/png). Filtrage strict pour éviter l'extraction de fichiers
// arbitraires (sécurité anti-malware via whitelist).
const ALLOWED_DOSSIER_EXTS = [".pdf", ".xlsx", ".docx", ".jpg", ".jpeg", ".png"];

function importsRoot(dataDir: string): string {
  return resolve(dataDir, "calibrage", "imports");
}

function importDir(dataDir: string, importId: string): string {
  return resolve(importsRoot(dataDir), importId);
}

/**
 * Génère un identifiant compact basé sur la date courante.
 * Format : YYYY-MM-DD-HH-MM-SS (24h, locale système).
 */
function generateImportId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(
    d.getHours()
  )}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

/**
 * Cherche dans le ZIP un fichier xlsx exploitable (à la racine).
 * Priorité : "notes-humaines.xlsx", sinon premier .xlsx trouvé.
 */
function findXlsxEntry(zip: JSZip): JSZip.JSZipObject | null {
  // Priorité au nom canonique
  const canonical = zip.file("notes-humaines.xlsx");
  if (canonical) return canonical;
  for (const name of Object.keys(zip.files)) {
    const entry = zip.files[name];
    if (entry.dir) continue;
    // Racine seulement (pas de slash, ou un seul segment)
    if (name.includes("/")) continue;
    if (name.toLowerCase().endsWith(".xlsx")) return entry;
  }
  return null;
}

/**
 * Convertit la valeur d'une cellule xlsx en string trim.
 */
function cellString(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "object") {
    // ExcelJS renvoie parfois { richText: [...] } ou { result: ... }
    const obj = v as Record<string, unknown>;
    if (typeof obj.text === "string") return String(obj.text).trim();
    if (Array.isArray(obj.richText)) {
      return (obj.richText as { text?: string }[])
        .map((p) => p.text ?? "")
        .join("")
        .trim();
    }
    if (obj.result != null) return cellString(obj.result);
    if (obj.formula != null) return ""; // formule sans résultat
  }
  return String(v).trim();
}

/**
 * Convertit une cellule en nombre, ou null si vide / non parsable.
 * Tolère "12,5", "12.5", "12 / 20".
 */
function cellNumber(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number" && !Number.isNaN(v)) return v;
  const s = cellString(v);
  if (!s) return null;
  // "12 / 20" ou "12/20" -> garder le numérateur
  const slash = s.split(/\s*\/\s*/);
  const head = slash[0].replace(",", ".").trim();
  const n = Number(head);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse le barème max depuis le libellé d'une colonne xlsx (suffixe "(/N)" ou
 * " /N"). Retourne null si rien trouvé.
 */
function parseBaremeFromLibelle(libelle: string): number | null {
  // "...questions ? (/2)" ou "...questions ? /2"
  // tolère espace, parenthèse fermante absente, position en fin de chaîne
  const re1 = /\(\s*\/\s*(\d+(?:[.,]\d+)?)\s*\)\s*$/;
  const m1 = libelle.match(re1);
  if (m1) {
    const n = Number(m1[1].replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  const re2 = /\s\/\s*(\d+(?:[.,]\d+)?)\s*$/;
  const m2 = libelle.match(re2);
  if (m2) {
    const n = Number(m2[1].replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

interface ParsedXlsx {
  /** Index 0-based de la colonne référence dans la feuille. */
  refColIdx: number;
  /** Index 0-based de la colonne Nom (best-effort). */
  nomColIdx: number | null;
  /** Index 0-based de la colonne Prénom (best-effort). */
  prenomColIdx: number | null;
  /** Index 0-based de la colonne "Catégorie" (questions à droite). */
  categorieColIdx: number | null;
  /** Index 0-based de la colonne "Moyenne générale" (best-effort). */
  moyenneColIdx: number | null;
  /** Headers complets de la feuille, indexés 0-based. */
  headers: string[];
  /** Lignes de données (chaque ligne = tableau de cellules). */
  rows: unknown[][];
  /** Indices 0-based des colonnes considérées comme notées (entre Catégorie et Moyenne). */
  notedColIdxs: number[];
}

/**
 * Parse l'xlsx et identifie les colonnes-clés.
 * - Header row : prend le ligne où on détecte au moins une cellule "Référence"
 *   ou similar, sinon ligne 1. En fallback, prend la ligne où on trouve "Q1".
 * - Détection de la colonne référence : on prend la colonne où une majorité de
 *   valeurs (>50% des lignes non vides) matchent regex hex 10 chars.
 * - Détection des colonnes notées : toutes les colonnes strictement entre
 *   `Catégorie` et `Moyenne générale` (exclus). Si Catégorie absente, on
 *   prend tout à droite de la référence (legacy).
 */
async function parseXlsx(buffer: Buffer): Promise<ParsedXlsx | null> {
  const wb = new ExcelJS.Workbook();
  // ExcelJS déclare son propre `interface Buffer extends ArrayBuffer { }` qui
  // n'a rien à voir avec NodeJS.Buffer. On passe l'ArrayBuffer sous-jacent.
  const ab = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  ) as ArrayBuffer;
  await wb.xlsx.load(ab as unknown as Parameters<typeof wb.xlsx.load>[0]);

  // Cherche onglet "Classement général" sinon premier
  const ws =
    wb.worksheets.find(
      (w) =>
        w.name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "") ===
        "classement general"
    ) ?? wb.worksheets[0];
  if (!ws) return null;

  // Extrait toutes les lignes en tableau brut
  const allRows: unknown[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const arr: unknown[] = [];
    // ExcelJS row.values est 1-based, [undefined, c1, c2, ...]
    const vals = row.values as unknown[];
    for (let i = 1; i < vals.length; i++) arr.push(vals[i]);
    allRows.push(arr);
  });

  if (allRows.length === 0) return null;

  // Détecte la ligne d'en-tête : la première qui contient un "Q1" littéral ou
  // "Référence", "Reference", "Nom", "Prénom"
  let headerRowIdx = 0;
  for (let i = 0; i < Math.min(5, allRows.length); i++) {
    const headers = allRows[i].map((c) => cellString(c).toLowerCase());
    if (
      headers.some(
        (h) =>
          h === "référence" ||
          h === "reference" ||
          h === "réference" ||
          h === "q1" ||
          h === "nom"
      )
    ) {
      headerRowIdx = i;
      break;
    }
  }
  const headers = allRows[headerRowIdx].map((c) => cellString(c));
  const dataRows = allRows.slice(headerRowIdx + 1).filter((r) =>
    r.some((c) => cellString(c) !== "")
  );

  // Détecte colonne référence : compte les valeurs hex 10 par colonne
  let refColIdx = -1;
  let bestRefHits = 0;
  const colCount = Math.max(headers.length, ...dataRows.map((r) => r.length));
  for (let col = 0; col < colCount; col++) {
    let hits = 0;
    for (const r of dataRows) {
      const v = cellString(r[col]);
      if (HEX10.test(v)) hits++;
    }
    if (hits > bestRefHits) {
      bestRefHits = hits;
      refColIdx = col;
    }
  }

  // Si aucune colonne ne contient suffisamment de hex 10, on tombe sur un nom
  // d'en-tête "référence" / "reference"
  if (bestRefHits === 0) {
    const idx = headers.findIndex((h) => {
      const norm = h.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
      return norm === "reference";
    });
    if (idx >= 0) refColIdx = idx;
  }

  if (refColIdx < 0) return null;

  // Best-effort sur Nom / Prénom / Catégorie / Moyenne générale
  function findCol(predicate: (h: string) => boolean): number | null {
    const idx = headers.findIndex((h) => predicate(h));
    return idx >= 0 ? idx : null;
  }
  const nomColIdx = findCol((h) => h.toLowerCase() === "nom");
  const prenomColIdx = findCol((h) => {
    const norm = h.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    return norm === "prenom";
  });
  const categorieColIdx = findCol((h) => {
    const norm = h.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    return norm === "categorie";
  });
  const moyenneColIdx = findCol((h) => {
    const norm = h.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    return norm === "moyenne generale" || norm === "moyenne";
  });

  // Détecte la zone des colonnes notées
  const notedColIdxs: number[] = [];
  if (categorieColIdx != null) {
    const stop = moyenneColIdx ?? colCount;
    for (let col = categorieColIdx + 1; col < stop && col < colCount; col++) {
      // Une colonne notée a un libellé non vide (ignore les colonnes "Examinateurs", "Examinations")
      const lib = headers[col] ?? "";
      if (!lib.trim()) continue;
      notedColIdxs.push(col);
    }
  } else {
    // Legacy : pas de Catégorie, on prend tout à droite de la référence (sauf nom/prénom/moyenne)
    for (let col = refColIdx + 1; col < colCount; col++) {
      if (col === nomColIdx || col === prenomColIdx || col === moyenneColIdx) continue;
      const lib = headers[col] ?? "";
      if (!lib.trim()) continue;
      notedColIdxs.push(col);
    }
  }

  return {
    refColIdx,
    nomColIdx,
    prenomColIdx,
    categorieColIdx,
    moyenneColIdx,
    headers,
    rows: dataRows,
    notedColIdxs,
  };
}

// ============================================================
// Chargement et parsing du skill evaluer-notation
// ============================================================

interface SkillQ {
  id: number;
  /** Libellé de la question (première ligne après le ### Q<id>, nettoyée). */
  libelle: string;
  /** True si la Q est marquée HORS IA. */
  horsIa: boolean;
}

/**
 * Trouve le fichier evaluer-notation.skill.md de la campagne active, avec
 * fallback sur le template global.
 */
function findEvaluerNotationSkill(
  dataDir: string,
  sharedSkillsDir?: string
): string | null {
  // Priorité 1 : campagne active
  const activeId = getActiveCampaignId(dataDir, sharedSkillsDir);
  if (activeId) {
    const p = resolve(
      campaignDir(dataDir, activeId, sharedSkillsDir),
      "skills",
      "evaluer-notation.skill.md"
    );
    if (existsSync(p)) return p;
  }
  // Priorité 2 : skills globaux dans data/.claude/skills/_global
  const globalP = resolve(
    dataDir,
    ".claude",
    "skills",
    "_global",
    "evaluer-notation.skill.md"
  );
  if (existsSync(globalP)) return globalP;
  // Priorité 3 : template au build (skills-template/_global)
  // on remonte de dataDir : dataDir = .../data, parent = repo root
  const tplP = resolve(
    dataDir,
    "..",
    "skills-template",
    "_global",
    "evaluer-notation.skill.md"
  );
  if (existsSync(tplP)) return tplP;
  return null;
}

/**
 * Parse les Q1..Q49 d'un fichier evaluer-notation.skill.md.
 * Format attendu pour chaque Q :
 *   ### Q<id> [<barème ou HORS IA>] [optionnel - suffixe]
 *   **<titre court.>** <question complète qui est plus proche du libellé xlsx>
 *
 * On concatène le titre en **gras** ET la phrase qui suit, parce que :
 *  - le titre seul ("Implantation locale") n'a pas assez de tokens pour matcher,
 *  - la phrase seule ("L'organisation a-t-elle son siège social...") est plus
 *    proche du libellé xlsx ("L'organisation est implantée localement...").
 * Plus on a de signal lexical, mieux le Jaccard fonctionne.
 */
function parseSkillQuestions(skillPath: string): SkillQ[] {
  const txt = readFileSync(skillPath, "utf8");
  const lines = txt.split(/\r?\n/);
  const headRe = /^###\s+Q(\d+)\b(.*)$/;
  const out: SkillQ[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(headRe);
    if (!m) continue;
    const id = Number(m[1]);
    if (!Number.isFinite(id)) continue;
    const headerSuffix = m[2] ?? "";
    const horsIa = /HORS\s*IA/i.test(headerSuffix);

    // On collecte les 1 à 3 premières lignes non vides après le heading,
    // jusqu'à atteindre le prochain heading ou une bullet list.
    const parts: string[] = [];
    for (let j = i + 1; j < lines.length && j < i + 6; j++) {
      const raw = lines[j];
      if (!raw.trim()) {
        if (parts.length > 0) break;
        continue;
      }
      const l = raw.trim();
      if (/^###\s+Q\d+/.test(l)) break; // heading suivant
      if (/^[-*]\s+/.test(l) || /^\d+\.\s+/.test(l)) break; // bullet/numérotée
      // Nettoie markdown
      const cleaned = l
        .replace(/\*\*([^*]+)\*\*/g, "$1") // **gras** -> gras
        .replace(/\*([^*]+)\*/g, "$1") // *italique*
        .replace(/`([^`]+)`/g, "$1") // `code`
        .trim();
      if (cleaned) parts.push(cleaned);
      if (parts.length >= 2) break;
    }
    const libelle = parts.join(" ").replace(/\s+/g, " ").trim();
    out.push({ id, libelle, horsIa });
  }
  return out;
}

// ============================================================
// Matching libellé colonne xlsx -> Q skill (Jaccard fuzzy)
// ============================================================

/**
 * Mots vides français + mots ultra-fréquents dans les libellés OIF (présents
 * dans presque tous les énoncés, donc non discriminants). En les filtrant on
 * concentre le Jaccard sur les vrais marqueurs sémantiques.
 */
/**
 * Mots vides français qui n'aident pas à discriminer entre questions.
 * Ne PAS y mettre les mots-clés métier OIF (organisation, projet, femmes,
 * filles, jeunes, francophonie, fonds, etc.) : même s'ils sont fréquents,
 * ils restent des marqueurs sémantiques utiles parce que les xlsx OIF les
 * combinent différemment selon les questions ("organisation de jeunes" vs
 * "organisation de femmes" vs "L'organisation est implantée localement").
 */
const STOP_TOKENS = new Set([
  // articles, pronoms, prépositions, auxiliaires, conjonctions
  "les", "des", "une", "aux", "qui", "que", "ces", "ses", "ils", "ont",
  "est", "sont", "pour", "par", "sur", "vers", "avec", "sans", "dans",
  "selon", "etre", "etant", "cet", "cette", "ceux", "elle", "elles",
  "leur", "leurs", "soit", "tout", "tous", "toutes", "fait", "faits",
  "mais", "pas", "plus", "moins", "non", "oui", "donc",
  "ainsi", "afin", "comme", "lors", "lorsque", "deja", "encore",
  "ete", "tres", "bien", "ceci", "cela", "ici", "alors", "puis",
]);

/**
 * Stemmer français léger (suffixes pluriel + accords). Pas de Porter complet,
 * juste assez pour matcher "modestes" ↔ "modeste", "implantées" ↔ "implanté",
 * "organisations" ↔ "organisation". Crucial pour le matching xlsx OIF qui
 * utilise les pluriels et accords là où le skill préfère les singuliers.
 */
function stem(t: string): string {
  if (t.length <= 4) return t;
  // Ordre important : suffixes les plus longs d'abord
  for (const suf of [
    "ements", "ements", "issent", "ssent",
    "ation", "tions", "aient",
    "ements", "ement",
    "elles", "elles", "iers", "ieres", "iere", "ier",
    "ales", "aux", "aire", "ales",
    "ees", "iee", "ees", "ent", "ant",
    "es", "ee", "er", "is", "it", "if", "ie", "ir", "us",
    "s", "e",
  ]) {
    if (t.length > suf.length + 2 && t.endsWith(suf)) {
      return t.slice(0, t.length - suf.length);
    }
  }
  return t;
}

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !STOP_TOKENS.has(t))
      .map(stem)
  );
}

/**
 * Score de similarité token-level entre deux libellés.
 *
 * On combine deux mesures pour rester robuste face à l'asymétrie inhérente
 * aux libellés OIF (xlsx = phrase compacte type "L'organisation est une
 * organisation de jeunes" vs skill = titre + détails + critères) :
 *
 *  - Jaccard classique (intersection / union) : symétrique, exigeant.
 *  - Containment (intersection / plus petite des deux) : pénalise moins
 *    quand un libellé est nettement plus long que l'autre.
 *
 * On retient le maximum des deux. C'est volontairement plus permissif que la
 * spec initiale (Jaccard pur) parce que les xlsx OIF sont court, le skill
 * long, et un Jaccard pur passe à côté de matches évidents (ex : col xlsx
 * "L'organisation est une organisation de jeunes" vs Q5 skill "Organisation
 * de jeunes (15-34 ans). Critères : (1) thématique jeunesse, ...").
 *
 * Détails :
 *  - tokens de >= 3 caractères (acronymes OIF : FAE, OIF, OSC, EFH, OING),
 *  - filtrage d'une stoplist française,
 *  - stem-light des suffixes (pluriels et accords).
 */
function jaccardTokens(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  const inter = [...ta].filter((t) => tb.has(t)).length;
  const union = new Set([...ta, ...tb]).size;
  const jaccard = inter / union;
  const containment = inter / Math.min(ta.size, tb.size);
  return Math.max(jaccard, containment);
}

interface MatchingResult {
  colonnes: ColonneXlsx[];
  matchedCount: number;
  totalCount: number;
}

/**
 * Pour chaque colonne notée du xlsx, calcule le meilleur match Jaccard contre
 * les Q du skill. Une Q ne peut être matchée qu'à UNE colonne (priorité au
 * meilleur score, en cas d'égalité au plus à gauche dans le xlsx).
 *
 * Algo : on construit toutes les paires (colonne, Q, score) et on les trie
 * par score décroissant puis par position xlsx croissante. On allume chaque
 * paire dans cet ordre tant que ni la colonne ni la Q ne sont déjà prises.
 * Cette stratégie évite qu'une colonne en début de xlsx vole la Q "parfaite"
 * d'une colonne plus à droite (vs une allocation purement gloutonne par xlsx).
 *
 * Seuils :
 *   - score >= 0.6 : match confirmé
 *   - 0.3 <= score < 0.6 : match probable (warning)
 *   - score < 0.3 : pas de match
 */
function normalizeForAlias(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[''`]/g, "'")
    .replace(/[«»"]/g, '"')
    .replace(/\s*\(\/\d+\)\s*$/, "")
    .replace(/\.\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Charge les alias libellés xlsx officiels (6e + 7e) depuis le JSON.
 * Retourne `aliases` (libellé_normalisé -> qId) et `ignored` (set de
 * libellés_normalisés à exclure du calcul totalCount sans warning,
 * pour les colonnes officiellement supprimées entre éditions).
 */
function loadOfficialAliases(dataDir: string): {
  aliases: Map<string, number>;
  ignored: Set<string>;
} {
  const aliases = new Map<string, number>();
  const ignored = new Set<string>();
  try {
    const path = resolve(dataDir, "calibrage", "libelles-xlsx-officiels.json");
    if (!existsSync(path)) return { aliases, ignored };
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as {
      aliases?: { libelle: string; qId: number }[];
      ignored?: { libelle: string }[];
    };
    for (const a of parsed.aliases ?? []) {
      if (!a.libelle || typeof a.qId !== "number") continue;
      aliases.set(normalizeForAlias(a.libelle), a.qId);
    }
    for (const i of parsed.ignored ?? []) {
      if (!i.libelle) continue;
      ignored.add(normalizeForAlias(i.libelle));
    }
  } catch {
    // ignore - fallback sur Jaccard pur
  }
  return { aliases, ignored };
}

function buildColonneMapping(
  parsed: ParsedXlsx,
  skillQuestions: SkillQ[],
  officialAliases: Map<string, number>,
  officialIgnored: Set<string>
): MatchingResult {
  // 1. Métadonnées par colonne (libellé, barème).
  // Pré-filtre : colonnes dont le libellé est officiellement "à ignorer"
  // (questions supprimées entre éditions) sont retirées du décompte total.
  const ignoredColIdxs = new Set<number>();
  for (const colIdx of parsed.notedColIdxs) {
    const lib = parsed.headers[colIdx] ?? "";
    if (officialIgnored.has(normalizeForAlias(lib))) {
      ignoredColIdxs.add(colIdx);
    }
  }
  const colMeta = parsed.notedColIdxs
    .filter((colIdx) => !ignoredColIdxs.has(colIdx))
    .map((colIdx) => ({
      colIdx,
      lib: parsed.headers[colIdx] ?? "",
      bareme: parseBaremeFromLibelle(parsed.headers[colIdx] ?? ""),
    }));

  const colTaken = new Set<number>();
  const qTaken = new Set<number>();
  const matched = new Map<number, { qId: number; score: number }>();

  // 1bis. Exact-match via alias officiels (libellés 6e/7e connus).
  // Score forcé à 1.0 pour éviter tout warning "match faible".
  for (const cm of colMeta) {
    const norm = normalizeForAlias(cm.lib);
    const qId = officialAliases.get(norm);
    if (qId != null && !qTaken.has(qId)) {
      colTaken.add(cm.colIdx);
      qTaken.add(qId);
      matched.set(cm.colIdx, { qId, score: 1.0 });
    }
  }

  // 2. Construit toutes les paires (colonne, Q, score) au-dessus du seuil 0.3
  //    pour limiter le travail. Seulement pour les colonnes non encore matchées.
  const pairs: { colIdx: number; q: SkillQ; score: number }[] = [];
  for (const cm of colMeta) {
    if (colTaken.has(cm.colIdx)) continue;
    for (const q of skillQuestions) {
      if (qTaken.has(q.id)) continue;
      const s = jaccardTokens(cm.lib, q.libelle);
      if (s >= 0.3) pairs.push({ colIdx: cm.colIdx, q, score: s });
    }
  }
  // Tri : meilleur score d'abord, en cas d'égalité la colonne la plus à gauche.
  pairs.sort((a, b) => b.score - a.score || a.colIdx - b.colIdx);

  for (const p of pairs) {
    if (colTaken.has(p.colIdx) || qTaken.has(p.q.id)) continue;
    colTaken.add(p.colIdx);
    qTaken.add(p.q.id);
    matched.set(p.colIdx, { qId: p.q.id, score: p.score });
  }

  // 3. Composition finale dans l'ordre xlsx
  const colonnes: ColonneXlsx[] = [];
  let matchedCount = 0;
  for (const cm of colMeta) {
    const m = matched.get(cm.colIdx);
    let matchedSkillQId: number | null = null;
    let matchScore = 0;
    let matchWarning: string | null = null;

    if (m && m.score >= 0.6) {
      matchedSkillQId = m.qId;
      matchScore = Number(m.score.toFixed(3));
      matchedCount++;
    } else if (m && m.score >= 0.3) {
      matchedSkillQId = m.qId;
      matchScore = Number(m.score.toFixed(3));
      matchWarning = `match faible (score ${matchScore.toFixed(2)})`;
      matchedCount++;
    } else {
      matchWarning = "aucune Q skill ne correspond";
    }

    colonnes.push({
      positionXlsx: cm.colIdx,
      libelleXlsx: cm.lib,
      baremeXlsxMax: cm.bareme,
      matchedSkillQId,
      matchScore,
      matchWarning,
    });
  }

  return { colonnes, matchedCount, totalCount: colMeta.length };
}

/**
 * Sécurise un nombre tombé dans une cellule xlsx contre les valeurs aberrantes
 * (note > barème). Retourne la valeur si elle est dans la plage attendue,
 * null sinon (et accumule un warning pour l'utilisateur).
 */
function clampScoreToBareme(
  value: number | null,
  bareme: number | null,
  context: string,
  warnings: string[]
): number | null {
  if (value == null) return null;
  if (bareme == null) return value;
  // Tolérance 5% (arrondi xlsx)
  if (value > bareme * 1.05) {
    warnings.push(
      `${context} : note ${value} > barème ${bareme}, ignorée (probable erreur de saisie xlsx).`
    );
    return null;
  }
  return value;
}

/**
 * Importe un bundle ZIP, parse l'xlsx, écrit le manifeste JSON et décompresse
 * les dossiers PDF dans data/calibrage/imports/<importId>/dossiers/<reference>/.
 */
export async function importBundle(
  dataDir: string,
  buffer: Buffer,
  filename: string,
  sharedSkillsDir?: string
): Promise<
  | { ok: true; data: CalibrageImport }
  | { ok: false; error: string; warnings?: string[] }
> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (err) {
    return { ok: false, error: `ZIP illisible : ${(err as Error).message}` };
  }

  const xlsxEntry = findXlsxEntry(zip);
  if (!xlsxEntry) {
    return {
      ok: false,
      error: "Aucun fichier xlsx trouvé à la racine du ZIP.",
    };
  }

  const xlsxBuffer = Buffer.from(await xlsxEntry.async("nodebuffer"));
  const parsed = await parseXlsx(xlsxBuffer);
  if (!parsed) {
    return {
      ok: false,
      error:
        "Le fichier xlsx ne contient pas de colonne reconnue comme référence (codes hex 10 caractères).",
    };
  }

  // ============================================================
  // Mapping libellé colonne xlsx -> Q skill
  // ============================================================
  const skillPath = findEvaluerNotationSkill(dataDir, sharedSkillsDir);
  if (!skillPath) {
    return {
      ok: false,
      error:
        "Skill evaluer-notation introuvable (ni campagne active, ni global, ni template). Configurer une campagne avant d'importer un bundle.",
    };
  }
  const skillQuestions = parseSkillQuestions(skillPath);
  if (skillQuestions.length === 0) {
    return {
      ok: false,
      error: `Skill ${basename(skillPath)} ne contient pas de question parsable (### Q<id>...).`,
    };
  }

  const officialMap = loadOfficialAliases(dataDir);
  const mapping = buildColonneMapping(parsed, skillQuestions, officialMap.aliases, officialMap.ignored);
  if (mapping.totalCount === 0) {
    return {
      ok: false,
      error:
        "Aucune colonne notée détectée dans le xlsx (entre 'Catégorie' et 'Moyenne générale').",
    };
  }

  // Refus si moins de 70% des colonnes ont un match >= 0.3
  const matchRatio = mapping.matchedCount / mapping.totalCount;
  if (matchRatio < 0.7) {
    return {
      ok: false,
      error: `Mapping insuffisant : ${mapping.totalCount - mapping.matchedCount} colonnes du xlsx ne correspondent à aucune question du skill actif (${mapping.matchedCount}/${mapping.totalCount} matchées, seuil 70%). Vérifiez que le xlsx correspond à la grille de la campagne active.`,
    };
  }

  // Construit la liste des dossiers depuis les lignes
  const warnings: string[] = [];
  const dossiers: CalibrageImportDossier[] = [];
  const refSet = new Set<string>();

  // Map positionXlsx -> ColonneXlsx pour lookup O(1)
  const colByPos = new Map<number, ColonneXlsx>();
  for (const c of mapping.colonnes) colByPos.set(c.positionXlsx, c);

  for (const row of parsed.rows) {
    const refRaw = cellString(row[parsed.refColIdx]);
    if (!HEX10.test(refRaw)) continue;
    const reference = refRaw.toLowerCase();
    if (refSet.has(reference)) continue;
    refSet.add(reference);

    const nom = parsed.nomColIdx != null ? cellString(row[parsed.nomColIdx]) : "";
    const prenom =
      parsed.prenomColIdx != null ? cellString(row[parsed.prenomColIdx]) : "";

    // Scores humains : indexés par position xlsx ("col_<N>"), pour rester lisible
    // dans le manifeste et permettre au script de calibrage de retrouver via le
    // mapping `colonnes`.
    const scoresHumains: Record<string, number | null> = {};
    for (const colIdx of parsed.notedColIdxs) {
      const rawValue = cellNumber(row[colIdx]);
      const col = colByPos.get(colIdx);
      const clamped = clampScoreToBareme(
        rawValue,
        col?.baremeXlsxMax ?? null,
        `Référence ${reference} colonne ${colIdx + 1}`,
        warnings
      );
      scoresHumains[`col_${colIdx}`] = clamped;
    }

    const moyenneHumaine =
      parsed.moyenneColIdx != null ? cellNumber(row[parsed.moyenneColIdx]) : null;

    dossiers.push({
      reference,
      nom,
      prenom,
      scoresHumains,
      moyenneHumaine,
      hasFolder: false,
      pdfCount: 0,
    });
  }

  if (dossiers.length < 3) {
    return {
      ok: false,
      error: `Moins de 3 références détectées dans l'xlsx (${dossiers.length}). Bundle insuffisant.`,
    };
  }

  // Détecte les sous-dossiers PDF dans le ZIP
  // Variantes : dossiers/<ref>/ ou <ref>/ à plat
  const folderToFiles = new Map<string, string[]>();
  zip.forEach((relativePath, entry) => {
    if (entry.dir) return;
    // Normalise les séparateurs
    const parts = relativePath.split("/").filter((p) => p.length > 0);
    if (parts.length < 2) return;
    let refCandidate: string | null = null;
    let fileName: string | null = null;
    if (parts[0] === "dossiers" && parts.length >= 3) {
      refCandidate = parts[1].toLowerCase();
      fileName = parts[parts.length - 1];
    } else if (parts.length >= 2) {
      refCandidate = parts[0].toLowerCase();
      fileName = parts[parts.length - 1];
    }
    if (!refCandidate || !fileName) return;
    if (!HEX10.test(refCandidate)) return;
    if (!ALLOWED_DOSSIER_EXTS.some((ext) => fileName!.toLowerCase().endsWith(ext))) return;
    const arr = folderToFiles.get(refCandidate) ?? [];
    arr.push(relativePath);
    folderToFiles.set(refCandidate, arr);
  });

  // Crée le dossier d'import
  const importId = generateImportId();
  const targetDir = importDir(dataDir, importId);
  if (existsSync(targetDir)) {
    return {
      ok: false,
      error: `Conflit d'identifiant d'import (${importId}). Réessayer dans une seconde.`,
    };
  }
  mkdirSync(resolve(targetDir, "dossiers"), { recursive: true });

  // Décompresse les fichiers en sécurité
  for (const [ref, files] of folderToFiles.entries()) {
    const dossierTarget = resolve(targetDir, "dossiers", ref);
    mkdirSync(dossierTarget, { recursive: true });
    for (const fpath of files) {
      const safeName = basename(fpath); // anti path traversal
      if (!ALLOWED_DOSSIER_EXTS.some((ext) => safeName.toLowerCase().endsWith(ext))) continue;
      const entry = zip.file(fpath);
      if (!entry) continue;
      const buf = await entry.async("nodebuffer");
      writeFileSync(resolve(dossierTarget, safeName), buf);
    }
  }

  // Compte les PDF par référence et croise avec les dossiers xlsx
  for (const d of dossiers) {
    const folderPath = resolve(targetDir, "dossiers", d.reference);
    if (existsSync(folderPath)) {
      const allFiles = readdirSync(folderPath).filter((f) =>
        ALLOWED_DOSSIER_EXTS.some((ext) => f.toLowerCase().endsWith(ext))
      );
      const pdfs = allFiles.filter((f) => f.toLowerCase().endsWith(".pdf"));
      d.hasFolder = allFiles.length > 0;
      d.pdfCount = pdfs.length;
    }
    if (!d.hasFolder) {
      warnings.push(`Référence ${d.reference} (${d.prenom} ${d.nom}) : aucune pièce trouvée dans le ZIP.`);
    }
  }

  // Référenes du ZIP sans entrée xlsx
  for (const ref of folderToFiles.keys()) {
    if (!refSet.has(ref)) {
      warnings.push(`Dossier ${ref} présent dans le ZIP mais absent de l'xlsx, ignoré.`);
    }
  }

  // Avertissements sur le mapping (faibles ou non matchés)
  for (const c of mapping.colonnes) {
    if (c.matchWarning) {
      const lib = c.libelleXlsx.length > 80 ? c.libelleXlsx.slice(0, 77) + "..." : c.libelleXlsx;
      warnings.push(`Colonne xlsx position ${c.positionXlsx + 1} "${lib}" : ${c.matchWarning}.`);
    }
  }

  // Refus définitif si on n'a aucun dossier avec PDF
  const withFolder = dossiers.filter((d) => d.hasFolder).length;
  if (withFolder < 3) {
    // Cleanup
    try {
      rmSync(targetDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    return {
      ok: false,
      error: `Moins de 3 dossiers avec PDF trouvés (${withFolder}). Bundle insuffisant.`,
      warnings,
    };
  }

  const data: CalibrageImport = {
    importId,
    createdAt: new Date().toISOString(),
    bundleName: filename,
    totalDossiers: dossiers.length,
    dossiers,
    colonnes: mapping.colonnes,
    warnings,
  };

  // Persiste le manifeste
  writeFileSync(
    resolve(targetDir, "_import.json"),
    JSON.stringify(data, null, 2),
    "utf8"
  );

  return { ok: true, data };
}

/**
 * Liste les bundles importés (du plus récent au plus ancien).
 */
export function listImports(dataDir: string): CalibrageImport[] {
  const root = importsRoot(dataDir);
  if (!existsSync(root)) return [];
  const out: CalibrageImport[] = [];
  for (const entry of readdirSync(root)) {
    const manifest = resolve(root, entry, "_import.json");
    if (!existsSync(manifest)) continue;
    try {
      const data = JSON.parse(readFileSync(manifest, "utf8")) as CalibrageImport;
      out.push(data);
    } catch {
      // ignore
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Retrouve un import par son id. Sécurisé : basename pour anti path-traversal.
 */
export function getImport(
  dataDir: string,
  importId: string
): CalibrageImport | null {
  const safe = basename(importId);
  const manifest = resolve(importsRoot(dataDir), safe, "_import.json");
  if (!existsSync(manifest)) return null;
  try {
    return JSON.parse(readFileSync(manifest, "utf8")) as CalibrageImport;
  } catch {
    return null;
  }
}

/**
 * Renvoie le chemin absolu du dossier d'un import (pour passage au script).
 */
export function getImportPath(dataDir: string, importId: string): string | null {
  const safe = basename(importId);
  const dir = resolve(importsRoot(dataDir), safe);
  return existsSync(dir) ? dir : null;
}

/**
 * Override manuel du mapping colonnes xlsx -> Q skill.
 *
 * Permet à l'admin de corriger les mappings ratés ou faibles avant de lancer
 * un calibrage. Patch en place le manifest `_import.json` et reclampe les
 * scores humains avec le barème de la nouvelle Q (sans relire l'xlsx).
 *
 * Format de l'override : `{ "col_<positionXlsx>": <qId> | null }`. La valeur
 * null signifie "ne pas mapper cette colonne" (équivalent à un match raté).
 *
 * Sécurité : on refuse les positions inexistantes et les Q dupliquées
 * (deux colonnes ne peuvent pas pointer vers la même Q).
 *
 * Renvoie le manifest mis à jour ou un message d'erreur explicite.
 */
export function updateImportMapping(
  dataDir: string,
  importId: string,
  overrides: Record<string, number | null>
): { ok: true; data: CalibrageImport } | { ok: false; error: string } {
  const safe = basename(importId);
  const manifestPath = resolve(importsRoot(dataDir), safe, "_import.json");
  if (!existsSync(manifestPath)) {
    return { ok: false, error: "import introuvable" };
  }
  let bundle: CalibrageImport;
  try {
    bundle = JSON.parse(readFileSync(manifestPath, "utf8")) as CalibrageImport;
  } catch (err) {
    return { ok: false, error: `manifest illisible : ${(err as Error).message}` };
  }
  if (!bundle.colonnes || bundle.colonnes.length === 0) {
    return {
      ok: false,
      error:
        "Cet import n'a pas de colonnes parsées (manifest pré-fix mapping). Ré-importer le ZIP.",
    };
  }

  // Index colonnes par position pour lookup O(1)
  const colByPos = new Map<number, ColonneXlsx>();
  for (const c of bundle.colonnes) colByPos.set(c.positionXlsx, c);

  // Étape 1 : appliquer les overrides en mémoire (validation au passage).
  const finalMapping = new Map<number, number | null>(); // pos -> qId
  for (const c of bundle.colonnes) {
    finalMapping.set(c.positionXlsx, c.matchedSkillQId);
  }
  for (const [key, value] of Object.entries(overrides)) {
    const m = key.match(/^col_(\d+)$/);
    if (!m) {
      return { ok: false, error: `clé invalide : "${key}" (attendu : col_<N>)` };
    }
    const pos = Number(m[1]);
    if (!colByPos.has(pos)) {
      return {
        ok: false,
        error: `position xlsx ${pos} inconnue dans cet import`,
      };
    }
    if (value !== null && (!Number.isInteger(value) || value < 1 || value > 49)) {
      return {
        ok: false,
        error: `valeur invalide pour ${key} : ${value} (attendu : 1-49 ou null)`,
      };
    }
    finalMapping.set(pos, value);
  }

  // Étape 2 : vérifie qu'aucune Q n'est mappée deux fois.
  const qSeen = new Map<number, number>(); // qId -> pos qui la prend
  for (const [pos, qId] of finalMapping.entries()) {
    if (qId == null) continue;
    const prev = qSeen.get(qId);
    if (prev != null && prev !== pos) {
      return {
        ok: false,
        error: `Q${qId} est mappée à la fois en col_${prev} et col_${pos}. Une Q ne peut être prise qu'une fois.`,
      };
    }
    qSeen.set(qId, pos);
  }

  // Étape 3 : applique en place sur le manifest. Conserve baremeXlsxMax,
  // libelleXlsx, positionXlsx ; remet matchScore = 1.0 (override admin) ou 0
  // (ignoré explicitement) et adapte matchWarning.
  const newWarnings: string[] = [];
  for (const c of bundle.colonnes) {
    const newQ = finalMapping.get(c.positionXlsx) ?? null;
    if (newQ === c.matchedSkillQId) continue; // pas de changement
    if (newQ == null) {
      c.matchedSkillQId = null;
      c.matchScore = 0;
      c.matchWarning = "ignorée par l'admin (override manuel)";
    } else {
      c.matchedSkillQId = newQ;
      c.matchScore = 1.0;
      c.matchWarning = null;
    }
    newWarnings.push(
      `Override admin : col_${c.positionXlsx} (${c.libelleXlsx.slice(0, 60)}) -> Q${newQ ?? "ignorée"}.`
    );
  }
  if (newWarnings.length === 0) {
    return { ok: true, data: bundle }; // rien à changer
  }

  bundle.warnings = [...(bundle.warnings ?? []), ...newWarnings];

  // Persiste
  try {
    writeFileSync(manifestPath, JSON.stringify(bundle, null, 2), "utf8");
  } catch (err) {
    return {
      ok: false,
      error: `écriture du manifest échouée : ${(err as Error).message}`,
    };
  }

  return { ok: true, data: bundle };
}

/**
 * Supprime un bundle importé (manifest + dossiers PDF).
 */
export function deleteImport(dataDir: string, importId: string): boolean {
  const safe = basename(importId);
  const dir = resolve(importsRoot(dataDir), safe);
  if (!existsSync(dir)) return false;
  try {
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Génère un xlsx vide aux colonnes attendues. Onglet "Classement général",
 * 49 questions, 50 lignes vides pour saisie. Renvoyé en buffer pour stream.
 */
export async function generateTemplate(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "OIF-Eval";
  wb.created = new Date();

  const ws = wb.addWorksheet("Classement général");

  const headers: string[] = [
    "N° réponse",
    "Référence",
    "Nom",
    "Prénom",
    "Catégorie",
  ];
  for (let i = 1; i <= 49; i++) headers.push(`Q${i}`);
  headers.push("Moyenne générale");

  ws.columns = headers.map((h) => ({
    header: h,
    key: h,
    width: h === "Référence" ? 14 : h === "Nom" || h === "Prénom" ? 18 : 8,
  }));

  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFFCEFEA" },
  };
  ws.views = [{ state: "frozen", xSplit: 2, ySplit: 1 }];

  // 50 lignes vides
  for (let i = 0; i < 50; i++) {
    ws.addRow({});
  }

  // Onglet d'aide
  const help = wb.addWorksheet("Mode d'emploi");
  help.columns = [{ header: "", key: "txt", width: 100 }];
  const lines = [
    "Modèle d'import - Calibrage OIF-Eval",
    "",
    "Renseigner une ligne par dossier dans l'onglet 'Classement général'.",
    "",
    "Colonnes obligatoires :",
    "- Référence : code hexadécimal 10 caractères (ex: 001f9dc70c). Doit correspondre",
    "  au nom du sous-dossier PDF dans le ZIP.",
    "- Nom, Prénom : identité du candidat.",
    "- Q1 à Q49 : note humaine sur le barème de chaque question. Laisser vide si",
    "  question hors-IA ou non notée.",
    "- Moyenne générale : moyenne sur 100 (optionnelle, recalculée sinon).",
    "",
    "Bundle ZIP attendu :",
    "  monbundle.zip",
    "    notes-humaines.xlsx (ce fichier, renseigné)",
    "    dossiers/",
    "      001f9dc70c/",
    "        Presentation-projet.pdf",
    "        ...",
    "      29e0252257/",
    "        ...",
    "",
    "Minimum : 5 dossiers avec PDF associés.",
  ];
  for (const l of lines) help.addRow({ txt: l });
  help.getRow(1).font = { bold: true };

  const ab = await wb.xlsx.writeBuffer();
  return Buffer.from(ab);
}
