/**
 * CRUD des campagnes d'évaluation OIF-Eval.
 *
 * Une campagne = grille d'évaluation pour une édition donnée (FAE 7e, 8e, ...).
 * Storage : `<skillsRoot>/campaigns/<id>/{skills/, propositions/, snapshots/, schema.json, manifest.json}`.
 * Une seule campagne `active` à un instant T. Les autres : `draft` ou `archived`.
 *
 * Le `<skillsRoot>` est résolu via sharedSkillsDir (si configuré, dossier partagé OIF)
 * sinon `data/.claude/skills/`.
 */
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  cpSync,
  rmSync,
  renameSync,
} from "node:fs";
import { resolve, join, basename } from "node:path";
import { createHash } from "node:crypto";
import {
  readGridMetadata,
  writeGridMetadata,
  ensureGridMetadata,
} from "./grid-metadata.js";
import type {
  Campaign,
  CampaignManifest,
  CampaignsIndex,
  CampaignStatus,
} from "../lib/campaign-types.js";

const APP_VERSION = "0.1.0-7e";

function skillsRoot(dataDir: string, sharedSkillsDir?: string): string {
  return sharedSkillsDir
    ? resolve(sharedSkillsDir)
    : resolve(dataDir, ".claude", "skills");
}

export function campaignsRoot(
  dataDir: string,
  sharedSkillsDir?: string
): string {
  return resolve(skillsRoot(dataDir, sharedSkillsDir), "campaigns");
}

export function campaignDir(
  dataDir: string,
  campaignId: string,
  sharedSkillsDir?: string
): string {
  return resolve(campaignsRoot(dataDir, sharedSkillsDir), campaignId);
}

export function indexPath(dataDir: string, sharedSkillsDir?: string): string {
  return resolve(campaignsRoot(dataDir, sharedSkillsDir), "_index.json");
}

export function readIndex(
  dataDir: string,
  sharedSkillsDir?: string
): CampaignsIndex | null {
  const p = indexPath(dataDir, sharedSkillsDir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as CampaignsIndex;
  } catch {
    return null;
  }
}

export function writeIndex(
  dataDir: string,
  index: CampaignsIndex,
  sharedSkillsDir?: string
): void {
  const p = indexPath(dataDir, sharedSkillsDir);
  mkdirSync(campaignsRoot(dataDir, sharedSkillsDir), { recursive: true });
  // Atomique : tmp + rename
  const tmp = p + ".tmp";
  writeFileSync(tmp, JSON.stringify(index, null, 2), "utf8");
  renameSync(tmp, p);
}

export function getActiveCampaignId(
  dataDir: string,
  sharedSkillsDir?: string
): string | null {
  const idx = readIndex(dataDir, sharedSkillsDir);
  return idx?.activeId ?? null;
}

export function listCampaigns(
  dataDir: string,
  sharedSkillsDir?: string
): { campaigns: Campaign[]; activeId: string | null } {
  const idx = readIndex(dataDir, sharedSkillsDir);
  if (!idx) return { campaigns: [], activeId: null };
  return { campaigns: idx.campaigns, activeId: idx.activeId };
}

export function getCampaign(
  dataDir: string,
  campaignId: string,
  sharedSkillsDir?: string
): Campaign | null {
  const idx = readIndex(dataDir, sharedSkillsDir);
  return idx?.campaigns.find((c) => c.id === campaignId) ?? null;
}

export function readManifest(
  dataDir: string,
  campaignId: string,
  sharedSkillsDir?: string
): CampaignManifest | null {
  const p = resolve(
    campaignDir(dataDir, campaignId, sharedSkillsDir),
    "manifest.json"
  );
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as CampaignManifest;
  } catch {
    return null;
  }
}

function computeSkillHashes(skillsDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(skillsDir)) return out;
  for (const f of readdirSync(skillsDir)) {
    if (!f.endsWith(".md")) continue;
    const p = join(skillsDir, f);
    if (!statSync(p).isFile()) continue;
    const content = readFileSync(p, "utf8");
    out[f] = createHash("sha256").update(content).digest("hex");
  }
  return out;
}

function computeFileHash(path: string): string | null {
  if (!existsSync(path)) return null;
  return createHash("sha256")
    .update(readFileSync(path, "utf8"))
    .digest("hex");
}

export function buildManifest(
  dataDir: string,
  campaignId: string,
  basedOn: string | null,
  sharedSkillsDir?: string
): CampaignManifest {
  const dir = campaignDir(dataDir, campaignId, sharedSkillsDir);
  const skillsDir = resolve(dir, "skills");
  const schemaPath = resolve(dir, "schema.json");
  return {
    id: campaignId,
    skillHashes: computeSkillHashes(skillsDir),
    schemaHash: computeFileHash(schemaPath),
    createdAt: new Date().toISOString(),
    basedOn,
    appVersion: APP_VERSION,
  };
}

