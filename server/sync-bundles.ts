/**
 * Bundles ZIP pour mode "import/export manuel" (sans serveur partagé).
 *
 * Workflow hub-and-spoke :
 *   - L'admin centralise les données.
 *   - L'admin exporte un "pack admin" (skills + campagne active + propositions
 *     publiables) et le diffuse aux 8 évaluateurs (Teams, email, clé USB).
 *   - Chaque évaluateur importe ce pack au démarrage : ses skills locaux
 *     sont synchronisés.
 *   - À la fin de sa session, l'évaluateur exporte un "pack évaluations"
 *     (uniquement les .json d'évals qu'il a finalisées + ses entrées d'audit).
 *   - L'admin reçoit, importe : merge des évaluations dans son data central.
 *
 * Format ZIP :
 *   - manifest.json : type, source_user, exported_at, app_version, counts,
 *                     active_campaign_id, fichiers + sha256
 *   - skills/        (admin pack uniquement) : skills _global du dossier actif
 *   - propositions/  (admin pack uniquement)
 *   - evaluations/   (évals pack uniquement)
 *   - audit/         (évals pack uniquement) : entrées du jour de l'évaluateur
 *
 * Garanties :
 *   - Manifest signe SHA-256 chaque fichier embarqué → détection de corruption.
 *   - Pas d'écrasement aveugle à l'import : on demande confirmation côté UI
 *     si un .json existe déjà dans le data central.
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { resolve, basename, join, dirname } from "node:path";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import {
  activeGlobalSkillsDir,
  activePropositionsDir,
  slugifyUser,
} from "./skills.js";
import { readIndex } from "./campaigns.js";

const APP_VERSION = "0.1.0-7e";

export type BundleType = "admin-pack" | "evaluations-pack";

export interface BundleManifest {
  type: BundleType;
  source_user: string;
  exported_at: string;
  app_version: string;
  active_campaign_id?: string;
  active_campaign_label?: string;
  counts: {
    skills?: number;
    propositions?: number;
    evaluations?: number;
    audit_files?: number;
  };
  files: { path: string; sha256: string; bytes: number }[];
}

export interface AdminPackOptions {
  dataDir: string;
  sharedSkillsDir?: string;
  sourceUser: string;
}

export interface EvaluationsPackOptions {
  dataDir: string;
  outputDir?: string;
  sharedDir?: string;
  sourceUser: string;
  /** Si fourni, n'embarquer que ces évaluations (sinon : toutes celles de l'évaluateur). */
  onlyIds?: string[];
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function listFiles(dir: string, ext: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(ext))
    .map((f) => resolve(dir, f));
}

function evaluationsRoot(dataDir: string, outputDir?: string): string {
  return outputDir ? resolve(outputDir) : resolve(dataDir, "evaluations");
}

/** Vérifie qu'un fichier d'éval JSON appartient à un évaluateur donné (champ review.evaluateur). */
function evalBelongsTo(path: string, user: string): boolean {
  try {
    const raw = readFileSync(path, "utf8");
    const data = JSON.parse(raw) as {
      review?: { validee_par?: string; evaluateur?: string };
    };
    const owner = data.review?.evaluateur ?? data.review?.validee_par;
    if (!owner) return true; // Si pas marqué, on inclut (permet le mode bootstrap)
    return slugifyUser(owner) === slugifyUser(user);
  } catch {
    return false;
  }
}

// ============================================================================
// EXPORT — Admin pack (skills + propositions + active campaign metadata)
// ============================================================================

