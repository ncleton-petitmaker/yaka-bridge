/**
 * Simule l'insertion d'une proposition dans le skill global cible
 * pour générer un diff git-style avant promotion.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as yamlParse } from "yaml";
import {
  activeGlobalSkillsDir,
  activePropositionsDir,
} from "./skills.js";

export interface PropositionPreview {
  before: string;
  after: string;
  targetFile: string;
  targetPath: string;
  insertedAt: { line: number; section: string | null };
  proposition: {
    auteur?: string;
    date?: string;
    affecte?: string;
    dossier_declencheur?: string;
    raison?: string;
    body: string;
  };
}

function skillsRoot(dataDir: string, sharedSkillsDir?: string): string {
  return sharedSkillsDir
    ? resolve(sharedSkillsDir)
    : resolve(dataDir, ".claude", "skills");
}

function parseFrontmatter(raw: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: raw };
  try {
    return {
      frontmatter: (yamlParse(match[1]) ?? {}) as Record<string, unknown>,
      body: match[2],
    };
  } catch {
    return { frontmatter: {}, body: match[2] };
  }
}

export function targetSkillFor(affecte: string | undefined): string {
  const a = (affecte ?? "").toUpperCase();
  if (/^ELG-?\d/.test(a)) return "evaluer-eligibilite.skill.md";
  if (/^Q-?\d/.test(a)) return "evaluer-notation.skill.md";
  return "evaluer-eligibilite.skill.md"; // fallback : règle générale → éligibilité
}

/**
 * Cherche la section `## ELG-X` ou `## Q-Y` dans le markdown.
 * Renvoie l'index de la ligne du heading, ou -1 si pas trouvé.
 */
function findSectionLine(lines: string[], affecte: string): number {
  const norm = affecte.toUpperCase().replace(/\s+/g, "");
  const patterns = [
    new RegExp(`^#{1,4}\\s.*\\b${norm}\\b`, "i"),
    new RegExp(`^#{1,4}\\s+${norm}\\b`, "i"),
  ];
  for (let i = 0; i < lines.length; i++) {
    for (const p of patterns) {
      if (p.test(lines[i])) return i;
    }
  }
  return -1;
}

/**
 * Cherche l'endroit où insérer la nouvelle règle :
 * juste avant la prochaine section de même niveau, ou en fin si aucune.
 */
function findInsertionPoint(lines: string[], sectionStart: number): number {
  if (sectionStart === -1) return lines.length;
  const startLine = lines[sectionStart];
  const headingLevel = startLine.match(/^(#{1,6})\s/)?.[1].length ?? 2;
  const headingRegex = new RegExp(`^#{1,${headingLevel}}\\s`);
  for (let i = sectionStart + 1; i < lines.length; i++) {
    if (headingRegex.test(lines[i])) return i;
  }
  return lines.length;
}

/**
 * Construit le bloc à insérer dans le skill global, à partir du body de la proposition.
 * Le body de la proposition est généré par le skill ameliorer-mes-regles ; on l'enveloppe
 * dans un bloc bien identifié (commentaire HTML pour idempotence).
 */
function buildInsertBlock(
  filename: string,
  auteur: string | undefined,
  date: string | undefined,
  raison: string | undefined,
  body: string
): string {
  const headerLines: string[] = [
    "",
    `<!-- prop:${filename} -->`,
    `### Règle ajoutée (proposition de ${auteur ?? "?"}${date ? ` le ${date.slice(0, 10)}` : ""})`,
    "",
  ];
  if (raison) headerLines.push(`> ${raison}`, "");
  return headerLines.join("\n") + body.trimEnd() + "\n";
}

export function previewProposition(
  dataDir: string,
  filename: string,
  sharedSkillsDir?: string
): PropositionPreview | null {
  const propPath = resolve(activePropositionsDir(dataDir, sharedSkillsDir), filename);
  if (!existsSync(propPath)) return null;
  const propRaw = readFileSync(propPath, "utf8");
  const { frontmatter, body } = parseFrontmatter(propRaw);

  const auteur = frontmatter.auteur as string | undefined;
  const date = frontmatter.date as string | undefined;
  const affecte = frontmatter.affecte as string | undefined;
  const dossier_declencheur = frontmatter.dossier_declencheur as string | undefined;
  const raison = frontmatter.raison as string | undefined;

  const targetFile = targetSkillFor(affecte);
  const targetPath = resolve(activeGlobalSkillsDir(dataDir, sharedSkillsDir), targetFile);

  if (!existsSync(targetPath)) {
    return {
      before: "",
      after: buildInsertBlock(filename, auteur, date, raison, body),
      targetFile,
      targetPath,
      insertedAt: { line: 0, section: null },
      proposition: { auteur, date, affecte, dossier_declencheur, raison, body },
    };
  }

  const before = readFileSync(targetPath, "utf8");
  const lines = before.split("\n");
  const sectionLine = affecte ? findSectionLine(lines, affecte) : -1;
  const insertLine =
    sectionLine === -1 ? lines.length : findInsertionPoint(lines, sectionLine);

  const block = buildInsertBlock(filename, auteur, date, raison, body);
  const beforeBlock = lines.slice(0, insertLine).join("\n");
  const afterBlock = lines.slice(insertLine).join("\n");
  const after =
    (beforeBlock ? beforeBlock + "\n" : "") +
    block +
    (afterBlock ? "\n" + afterBlock : "");

  return {
    before,
    after,
    targetFile,
    targetPath,
    insertedAt: {
      line: insertLine,
      section: sectionLine === -1 ? null : lines[sectionLine].replace(/^#+\s*/, ""),
    },
    proposition: { auteur, date, affecte, dossier_declencheur, raison, body },
  };
}