export function writeManifest(
  dataDir: string,
  manifest: CampaignManifest,
  sharedSkillsDir?: string
): void {
  const p = resolve(
    campaignDir(dataDir, manifest.id, sharedSkillsDir),
    "manifest.json"
  );
  mkdirSync(campaignDir(dataDir, manifest.id, sharedSkillsDir), {
    recursive: true,
  });
  writeFileSync(p, JSON.stringify(manifest, null, 2), "utf8");
}

/**
 * Crée une nouvelle campagne par clone d'une campagne source.
 * Si basedOn est null, crée un squelette vide (déconseillé en V1).
 */
export interface CreateCampaignOptions {
  id: string;
  label: string;
  basedOn: string | null;
  dateOuverture?: string;
  dateCloture?: string;
  activate?: boolean;
}

export function createCampaign(
  dataDir: string,
  opts: CreateCampaignOptions,
  sharedSkillsDir?: string
): { campaign: Campaign; manifest: CampaignManifest } {
  // Si _index.json n'existe pas encore (premier lancement / nouveau dossier
  // partagé), on l'initialise vide ici plutôt que de throw. Évite à l'utilisateur
  // de devoir relancer l'app pour que la migration boot tourne.
  let idx = readIndex(dataDir, sharedSkillsDir);
  if (!idx) {
    idx = {
      campaigns: [],
      activeId: "",
      layoutVersion: 1,
      layoutV1Confirmed: true,
    };
    writeIndex(dataDir, idx, sharedSkillsDir);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(opts.id)) {
    throw new Error("id invalide : minuscules, chiffres, tirets uniquement");
  }
  if (idx.campaigns.find((c) => c.id === opts.id)) {
    throw new Error(`une campagne avec l'id '${opts.id}' existe déjà`);
  }
  const targetDir = campaignDir(dataDir, opts.id, sharedSkillsDir);
  if (existsSync(targetDir)) {
    throw new Error(`le dossier ${targetDir} existe déjà sur disque`);
  }

  // Clone depuis source
  if (opts.basedOn) {
    const srcDir = campaignDir(dataDir, opts.basedOn, sharedSkillsDir);
    if (!existsSync(srcDir)) {
      throw new Error(`campagne source '${opts.basedOn}' introuvable`);
    }
    cpSync(srcDir, targetDir, { recursive: true });
    // On ne copie PAS l'historique ni les snapshots ni les propositions de la source
    // (chaque campagne a son propre cycle de vie)
    for (const sub of ["historique.jsonl", "snapshots", "propositions"]) {
      const p = resolve(targetDir, sub);
      if (existsSync(p)) rmSync(p, { recursive: true, force: true });
    }
    mkdirSync(resolve(targetDir, "snapshots"), { recursive: true });
    mkdirSync(resolve(targetDir, "propositions"), { recursive: true });
  } else {
    // Squelette vide (peu utile en V1)
    mkdirSync(resolve(targetDir, "skills"), { recursive: true });
    mkdirSync(resolve(targetDir, "propositions"), { recursive: true });
    mkdirSync(resolve(targetDir, "snapshots"), { recursive: true });
  }

  const manifest = buildManifest(
    dataDir,
    opts.id,
    opts.basedOn,
    sharedSkillsDir
  );
  writeManifest(dataDir, manifest, sharedSkillsDir);

  // Hérite la grid-metadata de la campagne source si possible, sinon défaut
  if (opts.basedOn) {
    const sourceMeta = readGridMetadata(dataDir, opts.basedOn, sharedSkillsDir);
    if (sourceMeta) {
      writeGridMetadata(
        dataDir,
        opts.id,
        { ...sourceMeta, source: "clone", generatedAt: new Date().toISOString() },
        sharedSkillsDir
      );
    } else {
      ensureGridMetadata(dataDir, opts.id, undefined, sharedSkillsDir);
    }
  } else {
    ensureGridMetadata(dataDir, opts.id, undefined, sharedSkillsDir);
  }

  const campaign: Campaign = {
    id: opts.id,
    label: opts.label,
    status: opts.activate ? "active" : "draft",
    createdAt: new Date().toISOString(),
    basedOn: opts.basedOn,
    dateOuverture: opts.dateOuverture,
    dateCloture: opts.dateCloture,
  };

  // Si activate : archive l'ancienne active
  let nextActiveId = idx.activeId;
  if (opts.activate) {
    const previousActive = idx.campaigns.find((c) => c.status === "active");
    if (previousActive) previousActive.status = "archived";
    nextActiveId = opts.id;
  }
  idx.campaigns.push(campaign);
  idx.activeId = nextActiveId;
  writeIndex(dataDir, idx, sharedSkillsDir);

  return { campaign, manifest };
}