export async function buildAdminPack(
  opts: AdminPackOptions
): Promise<{ buffer: Buffer; filename: string }> {
  const zip = new JSZip();
  const files: BundleManifest["files"] = [];

  const idx = readIndex(opts.dataDir, opts.sharedSkillsDir);
  const active = idx?.campaigns.find((c) => c.id === idx.activeId);

  // Skills _global (issus de la campagne active si dispo, sinon legacy)
  const skillsDir = activeGlobalSkillsDir(opts.dataDir, opts.sharedSkillsDir);
  const skillFiles = listFiles(skillsDir, ".md");
  for (const f of skillFiles) {
    const buf = readFileSync(f);
    const rel = `skills/${basename(f)}`;
    zip.file(rel, buf);
    files.push({ path: rel, sha256: sha256(buf), bytes: buf.length });
  }

  // Propositions (état partagé pour que les évaluateurs voient ce qui est en attente)
  const propsDir = activePropositionsDir(opts.dataDir, opts.sharedSkillsDir);
  const propFiles = listFiles(propsDir, ".md");
  for (const f of propFiles) {
    const buf = readFileSync(f);
    const rel = `propositions/${basename(f)}`;
    zip.file(rel, buf);
    files.push({ path: rel, sha256: sha256(buf), bytes: buf.length });
  }

  const manifest: BundleManifest = {
    type: "admin-pack",
    source_user: opts.sourceUser,
    exported_at: new Date().toISOString(),
    app_version: APP_VERSION,
    active_campaign_id: active?.id,
    active_campaign_label: active?.label,
    counts: {
      skills: skillFiles.length,
      propositions: propFiles.length,
    },
    files,
  };
  zip.file("manifest.json", JSON.stringify(manifest, null, 2));

  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  const day = new Date().toISOString().slice(0, 10);
  const slug = slugifyUser(opts.sourceUser) || "admin";
  const filename = `oif-eval-admin-pack-${slug}-${day}.zip`;
  return { buffer, filename };
}

// ============================================================================
// EXPORT — Evaluations pack (évals d'un évaluateur + ses entrées d'audit)
// ============================================================================

export async function buildEvaluationsPack(
  opts: EvaluationsPackOptions
): Promise<{ buffer: Buffer; filename: string; count: number }> {
  const zip = new JSZip();
  const files: BundleManifest["files"] = [];
  const evalsDir = evaluationsRoot(opts.dataDir, opts.outputDir);
  let count = 0;

  if (existsSync(evalsDir)) {
    const allFiles = readdirSync(evalsDir).filter((f) => f.endsWith(".json"));
    const targetSet = opts.onlyIds ? new Set(opts.onlyIds) : null;

    for (const fname of allFiles) {
      const id = fname.replace(/\.json$/, "");
      if (targetSet && !targetSet.has(id)) continue;
      const full = resolve(evalsDir, fname);
      if (!evalBelongsTo(full, opts.sourceUser)) continue;
      const buf = readFileSync(full);
      const rel = `evaluations/${fname}`;
      zip.file(rel, buf);
      files.push({ path: rel, sha256: sha256(buf), bytes: buf.length });
      count += 1;

      // Embarque aussi le .events.jsonl s'il existe
      const eventsPath = resolve(evalsDir, `${id}.events.jsonl`);
      if (existsSync(eventsPath)) {
        const ebuf = readFileSync(eventsPath);
        const erel = `evaluations/${id}.events.jsonl`;
        zip.file(erel, ebuf);
        files.push({ path: erel, sha256: sha256(ebuf), bytes: ebuf.length });
      }
    }
  }

  // Embarque les entrées d'audit de l'évaluateur (tous ses fichiers per-day)
  const auditRoot = opts.sharedDir
    ? resolve(opts.sharedDir, "audit-log")
    : resolve(opts.dataDir, ".claude", "audit-log");
  const userSlug = slugifyUser(opts.sourceUser) || "anonyme";
  const userAuditDir = resolve(auditRoot, userSlug);
  let auditFileCount = 0;
  if (existsSync(userAuditDir)) {
    for (const f of readdirSync(userAuditDir)) {
      if (!f.endsWith(".jsonl")) continue;
      const buf = readFileSync(resolve(userAuditDir, f));
      const rel = `audit/${userSlug}/${f}`;
      zip.file(rel, buf);
      files.push({ path: rel, sha256: sha256(buf), bytes: buf.length });
      auditFileCount += 1;
    }
  }

  const idx = readIndex(opts.dataDir, opts.sharedDir);
  const active = idx?.campaigns.find((c) => c.id === idx.activeId);

  const manifest: BundleManifest = {
    type: "evaluations-pack",
    source_user: opts.sourceUser,
    exported_at: new Date().toISOString(),
    app_version: APP_VERSION,
    active_campaign_id: active?.id,
    active_campaign_label: active?.label,
    counts: {
      evaluations: count,
      audit_files: auditFileCount,
    },
    files,
  };
  zip.file("manifest.json", JSON.stringify(manifest, null, 2));

  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  const day = new Date().toISOString().slice(0, 10);
  const slug = userSlug;
  const filename = `oif-eval-evals-${slug}-${day}.zip`;
  return { buffer, filename, count };
}

