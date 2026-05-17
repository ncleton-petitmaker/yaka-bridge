/**
 * Snapshot du skill global AVANT promotion d'une proposition, et revert.
 * Utile pendant la phase de calibrage où l'auto-approve est actif :
 * si une règle douteuse passe, l'admin peut annuler la promotion en 1 clic.
 *
 * Stratégie : avant de lancer Claude pour promouvoir une proposition,
 * on copie le contenu courant du skill global cible dans
 * `_snapshots/<proposition_filename>.<skill_name>`. Au revert, on
 * restaure le snapshot tel quel.
 */
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { parse as yamlParse } from "yaml";
import { targetSkillFor } from "./proposition-preview.js";
import {
  activeGlobalSkillsDir,
  activePropositionsDir,
  activeSnapshotsDir,
} from "./skills.js";

function snapshotPath(
  dataDir: string,
  propositionFilename: string,
  targetSkillName: string,
  sharedSkillsDir?: string
): string {
  return resolve(
    activeSnapshotsDir(dataDir, sharedSkillsDir),
    `${propositionFilename}.${targetSkillName}`
  );
}

/**
 * À appeler AVANT de lancer Claude pour promouvoir une proposition.
 * Sauve le contenu actuel du skill global cible dans _snapshots/.
 * Renvoie le chemin du snapshot ou null si pas de skill cible.
 */
export function snapshotSkillBeforePromotion(
  dataDir: string,
  propositionFilename: string,
  affecte: string | undefined,
  sharedSkillsDir?: string
): { snapshotPath: string; targetSkill: string } | null {
  const targetSkillName = targetSkillFor(affecte);
  const targetPath = resolve(
    activeGlobalSkillsDir(dataDir, sharedSkillsDir),
    targetSkillName
  );
  if (!existsSync(targetPath)) return null;
  const content = readFileSync(targetPath, "utf8");
  const snapPath = snapshotPath(
    dataDir,
    propositionFilename,
    targetSkillName,
    sharedSkillsDir
  );
  mkdirSync(dirname(snapPath), { recursive: true });
  writeFileSync(snapPath, content, "utf8");
  return { snapshotPath: snapPath, targetSkill: targetSkillName };
}

/**
 * Restaure le skill global au contenu du snapshot pris avant promotion,
 * et marque la proposition comme rejetée.
 */
export interface RevertResult {
  ok: boolean;
  restoredSkill?: string;
  reason?: string;
}

export function revertPromotion(
  dataDir: string,
  propositionFilename: string,
  admin: string,
  commentaire: string,
  sharedSkillsDir?: string
): RevertResult {
  const propPath = resolve(
    activePropositionsDir(dataDir, sharedSkillsDir),
    propositionFilename
  );
  if (!existsSync(propPath)) {
    return { ok: false, reason: "proposition introuvable" };
  }
  const raw = readFileSync(propPath, "utf8");
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { ok: false, reason: "frontmatter invalide" };
  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = (yamlParse(match[1]) ?? {}) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "YAML invalide" };
  }
  const body = match[2];
  if (frontmatter.statut !== "promu") {
    return {
      ok: false,
      reason: `proposition au statut '${String(frontmatter.statut)}', pas 'promu'`,
    };
  }
  const targetSkillName = targetSkillFor(frontmatter.affecte as string | undefined);
  const snapPath = snapshotPath(
    dataDir,
    propositionFilename,
    targetSkillName,
    sharedSkillsDir
  );
  if (!existsSync(snapPath)) {
    return {
      ok: false,
      reason:
        "Snapshot introuvable. La promotion a été faite avant l'introduction des snapshots, ou le fichier a été supprimé.",
    };
  }
  // Restore le skill global
  const snapshot = readFileSync(snapPath, "utf8");
  const targetPath = resolve(
    activeGlobalSkillsDir(dataDir, sharedSkillsDir),
    targetSkillName
  );
  writeFileSync(targetPath, snapshot, "utf8");
  // Repasse la proposition en rejete
  frontmatter.statut = "rejete";
  frontmatter.rejete_le = new Date().toISOString();
  frontmatter.rejete_par = admin;
  frontmatter.commentaire_admin =
    commentaire || "Promotion annulée par l'admin";
  delete frontmatter.promu_le;
  delete frontmatter.promu_par;
  const yamlOut = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");
  writeFileSync(propPath, `---\n${yamlOut}\n---\n${body}`, "utf8");
  // Journalise
  const histPath = resolve(
    sharedSkillsDir ? resolve(sharedSkillsDir) : resolve(dataDir, ".claude"),
    "_historique.jsonl"
  );
  const line =
    JSON.stringify({
      date: new Date().toISOString(),
      action: "revert_promotion",
      proposition_id: propositionFilename,
      admin,
      commentaire_admin: commentaire,
      skill_restore: targetSkillName,
    }) + "\n";
  try {
    if (existsSync(histPath)) {
      writeFileSync(histPath, readFileSync(histPath, "utf8") + line, "utf8");
    } else {
      writeFileSync(histPath, line, "utf8");
    }
  } catch {
    // pas bloquant
  }
  return { ok: true, restoredSkill: targetSkillName };
}
