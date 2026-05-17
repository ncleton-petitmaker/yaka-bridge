/**
 * CRUD skills perso/global/propositions.
 * Tout vit dans data/.claude/skills/ (déployé depuis skills-template/).
 */
import { readdirSync, readFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { parse as yamlParse } from "yaml";

export interface SkillEntry {
  scope: "global" | "perso" | "proposition";
  owner?: string;            // pour perso et proposition
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
  dossier_declencheur?: string;
  raison?: string;
}

function parseSkillFile(path: string, raw: string) {
  // Frontmatter YAML entre --- et ---
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: raw };
  try {
    return { frontmatter: (yamlParse(match[1]) ?? {}) as Record<string, unknown>, body: match[2] };
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

/** Racine du dossier des skills : sharedSkillsDir (serveur partagé) ou data/.claude/skills/ */
export function skillsRoot(dataDir: string, sharedSkillsDir?: string): string {
  return sharedSkillsDir
    ? resolve(sharedSkillsDir)
    : resolve(dataDir, ".claude", "skills");
}

/**
 * Résout le dossier "skills global" actif :
 * - Si campaigns/<activeId>/skills/ existe → utilise (nouveau layout)
 * - Sinon fallback _global/ (ancien layout, compat)
 */
export function activeGlobalSkillsDir(
  dataDir: string,
  sharedSkillsDir?: string
): string {
  const root = skillsRoot(dataDir, sharedSkillsDir);
  const idxPath = resolve(root, "campaigns", "_index.json");
  if (existsSync(idxPath)) {
    try {
      const idx = JSON.parse(readFileSync(idxPath, "utf8")) as {
        activeId?: string;
      };
      if (idx.activeId) {
        const newDir = resolve(root, "campaigns", idx.activeId, "skills");
        if (existsSync(newDir)) return newDir;
      }
    } catch {
      // ignore
    }
  }
  return resolve(root, "_global");
}

export function activePropositionsDir(
  dataDir: string,
  sharedSkillsDir?: string
): string {
  const root = skillsRoot(dataDir, sharedSkillsDir);
  const idxPath = resolve(root, "campaigns", "_index.json");
  if (existsSync(idxPath)) {
    try {
      const idx = JSON.parse(readFileSync(idxPath, "utf8")) as {
        activeId?: string;
      };
      if (idx.activeId) {
        const newDir = resolve(root, "campaigns", idx.activeId, "propositions");
        if (existsSync(newDir)) return newDir;
      }
    } catch {
      // ignore
    }
  }
  return resolve(root, "_propositions");
}

export function activeSnapshotsDir(
  dataDir: string,
  sharedSkillsDir?: string
): string {
  const root = skillsRoot(dataDir, sharedSkillsDir);
  const idxPath = resolve(root, "campaigns", "_index.json");
  if (existsSync(idxPath)) {
    try {
      const idx = JSON.parse(readFileSync(idxPath, "utf8")) as {
        activeId?: string;
      };
      if (idx.activeId) {
        const newDir = resolve(root, "campaigns", idx.activeId, "snapshots");
        if (existsSync(newDir)) return newDir;
      }
    } catch {
      // ignore
    }
  }
  return resolve(root, "_snapshots");
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
        dossier_declencheur: fm.dossier_declencheur as string | undefined,
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

export function updatePropositionStatus(
  dataDir: string,
  filename: string,
  newStatus: "promu" | "rejete",
  admin: string,
  commentaire: string,
  sharedSkillsDir?: string
): PropositionEntry | null {
  const path = resolve(activePropositionsDir(dataDir, sharedSkillsDir), filename);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  const { frontmatter, body } = parseSkillFile(path, raw);
  frontmatter.statut = newStatus;
  if (newStatus === "promu") {
    frontmatter.promu_le = new Date().toISOString();
    frontmatter.promu_par = admin;
  } else {
    frontmatter.rejete_le = new Date().toISOString();
    frontmatter.rejete_par = admin;
  }
  if (commentaire) frontmatter.commentaire_admin = commentaire;
  // Réécrit le fichier avec le frontmatter mis à jour
  const yamlOut = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v)}`)
    .join("\n");
  const out = `---\n${yamlOut}\n---\n${body}`;
  writeFileSync(path, out, "utf8");

  // Journalise
  const histPath = resolve(
    sharedSkillsDir ? resolve(sharedSkillsDir) : resolve(dataDir, ".claude"),
    "_historique.jsonl"
  );
  const line = JSON.stringify({
    date: new Date().toISOString(),
    action: newStatus === "promu" ? "promouvoir" : "rejeter",
    proposition_id: filename,
    admin,
    commentaire_admin: commentaire,
  }) + "\n";
  try {
    if (existsSync(histPath)) {
      const cur = readFileSync(histPath, "utf8");
      writeFileSync(histPath, cur + line, "utf8");
    } else {
      writeFileSync(histPath, line, "utf8");
    }
  } catch {}

  return {
    ...loadSkill(path, "proposition"),
    scope: "proposition",
    auteur: frontmatter.auteur as string | undefined,
    date: frontmatter.date as string | undefined,
    affecte: frontmatter.affecte as string | undefined,
    statut: newStatus,
    dossier_declencheur: frontmatter.dossier_declencheur as string | undefined,
    raison: frontmatter.raison as string | undefined,
  };
}