// ============================================================================
// IMPORT
// ============================================================================

export interface ImportPreview {
  manifest: BundleManifest;
  /** Fichiers qui seront ajoutés (n'existent pas encore en local). */
  newFiles: string[];
  /** Fichiers qui seront écrasés (existent déjà, contenu différent). */
  overwriteFiles: string[];
  /** Fichiers identiques (skip). */
  identicalFiles: string[];
  /** Fichiers dont le sha256 ne correspond pas au manifest (corruption). */
  corruptFiles: string[];
}

export interface ImportResult {
  ok: boolean;
  manifest?: BundleManifest;
  imported: number;
  skipped: number;
  warnings: string[];
  error?: string;
}

export interface ImportOptions {
  dataDir: string;
  sharedSkillsDir?: string;
  outputDir?: string;
  /** Si true, écrase les fichiers existants. Sinon, skip. */
  overwrite?: boolean;
}

async function loadZip(buf: Buffer): Promise<JSZip> {
  return JSZip.loadAsync(buf);
}

async function readManifest(zip: JSZip): Promise<BundleManifest | null> {
  const f = zip.file("manifest.json");
  if (!f) return null;
  try {
    const text = await f.async("string");
    return JSON.parse(text) as BundleManifest;
  } catch {
    return null;
  }
}

async function fileBytes(zip: JSZip, path: string): Promise<Buffer | null> {
  const f = zip.file(path);
  if (!f) return null;
  return Buffer.from(await f.async("nodebuffer"));
}

/**
 * Calcule où un fichier du bundle doit aller dans l'arborescence locale.
 * Retourne null si le path n'est pas reconnu.
 */
function targetPathFor(
  rel: string,
  opts: ImportOptions
): string | null {
  if (rel === "manifest.json") return null;

  if (rel.startsWith("skills/")) {
    return resolve(activeGlobalSkillsDir(opts.dataDir, opts.sharedSkillsDir), basename(rel));
  }
  if (rel.startsWith("propositions/")) {
    return resolve(activePropositionsDir(opts.dataDir, opts.sharedSkillsDir), basename(rel));
  }
  if (rel.startsWith("evaluations/")) {
    const root = evaluationsRoot(opts.dataDir, opts.outputDir);
    return resolve(root, basename(rel));
  }
  if (rel.startsWith("audit/")) {
    const auditRoot = opts.sharedSkillsDir
      ? resolve(opts.sharedSkillsDir, "audit-log")
      : resolve(opts.dataDir, ".claude", "audit-log");
    const sub = rel.slice("audit/".length);
    return resolve(auditRoot, sub);
  }
  return null;
}

