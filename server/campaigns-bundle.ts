/**
 * Export/Import d'une campagne sous forme de bundle ZIP.
 *
 * Le bundle contient :
 *   - manifest.json   (métadonnées + hashes skills)
 *   - skills/*.skill.md
 *   - schema.json
 *   - bundle-meta.json (id source, label, dates, créé le)
 *
 * On ne met PAS les propositions ni les snapshots dans le bundle :
 *   - propositions = circuit social par instance, ça n'a pas de sens à partager
 *   - snapshots = liés à l'historique de promotion local
 *
 * À l'import : on accepte un ZIP, on lit bundle-meta.json + skills/, on crée
 * une nouvelle campagne en draft avec un id qu'on déduplique.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import JSZip from "jszip";
import {
  campaignDir,
  buildManifest,
  writeManifest,
  writeIndex,
  readIndex,
  campaignsRoot,
} from "./campaigns.js";
import type { Campaign, CampaignsIndex } from "../lib/campaign-types.js";

interface BundleMeta {
  source_id: string;
  label: string;
  exportedAt: string;
  appVersion: string;
  dateOuverture?: string;
  dateCloture?: string;
}

const APP_VERSION = "0.1.0-7e";

/**
 * Construit le ZIP en mémoire à partir d'une campagne.
 */
export async function exportCampaignToZip(
  dataDir: string,
  campaignId: string,
  sharedSkillsDir?: string
): Promise<{ buffer: Buffer; filename: string } | null> {
  const idx = readIndex(dataDir, sharedSkillsDir);
  const campaign = idx?.campaigns.find((c) => c.id === campaignId);
  if (!campaign) return null;

  const dir = campaignDir(dataDir, campaignId, sharedSkillsDir);
  if (!existsSync(dir)) return null;

  const zip = new JSZip();

  // manifest.json (existant)
  const manifestPath = resolve(dir, "manifest.json");
  if (existsSync(manifestPath)) {
    zip.file("manifest.json", readFileSync(manifestPath, "utf8"));
  }

  // skills/*.skill.md
  const skillsDir = resolve(dir, "skills");
  if (existsSync(skillsDir)) {
    for (const f of readdirSync(skillsDir)) {
      if (!f.endsWith(".md")) continue;
      const content = readFileSync(resolve(skillsDir, f), "utf8");
      zip.file(`skills/${f}`, content);
    }
  }

  // schema.json
  const schemaPath = resolve(dir, "schema.json");
  if (existsSync(schemaPath)) {
    zip.file("schema.json", readFileSync(schemaPath, "utf8"));
  }

  // bundle-meta.json
  const meta: BundleMeta = {
    source_id: campaign.id,
    label: campaign.label,
    exportedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    dateOuverture: campaign.dateOuverture,
    dateCloture: campaign.dateCloture,
  };
  zip.file("bundle-meta.json", JSON.stringify(meta, null, 2));

  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  const filename = `oif-eval-campaign-${campaignId}-${
    new Date().toISOString().slice(0, 10)
  }.zip`;
  return { buffer, filename };
}

/**
 * Import d'un bundle ZIP. Crée une nouvelle campagne en draft.
 * Si l'id existe déjà, on suffixe avec un timestamp.
 */
export interface ImportOptions {
  /** Si fourni, force l'id du draft. Sinon dérivé du bundle-meta.source_id. */
  desiredId?: string;
  /** Si fourni, force le label. Sinon dérivé du bundle-meta.label. */
  desiredLabel?: string;
}

export interface ImportResult {
  ok: boolean;
  campaignId?: string;
  reason?: string;
  warnings?: string[];
}

const REQUIRED_SKILLS = [
  "evaluer-eligibilite.skill.md",
  "evaluer-notation.skill.md",
];