export function activateCampaign(
  dataDir: string,
  campaignId: string,
  sharedSkillsDir?: string
): { activeId: string; archivedId: string | null } {
  const idx = readIndex(dataDir, sharedSkillsDir);
  if (!idx) throw new Error("campaigns/_index.json absent");
  const target = idx.campaigns.find((c) => c.id === campaignId);
  if (!target) throw new Error(`campagne '${campaignId}' introuvable`);
  if (target.status === "active") {
    return { activeId: campaignId, archivedId: null };
  }
  let archivedId: string | null = null;
  for (const c of idx.campaigns) {
    if (c.status === "active") {
      c.status = "archived";
      archivedId = c.id;
    }
  }
  target.status = "active";
  idx.activeId = campaignId;
  writeIndex(dataDir, idx, sharedSkillsDir);
  return { activeId: campaignId, archivedId };
}

export function archiveCampaign(
  dataDir: string,
  campaignId: string,
  sharedSkillsDir?: string
): void {
  const idx = readIndex(dataDir, sharedSkillsDir);
  if (!idx) throw new Error("campaigns/_index.json absent");
  const target = idx.campaigns.find((c) => c.id === campaignId);
  if (!target) throw new Error(`campagne '${campaignId}' introuvable`);
  if (target.status === "active") {
    throw new Error("Impossible d'archiver la campagne active. Activer une autre campagne d'abord.");
  }
  target.status = "archived";
  writeIndex(dataDir, idx, sharedSkillsDir);
}

export function updateCampaign(
  dataDir: string,
  campaignId: string,
  patch: { label?: string; dateOuverture?: string; dateCloture?: string },
  sharedSkillsDir?: string
): Campaign {
  const idx = readIndex(dataDir, sharedSkillsDir);
  if (!idx) throw new Error("campaigns/_index.json absent");
  const target = idx.campaigns.find((c) => c.id === campaignId);
  if (!target) throw new Error(`campagne '${campaignId}' introuvable`);
  if (patch.label !== undefined) target.label = patch.label;
  if (patch.dateOuverture !== undefined) target.dateOuverture = patch.dateOuverture;
  if (patch.dateCloture !== undefined) target.dateCloture = patch.dateCloture;
  writeIndex(dataDir, idx, sharedSkillsDir);
  return target;
}

export function deleteCampaign(
  dataDir: string,
  campaignId: string,
  sharedSkillsDir?: string
): void {
  const idx = readIndex(dataDir, sharedSkillsDir);
  if (!idx) throw new Error("campaigns/_index.json absent");
  const target = idx.campaigns.find((c) => c.id === campaignId);
  if (!target) throw new Error(`campagne '${campaignId}' introuvable`);
  if (target.status === "active") {
    throw new Error(
      "Impossible de supprimer la campagne active. Activez une autre campagne d'abord (la précédente passera en archived), puis supprimez."
    );
  }
  // OK pour draft et archived
  const dir = campaignDir(dataDir, campaignId, sharedSkillsDir);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  idx.campaigns = idx.campaigns.filter((c) => c.id !== campaignId);
  writeIndex(dataDir, idx, sharedSkillsDir);
}

/**
 * Stats simples d'une campagne : nombre d'évaluations associées,
 * nombre de propositions par statut, etc.
 */
export function getCampaignStats(
  dataDir: string,
  campaignId: string,
  sharedSkillsDir?: string
): { evaluations: number; propositionsTotal: number; propositionsPromues: number } {
  const dir = campaignDir(dataDir, campaignId, sharedSkillsDir);
  const propsDir = resolve(dir, "propositions");
  let total = 0;
  let promues = 0;
  if (existsSync(propsDir)) {
    for (const f of readdirSync(propsDir)) {
      if (!f.endsWith(".md")) continue;
      total += 1;
      try {
        const raw = readFileSync(resolve(propsDir, f), "utf8");
        if (/statut:\s*"?promu"?/.test(raw)) promues += 1;
      } catch {
        // ignore
      }
    }
  }
  // Pour V1 : compte seulement le total des évaluations sans filtrer par campaign_id.
  // Quand l'évaluation embarquera campaign_id, on filtrera.
  let evaluations = 0;
  const evalDir = resolve(dataDir, "evaluations");
  if (existsSync(evalDir)) {
    evaluations = readdirSync(evalDir).filter((f) => f.endsWith(".json")).length;
  }
  return { evaluations, propositionsTotal: total, propositionsPromues: promues };
}

/**
 * Liste les skills d'une campagne (pour la page détail / debug).
 */
export function listCampaignSkills(
  dataDir: string,
  campaignId: string,
  sharedSkillsDir?: string
): { filename: string; size: number; hash: string }[] {
  const skillsDir = resolve(
    campaignDir(dataDir, campaignId, sharedSkillsDir),
    "skills"
  );
  if (!existsSync(skillsDir)) return [];
  const out: { filename: string; size: number; hash: string }[] = [];
  for (const f of readdirSync(skillsDir)) {
    if (!f.endsWith(".md")) continue;
    const p = join(skillsDir, f);
    const stat = statSync(p);
    if (!stat.isFile()) continue;
    const content = readFileSync(p, "utf8");
    out.push({
      filename: basename(f),
      size: stat.size,
      hash: createHash("sha256").update(content).digest("hex"),
    });
  }
  return out;
}

export type { CampaignStatus };