export async function previewImport(
  buf: Buffer,
  opts: ImportOptions
): Promise<ImportPreview | { error: string }> {
  let zip: JSZip;
  try {
    zip = await loadZip(buf);
  } catch (e) {
    return { error: `ZIP illisible : ${(e as Error).message}` };
  }
  const manifest = await readManifest(zip);
  if (!manifest) return { error: "manifest.json absent ou invalide" };

  const preview: ImportPreview = {
    manifest,
    newFiles: [],
    overwriteFiles: [],
    identicalFiles: [],
    corruptFiles: [],
  };

  for (const file of manifest.files) {
    const target = targetPathFor(file.path, opts);
    if (!target) continue;
    const bytes = await fileBytes(zip, file.path);
    if (!bytes) {
      preview.corruptFiles.push(file.path);
      continue;
    }
    const actualHash = sha256(bytes);
    if (actualHash !== file.sha256) {
      preview.corruptFiles.push(file.path);
      continue;
    }
    if (existsSync(target)) {
      const existingHash = sha256(readFileSync(target));
      if (existingHash === actualHash) {
        preview.identicalFiles.push(file.path);
      } else {
        preview.overwriteFiles.push(file.path);
      }
    } else {
      preview.newFiles.push(file.path);
    }
  }
  return preview;
}

export async function applyImport(
  buf: Buffer,
  opts: ImportOptions
): Promise<ImportResult> {
  let zip: JSZip;
  try {
    zip = await loadZip(buf);
  } catch (e) {
    return {
      ok: false,
      imported: 0,
      skipped: 0,
      warnings: [],
      error: `ZIP illisible : ${(e as Error).message}`,
    };
  }
  const manifest = await readManifest(zip);
  if (!manifest) {
    return {
      ok: false,
      imported: 0,
      skipped: 0,
      warnings: [],
      error: "manifest.json absent ou invalide",
    };
  }

  let imported = 0;
  let skipped = 0;
  const warnings: string[] = [];

  for (const file of manifest.files) {
    const target = targetPathFor(file.path, opts);
    if (!target) {
      warnings.push(`Chemin non reconnu : ${file.path}`);
      continue;
    }
    const bytes = await fileBytes(zip, file.path);
    if (!bytes) {
      warnings.push(`Fichier manquant dans le ZIP : ${file.path}`);
      continue;
    }
    if (sha256(bytes) !== file.sha256) {
      warnings.push(`SHA-256 ne correspond pas : ${file.path} (corruption ?)`);
      continue;
    }
    if (existsSync(target) && !opts.overwrite) {
      const existingHash = sha256(readFileSync(target));
      if (existingHash === file.sha256) {
        skipped += 1;
        continue;
      }
      warnings.push(
        `Fichier existant non écrasé (option overwrite=false) : ${file.path}`
      );
      skipped += 1;
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    imported += 1;
  }

  return {
    ok: true,
    manifest,
    imported,
    skipped,
    warnings,
  };
}

// ============================================================================
// Helpers UI : compter ce qu'il y a à exporter
// ============================================================================

export interface ExportPreview {
  evaluations: number;
  auditFiles: number;
}

export function previewEvaluationsPack(opts: {
  dataDir: string;
  outputDir?: string;
  sharedDir?: string;
  user: string;
}): ExportPreview {
  const evalsDir = evaluationsRoot(opts.dataDir, opts.outputDir);
  let evalCount = 0;
  if (existsSync(evalsDir)) {
    for (const f of readdirSync(evalsDir)) {
      if (!f.endsWith(".json")) continue;
      const full = resolve(evalsDir, f);
      if (evalBelongsTo(full, opts.user)) evalCount += 1;
    }
  }
  const auditRoot = opts.sharedDir
    ? resolve(opts.sharedDir, "audit-log")
    : resolve(opts.dataDir, ".claude", "audit-log");
  const userSlug = slugifyUser(opts.user) || "anonyme";
  const userAuditDir = resolve(auditRoot, userSlug);
  let auditCount = 0;
  if (existsSync(userAuditDir)) {
    for (const f of readdirSync(userAuditDir)) {
      if (f.endsWith(".jsonl")) auditCount += 1;
    }
  }
  return { evaluations: evalCount, auditFiles: auditCount };
}

// Re-export for use in API
export { join, statSync };