export async function importCampaignFromZip(
  dataDir: string,
  zipBuffer: Buffer,
  opts: ImportOptions = {},
  sharedSkillsDir?: string
): Promise<ImportResult> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(zipBuffer);
  } catch (err) {
    return { ok: false, reason: `ZIP illisible : ${(err as Error).message}` };
  }

  // Lire bundle-meta
  const metaFile = zip.file("bundle-meta.json");
  let meta: BundleMeta | null = null;
  if (metaFile) {
    try {
      meta = JSON.parse(await metaFile.async("string")) as BundleMeta;
    } catch {
      // pas bloquant, on continue avec un meta synthétique
    }
  }

  // Vérifier les skills requis
  const warnings: string[] = [];
  for (const required of REQUIRED_SKILLS) {
    if (!zip.file(`skills/${required}`)) {
      return {
        ok: false,
        reason: `Skill obligatoire manquant : skills/${required}`,
      };
    }
  }
  if (!zip.file("schema.json")) {
    warnings.push("schema.json absent du bundle (sera vide)");
  }

  // Détermine l'id final
  const baseId = opts.desiredId || meta?.source_id || "imported";
  const idx = readIndex(dataDir, sharedSkillsDir);
  if (!idx) {
    return { ok: false, reason: "campaigns/_index.json absent. Lancer la migration boot d'abord." };
  }
  let finalId = baseId;
  if (idx.campaigns.find((c) => c.id === finalId)) {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
    finalId = `${baseId}-import-${stamp}`;
    warnings.push(`L'id "${baseId}" existait déjà, importé sous "${finalId}".`);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(finalId)) {
    return { ok: false, reason: `id invalide : "${finalId}"` };
  }

  const targetDir = campaignDir(dataDir, finalId, sharedSkillsDir);
  if (existsSync(targetDir)) {
    return { ok: false, reason: `dossier ${targetDir} existe déjà` };
  }

  // Crée la structure et écrit les fichiers
  mkdirSync(resolve(targetDir, "skills"), { recursive: true });
  mkdirSync(resolve(targetDir, "propositions"), { recursive: true });
  mkdirSync(resolve(targetDir, "snapshots"), { recursive: true });

  // skills/
  const skillsZip = zip.folder("skills");
  if (skillsZip) {
    const entries: { name: string; content: string }[] = [];
    skillsZip.forEach((relativePath, file) => {
      if (relativePath.endsWith(".md")) {
        entries.push({ name: relativePath, content: "" });
      }
    });
    // Lis chaque entrée (forEach JSZip ne supporte pas l'async direct)
    for (const entry of entries) {
      const f = zip.file(`skills/${entry.name}`);
      if (f) {
        const content = await f.async("string");
        writeFileSync(resolve(targetDir, "skills", entry.name), content, "utf8");
      }
    }
  }

  // schema.json
  const schemaFile = zip.file("schema.json");
  if (schemaFile) {
    const content = await schemaFile.async("string");
    writeFileSync(resolve(targetDir, "schema.json"), content, "utf8");
  }

  // Manifest régénéré (les hashes du bundle pourraient ne plus matcher si modif)
  const manifest = buildManifest(dataDir, finalId, meta?.source_id ?? null, sharedSkillsDir);
  writeManifest(dataDir, manifest, sharedSkillsDir);

  // Met à jour _index.json
  const campaign: Campaign = {
    id: finalId,
    label: opts.desiredLabel || meta?.label || `Import ${finalId}`,
    status: "draft",
    createdAt: new Date().toISOString(),
    basedOn: meta?.source_id ?? null,
    dateOuverture: meta?.dateOuverture,
    dateCloture: meta?.dateCloture,
  };
  idx.campaigns.push(campaign);
  writeIndex(dataDir, idx, sharedSkillsDir);

  return { ok: true, campaignId: finalId, warnings };
}

/**
 * Édition directe d'un skill markdown d'une campagne (drafts uniquement).
 */
export interface SkillEditResult {
  ok: boolean;
  reason?: string;
  newHash?: string;
}

export function readCampaignSkill(
  dataDir: string,
  campaignId: string,
  skillName: string,
  sharedSkillsDir?: string
): { content: string } | null {
  const path = resolve(
    campaignDir(dataDir, campaignId, sharedSkillsDir),
    "skills",
    skillName
  );
  if (!existsSync(path)) return null;
  if (!skillName.endsWith(".md")) return null;
  return { content: readFileSync(path, "utf8") };
}

export function writeCampaignSkill(
  dataDir: string,
  campaignId: string,
  skillName: string,
  content: string,
  sharedSkillsDir?: string
): SkillEditResult {
  const idx = readIndex(dataDir, sharedSkillsDir);
  const campaign = idx?.campaigns.find((c) => c.id === campaignId);
  if (!campaign) return { ok: false, reason: "campagne introuvable" };
  // L'édition est autorisée sur les drafts ET les campagnes actives.
  // Les archives restent figées pour préserver l'historique d'évaluations.
  // Risque connu en mode "active" : si une évaluation tourne au même moment
  // chez un autre opérateur, elle utilisera l'ancienne version chargée en
  // mémoire. À gérer humainement (communication équipe).
  if (campaign.status === "archived") {
    return {
      ok: false,
      reason: "Édition impossible sur une campagne archivée. Réactivez-la d'abord.",
    };
  }
  if (!skillName.endsWith(".md")) {
    return { ok: false, reason: "filename doit se terminer par .md" };
  }
  if (skillName.includes("/") || skillName.includes("..")) {
    return { ok: false, reason: "filename invalide" };
  }
  const dir = resolve(
    campaignDir(dataDir, campaignId, sharedSkillsDir),
    "skills"
  );
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = resolve(dir, skillName);
  writeFileSync(path, content, "utf8");

  // Recalcule manifest (les hashes ont changé)
  const manifest = buildManifest(
    dataDir,
    campaignId,
    campaign.basedOn,
    sharedSkillsDir
  );
  writeManifest(dataDir, manifest, sharedSkillsDir);

  return { ok: true, newHash: manifest.skillHashes[skillName] };
}
