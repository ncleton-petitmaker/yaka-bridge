/**
 * CRUD skills perso/global/propositions.
 * Tout vit dans `<dataDir>/.claude/skills/` (déployé depuis `skills-template/`).
 *
 * Layout :
 *   _global/                     skills par défaut versionnés avec l'app
 *   _perso/<user-slug>/          surcharges personnelles
 *   _propositions/               propositions en review
 *   _snapshots/                  snapshots pris avant promotion (revert)
 */
import { readdirSync, readFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { parse as yamlParse } from "yaml";

export interface SkillEntry {
  scope: "global" | "perso" | "proposition";
  owner?: string;
  filename: string;
  path: string;
  frontmatter: Record<string, unknown>;
  body: string;
  raw: string;
  size: number;
  modifiedAt: number;
}

export interface PropositionEntry extends SkillEntry {
  scope: "proposition";
  auteur?: string;
  date?: string;
  affecte?: string;
  statut?: "en_attente" | "promu" | "rejete";
  raison?: string;
}

function parseSkillFile(_path: string, raw: string) {
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

function safeReaddir(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

export function skillsRoot(dataDir: string, sharedSkillsDir?: string): string {
  return sharedSkillsDir
    ? resolve(sharedSkillsDir)
    : resolve(dataDir, ".claude", "skills");
}

export function activeGlobalSkillsDir(
  dataDir: string,
  sharedSkillsDir?: string
): string {
  return resolve(skillsRoot(dataDir, sharedSkillsDir), "_global");
}

export function activePropositionsDir(
  dataDir: string,
  sharedSkillsDir?: string
): string {
  return resolve(skillsRoot(dataDir, sharedSkillsDir), "_propositions");
}

export function listGlobalSkills(dataDir: string, sharedSkillsDir?: string): SkillEntry[] {
  const dir = activeGlobalSkillsDir(dataDir, sharedSkillsDir);
  return safeReaddir(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => loadSkill(join(dir, f), "global"));
}

export function listPersoSkills(
  dataDir: string,
  user: string,
  sharedSkillsDir?: string
): SkillEntry[] {
  const dir = resolve(skillsRoot(dataDir, sharedSkillsDir), "_perso", slugifyUser(user));
  if (!existsSync(dir)) return [];
  return safeReaddir(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({ ...loadSkill(join(dir, f), "perso"), owner: user }));
}

export function listAllPersoSkills(dataDir: string, sharedSkillsDir?: string): SkillEntry[] {
  const root = resolve(skillsRoot(dataDir, sharedSkillsDir), "_perso");
  if (!existsSync(root)) return [];
  const out: SkillEntry[] = [];
  for (const userDir of safeReaddir(root)) {
    const userPath = join(root, userDir);
    if (!statSync(userPath).isDirectory()) continue;
    for (const f of safeReaddir(userPath)) {
      if (!f.endsWith(".md")) continue;
      out.push({ ...loadSkill(join(userPath, f), "perso"), owner: userDir });
    }
  }
  return out;
}

export function listPropositions(
  dataDir: string,
  sharedSkillsDir?: string
): PropositionEntry[] {
  const dir = activePropositionsDir(dataDir, sharedSkillsDir);
  if (!existsSync(dir)) return [];
  return safeReaddir(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f): PropositionEntry => {
      const base = loadSkill(join(dir, f), "proposition");
      const fm = base.frontmatter;
      return {
        ...base,
        scope: "proposition",
        auteur: fm.auteur as string | undefined,
        date: fm.date as string | undefined,
        affecte: fm.affecte as string | undefined,
        statut: (fm.statut as "en_attente" | "promu" | "rejete") ?? "en_attente",
        raison: fm.raison as string | undefined,
      };
    })
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
}

function loadSkill(path: string, scope: "global" | "perso" | "proposition"): SkillEntry {
  const raw = readFileSync(path, "utf8");
  const stat = statSync(path);
  const { frontmatter, body } = parseSkillFile(path, raw);
  return {
    scope,
    filename: basename(path),
    path,
    frontmatter,
    body,
    raw,
    size: stat.size,
    modifiedAt: stat.mtimeMs,
  };
}

export function slugifyUser(user: string): string {
  return user
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Écrit le contenu d'un skill global. Utilisé par PUT /api/skills/:slug.
 */
export function writeGlobalSkill(
  dataDir: string,
  filename: string,
  content: string,
  sharedSkillsDir?: string
): SkillEntry {
  if (!filename.endsWith(".md")) {
    throw new Error("Le filename doit terminer par .md");
  }
  const dir = activeGlobalSkillsDir(dataDir, sharedSkillsDir);
  const path = resolve(dir, filename);
  // Anti path-traversal : on s'assure que le path normalisé reste sous `dir`.
  if (!path.startsWith(dir + "/") && path !== dir) {
    throw new Error("Path skill hors du dossier autorisé");
  }
  writeFileSync(path, content, "utf8");
  return loadSkill(path, "global");
}
