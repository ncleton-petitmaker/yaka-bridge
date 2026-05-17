/**
 * Daemon OIF-Eval. Hono + spawn Claude Code + SSE.
 * Port par défaut : 7456 (override via FAE_DAEMON_PORT).
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { serve } from "@hono/node-server";
import { existsSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import { findClaudeBin } from "./agents.js";
import { getAgentStatus } from "./agents-status.js";
import { loadAppConfig, saveAppConfig, AVAILABLE_MODELS, type AppConfig } from "./app-config.js";
import { loadRunEvents, extractDossierId, extractCostFromEvents, loadRunEventsFromPath, type RunCostSummary } from "./run-history.js";
import {
  tariffFor,
  setPricingDataDir,
  getPricingMetadata,
  writePricingFromAgent as _writePricingFromAgent,
  getModelTariffs,
  pricingJsonPath as pricingJsonPathFor,
} from "./pricing.js";
void _writePricingFromAgent;
import {
  startRun,
  getRun,
  getRunUsage,
  listRuns,
  attachListener,
  cancelRun,
  waitForRun,
  cleanupZombies,
} from "./runs.js";
import { listDossiers } from "./dossiers.js";
import { getVeriteSummary, getVerite } from "./verite.js";
import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import {
  listGlobalSkills,
  listPropositions,
  updatePropositionStatus,
  activeGlobalSkillsDir,
} from "./skills.js";
import { previewProposition } from "./proposition-preview.js";
import {
  snapshotSkillBeforePromotion,
  revertPromotion,
} from "./promotion-revert.js";
import { ensureCampaignsLayout } from "./campaigns-migration.js";
import {
  exportCampaignToZip,
  importCampaignFromZip,
  readCampaignSkill,
  writeCampaignSkill,
} from "./campaigns-bundle.js";
import { buildDebugBundle } from "./debug-bundle.js";
import { storeUpload, inboxDir } from "./inbox.js";
import {
  listReports as listCalibrageReports,
  getReportJson as getCalibrageReportJson,
  getReportMarkdown as getCalibrageReportMarkdown,
  getReportJsonPath as getCalibrageReportJsonPath,
  deleteReport as deleteCalibrageReport,
} from "./calibrage-reports.js";
import {
  startCalibrage,
  isCalibrageRunning,
  getCalibrageRun,
  getCurrentCalibrageRun,
  attachCalibrageListener,
  waitForCalibrage,
  cancelCalibrage,
} from "./calibrage-runs.js";
import {
  importBundle,
  listImports as listCalibrageImports,
  getImport as getCalibrageImport,
  deleteImport as deleteCalibrageImport,
  generateTemplate as generateCalibrageTemplate,
  updateImportMapping as updateCalibrageImportMapping,
} from "./calibrage-imports.js";
import {
  resolveGridMetadata,
  readGridMetadata,
  writeGridMetadata,
  type GridMetadata,
} from "./grid-metadata.js";
import {
  listCampaigns,
  getCampaign,
  readManifest,
  getCampaignStats,
  listCampaignSkills,
  createCampaign as createCampaignModel,
  activateCampaign as activateCampaignModel,
  archiveCampaign as archiveCampaignModel,
  updateCampaign as updateCampaignModel,
  deleteCampaign as deleteCampaignModel,
  getActiveCampaignId,
} from "./campaigns.js";
import {
  appendAuditEvent,
  readAuditEvents,
  verifyAuditLogIntegrity,
  computeAuditStats,
  type AuditEventInput,
} from "./audit-log.js";

const APP_VERSION = "0.1.0-7e";

function getActor(): { actor_id: string; actor_role: string } {
  const cfg = loadAppConfig(DATA_DIR);
  return {
    actor_id: cfg.currentUser ?? "anonyme",
    actor_role: cfg.isAdmin ? "admin" : "evaluator",
  };
}

function audit(
  c: { req: { header: (k: string) => string | undefined } },
  partial: Omit<AuditEventInput, "actor_id" | "actor_role" | "app_version" | "client_ip"> & {
    actor_id?: string;
    actor_role?: string;
  }
): void {
  try {
    const cfg = loadAppConfig(DATA_DIR);
    const actor_id = partial.actor_id ?? cfg.currentUser ?? "anonyme";
    const actor_role = partial.actor_role ?? (cfg.isAdmin ? "admin" : "evaluator");
    appendAuditEvent(
      DATA_DIR,
      {
        actor_id,
        actor_role,
        app_version: APP_VERSION,
        client_ip:
          c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "local",
        ...partial,
      },
      cfg.auditLogDir
    );
  } catch (err) {
    console.warn("[audit] échec écriture log:", err);
  }
}
import { buildExportXlsx } from "./export.js";
import type { ChatRequest, ChatRunCreated } from "./types.js";

const app = new Hono();

const DATA_DIR = resolve(process.env.FAE_DATA_DIR ?? "./data");
setPricingDataDir(DATA_DIR);

/**
 * Construit la whitelist de dossiers passée à Claude Code (`--add-dir`).
 *
 * Principe de moindre privilège : on liste UNIQUEMENT les dossiers nécessaires
 * (pas leur parent). Si Claude doit écrire dans `<root>/evaluations/X.json`,
 * il a besoin de `<root>/evaluations/` dans la whitelist, PAS de `<root>` entier
 * (qui donnerait accès à TOUS les sous-dossiers du NAS partagé : skills, audit-log,
 * candidatures d'autres utilisateurs, calibrage, etc.).
 *
 * Note : `--add-dir` n'est pas une vraie sandbox stricte (cf. doc Claude Code).
 * Pour bloquer les escapes (symlinks, ../), on s'appuie sur :
 *  1. Les deny rules dans `.claude/settings.json` (prioritaires sur tout)
 *  2. Le hook PreToolUse qui valide les paths Write/Edit
 *  3. Les règles explicites dans CLAUDE.md
 */
function buildAddDirs(dataDir: string, cfg: AppConfig): string[] {
  const dirs = new Set<string>();
  dirs.add(dataDir);
  if (cfg.sharedSkillsDir) dirs.add(resolve(cfg.sharedSkillsDir));
  if (cfg.auditLogDir) dirs.add(resolve(cfg.auditLogDir));
  if (cfg.outputDir) dirs.add(resolve(cfg.outputDir));
  if (cfg.inputDir) dirs.add(resolve(cfg.inputDir));
  return Array.from(dirs);
}

/**
 * Retourne le chemin relatif (depuis DATA_DIR) vers un fichier skill de la
 * campagne active. Utilisé dans les prompts pour remplacer Skill("name") par
 * Read("<path>"), ce qui est nécessaire car Claude Code résout les skills par
 * nom de fichier sans extension (.md), et nos fichiers ont l'extension .skill.md.
 */
function skillRelPath(skillName: string, cfg?: AppConfig): string {
  const c = cfg ?? loadAppConfig(DATA_DIR);
  const dir = activeGlobalSkillsDir(DATA_DIR, c.sharedSkillsDir);
  const abs = resolve(dir, `${skillName}.skill.md`);
  return relative(DATA_DIR, abs).split("\\").join("/");
}

app.use(
  "*",
  cors({
    origin: [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://localhost:3100",
      "http://127.0.0.1:3100",
    ],
    credentials: true,
  })
);

// Sert le viewer PDF.js depuis vendor/pdfjs/ (chemin transmis par Electron via OIF_PDFJS_DIR).
// Next.js redirige /pdfjs/* vers ce daemon (cf. next.config.ts rewrites).
const PDFJS_DIR = process.env.OIF_PDFJS_DIR
  ? resolve(process.env.OIF_PDFJS_DIR)
  : resolve(process.cwd(), "vendor", "pdfjs");

app.get("/pdfjs/*", async (c) => {
  const subpath = c.req.path.replace(/^\/pdfjs\/?/, "") || "web/viewer.html";
  const { join, extname } = await import("node:path");
  const target = join(PDFJS_DIR, subpath);
  // Anti path-traversal
  if (!target.startsWith(PDFJS_DIR)) return c.json({ error: "accès refusé" }, 403);
  try {
    const buf = await readFile(target);
    const ext = extname(target).toLowerCase();
    const ct =
      ext === ".html" ? "text/html; charset=utf-8" :
      ext === ".js" || ext === ".mjs" ? "application/javascript" :
      ext === ".css" ? "text/css" :
      ext === ".pdf" ? "application/pdf" :
      ext === ".png" ? "image/png" :
      ext === ".svg" ? "image/svg+xml" :
      ext === ".woff2" ? "font/woff2" :
      ext === ".woff" ? "font/woff" :
      "application/octet-stream";
    return new Response(buf, {
      headers: {
        "Content-Type": ct,
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch {
    return c.json({ error: "fichier introuvable", path: subpath }, 404);
  }
});

app.get("/api/health", (c) =>
  c.json({
    ok: true,
    ts: new Date().toISOString(),
    service: "oif-eval-daemon",
    claude: findClaudeBin(),
    dataDir: DATA_DIR,
    dataDirExists: existsSync(DATA_DIR),
  })
);

/**
 * Limite par défaut si la config admin ne précise rien. La valeur effective
 * est lue via `getMaxConcurrent()` à chaque check, ce qui permet à l'admin de
 * modifier la limite à chaud sans redémarrer le daemon.
 */
const DEFAULT_MAX_CONCURRENT = 5;
function getMaxConcurrent(): number {
  const cfg = loadAppConfig(DATA_DIR);
  const v = cfg.maxConcurrentEvaluations;
  if (typeof v === "number" && v > 0 && v <= 20) return v;
  return DEFAULT_MAX_CONCURRENT;
}

function countRunningEvaluations(): number {
  // Avant chaque check, on nettoie les runs zombies (process Claude mort
  // côté OS, ou aucune activité depuis 30 min). Sans ça, un run fantôme
  // bloquerait indéfiniment la concurrence.
  const cleaned = cleanupZombies();
  if (cleaned > 0) {
    console.log(`[concurrency] ${cleaned} run(s) zombie(s) nettoyé(s) avant check`);
  }
  return listRuns().filter((r) => {
    if (r.status !== "running") return false;
    return Boolean(extractDossierId(r.prompt));
  }).length;
}

app.post("/api/runs", async (c) => {
  const body = (await c.req.json()) as ChatRequest;
  if (!body || typeof body.message !== "string") {
    return c.json({ error: "champ 'message' obligatoire" }, 400);
  }

  // Limite concurrente : maximum 5 évaluations en parallèle.
  // S'applique uniquement aux runs d'évaluation (pas chat libre, pas
  // amelioration de règles, pas promotion).
  const isEvaluation = Boolean(extractDossierId(body.message));
  if (isEvaluation) {
    const running = countRunningEvaluations();
    if (running >= getMaxConcurrent()) {
      return c.json(
        {
          error: `Limite de ${getMaxConcurrent()} évaluations en parallèle atteinte. Attendez qu'une évaluation se termine avant d'en lancer une nouvelle.`,
          running,
          max: getMaxConcurrent(),
        },
        429
      );
    }
  }

  const cwd = body.workdir
    ? resolve(DATA_DIR, body.workdir)
    : DATA_DIR;

  if (!existsSync(cwd)) {
    return c.json({ error: `cwd introuvable: ${cwd}` }, 400);
  }

  // Modèle : priorité au body.model (si l'UI override), sinon config persistée
  const cfg = loadAppConfig(DATA_DIR);
  const model = body.model ?? cfg.model;

  // Résolution des dossiers input/output (config user → fallback DATA_DIR)
  const inputDirAbs = cfg.inputDir ? resolve(cfg.inputDir) : null;
  const outputDirAbs = cfg.outputDir ? resolve(cfg.outputDir) : resolve(DATA_DIR, "evaluations");

  // Whitelist d'écriture : tous les dossiers configurés que Claude doit pouvoir
  // lire ET écrire. Sans ça, l'app prompte une approbation interactive pour
  // chaque write hors cwd, ce qui casse les évaluations automatiques.
  const addDirs = buildAddDirs(DATA_DIR, cfg);
  if (inputDirAbs && !addDirs.includes(inputDirAbs)) addDirs.push(inputDirAbs);
  if (outputDirAbs && !addDirs.includes(outputDirAbs)) addDirs.push(outputDirAbs);
  const inboxAbs = inboxDir(DATA_DIR);
  if (!addDirs.includes(inboxAbs)) addDirs.push(inboxAbs);

  // Expansion de /evaluer <id> en prompt explicite avec chemins absolus
  // (pour que ça marche que les dossiers soient sur disque local ou serveur partagé)
  function expandEvaluer(message: string): string {
    if (/^\s*\/evaluer-eligibilite\s/.test(message)) return expandEvaluerEligibilite(message);
    if (/^\s*\/evaluer-notation\s/.test(message)) return expandEvaluerNotation(message);
    const m = message.match(/^\s*\/evaluer\s+(\S+)\s*(.*)$/s);
    if (!m) return message;
    const id = m[1];
    const rest = m[2] || "";
    const inputHint = inputDirAbs
      ? `Le dossier candidate est à : \`${inputDirAbs}/${id}/\``
      : `Localise le dossier avec Glob \`candidatures-*/${id}/\``;
    return `# Évaluation FAE 7e - dossier ${id}

${inputHint}
Tu écriras le JSON de sortie dans : \`${outputDirAbs}/${id}.json\`

Suis le workflow standard de CLAUDE.md :
1. Liste les fichiers du dossier candidate.
2. Lis les pièces utiles dans l'ordre : depot.xlsx en premier (formulaire officiel Q1-Q54), budget xlsx, rapport financier, puis les PDF.
3. Lis \`${skillRelPath("evaluer-eligibilite", cfg)}\` et applique les règles d'éligibilité. Produit la grille 14 critères + verdict.
4. Si verdict ELIGIBLE uniquement (PAS ELIGIBILITE_INCERTAINE qui nécessite un jugement humain), lis \`${skillRelPath("evaluer-notation", cfg)}\` et applique les règles de notation. Produit la grille 49 questions (16 hors-IA = null).
5. Compose le JSON conforme au schéma .claude/schemas/evaluation-7e.schema.json et écris-le dans le chemin output indiqué ci-dessus via Write.

${rest}`.trim();
  }

  function expandEvaluerEligibilite(message: string): string {
    const m = message.match(/^\s*\/evaluer-eligibilite\s+(\S+)\s*(.*)$/s);
    if (!m) return message;
    const id = m[1];
    const rest = m[2] || "";
    const inputHint = inputDirAbs
      ? `Le dossier candidate est à : \`${inputDirAbs}/${id}/\``
      : `Localise le dossier avec Glob \`candidatures-*/${id}/\``;
    return `# Évaluation FAE 7e - dossier ${id} (phase éligibilité)

${inputHint}
Tu écriras le JSON de sortie dans : \`${outputDirAbs}/${id}.json\`

Phase 1 - Éligibilité uniquement :
1. Liste les fichiers du dossier candidate.
2. Lis les pièces utiles dans l'ordre : depot.xlsx en premier (formulaire officiel Q1-Q54), budget xlsx, rapport financier, puis les PDF.
3. Lis \`${skillRelPath("evaluer-eligibilite", cfg)}\` et applique les règles d'éligibilité. Produit la grille 14 critères + verdict.
4. Compose un JSON PARTIEL : uniquement phase_eligibilite, dossier_id, evaluateur_ia, horodatage, synthese (sans score ni questions). N'inclus PAS phase_notation.
5. Écris ce JSON partiel dans \`${outputDirAbs}/${id}.json\` via Write.

${rest}`.trim();
  }

  function expandEvaluerNotation(message: string): string {
    const m = message.match(/^\s*\/evaluer-notation\s+(\S+)\s*(.*)$/s);
    if (!m) return message;
    const id = m[1];
    const rest = m[2] || "";
    const inputHint = inputDirAbs
      ? `Le dossier candidate est à : \`${inputDirAbs}/${id}/\``
      : `Localise le dossier avec Glob \`candidatures-*/${id}/\``;
    return `# Évaluation FAE 7e - dossier ${id} (phase notation)

${inputHint}
Le JSON d'éligibilité existe dans : \`${outputDirAbs}/${id}.json\`

Phase 2 - Notation uniquement (le dossier a été jugé éligible) :
1. Lis le JSON existant \`${outputDirAbs}/${id}.json\` pour récupérer phase_eligibilite.
2. Lis les pièces utiles du dossier candidate.
3. Lis \`${skillRelPath("evaluer-notation", cfg)}\` et applique les règles de notation. Produit la grille 49 questions (16 hors-IA = null).
4. Met à jour le JSON en ajoutant phase_notation et en conservant phase_eligibilite intacte. Réécris le fichier complet via Write dans \`${outputDirAbs}/${id}.json\`.

${rest}`.trim();
  }

  let composedPrompt = body.slashCommand
    ? `${body.slashCommand}\n\n${body.message}`
    : expandEvaluer(body.message);

  // Chat ciblé sur un dossier : injecte un préfixe avec les chemins absolus
  // du dossier candidate ET le JSON d'évaluation déjà produit (inliné, tronqué).
  // Claude répond sans avoir à "chercher" le dossier. Ne s'applique pas aux
  // slash-commands ni aux prompts /evaluer qui ont déjà leur propre contexte.
  if (
    body.scope?.type === "dossier" &&
    !body.slashCommand &&
    !/^\s*\/evaluer/.test(body.message)
  ) {
    const dossierId = body.scope.id;
    const dossierDir = inputDirAbs ? `${inputDirAbs}/${dossierId}/` : null;
    const evalJsonPath = `${outputDirAbs}/${dossierId}.json`;
    let evalSnippet = "";
    try {
      if (existsSync(evalJsonPath)) {
        const raw = readFileSync(evalJsonPath, "utf8");
        const MAX = 8000;
        evalSnippet =
          raw.length > MAX
            ? `${raw.slice(0, MAX)}\n... (JSON tronqué à ${MAX} caractères, lis le fichier complet via Read si besoin)`
            : raw;
      }
    } catch {
      // pas bloquant, on continue sans le snippet
    }
    if (dossierDir && existsSync(dossierDir) && !addDirs.includes(dossierDir)) {
      addDirs.push(dossierDir);
    }
    const dossierPrefix = `# Contexte dossier ${dossierId}

${dossierDir ? `**Fichiers source du candidat** : \`${dossierDir}\`\n(PDF de présentation, statuts, depot.xlsx, budget, rapport financier, etc.)` : "**Fichiers source** : pas de `inputDir` configuré, fallback `data/.claude/inbox/`"}

**Évaluation IA existante** : \`${evalJsonPath}\`${evalSnippet ? "\n\nContenu actuel (extrait) :\n```json\n" + evalSnippet + "\n```" : "\n(pas encore d'évaluation produite pour ce dossier)"}

**Consignes** :
- Réponds à la question sur ce dossier uniquement (ne parle pas d'autres dossiers).
- Le JSON ci-dessus contient déjà verdict, scores, points forts/vigilance. Utilise-le en priorité.
- Lis un PDF/xlsx du candidat seulement si la question demande un détail qui n'est pas dans le JSON.

---

`;
    composedPrompt = dossierPrefix + composedPrompt;
  }

  // Auto-approbation : si l'admin a activé le flag, on dit à Claude
  // d'enchaîner immédiatement la promotion après création de la proposition.
  if (body.slashCommand === "/ameliorer-regle" && cfg.autoApprove === true) {
    composedPrompt += `\n\n[CONFIGURATION AUTO-APPROBATION ACTIVE]
L'admin a activé l'auto-approbation des propositions. Donc :
1. Crée la proposition dans _propositions/ comme d'habitude en lisant \`${skillRelPath("ameliorer-mes-regles", cfg)}\`.
2. Enchaîne IMMÉDIATEMENT en lisant \`${skillRelPath("promouvoir-regle", cfg)}\` pour appliquer la règle au skill global concerné, comme si l'admin venait de cliquer sur "promouvoir".
3. Marque la proposition avec : statut: promu, promu_le: <ISO maintenant>, promu_par: "auto-approbation", commentaire_admin: "auto-approbation activée par l'admin".
4. Journalise dans _historique.jsonl avec admin: "auto-approbation".
Le résultat final : la règle est dans le skill global ET la proposition est marquée "promu", en un seul run.`;
  }

  try {
    const run = startRun({
      prompt: composedPrompt,
      cwd,
      addDirs,
      allowedTools: ["Read", "Write", "Edit", "Glob", "Grep", "Skill", "Task", "mcp__office__read_xlsx"],
      permissionMode: "bypassPermissions",
      model,
    });
    const dossierId = extractDossierId(body.message);
    const action =
      body.slashCommand === "/ameliorer-regle"
        ? "rule.improve.run.start"
        : dossierId
        ? "evaluation.run.start"
        : "claude.run.start";
    audit(c, {
      action,
      resource_type: dossierId ? "dossier" : "claude_run",
      resource_id: dossierId ?? run.id,
      result: "success",
      metadata: {
        run_id: run.id,
        model,
        slash_command: body.slashCommand ?? null,
      },
    });
    const created: ChatRunCreated = { runId: run.id };
    return c.json(created, 201);
  } catch (err) {
    audit(c, {
      action: "claude.run.start",
      resource_type: "claude_run",
      result: "failure",
      reason: (err as Error).message,
    });
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.get("/api/runs", (c) => c.json({ runs: listRuns() }));

app.get("/api/runs/concurrency", (c) => {
  return c.json({
    running: countRunningEvaluations(),
    max: getMaxConcurrent(),
    canStart:
      getMaxConcurrent() - countRunningEvaluations(),
  });
});

/**
 * Lance plusieurs évaluations d'un coup (batch). Limité par
 * getMaxConcurrent() - runs déjà en cours.
 * Body : { dossier_ids: string[] }. On lance dans l'ordre, on s'arrête à la
 * limite. Renvoie la liste des dossiers effectivement lancés et ceux skippés.
 */
app.post("/api/runs/batch", async (c) => {
  const body = (await c.req.json()) as { dossier_ids?: string[]; model?: string; eligibilite_only?: boolean };
  const ids = Array.isArray(body.dossier_ids) ? body.dossier_ids : [];
  if (ids.length === 0) {
    return c.json({ error: "dossier_ids requis (array non vide)" }, 400);
  }

  const cfg = loadAppConfig(DATA_DIR);
  const model = body.model ?? cfg.model;
  const eligibiliteOnly = body.eligibilite_only ?? false;
  const inputDirAbs = cfg.inputDir ? resolve(cfg.inputDir) : null;
  const outputDirAbs = cfg.outputDir
    ? resolve(cfg.outputDir)
    : resolve(DATA_DIR, "evaluations");
  const addDirs = buildAddDirs(DATA_DIR, cfg);
  if (inputDirAbs && !addDirs.includes(inputDirAbs)) addDirs.push(inputDirAbs);
  if (outputDirAbs && !addDirs.includes(outputDirAbs)) addDirs.push(outputDirAbs);
  const inboxAbs = inboxDir(DATA_DIR);
  if (!addDirs.includes(inboxAbs)) addDirs.push(inboxAbs);

  const slotsAvailable =
    getMaxConcurrent() - countRunningEvaluations();
  const launched: { dossier_id: string; run_id: string }[] = [];
  const skipped: { dossier_id: string; reason: string }[] = [];

  for (const id of ids) {
    if (launched.length >= slotsAvailable) {
      skipped.push({ dossier_id: id, reason: "limite parallèle atteinte" });
      continue;
    }
    // Refuse si une évaluation pour ce dossier tourne déjà
    const alreadyRunning = listRuns().some(
      (r) => r.status === "running" && extractDossierId(r.prompt) === id
    );
    if (alreadyRunning) {
      skipped.push({ dossier_id: id, reason: "évaluation déjà en cours" });
      continue;
    }

    const inputHint = inputDirAbs
      ? `Le dossier candidate est à : \`${inputDirAbs}/${id}/\``
      : `Localise le dossier avec Glob \`candidatures-*/${id}/\``;
    const composedPrompt = eligibiliteOnly
      ? `# Évaluation FAE 7e - dossier ${id} (phase éligibilité)

${inputHint}
Tu écriras le JSON de sortie dans : \`${outputDirAbs}/${id}.json\`

Phase 1 - Éligibilité uniquement :
1. Liste les fichiers du dossier candidate.
2. Lis les pièces utiles dans l'ordre : depot.xlsx en premier (formulaire officiel Q1-Q54), budget xlsx, rapport financier, puis les PDF.
3. Lis \`${skillRelPath("evaluer-eligibilite", cfg)}\` et applique les règles d'éligibilité. Produit la grille 14 critères + verdict.
4. Compose un JSON PARTIEL : uniquement phase_eligibilite, dossier_id, evaluateur_ia, horodatage, synthese (sans score ni questions). N'inclus PAS phase_notation.
5. Écris ce JSON partiel dans \`${outputDirAbs}/${id}.json\` via Write.`
      : `# Évaluation FAE 7e - dossier ${id}

${inputHint}
Tu écriras le JSON de sortie dans : \`${outputDirAbs}/${id}.json\`

Suis le workflow standard de CLAUDE.md :
1. Liste les fichiers du dossier candidate.
2. Lis les pièces utiles dans l'ordre : depot.xlsx en premier (formulaire officiel Q1-Q54), budget xlsx, rapport financier, puis les PDF.
3. Lis \`${skillRelPath("evaluer-eligibilite", cfg)}\` et applique les règles d'éligibilité. Produit la grille 14 critères + verdict.
4. Si verdict ELIGIBLE uniquement (PAS ELIGIBILITE_INCERTAINE qui nécessite un jugement humain), lis \`${skillRelPath("evaluer-notation", cfg)}\` et applique les règles de notation. Produit la grille 49 questions (16 hors-IA = null).
5. Compose le JSON conforme au schéma .claude/schemas/evaluation-7e.schema.json et écris-le dans le chemin output indiqué ci-dessus via Write.`;

    try {
      const run = startRun({
        prompt: composedPrompt,
        cwd: DATA_DIR,
        addDirs,
        allowedTools: ["Read", "Write", "Edit", "Glob", "Grep", "Skill", "Task", "mcp__office__read_xlsx"],
        permissionMode: "bypassPermissions",
        model,
      });
      launched.push({ dossier_id: id, run_id: run.id });
      audit(c, {
        action: "evaluation.batch.start",
        resource_type: "dossier",
        resource_id: id,
        result: "success",
        metadata: { run_id: run.id, model, batch_size: ids.length },
      });
    } catch (err) {
      skipped.push({ dossier_id: id, reason: (err as Error).message });
    }
  }

  return c.json({
    launched,
    skipped,
    runningTotal: countRunningEvaluations(),
    max: getMaxConcurrent(),
  });
});

/**
 * Lance la phase notation pour une liste de dossiers éligibles (eligibilite_ok).
 * Body : { dossier_ids: string[] }
 */
app.post("/api/runs/batch-notation", async (c) => {
  const body = (await c.req.json()) as { dossier_ids?: string[] };
  const ids = Array.isArray(body.dossier_ids) ? body.dossier_ids : [];
  if (ids.length === 0) {
    return c.json({ error: "dossier_ids requis (array non vide)" }, 400);
  }

  const cfg = loadAppConfig(DATA_DIR);
  const model = cfg.model;
  const inputDirAbs = cfg.inputDir ? resolve(cfg.inputDir) : null;
  const outputDirAbs = cfg.outputDir
    ? resolve(cfg.outputDir)
    : resolve(DATA_DIR, "evaluations");
  const addDirs = buildAddDirs(DATA_DIR, cfg);
  if (inputDirAbs && !addDirs.includes(inputDirAbs)) addDirs.push(inputDirAbs);
  if (outputDirAbs && !addDirs.includes(outputDirAbs)) addDirs.push(outputDirAbs);
  const inboxAbs = inboxDir(DATA_DIR);
  if (!addDirs.includes(inboxAbs)) addDirs.push(inboxAbs);

  const slotsAvailable = getMaxConcurrent() - countRunningEvaluations();
  const launched: { dossier_id: string; run_id: string }[] = [];
  const skipped: { dossier_id: string; reason: string }[] = [];

  for (const id of ids) {
    if (launched.length >= slotsAvailable) {
      skipped.push({ dossier_id: id, reason: "limite parallèle atteinte" });
      continue;
    }
    const alreadyRunning = listRuns().some(
      (r) => r.status === "running" && extractDossierId(r.prompt) === id
    );
    if (alreadyRunning) {
      skipped.push({ dossier_id: id, reason: "évaluation déjà en cours" });
      continue;
    }

    const inputHint = inputDirAbs
      ? `Le dossier candidate est à : \`${inputDirAbs}/${id}/\``
      : `Localise le dossier avec Glob \`candidatures-*/${id}/\``;
    const composedPrompt = `# Évaluation FAE 7e - dossier ${id} (phase notation)

${inputHint}
Le JSON d'éligibilité existe dans : \`${outputDirAbs}/${id}.json\`

Phase 2 - Notation uniquement (le dossier a été jugé éligible) :
1. Lis le JSON existant \`${outputDirAbs}/${id}.json\` pour récupérer phase_eligibilite.
2. Lis les pièces utiles du dossier candidate.
3. Lis \`${skillRelPath("evaluer-notation", cfg)}\` et applique les règles de notation. Produit la grille 49 questions (16 hors-IA = null).
4. Met à jour le JSON en ajoutant phase_notation et en conservant phase_eligibilite intacte. Réécris le fichier complet via Write dans \`${outputDirAbs}/${id}.json\`.`;

    try {
      const run = startRun({
        prompt: composedPrompt,
        cwd: DATA_DIR,
        addDirs,
        allowedTools: ["Read", "Write", "Edit", "Glob", "Grep", "Skill", "Task", "mcp__office__read_xlsx"],
        permissionMode: "bypassPermissions",
        model,
      });
      launched.push({ dossier_id: id, run_id: run.id });
      audit(c, {
        action: "evaluation.batch-notation.start",
        resource_type: "dossier",
        resource_id: id,
        result: "success",
        metadata: { run_id: run.id, model, batch_size: ids.length },
      });
    } catch (err) {
      skipped.push({ dossier_id: id, reason: (err as Error).message });
    }
  }

  return c.json({
    launched,
    skipped,
    runningTotal: countRunningEvaluations(),
    max: getMaxConcurrent(),
  });
});

/**
 * Upload d'un fichier joint au chat (ex. référentiel docx). Le fichier est
 * stocké dans data/.claude/inbox/, accessible par Claude dans les runs
 * suivants. Si .docx, on convertit en .md via mammoth pour faciliter la
 * lecture par Claude.
 */
app.post("/api/chat/upload", async (c) => {
  let buffer: Buffer;
  let filename: string;
  try {
    const form = await c.req.formData();
    const file = form.get("file");
    if (!file || !(file instanceof File)) {
      return c.json({ error: "champ 'file' manquant" }, 400);
    }
    filename = file.name || "fichier";
    const ab = await file.arrayBuffer();
    buffer = Buffer.from(ab);
  } catch (err) {
    return c.json({ error: `formdata illisible : ${(err as Error).message}` }, 400);
  }
  try {
    const result = await storeUpload(DATA_DIR, filename, buffer);
    audit(c, {
      action: "chat.upload",
      resource_type: "inbox_file",
      resource_id: result.originalPath,
      result: "success",
      metadata: {
        filename: result.filename,
        ext: result.ext,
        size: result.size,
        text_path: result.textPath,
        warnings: result.conversionWarnings,
      },
    });
    return c.json(result);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.get("/api/dossiers", (c) => {
  const cfg = loadAppConfig(DATA_DIR);
  const dossiers = listDossiers(DATA_DIR, { inputDir: cfg.inputDir, outputDir: cfg.outputDir });
  // Marque les dossiers ayant un run actif (running=true) pour que l'UI
  // affiche un spinner même avant que le JSON soit écrit sur disque.
  const runningIds = new Set<string>();
  for (const r of listRuns()) {
    if (r.status !== "running") continue;
    const id = extractDossierId(r.prompt);
    if (id) runningIds.add(id);
  }
  for (const d of dossiers) {
    if (runningIds.has(d.id)) d.running = true;
  }
  return c.json({ dossiers });
});

app.get("/api/agents", async (c) => {
  const claude = await getAgentStatus();
  return c.json({ agents: [claude] });
});

app.get("/api/app-config", (c) => {
  return c.json({
    config: loadAppConfig(DATA_DIR),
    availableModels: AVAILABLE_MODELS,
  });
});

app.put("/api/app-config", async (c) => {
  const before = loadAppConfig(DATA_DIR);
  const body = (await c.req.json()) as {
    model?: string;
    inputDir?: string | null;
    outputDir?: string | null;
    sharedSkillsDir?: string | null;
    auditLogDir?: string | null;
    currentUser?: string | null;
    isAdmin?: boolean;
    autoApprove?: boolean;
    autoNotation?: boolean;
    storageMode?: "shared" | "manual" | null;
    maxConcurrentEvaluations?: number;
  };
  if (typeof body.model === "string") {
    const allowedIds = AVAILABLE_MODELS.map((m) => m.id);
    if (!allowedIds.includes(body.model as (typeof allowedIds)[number])) {
      return c.json({ error: `model invalide. Accepted: ${allowedIds.join(", ")}` }, 400);
    }
  }
  const patch: Partial<{
    model: string;
    inputDir: string | undefined;
    outputDir: string | undefined;
    sharedSkillsDir: string | undefined;
    auditLogDir: string | undefined;
    currentUser: string | undefined;
    isAdmin: boolean;
    autoApprove: boolean;
    autoNotation: boolean;
    storageMode: "shared" | "manual" | undefined;
    maxConcurrentEvaluations: number;
  }> = {};
  if (typeof body.model === "string") patch.model = body.model;
  if (body.inputDir !== undefined) patch.inputDir = body.inputDir ? String(body.inputDir) : undefined;
  if (body.outputDir !== undefined) patch.outputDir = body.outputDir ? String(body.outputDir) : undefined;
  if (body.sharedSkillsDir !== undefined)
    patch.sharedSkillsDir = body.sharedSkillsDir ? String(body.sharedSkillsDir) : undefined;
  if (body.auditLogDir !== undefined)
    patch.auditLogDir = body.auditLogDir ? String(body.auditLogDir) : undefined;
  if (body.currentUser !== undefined)
    patch.currentUser = body.currentUser ? String(body.currentUser) : undefined;
  if (typeof body.isAdmin === "boolean") patch.isAdmin = body.isAdmin;
  if (typeof body.autoApprove === "boolean") patch.autoApprove = body.autoApprove;
  if (typeof body.autoNotation === "boolean") patch.autoNotation = body.autoNotation;
  if (body.storageMode !== undefined)
    patch.storageMode = body.storageMode === null ? undefined : body.storageMode;
  if (typeof body.maxConcurrentEvaluations === "number") {
    const n = Math.round(body.maxConcurrentEvaluations);
    if (n < 1 || n > 20) {
      return c.json({ error: "maxConcurrentEvaluations doit être entre 1 et 20" }, 400);
    }
    patch.maxConcurrentEvaluations = n;
  }
  const updated = saveAppConfig(DATA_DIR, patch);
  // Trace les changements sensibles (rôle, auto-approve, chemins)
  const sensitiveKeys: (keyof typeof patch)[] = [
    "isAdmin",
    "autoApprove",
    "autoNotation",
    "inputDir",
    "outputDir",
    "sharedSkillsDir",
    "auditLogDir",
    "currentUser",
    "model",
    "storageMode",
  ];
  const changed = sensitiveKeys.filter((k) => patch[k] !== undefined && before[k] !== patch[k]);
  if (changed.length > 0) {
    audit(c, {
      action: "config.update",
      resource_type: "app_config",
      resource_id: "global",
      result: "success",
      metadata: {
        changed_keys: changed,
        before: Object.fromEntries(changed.map((k) => [k, before[k] ?? null])),
        after: Object.fromEntries(changed.map((k) => [k, patch[k] ?? null])),
      },
    });
  }
  return c.json({ config: updated });
});

app.get("/api/dossiers/:id/events", (c) => {
  const id = c.req.param("id");
  // Cherche d'abord un run en mémoire (en cours ou récent) pour avoir les events live
  const runs = listRuns();
  const matching = runs
    .filter((r) => extractDossierId(r.prompt) === id)
    .sort((a, b) => b.startedAt - a.startedAt);
  if (matching.length > 0) {
    const r = matching[0];
    return c.json({
      runId: r.id,
      status: r.status,
      events: r.events,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
    });
  }
  // Sinon : recharge depuis le disque
  const events = loadRunEvents(DATA_DIR, id);
  return c.json({
    runId: null,
    status: events.length > 0 ? "succeeded" : "idle",
    events,
    startedAt: null,
    endedAt: null,
  });
});

app.get("/api/dossiers/:id/files", async (c) => {
  const id = c.req.param("id");
  const cfgL = loadAppConfig(DATA_DIR);
  const all = listDossiers(DATA_DIR, { inputDir: cfgL.inputDir, outputDir: cfgL.outputDir });
  const d = all.find((x) => x.id === id);
  if (!d) return c.json({ error: "dossier introuvable" }, 404);
  const fs = await import("node:fs");
  const path = await import("node:path");
  const files = d.files.map((f) => {
    const p = path.join(d.path, f);
    let size = 0;
    try { size = fs.statSync(p).size; } catch {}
    const ext = path.extname(f).toLowerCase();
    const kind =
      ext === ".pdf" ? "pdf" :
      ext === ".xlsx" ? "xlsx" :
      ext === ".docx" ? "docx" :
      ext === ".jpg" || ext === ".jpeg" || ext === ".png" ? "image" :
      "other";
    return { name: f, size, kind, absPath: p };
  });
  return c.json({ id, path: d.path, files });
});

app.get("/api/dossiers/:id/files/:filename{.+}", async (c) => {
  const id = c.req.param("id");
  const filename = c.req.param("filename");
  // Sanity : pas de path traversal
  if (filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
    return c.json({ error: "filename invalide" }, 400);
  }
  const cfgL = loadAppConfig(DATA_DIR);
  const all = listDossiers(DATA_DIR, { inputDir: cfgL.inputDir, outputDir: cfgL.outputDir });
  const d = all.find((x) => x.id === id);
  if (!d) return c.json({ error: "dossier introuvable" }, 404);
  const path = await import("node:path");
  const targetPath = path.join(d.path, filename);
  // S'assure que la cible est bien sous d.path (suivi des symlinks)
  let realTarget: string;
  try {
    realTarget = realpathSync(targetPath);
  } catch {
    return c.json({ error: "fichier introuvable" }, 404);
  }
  const realDossier = realpathSync(d.path);
  if (!realTarget.startsWith(realDossier)) {
    return c.json({ error: "accès refusé" }, 403);
  }
  const ext = path.extname(filename).toLowerCase();
  const ct =
    ext === ".pdf" ? "application/pdf" :
    ext === ".xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" :
    ext === ".docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" :
    ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" :
    ext === ".png" ? "image/png" :
    "application/octet-stream";
  const buf = await readFile(realTarget);
  audit(c, {
    action: "dossier.file.read",
    resource_type: "dossier_file",
    resource_id: id,
    resource_label: filename,
    result: "success",
    metadata: { ext, size: buf.length },
  });
  // Inline pour PDF/images, attachment pour le reste
  const disposition = ext === ".pdf" || ext === ".jpg" || ext === ".jpeg" || ext === ".png"
    ? "inline" : "attachment";
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": ct,
      "Content-Disposition": `${disposition}; filename="${encodeURIComponent(filename)}"`,
    },
  });
});

app.get("/api/dossiers/:id/verite", (c) => {
  const id = c.req.param("id");
  const summary = getVeriteSummary(id);
  if (!summary) return c.json({ error: "dossier introuvable" }, 404);
  return c.json(summary);
});

app.get("/api/dossiers/:id/verite/full", (c) => {
  const id = c.req.param("id");
  const v = getVerite(id);
  if (!v) return c.json({ error: "non trouvée" }, 404);
  return c.json(v);
});

function resolveEvalPath(id: string): string | null {
  const cfg = loadAppConfig(DATA_DIR);
  const outputDir = cfg.outputDir
    ? resolve(cfg.outputDir)
    : resolve(DATA_DIR, "evaluations");
  const primary = resolve(outputDir, `${id}.json`);
  if (existsSync(primary)) return primary;
  const fallback = resolve(DATA_DIR, "evaluations", `${id}.json`);
  if (existsSync(fallback)) return fallback;
  return null;
}

/**
 * Résumé des coûts de tous les runs d'évaluation ayant un .events.jsonl.
 * Lit les events persistés sur disque depuis DEUX sources :
 *   1. data/evaluations/ (local au poste)
 *   2. outputDir configuré (NAS partagé OIF)
 * Les doublons sont dédupliqués par dossierId (priorité au plus récent par ts).
 *
 * Retourne, en plus de la liste plate :
 *   - byModel : agrégation tokens/coût par modèle Claude
 *   - byDay   : coût cumulé jour par jour (clé YYYY-MM-DD, UTC)
 *   - top10   : 10 dossiers les plus chers (anomalies)
 *
 * Si un run n'a pas de cost_usd reporté (event "result" absent), on tente
 * un fallback : calculer le coût depuis les events `usage` + grille tarifaire.
 */
app.get("/api/evaluations/costs", (c) => {
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  const cfg = loadAppConfig(DATA_DIR);
  const sources = new Set<string>();
  sources.add(resolve(DATA_DIR, "evaluations"));
  if (cfg.outputDir) sources.add(resolve(cfg.outputDir));

  type CostRow = { dossierId: string } & RunCostSummary;
  const byId = new Map<string, CostRow>();

  for (const dir of sources) {
    let files: string[] = [];
    try {
      files = readdirSync(dir).filter((f: string) => f.endsWith(".events.jsonl"));
    } catch {
      continue;
    }
    for (const file of files) {
      const dossierId = file.replace(".events.jsonl", "");
      const events = loadRunEventsFromPath(resolve(dir, file));
      let summary = extractCostFromEvents(events);

      // On préfère toujours recompute via la grille tarifaire courante :
      // si l'admin actualise les tarifs, tous les historiques se mettent à
      // jour automatiquement (au lieu de garder le costUsd figé au run).
      if (summary) {
        const t = tariffFor(summary.model);
        const tokens = summary.tokens;
        const recomputedCost =
          (tokens.input * t.input) / 1_000_000 +
          (tokens.output * t.output) / 1_000_000 +
          (tokens.cacheRead * t.cache_read) / 1_000_000 +
          (tokens.cacheCreate5m * t.cache_create_5m) / 1_000_000 +
          (tokens.cacheCreate1h * t.cache_create_5m * t.cache_create_1h_multiplier) / 1_000_000;
        if (recomputedCost > 0) summary = { ...summary, costUsd: Number(recomputedCost.toFixed(6)) };
      }

      // Fallback : pas de result event mais on a des usage events -> recompute
      if (!summary || (summary.costUsd === 0 && summary.tokens.input + summary.tokens.output > 0)) {
        const recomputed = recomputeFromUsage(events);
        if (recomputed) summary = recomputed;
      }
      if (!summary) continue;
      const prev = byId.get(dossierId);
      if (!prev || summary.ts > prev.ts) {
        byId.set(dossierId, { dossierId, ...summary });
      }
    }
  }

  const costs = Array.from(byId.values()).sort((a, b) => b.ts - a.ts);
  const total = costs.reduce((s, c) => s + c.costUsd, 0);
  const avg = costs.length > 0 ? total / costs.length : 0;
  const totalDurationMs = costs.reduce((s, c) => s + c.durationMs, 0);
  const tokensTotals = costs.reduce(
    (acc, r) => {
      acc.input += r.tokens.input;
      acc.output += r.tokens.output;
      acc.cacheRead += r.tokens.cacheRead;
      acc.cacheCreate5m += r.tokens.cacheCreate5m;
      acc.cacheCreate1h += r.tokens.cacheCreate1h;
      return acc;
    },
    { input: 0, output: 0, cacheRead: 0, cacheCreate5m: 0, cacheCreate1h: 0 }
  );

  // Agrégation par modèle
  const modelMap = new Map<
    string,
    {
      model: string;
      count: number;
      costUsd: number;
      durationMs: number;
      tokens: { input: number; output: number; cacheRead: number; cacheCreate5m: number; cacheCreate1h: number };
    }
  >();
  for (const r of costs) {
    const key = r.model || "inconnu";
    const m = modelMap.get(key) ?? {
      model: key,
      count: 0,
      costUsd: 0,
      durationMs: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate5m: 0, cacheCreate1h: 0 },
    };
    m.count++;
    m.costUsd += r.costUsd;
    m.durationMs += r.durationMs;
    m.tokens.input += r.tokens.input;
    m.tokens.output += r.tokens.output;
    m.tokens.cacheRead += r.tokens.cacheRead;
    m.tokens.cacheCreate5m += r.tokens.cacheCreate5m;
    m.tokens.cacheCreate1h += r.tokens.cacheCreate1h;
    modelMap.set(key, m);
  }
  const byModel = Array.from(modelMap.values()).sort((a, b) => b.costUsd - a.costUsd);

  // Agrégation par jour (clé YYYY-MM-DD, heure locale du serveur)
  const dayMap = new Map<string, { day: string; costUsd: number; count: number }>();
  for (const r of costs) {
    const d = new Date(r.ts);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const e = dayMap.get(key) ?? { day: key, costUsd: 0, count: 0 };
    e.costUsd += r.costUsd;
    e.count++;
    dayMap.set(key, e);
  }
  const byDay = Array.from(dayMap.values()).sort((a, b) => a.day.localeCompare(b.day));

  // Top 10 par coût décroissant
  const top10 = [...costs].sort((a, b) => b.costUsd - a.costUsd).slice(0, 10);

  // Taux de cache hit (lecture cache / total input équivalent)
  const cacheableTotal = tokensTotals.input + tokensTotals.cacheRead + tokensTotals.cacheCreate5m + tokensTotals.cacheCreate1h;
  const cacheHitRate = cacheableTotal > 0 ? tokensTotals.cacheRead / cacheableTotal : 0;

  return c.json({
    costs,
    total,
    avg,
    count: costs.length,
    totalDurationMs,
    tokensTotals,
    cacheHitRate,
    byModel,
    byDay,
    top10,
    sources: Array.from(sources),
    pricingMeta: getPricingMetadata(),
    configuredModel: cfg.model ?? null,
  });
});

/**
 * Tarifs Claude courants (utilisés pour calculer tous les coûts du dashboard).
 */
app.get("/api/pricing", (c) => {
  return c.json({ tariffs: getModelTariffs(), meta: getPricingMetadata() });
});

/**
 * Déclenche un agent Claude qui va chercher les tarifs Anthropic à jour
 * sur leur doc officielle (via WebFetch) et écrire le JSON. Réponse :
 * { runId } pour permettre à l'UI de tracker la progression.
 */
app.post("/api/pricing/refresh", async (c) => {
  const cfg = loadAppConfig(DATA_DIR);
  const model = cfg.model;
  const targetPath = pricingJsonPathFor(DATA_DIR);
  const prompt = `# Mise à jour des tarifs Claude API

Tu dois récupérer la grille tarifaire Anthropic à jour et écrire un fichier JSON.

## Source officielle
Va chercher la page : https://docs.claude.com/en/docs/about-claude/pricing
Si elle ne charge pas, essaie : https://www.anthropic.com/pricing

Utilise WebFetch pour extraire **TOUS** les modèles Claude documentés (génération 3.x ET 4.x, toutes tailles : Haiku, Sonnet, Opus). Les modèles attendus aujourd'hui (mai 2026) sont au minimum :

**Famille 4.x :**
- claude-opus-4-7, claude-opus-4-6, claude-opus-4-5
- claude-sonnet-4-7, claude-sonnet-4-6, claude-sonnet-4-5
- claude-haiku-4-7, claude-haiku-4-6, claude-haiku-4-5

**Famille 3.x (legacy mais encore facturable) :**
- claude-3-7-sonnet, claude-3-5-sonnet, claude-3-5-haiku
- claude-3-opus, claude-3-haiku

Si la doc liste d'autres modèles (préview, snapshot, etc.), ajoute-les aussi avec l'ID exact utilisé par l'API (sans alias).

Pour CHAQUE modèle, récupère :
- **input** : Standard input price ($/M tokens)
- **output** : Output price ($/M tokens)
- **cache_read** : Prompt caching - cache hits & refreshes ($/M tokens)
- **cache_create_5m** : Prompt caching - cache writes 5min TTL ($/M tokens)
- **cache_create_1h_multiplier** : si la doc liste séparément le cache write 1h, calcule \`cache_write_1h_price / cache_create_5m\`. Sinon, laisse 1.6 (ratio empirique standard Anthropic).

## Format de sortie exact

Écris le fichier suivant via Write à : \`${targetPath}\`

\`\`\`json
{
  "updatedAt": "<ISO date maintenant>",
  "source": "https://docs.claude.com/en/docs/about-claude/pricing",
  "tariffs": {
    "claude-opus-4-7":   { "input": 5.0,  "output": 25.0, "cache_read": 0.5,  "cache_create_5m": 6.25, "cache_create_1h_multiplier": 1.6 },
    "claude-sonnet-4-6": { "input": 3.0,  "output": 15.0, "cache_read": 0.3,  "cache_create_5m": 3.75, "cache_create_1h_multiplier": 1.6 },
    "claude-haiku-4-5":  { "input": 1.0,  "output": 5.0,  "cache_read": 0.1,  "cache_create_5m": 1.25, "cache_create_1h_multiplier": 1.6 }
    // ... continue pour tous les modèles trouvés
  }
}
\`\`\`

REMPLACE les valeurs par les VRAIES extraites de la doc. Tous les nombres en USD par million de tokens. N'invente pas de modèles ; n'écris que ceux que tu as effectivement trouvés dans la doc.`;

  const addDirs = buildAddDirs(DATA_DIR, cfg);
  const claudeDir = resolve(DATA_DIR, ".claude");
  if (!addDirs.includes(claudeDir)) addDirs.push(claudeDir);

  try {
    const run = startRun({
      prompt,
      cwd: DATA_DIR,
      addDirs,
      allowedTools: ["WebFetch", "WebSearch", "Read", "Write", "Edit"],
      permissionMode: "bypassPermissions",
      model,
    });
    audit(c, {
      action: "pricing.refresh.start",
      resource_type: "pricing",
      resource_id: run.id,
      result: "success",
      metadata: { run_id: run.id, model },
    });
    return c.json({ runId: run.id }, 201);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// Déclaré APRÈS /api/evaluations/costs : Hono matche les routes dans l'ordre
// de déclaration, donc /costs doit être enregistré en premier pour ne pas
// être capturé par /:id qui matcherait id="costs".
app.get("/api/evaluations/:id", async (c) => {
  const id = c.req.param("id");
  const path = resolveEvalPath(id);
  if (!path) return c.json({ error: "non trouvée" }, 404);
  const fs = await import("node:fs/promises");
  const content = await fs.readFile(path, "utf8");
  try {
    return c.json(JSON.parse(content));
  } catch {
    return c.json({ error: "JSON corrompu" }, 500);
  }
});

/**
 * Fallback : reconstruit un RunCostSummary depuis les events `usage` quand
 * l'event `result` est manquant ou que costUsd vaut 0. Utilise la grille
 * tarifaire embarquée (server/pricing.ts) et applique la même dédup par
 * message_id que extractCostFromEvents.
 */
function recomputeFromUsage(events: import("./types.js").AgentEvent[]): RunCostSummary | null {
  type Snap = { i: number; o: number; cr: number; c5m: number; c1h: number };
  const seen = new Map<string, Snap>();
  let input = 0, output = 0, cr = 0, c5m = 0, c1h = 0;
  let model = "";
  let firstTs = 0;
  let lastTs = 0;

  for (const ev of events) {
    if (ev.kind !== "usage" || !ev.usage) continue;
    if (!firstTs) firstTs = ev.ts;
    lastTs = ev.ts;
    const u = ev.usage;
    const mid = u.message_id;
    if (mid) {
      const prev = seen.get(mid);
      if (prev) {
        input -= prev.i; output -= prev.o; cr -= prev.cr; c5m -= prev.c5m; c1h -= prev.c1h;
      }
      seen.set(mid, { i: u.input_tokens, o: u.output_tokens, cr: u.cache_read, c5m: u.cache_create_5m, c1h: u.cache_create_1h });
    }
    input += u.input_tokens;
    output += u.output_tokens;
    cr += u.cache_read;
    c5m += u.cache_create_5m;
    c1h += u.cache_create_1h;
    if (u.model) model = u.model;
  }
  if (!model || (input + output + cr + c5m + c1h) === 0) return null;

  const t = tariffFor(model);
  const cost =
    (input * t.input) / 1_000_000 +
    (output * t.output) / 1_000_000 +
    (cr * t.cache_read) / 1_000_000 +
    (c5m * t.cache_create_5m) / 1_000_000 +
    (c1h * t.cache_create_5m * t.cache_create_1h_multiplier) / 1_000_000;

  return {
    costUsd: Number(cost.toFixed(6)),
    durationMs: lastTs - firstTs,
    success: true, // inconnu - on suppose OK
    model,
    tokens: { input, output, cacheRead: cr, cacheCreate5m: c5m, cacheCreate1h: c1h },
    ts: lastTs || firstTs || Date.now(),
  };
}

app.get("/api/skills", (c) => {
  const cfg = loadAppConfig(DATA_DIR);
  return c.json({
    global: listGlobalSkills(DATA_DIR, cfg.sharedSkillsDir),
    perso: [], // système perso supprimé : tout passe par /propositions
  });
});

/**
 * Endpoints CRUD des campagnes (V1 : clone-and-activate, sans édition de grille).
 */
app.get("/api/campaigns", (c) => {
  const cfg = loadAppConfig(DATA_DIR);
  return c.json(listCampaigns(DATA_DIR, cfg.sharedSkillsDir));
});

app.get("/api/campaigns/:id", (c) => {
  const id = c.req.param("id");
  const cfg = loadAppConfig(DATA_DIR);
  const campaign = getCampaign(DATA_DIR, id, cfg.sharedSkillsDir);
  if (!campaign) return c.json({ error: "campagne introuvable" }, 404);
  const manifest = readManifest(DATA_DIR, id, cfg.sharedSkillsDir);
  const stats = getCampaignStats(DATA_DIR, id, cfg.sharedSkillsDir);
  const skills = listCampaignSkills(DATA_DIR, id, cfg.sharedSkillsDir);
  const gridMeta = readGridMetadata(DATA_DIR, id, cfg.sharedSkillsDir);
  return c.json({ campaign, manifest, stats, skills, gridMeta });
});

/**
 * Métadonnées de grille par campagne (questions hors-IA, barème max...).
 * Utilisé par l'UI pour adapter dynamiquement CriteresGrid et ReviewForm.
 * Si pas de campaignId : retourne celle de la campagne active.
 */
app.get("/api/grid-metadata", (c) => {
  const cfg = loadAppConfig(DATA_DIR);
  const id = c.req.query("campaignId");
  const meta = resolveGridMetadata(DATA_DIR, id, cfg.sharedSkillsDir);
  return c.json(meta);
});

app.put("/api/campaigns/:id/grid-metadata", async (c) => {
  const id = c.req.param("id");
  const cfg = loadAppConfig(DATA_DIR);
  if (!cfg.isAdmin) return c.json({ error: "réservé à l'admin" }, 403);
  const campaign = getCampaign(DATA_DIR, id, cfg.sharedSkillsDir);
  if (!campaign) return c.json({ error: "campagne introuvable" }, 404);
  if (campaign.status !== "draft") {
    return c.json({ error: "édition réservée aux brouillons" }, 400);
  }
  const body = (await c.req.json()) as Partial<GridMetadata>;
  const current =
    readGridMetadata(DATA_DIR, id, cfg.sharedSkillsDir) ??
    resolveGridMetadata(DATA_DIR, id, cfg.sharedSkillsDir);
  const next: GridMetadata = {
    ...current,
    ...body,
    version: current.version,
    generatedAt: new Date().toISOString(),
    source: "manual-edit",
  };
  writeGridMetadata(DATA_DIR, id, next, cfg.sharedSkillsDir);
  audit(c, {
    action: "campaign.grid_metadata.update",
    resource_type: "campaign",
    resource_id: id,
    result: "success",
    metadata: { patch: body },
  });
  return c.json(next);
});

app.post("/api/campaigns", async (c) => {
  const cfg = loadAppConfig(DATA_DIR);
  if (!cfg.isAdmin) {
    audit(c, {
      action: "campaign.create",
      resource_type: "campaign",
      result: "denied",
      reason: "user not admin",
    });
    return c.json({ error: "réservé à l'admin" }, 403);
  }
  const body = (await c.req.json()) as {
    id?: string;
    label?: string;
    basedOn?: string | null;
    dateOuverture?: string;
    dateCloture?: string;
    activate?: boolean;
  };
  if (!body.id || !body.label) {
    return c.json({ error: "champs 'id' et 'label' requis" }, 400);
  }
  try {
    const result = createCampaignModel(
      DATA_DIR,
      {
        id: body.id,
        label: body.label,
        basedOn: body.basedOn ?? null,
        dateOuverture: body.dateOuverture,
        dateCloture: body.dateCloture,
        activate: body.activate === true,
      },
      cfg.sharedSkillsDir
    );
    audit(c, {
      action: "campaign.create",
      resource_type: "campaign",
      resource_id: body.id,
      result: "success",
      metadata: {
        label: body.label,
        based_on: body.basedOn ?? null,
        activated: body.activate === true,
      },
    });
    return c.json(result, 201);
  } catch (err) {
    audit(c, {
      action: "campaign.create",
      resource_type: "campaign",
      resource_id: body.id,
      result: "failure",
      reason: (err as Error).message,
    });
    return c.json({ error: (err as Error).message }, 400);
  }
});

app.put("/api/campaigns/:id", async (c) => {
  const id = c.req.param("id");
  const cfg = loadAppConfig(DATA_DIR);
  if (!cfg.isAdmin) return c.json({ error: "réservé à l'admin" }, 403);
  const body = (await c.req.json()) as {
    label?: string;
    dateOuverture?: string;
    dateCloture?: string;
  };
  try {
    const updated = updateCampaignModel(DATA_DIR, id, body, cfg.sharedSkillsDir);
    audit(c, {
      action: "campaign.update",
      resource_type: "campaign",
      resource_id: id,
      result: "success",
      metadata: { patch: body },
    });
    return c.json({ campaign: updated });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

app.post("/api/campaigns/:id/activate", (c) => {
  const id = c.req.param("id");
  const cfg = loadAppConfig(DATA_DIR);
  if (!cfg.isAdmin) {
    audit(c, {
      action: "campaign.activate",
      resource_type: "campaign",
      resource_id: id,
      result: "denied",
      reason: "user not admin",
    });
    return c.json({ error: "réservé à l'admin" }, 403);
  }
  try {
    const result = activateCampaignModel(DATA_DIR, id, cfg.sharedSkillsDir);
    audit(c, {
      action: "campaign.activate",
      resource_type: "campaign",
      resource_id: id,
      result: "success",
      metadata: { archived: result.archivedId },
    });
    return c.json(result);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

app.post("/api/campaigns/:id/archive", (c) => {
  const id = c.req.param("id");
  const cfg = loadAppConfig(DATA_DIR);
  if (!cfg.isAdmin) return c.json({ error: "réservé à l'admin" }, 403);
  try {
    archiveCampaignModel(DATA_DIR, id, cfg.sharedSkillsDir);
    audit(c, {
      action: "campaign.archive",
      resource_type: "campaign",
      resource_id: id,
      result: "success",
    });
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

/**
 * Export d'une campagne en bundle ZIP. Réservé admin (lecture seule, mais
 * contient les skills qui sont sensibles).
 */
app.get("/api/campaigns/:id/export", async (c) => {
  const id = c.req.param("id");
  const cfg = loadAppConfig(DATA_DIR);
  if (!cfg.isAdmin) {
    audit(c, {
      action: "campaign.export",
      resource_type: "campaign",
      resource_id: id,
      result: "denied",
      reason: "user not admin",
    });
    return c.json({ error: "réservé à l'admin" }, 403);
  }
  const result = await exportCampaignToZip(DATA_DIR, id, cfg.sharedSkillsDir);
  if (!result) {
    audit(c, {
      action: "campaign.export",
      resource_type: "campaign",
      resource_id: id,
      result: "failure",
      reason: "campagne introuvable",
    });
    return c.json({ error: "campagne introuvable" }, 404);
  }
  audit(c, {
    action: "campaign.export",
    resource_type: "campaign",
    resource_id: id,
    result: "success",
    metadata: { size_bytes: result.buffer.length, filename: result.filename },
  });
  return new Response(new Uint8Array(result.buffer), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${result.filename}"`,
    },
  });
});

/**
 * Import d'un bundle ZIP. Crée une nouvelle campagne en draft.
 * Body : multipart/form-data avec un champ "file" (le ZIP).
 */
app.post("/api/campaigns/import", async (c) => {
  const cfg = loadAppConfig(DATA_DIR);
  if (!cfg.isAdmin) {
    audit(c, {
      action: "campaign.import",
      resource_type: "campaign",
      result: "denied",
      reason: "user not admin",
    });
    return c.json({ error: "réservé à l'admin" }, 403);
  }
  let buffer: Buffer;
  try {
    const form = await c.req.formData();
    const file = form.get("file");
    if (!file || !(file instanceof File)) {
      return c.json({ error: "champ 'file' (ZIP) manquant" }, 400);
    }
    const ab = await file.arrayBuffer();
    buffer = Buffer.from(ab);
  } catch (err) {
    return c.json({ error: `formdata illisible : ${(err as Error).message}` }, 400);
  }
  const desiredId = c.req.query("id");
  const desiredLabel = c.req.query("label");
  const result = await importCampaignFromZip(
    DATA_DIR,
    buffer,
    {
      desiredId: desiredId || undefined,
      desiredLabel: desiredLabel || undefined,
    },
    cfg.sharedSkillsDir
  );
  audit(c, {
    action: "campaign.import",
    resource_type: "campaign",
    resource_id: result.campaignId ?? "?",
    result: result.ok ? "success" : "failure",
    reason: result.reason,
    metadata: { warnings: result.warnings },
  });
  if (!result.ok) {
    return c.json({ error: result.reason }, 400);
  }
  return c.json({
    campaignId: result.campaignId,
    warnings: result.warnings ?? [],
  });
});

/**
 * Lecture du contenu raw d'un skill d'une campagne. Pour pré-remplir
 * l'éditeur. Réservé admin.
 */
app.get("/api/campaigns/:id/skills/:skillName{.+\\.md}", (c) => {
  const id = c.req.param("id");
  const skillName = c.req.param("skillName");
  const cfg = loadAppConfig(DATA_DIR);
  if (!cfg.isAdmin) return c.json({ error: "réservé à l'admin" }, 403);
  const result = readCampaignSkill(DATA_DIR, id, skillName, cfg.sharedSkillsDir);
  if (!result) return c.json({ error: "skill introuvable" }, 404);
  return c.json(result);
});

/**
 * Édition d'un skill d'une campagne (drafts uniquement). Réservé admin.
 */
app.put("/api/campaigns/:id/skills/:skillName{.+\\.md}", async (c) => {
  const id = c.req.param("id");
  const skillName = c.req.param("skillName");
  const cfg = loadAppConfig(DATA_DIR);
  if (!cfg.isAdmin) {
    audit(c, {
      action: "campaign.skill.edit",
      resource_type: "campaign_skill",
      resource_id: `${id}/${skillName}`,
      result: "denied",
      reason: "user not admin",
    });
    return c.json({ error: "réservé à l'admin" }, 403);
  }
  const body = (await c.req.json()) as { content?: string };
  if (typeof body.content !== "string") {
    return c.json({ error: "champ 'content' (string) requis" }, 400);
  }
  const result = writeCampaignSkill(
    DATA_DIR,
    id,
    skillName,
    body.content,
    cfg.sharedSkillsDir
  );
  audit(c, {
    action: "campaign.skill.edit",
    resource_type: "campaign_skill",
    resource_id: `${id}/${skillName}`,
    result: result.ok ? "success" : "failure",
    reason: result.reason,
    metadata: {
      new_hash: result.newHash,
      content_size: body.content.length,
    },
  });
  if (!result.ok) return c.json({ error: result.reason }, 400);
  return c.json({ ok: true, hash: result.newHash });
});

app.delete("/api/campaigns/:id", (c) => {
  const id = c.req.param("id");
  const cfg = loadAppConfig(DATA_DIR);
  if (!cfg.isAdmin) return c.json({ error: "réservé à l'admin" }, 403);
  try {
    deleteCampaignModel(DATA_DIR, id, cfg.sharedSkillsDir);
    audit(c, {
      action: "campaign.delete",
      resource_type: "campaign",
      resource_id: id,
      result: "success",
    });
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

app.get("/api/propositions", (c) => {
  const cfg = loadAppConfig(DATA_DIR);
  return c.json({ propositions: listPropositions(DATA_DIR, cfg.sharedSkillsDir) });
});

app.get("/api/propositions/:filename/preview", (c) => {
  const filename = c.req.param("filename");
  const cfg = loadAppConfig(DATA_DIR);
  const preview = previewProposition(DATA_DIR, filename, cfg.sharedSkillsDir);
  if (!preview) return c.json({ error: "proposition introuvable" }, 404);
  return c.json(preview);
});

app.post("/api/propositions/:filename/decide", async (c) => {
  const filename = c.req.param("filename");
  const body = (await c.req.json()) as {
    decision: "promouvoir" | "rejeter";
    admin: string;
    commentaire?: string;
  };
  if (!body.decision || !body.admin) {
    return c.json({ error: "champs 'decision' et 'admin' requis" }, 400);
  }
  const cfg = loadAppConfig(DATA_DIR);
  // Sécurité minimale : seul un admin peut décider
  if (!cfg.isAdmin) {
    audit(c, {
      action: "proposition.decide",
      resource_type: "proposition",
      resource_id: filename,
      result: "denied",
      reason: "user not admin",
      metadata: { decision: body.decision, attempted_by: body.admin },
    });
    return c.json({ error: "réservé à l'admin (cfg.isAdmin doit être true)" }, 403);
  }
  const newStatus = body.decision === "promouvoir" ? "promu" : "rejete";

  // Snapshot du skill global cible AVANT la promotion (pour pouvoir revert)
  let snapshotInfo: { targetSkill: string; snapshotPath: string } | null = null;
  if (body.decision === "promouvoir") {
    const propsList = listPropositions(DATA_DIR, cfg.sharedSkillsDir);
    const prop = propsList.find((p) => p.filename === filename);
    if (prop) {
      snapshotInfo = snapshotSkillBeforePromotion(
        DATA_DIR,
        filename,
        prop.affecte,
        cfg.sharedSkillsDir
      );
    }
  }

  const updated = updatePropositionStatus(
    DATA_DIR,
    filename,
    newStatus,
    body.admin,
    body.commentaire ?? "",
    cfg.sharedSkillsDir
  );
  if (!updated) return c.json({ error: "proposition introuvable" }, 404);

  // Si promotion, on lance Claude avec /promouvoir-regle pour qu'il édite le skill global
  if (body.decision === "promouvoir") {
    try {
      const composedPrompt = `/promouvoir-regle ${filename}\n\nAdmin: ${body.admin}\nCommentaire: ${body.commentaire ?? "(sans commentaire)"}`;
      // Lance le run en feu et oublie : l'UI verra le résultat dans skills/_global/ et _historique.jsonl
      const { startRun } = await import("./runs.js");
      startRun({
        prompt: composedPrompt,
        cwd: DATA_DIR,
        addDirs: buildAddDirs(DATA_DIR, loadAppConfig(DATA_DIR)),
        allowedTools: ["Read", "Write", "Edit", "Glob", "Grep", "Skill", "Task", "mcp__office__read_xlsx"],
        permissionMode: "bypassPermissions",
      });
    } catch (err) {
      console.warn("[promouvoir] échec lancement skill promouvoir-regle:", err);
    }
  }
  audit(c, {
    action: body.decision === "promouvoir" ? "proposition.promote" : "proposition.reject",
    resource_type: "proposition",
    resource_id: filename,
    result: "success",
    metadata: {
      affecte: updated.affecte ?? null,
      auteur: updated.auteur ?? null,
      admin: body.admin,
      commentaire: body.commentaire ?? null,
      snapshot: snapshotInfo,
    },
  });
  return c.json({ ok: true, proposition: updated, snapshot: snapshotInfo });
});

/**
 * Annule une promotion : restaure le skill global au snapshot pris avant
 * promotion, et marque la proposition comme rejetée. Réservé admin.
 * Utile en mode calibrage où des règles passent vite et certaines doivent
 * être révoquées.
 */
app.post("/api/propositions/:filename/revert", async (c) => {
  const filename = c.req.param("filename");
  const body = (await c.req.json()) as {
    admin: string;
    commentaire?: string;
  };
  if (!body.admin) return c.json({ error: "champ 'admin' requis" }, 400);
  const cfg = loadAppConfig(DATA_DIR);
  if (!cfg.isAdmin) {
    audit(c, {
      action: "proposition.revert",
      resource_type: "proposition",
      resource_id: filename,
      result: "denied",
      reason: "user not admin",
    });
    return c.json({ error: "réservé à l'admin" }, 403);
  }
  const result = revertPromotion(
    DATA_DIR,
    filename,
    body.admin,
    body.commentaire ?? "",
    cfg.sharedSkillsDir
  );
  audit(c, {
    action: "proposition.revert",
    resource_type: "proposition",
    resource_id: filename,
    result: result.ok ? "success" : "failure",
    reason: result.reason,
    metadata: {
      admin: body.admin,
      commentaire: body.commentaire ?? null,
      restored_skill: result.restoredSkill ?? null,
    },
  });
  if (!result.ok) {
    return c.json({ error: result.reason ?? "revert impossible" }, 400);
  }
  return c.json({ ok: true, restoredSkill: result.restoredSkill });
});

app.post("/api/export-xlsx", async (c) => {
  const body = (await c.req.json()) as { dossier_ids?: string[] };
  const ids = body?.dossier_ids ?? [];
  if (!Array.isArray(ids) || ids.length === 0) {
    return c.json({ error: "dossier_ids requis" }, 400);
  }
  try {
    const buf = await buildExportXlsx(DATA_DIR, ids);
    audit(c, {
      action: "export.xlsx",
      resource_type: "export",
      resource_label: `${ids.length} dossiers`,
      result: "success",
      metadata: { dossier_ids: ids, size_bytes: buf.length },
    });
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="oif-eval-${new Date().toISOString().slice(0,10)}.xlsx"`,
      },
    });
  } catch (err) {
    audit(c, {
      action: "export.xlsx",
      resource_type: "export",
      result: "failure",
      reason: (err as Error).message,
      metadata: { dossier_ids: ids },
    });
    return c.json({ error: (err as Error).message }, 500);
  }
});

/**
 * Override par un humain de la note IA d'une question (ou statut ELG).
 * L'opérateur n'est pas d'accord avec Claude → il met sa note + sa raison.
 * Trace en journal RGPD.
 */
app.post("/api/evaluations/:id/override", async (c) => {
  const id = c.req.param("id");
  const path = resolveEvalPath(id);
  if (!path) return c.json({ error: "non trouvée" }, 404);
  const body = (await c.req.json()) as {
    type: "question" | "eligibilite";
    question_id?: number;
    critere_id?: string;
    score_human?: number;
    statut_human?: string;
    raison: string;
    par?: string;
  };
  if (!body.raison || !body.raison.trim()) {
    return c.json({ error: "raison obligatoire pour un override" }, 400);
  }
  const cfg = loadAppConfig(DATA_DIR);
  const par = body.par || cfg.currentUser || "anonyme";
  const fs = await import("node:fs/promises");
  const content = await fs.readFile(path, "utf8");
  let data: {
    review?: {
      overrides_ia?: unknown[];
      overrides_eligibilite?: unknown[];
      [k: string]: unknown;
    };
    phase_notation?: { questions?: { id: number; score: number | null }[] };
    phase_eligibilite?: { criteres?: { id: string; statut: string }[] };
    [k: string]: unknown;
  };
  try {
    data = JSON.parse(content);
  } catch {
    return c.json({ error: "JSON corrompu" }, 500);
  }
  if (!data.review) data.review = {};
  const now = new Date().toISOString();

  if (body.type === "question") {
    if (typeof body.question_id !== "number" || typeof body.score_human !== "number") {
      return c.json({ error: "question_id et score_human requis" }, 400);
    }
    const scoreIa =
      data.phase_notation?.questions?.find((q) => q.id === body.question_id)?.score ?? null;
    const arr = (data.review.overrides_ia ?? []) as {
      question_id: number;
      [k: string]: unknown;
    }[];
    // Remplace l'override existant ou ajoute
    const filtered = arr.filter((o) => o.question_id !== body.question_id);
    filtered.push({
      question_id: body.question_id,
      score_ia: scoreIa,
      score_human: body.score_human,
      raison: body.raison.trim(),
      par,
      le: now,
    });
    data.review.overrides_ia = filtered;
  } else if (body.type === "eligibilite") {
    if (!body.critere_id || !body.statut_human) {
      return c.json({ error: "critere_id et statut_human requis" }, 400);
    }
    const statutIa =
      data.phase_eligibilite?.criteres?.find((cri) => cri.id === body.critere_id)?.statut ??
      null;
    const arr = (data.review.overrides_eligibilite ?? []) as {
      critere_id: string;
      [k: string]: unknown;
    }[];
    const filtered = arr.filter((o) => o.critere_id !== body.critere_id);
    filtered.push({
      critere_id: body.critere_id,
      statut_ia: statutIa,
      statut_human: body.statut_human,
      raison: body.raison.trim(),
      par,
      le: now,
    });
    data.review.overrides_eligibilite = filtered;
  } else {
    return c.json({ error: "type doit être 'question' ou 'eligibilite'" }, 400);
  }

  await fs.writeFile(path, JSON.stringify(data, null, 2), "utf8");
  audit(c, {
    action: "evaluation.override",
    resource_type: "evaluation",
    resource_id: id,
    result: "success",
    metadata: {
      type: body.type,
      target: body.type === "question" ? body.question_id : body.critere_id,
      raison: body.raison,
      par,
    },
  });
  return c.json({ ok: true, evaluation: data });
});

/**
 * Annule un override (par question_id ou critere_id).
 */
app.delete("/api/evaluations/:id/override", async (c) => {
  const id = c.req.param("id");
  const path = resolveEvalPath(id);
  if (!path) return c.json({ error: "non trouvée" }, 404);
  const body = (await c.req.json()) as {
    type: "question" | "eligibilite";
    question_id?: number;
    critere_id?: string;
  };
  const fs = await import("node:fs/promises");
  const content = await fs.readFile(path, "utf8");
  let data: {
    review?: {
      overrides_ia?: { question_id: number; [k: string]: unknown }[];
      overrides_eligibilite?: { critere_id: string; [k: string]: unknown }[];
      [k: string]: unknown;
    };
    [k: string]: unknown;
  };
  try {
    data = JSON.parse(content);
  } catch {
    return c.json({ error: "JSON corrompu" }, 500);
  }
  if (!data.review) data.review = {};
  if (body.type === "question" && typeof body.question_id === "number") {
    data.review.overrides_ia = (data.review.overrides_ia ?? []).filter(
      (o) => o.question_id !== body.question_id
    );
  } else if (body.type === "eligibilite" && body.critere_id) {
    data.review.overrides_eligibilite = (data.review.overrides_eligibilite ?? []).filter(
      (o) => o.critere_id !== body.critere_id
    );
  } else {
    return c.json({ error: "paramètres invalides" }, 400);
  }
  await fs.writeFile(path, JSON.stringify(data, null, 2), "utf8");
  audit(c, {
    action: "evaluation.override.remove",
    resource_type: "evaluation",
    resource_id: id,
    result: "success",
    metadata: {
      type: body.type,
      target: body.type === "question" ? body.question_id : body.critere_id,
    },
  });
  return c.json({ ok: true, evaluation: data });
});

app.put("/api/evaluations/:id/review", async (c) => {
  const id = c.req.param("id");
  const path = resolveEvalPath(id);
  if (!path) return c.json({ error: "non trouvée" }, 404);
  const body = await c.req.json();
  const fs = await import("node:fs/promises");
  const content = await fs.readFile(path, "utf8");
  let data: any;
  try {
    data = JSON.parse(content);
  } catch {
    return c.json({ error: "JSON corrompu" }, 500);
  }
  data.review = { ...(data.review ?? {}), ...body };
  await fs.writeFile(path, JSON.stringify(data, null, 2), "utf8");
  audit(c, {
    action: "evaluation.review.update",
    resource_type: "evaluation",
    resource_id: id,
    result: "success",
    metadata: {
      validee_par: data.review?.validee_par ?? null,
      keys_changed: Object.keys(body),
    },
  });
  return c.json({ ok: true, evaluation: data });
});

/**
 * Auto-création d'un dossier partagé OIF avec toute la structure attendue.
 * L'admin choisit un dossier racine, on crée les sous-dossiers (skills,
 * audit-log, evaluations) et on remplit les chemins individuels dans la
 * config. Pratique sur un serveur partagé OIF où tous les évaluateurs
 * pointent vers la même racine.
 */
app.post("/api/setup-shared-dir", async (c) => {
  const body = (await c.req.json()) as {
    rootDir?: string;
    setOutputDir?: boolean;
    setAuditLogDir?: boolean;
    setSharedSkillsDir?: boolean;
    setInputDir?: boolean;
    /** Prénom de l'utilisateur, pour créer son sous-dossier candidatures/<slug>/
     *  (sa propre charge de travail). Si absent, fallback sur cfg.currentUser. */
    currentUser?: string;
  };
  const rootDir = body.rootDir?.trim();
  if (!rootDir) {
    return c.json({ error: "rootDir requis" }, 400);
  }
  // Slug du prénom pour le dossier candidatures/<slug>/ : lowercase, sans
  // accents, espaces remplacés par tirets. "Nicolas Cléton" → "nicolas-cleton".
  const slugifyUser = (s: string): string =>
    s
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
  const cfgCurrent = loadAppConfig(DATA_DIR);
  const userName = body.currentUser?.trim() || cfgCurrent.currentUser || "";
  const userSlug = slugifyUser(userName);
  const fs = await import("node:fs");
  const path = await import("node:path");
  let absRoot: string;
  try {
    absRoot = path.resolve(rootDir);
    fs.mkdirSync(absRoot, { recursive: true });
  } catch (err) {
    return c.json(
      { error: `impossible de créer le dossier racine : ${(err as Error).message}` },
      500
    );
  }

  const created: string[] = [];
  const subdirs = [
    "skills",
    "skills/campaigns",
    "audit-log",
    "evaluations",
    "candidatures",
    "calibrage",
    "calibrage/imports",
  ];
  // Sous-dossier candidatures/<user>/ : la charge de travail propre à cet
  // opérateur. L'admin dépose ici les candidatures qu'il attribue à cette
  // personne. Chaque opérateur a son propre sous-dossier ; les evaluations,
  // skills, audit-log restent partagés au niveau racine.
  if (userSlug) {
    subdirs.push("candidatures/" + userSlug);
  }
  for (const sub of subdirs) {
    const p = path.resolve(absRoot, sub);
    if (!fs.existsSync(p)) {
      fs.mkdirSync(p, { recursive: true });
      created.push(sub);
    }
  }

  // Copier les skills templates + structure campagnes vers le dossier de l'utilisateur
  // (sans écraser si déjà présent : c'est un init, pas un reset)
  const copiedSkills: string[] = [];
  try {
    const repoRoot = path.resolve(import.meta.dirname ?? __dirname, "..");
    // 1. Copier la structure campaigns/ (avec fae-7e officiel + _index.json) si pas déjà là
    const srcCampaigns = path.resolve(repoRoot, "data", ".claude", "skills", "campaigns");
    const dstCampaigns = path.resolve(absRoot, "skills", "campaigns");
    if (fs.existsSync(srcCampaigns) && !fs.existsSync(path.resolve(dstCampaigns, "_index.json"))) {
      fs.cpSync(srcCampaigns, dstCampaigns, { recursive: true });
      copiedSkills.push("campaigns/");
    }
    // 2. Copier le _global (skills hors-campagne : ameliorer-mes-regles, etc.)
    const srcGlobal = path.resolve(repoRoot, "skills-template", "_global");
    const dstGlobal = path.resolve(absRoot, "skills", "_global");
    if (fs.existsSync(srcGlobal) && !fs.existsSync(dstGlobal)) {
      fs.cpSync(srcGlobal, dstGlobal, { recursive: true });
      copiedSkills.push("_global/");
    }
    // 3. Copier les schemas + hooks + CLAUDE.md (config Claude Code) si absents
    const srcClaude = path.resolve(repoRoot, "data-template", ".claude");
    const dstClaude = path.resolve(absRoot, ".claude");
    if (fs.existsSync(srcClaude) && !fs.existsSync(dstClaude)) {
      fs.cpSync(srcClaude, dstClaude, { recursive: true });
      copiedSkills.push(".claude/ (schemas, hooks, CLAUDE.md)");
    }
  } catch (err) {
    // Non-bloquant : si la copie échoue, on log mais on continue avec la config
    console.warn(`setup-shared-dir : copie skills échouée: ${(err as Error).message}`);
  }

  // Patch config : on remplit TOUS les chemins par défaut pour que l'app
  // n'utilise plus DATA_DIR (le repo) mais uniquement le dossier choisi.
  const patch: {
    sharedSkillsDir?: string;
    auditLogDir?: string;
    outputDir?: string;
    inputDir?: string;
  } = {};
  if (body.setSharedSkillsDir !== false)
    patch.sharedSkillsDir = path.resolve(absRoot, "skills");
  if (body.setAuditLogDir !== false)
    patch.auditLogDir = path.resolve(absRoot, "audit-log");
  if (body.setOutputDir !== false)
    patch.outputDir = path.resolve(absRoot, "evaluations");
  if (body.setInputDir !== false) {
    // inputDir = sous-dossier propre à l'opérateur si on a son nom, sinon
    // racine "candidatures/" (rétro-compat / cas sans user défini).
    patch.inputDir = userSlug
      ? path.resolve(absRoot, "candidatures", userSlug)
      : path.resolve(absRoot, "candidatures");
  }

  const updated = saveAppConfig(DATA_DIR, patch);

  // Assure que campaigns/_index.json existe dans le nouveau sharedSkillsDir.
  // Sans ça, /api/campaigns POST échoue avec "campaigns/_index.json absent.
  // Migration boot non faite." parce que la migration boot tourne au démarrage
  // du daemon avec l'ancien sharedSkillsDir (ou aucun), et ne sait pas qu'on
  // vient de pointer vers un nouveau dossier.
  try {
    if (patch.sharedSkillsDir) {
      const newShared = patch.sharedSkillsDir;
      // 1. Tente d'exécuter la vraie migration sur le nouveau dossier (copie
      //    legacy → campaigns/<fae-7e>/ + manifest + schema + _index.json).
      //    Idempotent : si déjà fait, retourne skipped_existing.
      const { ensureCampaignsLayout } = await import("./campaigns-migration.js");
      const migResult = ensureCampaignsLayout(DATA_DIR, newShared);
      // 2. Filet de sécurité : si la migration n'a rien fait (dossier fraîchement
      //    créé sans legacy à migrer), créer manuellement un _index.json minimal
      //    pour que /api/campaigns POST fonctionne.
      const idxFile = path.resolve(newShared, "campaigns", "_index.json");
      if (!fs.existsSync(idxFile)) {
        fs.mkdirSync(path.dirname(idxFile), { recursive: true });
        const emptyIdx = {
          version: 1,
          campaigns: [],
          activeId: null,
          layoutV1Confirmed: true,
        };
        fs.writeFileSync(idxFile, JSON.stringify(emptyIdx, null, 2), "utf8");
      }
      copiedSkills.push(`migration:${migResult.status}`);
    }
  } catch (err) {
    console.warn(
      `setup-shared-dir : init _index.json échouée: ${(err as Error).message}`
    );
  }
  audit(c, {
    action: "config.setup_shared_dir",
    resource_type: "app_config",
    resource_id: "global",
    result: "success",
    metadata: {
      root_dir: absRoot,
      created_subdirs: created,
      copied_skills: copiedSkills,
      applied_patch: patch,
    },
  });

  return c.json({
    rootDir: absRoot,
    createdSubdirs: [...created, ...copiedSkills],
    config: updated,
  });
});

/**
 * Détection du type de dossier choisi (OneDrive/SharePoint/Dropbox/SMB/local)
 * + check du sync engine. Permet à l'UI d'afficher un badge intelligent et un
 * warning si le sync engine n'est pas en train de tourner.
 */
app.get("/api/storage/detect", async (c) => {
  const { detectStorageType, checkSyncHealth } = await import("./storage-mode.js");
  const path = c.req.query("path");
  if (!path) return c.json({ error: "param 'path' requis" }, 400);
  const detection = detectStorageType(path);
  const health = checkSyncHealth(detection.type);
  return c.json({ detection, health });
});

/**
 * Liste les "conflict copies" laissées par les sync engines dans le dossier
 * partagé. À appeler au démarrage et de temps en temps pour alerter l'utilisateur.
 */
app.get("/api/storage/conflicts", async (c) => {
  const { findConflictCopies } = await import("./storage-mode.js");
  const cfg = loadAppConfig(DATA_DIR);
  const root =
    c.req.query("path") ?? cfg.sharedSkillsDir ?? cfg.outputDir ?? cfg.auditLogDir;
  if (!root) return c.json({ conflicts: [] });
  const conflicts = findConflictCopies(root);
  return c.json({ conflicts });
});

/**
 * Export du pack admin (skills + propositions de la campagne active).
 * À diffuser aux évaluateurs en mode autonome (Teams/email/clé USB).
 */
app.get("/api/sync-bundles/admin-pack", async (c) => {
  const { buildAdminPack } = await import("./sync-bundles.js");
  const cfg = loadAppConfig(DATA_DIR);
  if (!cfg.isAdmin) return c.json({ error: "réservé admin" }, 403);
  const user = cfg.currentUser ?? "admin";
  const result = await buildAdminPack({
    dataDir: DATA_DIR,
    sharedSkillsDir: cfg.sharedSkillsDir,
    sourceUser: user,
  });
  audit(c, {
    action: "sync_bundle.export_admin_pack",
    resource_type: "sync_bundle",
    resource_id: result.filename,
    result: "success",
  });
  return new Response(new Uint8Array(result.buffer), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${result.filename}"`,
    },
  });
});

/**
 * Import d'un pack admin reçu (côté évaluateur).
 * Met à jour les skills locaux et les propositions actives.
 */
app.post("/api/sync-bundles/admin-pack/import", async (c) => {
  const { previewImport, applyImport } = await import("./sync-bundles.js");
  const formData = await c.req.formData();
  const file = formData.get("file");
  if (!file || typeof file === "string") {
    return c.json({ error: "fichier .zip requis (champ 'file')" }, 400);
  }
  const buf = Buffer.from(await (file as File).arrayBuffer());
  const cfg = loadAppConfig(DATA_DIR);
  const dryRun = formData.get("dryRun") === "1";
  const overwrite = formData.get("overwrite") === "1";
  if (dryRun) {
    const preview = await previewImport(buf, {
      dataDir: DATA_DIR,
      sharedSkillsDir: cfg.sharedSkillsDir,
      outputDir: cfg.outputDir,
    });
    return c.json(preview);
  }
  const result = await applyImport(buf, {
    dataDir: DATA_DIR,
    sharedSkillsDir: cfg.sharedSkillsDir,
    outputDir: cfg.outputDir,
    overwrite,
  });
  audit(c, {
    action: "sync_bundle.import_admin_pack",
    resource_type: "sync_bundle",
    resource_id: result.manifest?.source_user ?? "unknown",
    result: result.ok ? "success" : "failure",
    metadata: {
      imported: result.imported,
      skipped: result.skipped,
      warnings: result.warnings,
    },
  });
  return c.json(result);
});

/**
 * Export du pack évaluations (côté évaluateur).
 * Embarque ses .json finalisés + ses entrées d'audit.
 */
app.get("/api/sync-bundles/evaluations-pack", async (c) => {
  const { buildEvaluationsPack, previewEvaluationsPack } = await import(
    "./sync-bundles.js"
  );
  const cfg = loadAppConfig(DATA_DIR);
  const user = cfg.currentUser ?? "anonyme";
  const previewOnly = c.req.query("preview") === "1";
  if (previewOnly) {
    const preview = previewEvaluationsPack({
      dataDir: DATA_DIR,
      outputDir: cfg.outputDir,
      sharedDir: cfg.sharedSkillsDir,
      user,
    });
    return c.json(preview);
  }
  const result = await buildEvaluationsPack({
    dataDir: DATA_DIR,
    outputDir: cfg.outputDir,
    sharedDir: cfg.sharedSkillsDir,
    sourceUser: user,
  });
  audit(c, {
    action: "sync_bundle.export_evaluations_pack",
    resource_type: "sync_bundle",
    resource_id: result.filename,
    result: "success",
    metadata: { evaluations_count: result.count },
  });
  return new Response(new Uint8Array(result.buffer), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${result.filename}"`,
    },
  });
});

/**
 * Import d'un pack évaluations (côté admin).
 * Merge les évaluations dans le data central.
 */
app.post("/api/sync-bundles/evaluations-pack/import", async (c) => {
  const { previewImport, applyImport } = await import("./sync-bundles.js");
  const cfg = loadAppConfig(DATA_DIR);
  if (!cfg.isAdmin) return c.json({ error: "réservé admin" }, 403);
  const formData = await c.req.formData();
  const file = formData.get("file");
  if (!file || typeof file === "string") {
    return c.json({ error: "fichier .zip requis (champ 'file')" }, 400);
  }
  const buf = Buffer.from(await (file as File).arrayBuffer());
  const dryRun = formData.get("dryRun") === "1";
  const overwrite = formData.get("overwrite") === "1";
  if (dryRun) {
    const preview = await previewImport(buf, {
      dataDir: DATA_DIR,
      sharedSkillsDir: cfg.sharedSkillsDir,
      outputDir: cfg.outputDir,
    });
    return c.json(preview);
  }
  const result = await applyImport(buf, {
    dataDir: DATA_DIR,
    sharedSkillsDir: cfg.sharedSkillsDir,
    outputDir: cfg.outputDir,
    overwrite,
  });
  audit(c, {
    action: "sync_bundle.import_evaluations_pack",
    resource_type: "sync_bundle",
    resource_id: result.manifest?.source_user ?? "unknown",
    result: result.ok ? "success" : "failure",
    metadata: {
      imported: result.imported,
      skipped: result.skipped,
      warnings: result.warnings,
    },
  });
  return c.json(result);
});

/**
 * Dashboard admin : avancement par opérateur.
 */
app.get("/api/dashboard/operators", async (c) => {
  const cfg = loadAppConfig(DATA_DIR);
  if (!cfg.isAdmin) return c.json({ error: "réservé admin" }, 403);
  const { computeDashboard } = await import("./dashboard.js");
  const summary = computeDashboard(DATA_DIR, {
    inputDir: cfg.inputDir,
    outputDir: cfg.outputDir,
    fallbackOwner: cfg.currentUser ?? undefined,
  });
  return c.json(summary);
});

app.get("/api/dashboard/operators/:operator/dossiers", async (c) => {
  const cfg = loadAppConfig(DATA_DIR);
  if (!cfg.isAdmin) return c.json({ error: "réservé admin" }, 403);
  const operator = c.req.param("operator");
  const { listDossiersForOperator } = await import("./dashboard.js");
  const dossiers = listDossiersForOperator(DATA_DIR, operator, {
    inputDir: cfg.inputDir,
    outputDir: cfg.outputDir,
    fallbackOwner: cfg.currentUser ?? undefined,
  });
  return c.json({ operator, dossiers });
});

/**
 * Rapports de calibrage : liste, détail JSON, génération de propositions.
 * Réservés admin (les rapports révèlent les biais des skills).
 */
app.get("/api/calibrage/reports", (c) => {
  const cfg = loadAppConfig(DATA_DIR);
  if (!cfg.isAdmin) return c.json({ error: "réservé à l'admin" }, 403);
  const reports = listCalibrageReports(DATA_DIR);
  return c.json({ reports });
});

app.get("/api/calibrage/reports/:filename", (c) => {
  const cfg = loadAppConfig(DATA_DIR);
  if (!cfg.isAdmin) return c.json({ error: "réservé à l'admin" }, 403);
  const filename = c.req.param("filename");
  const json = getCalibrageReportJson(DATA_DIR, filename);
  const markdown = getCalibrageReportMarkdown(DATA_DIR, filename);
  if (!json && !markdown) {
    return c.json({ error: "rapport introuvable" }, 404);
  }
  return c.json({ json, markdown });
});

/**
 * Suppression d'un rapport (md + json). Admin only. Trace RGPD.
 */
app.delete("/api/calibrage/reports/:filename", (c) => {
  const cfg = loadAppConfig(DATA_DIR);
  if (!cfg.isAdmin) {
    audit(c, {
      action: "calibrage.delete_report",
      resource_type: "calibrage_report",
      result: "denied",
      reason: "user not admin",
    });
    return c.json({ error: "réservé à l'admin" }, 403);
  }
  const filename = c.req.param("filename");
  const ok = deleteCalibrageReport(DATA_DIR, filename);
  if (!ok) {
    audit(c, {
      action: "calibrage.delete_report",
      resource_type: "calibrage_report",
      resource_id: filename,
      result: "failure",
      reason: "not_found",
    });
    return c.json({ error: "rapport introuvable" }, 404);
  }
  audit(c, {
    action: "calibrage.delete_report",
    resource_type: "calibrage_report",
    resource_id: filename,
    result: "success",
  });
  return c.json({ deleted: true });
});

/**
 * Lance un calibrage stratifié en background. Admin only.
 * Refuse si un calibrage tourne déjà (verrou en mémoire + sur disque).
 * Retourne { runId } ; les events sont consommés via SSE sur
 * /api/calibrage/runs/:runId/stream.
 */
app.post("/api/calibrage/start", async (c) => {
  const cfg = loadAppConfig(DATA_DIR);
  if (!cfg.isAdmin) {
    audit(c, {
      action: "calibrage.start",
      resource_type: "calibrage_run",
      result: "denied",
      reason: "user not admin",
    });
    return c.json({ error: "réservé à l'admin" }, 403);
  }
  if (isCalibrageRunning(DATA_DIR)) {
    audit(c, {
      action: "calibrage.start",
      resource_type: "calibrage_run",
      result: "denied",
      reason: "already_running",
    });
    return c.json({ error: "already_running" }, 409);
  }
  // Body : { importId } obligatoire (le mode 6e figé est supprimé).
  let body: { importId?: string; modeCompat?: boolean } = {}; // DEBUG modeCompat
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const importId = body.importId;
  if (!importId || typeof importId !== "string") {
    audit(c, {
      action: "calibrage.start",
      resource_type: "calibrage_run",
      result: "failure",
      reason: "import requis",
    });
    return c.json(
      {
        error:
          "Un bundle de calibrage importé est obligatoire. Importer un fichier ZIP avant de lancer.",
      },
      400
    );
  }
  // Vérifie que l'import existe
  const imp = getCalibrageImport(DATA_DIR, importId);
  if (!imp) {
    audit(c, {
      action: "calibrage.start",
      resource_type: "calibrage_run",
      result: "failure",
      reason: "import introuvable",
      metadata: { importId },
    });
    return c.json({ error: "Bundle importé introuvable." }, 404);
  }
  try {
    const { runId } = startCalibrage(DATA_DIR, { importId, modeCompat: body.modeCompat }); // DEBUG modeCompat
    audit(c, {
      action: "calibrage.start",
      resource_type: "calibrage_run",
      resource_id: runId,
      result: "success",
      metadata: { importId, totalDossiers: imp.totalDossiers },
    });
    return c.json({ runId, started: true }, 201);
  } catch (err) {
    audit(c, {
      action: "calibrage.start",
      resource_type: "calibrage_run",
      result: "failure",
      reason: (err as Error).message,
    });
    return c.json({ error: (err as Error).message }, 500);
  }
});

/**
 * Annule un calibrage en cours. Admin only.
 */
app.post("/api/calibrage/runs/:runId/cancel", (c) => {
  const cfg = loadAppConfig(DATA_DIR);
  if (!cfg.isAdmin) return c.json({ error: "réservé à l'admin" }, 403);
  const runId = c.req.param("runId");
  const ok = cancelCalibrage(runId);
  audit(c, {
    action: "calibrage.cancel",
    resource_type: "calibrage_run",
    resource_id: runId,
    result: ok ? "success" : "failure",
    reason: ok ? undefined : "run non annulable",
  });
  if (!ok) return c.json({ error: "run non annulable" }, 400);
  return c.json({ cancelled: true });
});

/**
 * Import d'un bundle ZIP pour calibrage. Admin only.
 * Multipart, champ "file" = ZIP. Le ZIP contient un xlsx (notes humaines) et
 * un dossier "dossiers/" avec un sous-dossier PDF par référence.
 */
app.post("/api/calibrage/imports", async (c) => {
  const cfg = loadAppConfig(DATA_DIR);
  if (!cfg.isAdmin) {
    audit(c, {
      action: "calibrage.import",
      resource_type: "calibrage_import",
      result: "denied",
      reason: "user not admin",
    });
    return c.json({ error: "réservé à l'admin" }, 403);
  }

  let buffer: Buffer;
  let filename: string;
  try {
    const form = await c.req.formData();
    const file = form.get("file");
    if (!file || !(file instanceof File)) {
      return c.json({ error: "champ 'file' manquant (ZIP attendu)" }, 400);
    }
    filename = file.name || "bundle.zip";
    const ab = await file.arrayBuffer();
    buffer = Buffer.from(ab);
  } catch (err) {
    return c.json(
      { error: `formdata illisible : ${(err as Error).message}` },
      400
    );
  }

  try {
    const result = await importBundle(DATA_DIR, buffer, filename, cfg.sharedSkillsDir);
    if (!result.ok) {
      audit(c, {
        action: "calibrage.import",
        resource_type: "calibrage_import",
        result: "failure",
        reason: result.error,
        metadata: { filename, size: buffer.length },
      });
      return c.json({ error: result.error, warnings: result.warnings ?? [] }, 400);
    }
    audit(c, {
      action: "calibrage.import",
      resource_type: "calibrage_import",
      resource_id: result.data.importId,
      result: "success",
      metadata: {
        filename,
        size: buffer.length,
        totalDossiers: result.data.totalDossiers,
        warnings: result.data.warnings.length,
      },
    });
    return c.json(result.data, 201);
  } catch (err) {
    audit(c, {
      action: "calibrage.import",
      resource_type: "calibrage_import",
      result: "failure",
      reason: (err as Error).message,
      metadata: { filename, size: buffer.length },
    });
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.get("/api/calibrage/imports", (c) => {
  const cfg = loadAppConfig(DATA_DIR);
  if (!cfg.isAdmin) return c.json({ error: "réservé à l'admin" }, 403);
  return c.json({ imports: listCalibrageImports(DATA_DIR) });
});

app.get("/api/calibrage/imports/:id", (c) => {
  const cfg = loadAppConfig(DATA_DIR);
  if (!cfg.isAdmin) return c.json({ error: "réservé à l'admin" }, 403);
  const id = c.req.param("id");
  const imp = getCalibrageImport(DATA_DIR, id);
  if (!imp) return c.json({ error: "import introuvable" }, 404);
  return c.json(imp);
});

/**
 * Override admin du mapping colonnes xlsx -> Q skill pour un import.
 * Body : { mapping: { "col_<N>": <qId> | null, ... } }. Patch le manifest
 * en place, conserve les scores xlsx, juste réoriente vers une autre Q
 * (ou désactive le mapping). Idempotent : si rien ne change, renvoie le
 * manifest tel quel.
 */
app.post("/api/calibrage/imports/:id/mapping", async (c) => {
  const cfg = loadAppConfig(DATA_DIR);
  if (!cfg.isAdmin) {
    audit(c, {
      action: "calibrage.import.mapping",
      resource_type: "calibrage_import",
      result: "denied",
      reason: "user not admin",
    });
    return c.json({ error: "réservé à l'admin" }, 403);
  }
  const id = c.req.param("id");
  let body: { mapping?: Record<string, number | null> };
  try {
    body = (await c.req.json()) as {
      mapping?: Record<string, number | null>;
    };
  } catch {
    return c.json({ error: "JSON body invalide" }, 400);
  }
  const overrides = body?.mapping ?? {};
  if (typeof overrides !== "object" || Array.isArray(overrides)) {
    return c.json(
      { error: "champ 'mapping' attendu (objet col_<N> -> qId|null)" },
      400
    );
  }
  const result = updateCalibrageImportMapping(DATA_DIR, id, overrides);
  if (!result.ok) {
    audit(c, {
      action: "calibrage.import.mapping",
      resource_type: "calibrage_import",
      resource_id: id,
      result: "failure",
      reason: result.error,
    });
    return c.json({ error: result.error }, 400);
  }
  audit(c, {
    action: "calibrage.import.mapping",
    resource_type: "calibrage_import",
    resource_id: id,
    result: "success",
    metadata: { changed: Object.keys(overrides).length },
  });
  return c.json(result.data);
});

app.delete("/api/calibrage/imports/:id", (c) => {
  const cfg = loadAppConfig(DATA_DIR);
  if (!cfg.isAdmin) {
    audit(c, {
      action: "calibrage.import.delete",
      resource_type: "calibrage_import",
      result: "denied",
      reason: "user not admin",
    });
    return c.json({ error: "réservé à l'admin" }, 403);
  }
  const id = c.req.param("id");
  const ok = deleteCalibrageImport(DATA_DIR, id);
  audit(c, {
    action: "calibrage.import.delete",
    resource_type: "calibrage_import",
    resource_id: id,
    result: ok ? "success" : "failure",
    reason: ok ? undefined : "not_found",
  });
  if (!ok) return c.json({ error: "import introuvable" }, 404);
  return c.json({ deleted: true });
});

/**
 * Génère un xlsx vide aux colonnes attendues. Public (pas d'admin requis :
 * c'est un template). Stream binaire.
 */
app.get("/api/calibrage/template.xlsx", async (c) => {
  const buf = await generateCalibrageTemplate();
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="template-calibrage.xlsx"`,
    },
  });
});

/**
 * Calibrage actuellement en cours (s'il y en a un). Doit être déclaré AVANT
 * `/runs/:runId` sinon Hono matche "current" comme un runId. Permet à l'UI
 * de récupérer le run après reload de la page ou changement d'onglet.
 */
app.get("/api/calibrage/runs/current", (c) => {
  const cfg = loadAppConfig(DATA_DIR);
  if (!cfg.isAdmin) return c.json({ error: "réservé à l'admin" }, 403);
  const r = getCurrentCalibrageRun();
  return c.json({ run: r });
});

/**
 * État courant d'un run de calibrage (status + progression).
 */
app.get("/api/calibrage/runs/:runId", (c) => {
  const cfg = loadAppConfig(DATA_DIR);
  if (!cfg.isAdmin) return c.json({ error: "réservé à l'admin" }, 403);
  const runId = c.req.param("runId");
  const r = getCalibrageRun(runId);
  if (!r) return c.json({ error: "run introuvable" }, 404);
  return c.json(r);
});

/**
 * SSE des events d'un run de calibrage. Replay des lignes déjà émises +
 * stream live. Frame `event: end` à la fin.
 */
app.get("/api/calibrage/runs/:runId/stream", (c) => {
  const cfg = loadAppConfig(DATA_DIR);
  if (!cfg.isAdmin) return c.json({ error: "réservé à l'admin" }, 403);
  const runId = c.req.param("runId");
  // Helper : nom d'event SSE en fonction du kind. progress = event dédié pour
  // que le client puisse parser sans avoir à inspecter le payload.
  function eventName(kind: string): string {
    if (kind === "end") return "end";
    if (kind === "progress") return "progress";
    return "calibrage";
  }
  return streamSSE(c, async (stream) => {
    const handle = attachCalibrageListener(runId, async (ev) => {
      await stream.writeSSE({
        event: eventName(ev.kind),
        data: JSON.stringify(ev),
      });
    });
    if (!handle) {
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ error: "run introuvable" }),
      });
      return;
    }
    for (const ev of handle.replay) {
      await stream.writeSSE({
        event: eventName(ev.kind),
        data: JSON.stringify(ev),
      });
    }
    await waitForCalibrage(runId);
    // Si le replay contenait déjà l'event end on le renvoie pas (déjà fait
    // dans la boucle), sinon on signale la fin proprement.
    const last = handle.replay[handle.replay.length - 1];
    if (!last || last.kind !== "end") {
      await stream.writeSSE({
        event: "end",
        data: JSON.stringify({ ok: true }),
      });
    }
    handle.detach();
  });
});

app.post("/api/calibrage/reports/:filename/gen-propositions", async (c) => {
  const cfg = loadAppConfig(DATA_DIR);
  if (!cfg.isAdmin) {
    audit(c, {
      action: "calibrage.gen_propositions",
      resource_type: "calibrage_report",
      result: "denied",
      reason: "user not admin",
    });
    return c.json({ error: "réservé à l'admin" }, 403);
  }
  const filename = c.req.param("filename");
  const reportJsonPath = getCalibrageReportJsonPath(DATA_DIR, filename);
  if (!reportJsonPath) {
    return c.json(
      {
        error:
          "Ce rapport n'a pas de version JSON (probablement généré avant l'ajout de l'export JSON). Relancer le calibrage avec le code actuel pour avoir un JSON exploitable.",
      },
      400
    );
  }
  const reportJson = getCalibrageReportJson(DATA_DIR, filename);
  if (!reportJson) {
    return c.json({ error: "JSON illisible" }, 500);
  }

  // Compose un prompt qui pointe Claude vers le rapport et active le skill
  // ameliorer-mes-regles en mode "from_calibration_report".
  // Note : on précise les biais 6e/7e à ne PAS transformer en propositions
  // (rapports financiers/activités 2024/2025 vs 2023 = artefact connu).
  const composedPrompt = `# Génération de propositions depuis un rapport de calibrage

Tu vas générer **automatiquement** des propositions de modifications de skills à partir d'un rapport de calibrage IA vs gold standard humain 6e.

**Rapport JSON à analyser** : \`${reportJsonPath}\`

Lis \`${skillRelPath("ameliorer-mes-regles", cfg)}\` et applique-le en mode \`from_calibration_report\`.

## Procédure stricte

1. Lis le fichier JSON via \`Read\` (chemin absolu fourni ci-dessus).
2. Analyse les sections \`biais_elg\` et \`biais_q\`.
3. Sélectionne les **top 5 biais critiques** :
   - Maximum 3 ELG (tri par \`desaccords/total\` décroissant, seuil >= 30%)
   - Maximum 3 Q de notation (tri par |\`delta_moyen\`| décroissant, seuil >= 0.5)
   - Total max 5 (combine ELG + Q)
4. **IGNORE explicitement** les biais suivants (ce sont des artefacts du calibrage 6e/7e, pas de vrais bugs de skill) :
   - **ELG-5** "Rapport d'activités 2025 (à défaut 2024)" → les dossiers 6e ont des rapports 2023, donc l'IA refuse à raison côté 7e. Pas un bug.
   - **ELG-6** "Rapport financier 2025 (à défaut 2024)" → idem, artefact connu.
5. Pour chaque biais sélectionné (autres que ELG-5/6), crée **1 proposition** dans le dossier \`propositions/\` de la campagne active. Frontmatter YAML :
   \`\`\`yaml
   ---
   auteur: "calibrage automatique"
   date: "<ISO maintenant>"
   dossier_declencheur: null
   affecte: "<id du biais, ex: ELG-7 ou Q10>"
   statut: en_attente
   raison: "<pattern observé + recommandation, en 2-3 phrases>"
   ---
   \`\`\`
   Corps : règle structurée à insérer dans le skill global cible. Indique clairement ce qui doit changer, exemple inclus.

6. Confirme dans le chat le nombre de propositions créées et leurs ids.

## Règles d'or

- Pas plus de 5 propositions au total.
- Pas de duplicata d'un biais existant déjà dans \`_propositions/\` (vérifier avec Glob avant écriture).
- Frontmatter YAML strict : sinon le diff visuel UI ne fonctionnera pas.
- Style des règles : prescriptif, factuel, sans em dash.
`;

  try {
    const cwd = DATA_DIR;
    const addDirs = buildAddDirs(DATA_DIR, cfg);
    const inboxAbs = inboxDir(DATA_DIR);
    if (!addDirs.includes(inboxAbs)) addDirs.push(inboxAbs);
    const calibrageDirAbs = resolve(DATA_DIR, "calibrage");
    if (!addDirs.includes(calibrageDirAbs)) addDirs.push(calibrageDirAbs);

    const run = startRun({
      prompt: composedPrompt,
      cwd,
      addDirs,
      allowedTools: ["Read", "Write", "Edit", "Glob", "Grep", "Skill", "Task", "mcp__office__read_xlsx"],
      permissionMode: "bypassPermissions",
      model: cfg.model,
    });
    audit(c, {
      action: "calibrage.gen_propositions",
      resource_type: "calibrage_report",
      resource_id: filename,
      result: "success",
      metadata: { run_id: run.id, model: cfg.model },
    });
    return c.json({ runId: run.id, expectedPropositions: 5 }, 201);
  } catch (err) {
    audit(c, {
      action: "calibrage.gen_propositions",
      resource_type: "calibrage_report",
      resource_id: filename,
      result: "failure",
      reason: (err as Error).message,
    });
    return c.json({ error: (err as Error).message }, 500);
  }
});

/**
 * Journal de traçabilité RGPD. Réservé admin.
 * Toute consultation ou export est lui-même tracé (méta-log obligatoire,
 * recommandation CNIL n° 2021-122).
 */
app.get("/api/audit-log", (c) => {
  const cfg = loadAppConfig(DATA_DIR);
  if (!cfg.isAdmin) {
    audit(c, {
      action: "audit.read",
      resource_type: "audit_log",
      result: "denied",
      reason: "user not admin",
    });
    return c.json({ error: "réservé à l'admin" }, 403);
  }
  const q = c.req.query();
  const result = readAuditEvents(
    DATA_DIR,
    {
      from: q.from,
      to: q.to,
      actor_id: q.actor_id,
      action: q.action,
      action_prefix: q.action_prefix,
      resource_type: q.resource_type,
      resource_id: q.resource_id,
      result: q.result as "success" | "failure" | "denied" | undefined,
      limit: q.limit ? Number(q.limit) : 200,
    },
    cfg.auditLogDir
  );
  // Méta-log : trace la consultation des logs
  audit(c, {
    action: "audit.read",
    resource_type: "audit_log",
    result: "success",
    metadata: {
      filters: q,
      returned: result.events.length,
      total_matching: result.total,
    },
  });
  return c.json(result);
});

app.get("/api/audit-log/integrity", (c) => {
  const cfg = loadAppConfig(DATA_DIR);
  if (!cfg.isAdmin) {
    return c.json({ error: "réservé à l'admin" }, 403);
  }
  const result = verifyAuditLogIntegrity(DATA_DIR, cfg.auditLogDir);
  audit(c, {
    action: "audit.integrity_check",
    resource_type: "audit_log",
    result: result.valid ? "success" : "failure",
    reason: result.reason,
    metadata: { checked: result.totalChecked, broken_at: result.brokenAt },
  });
  return c.json(result);
});

app.get("/api/audit-log/stats", (c) => {
  const cfg = loadAppConfig(DATA_DIR);
  if (!cfg.isAdmin) return c.json({ error: "réservé à l'admin" }, 403);
  const days = Number(c.req.query("days") ?? 30);
  return c.json(computeAuditStats(DATA_DIR, days, cfg.auditLogDir));
});

/**
 * Bundle de diagnostic à envoyer au support (zip de logs + system info).
 * Accessible à tous les utilisateurs : le journal RGPD n'est inclus que
 * pour les admins, les autres obtiennent un bundle technique sans PII.
 */
app.get("/api/debug-bundle/export", async (c) => {
  const cfg = loadAppConfig(DATA_DIR);
  const isAdmin = cfg.isAdmin === true;
  try {
    const result = await buildDebugBundle(DATA_DIR, {
      isAdmin,
      logDir: process.env.OIF_LOG_DIR,
      appVersion: process.env.OIF_APP_VERSION ?? "0.1.0",
      auditLogDir: cfg.auditLogDir,
    });
    audit(c, {
      action: "debug.bundle_export",
      resource_type: "debug_bundle",
      result: "success",
      metadata: {
        size_bytes: result.buffer.length,
        filename: result.filename,
        included_audit: isAdmin,
      },
    });
    return new Response(new Uint8Array(result.buffer), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${result.filename}"`,
      },
    });
  } catch (err) {
    audit(c, {
      action: "debug.bundle_export",
      resource_type: "debug_bundle",
      result: "failure",
      reason: (err as Error).message,
    });
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.get("/api/runs/:id", (c) => {
  const run = getRun(c.req.param("id"));
  if (!run) return c.json({ error: "run introuvable" }, 404);
  return c.json(run);
});

/**
 * Tokens consommés et coût USD agrégés pour un run.
 *
 * Body :
 *   { totals: UsageTotals, model: string|null, events?: AgentEvent[] }
 *
 * Le tableau `events` (breakdown par tour Claude) est inclus uniquement si
 * `?detail=1` est passé en query, pour garder la réponse légère par défaut
 * (un calibrage de 296 dossiers fait O(20-50) tours par dossier).
 */
app.get("/api/runs/:id/usage", (c) => {
  const u = getRunUsage(c.req.param("id"));
  if (!u) return c.json({ error: "run introuvable" }, 404);
  const detail = c.req.query("detail") === "1";
  return c.json({
    totals: u.totals,
    model: u.totals.last_model,
    ...(detail ? { events: u.events } : {}),
  });
});

app.post("/api/runs/:id/cancel", (c) => {
  const ok = cancelRun(c.req.param("id"));
  if (!ok) return c.json({ error: "run non annulable" }, 400);
  return c.json({ cancelled: true });
});

/**
 * SSE stream des events d'un run. Replay des events déjà émis + nouveaux events live.
 * Format : event: agent / data: <AgentEvent>
 */
app.get("/api/runs/:id/events", (c) => {
  const id = c.req.param("id");
  return streamSSE(c, async (stream) => {
    const handle = attachListener(id, async (ev) => {
      await stream.writeSSE({ event: "agent", data: JSON.stringify(ev) });
    });
    if (!handle) {
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ error: "run introuvable" }),
      });
      return;
    }
    // Replay des events déjà arrivés
    for (const ev of handle.replay) {
      await stream.writeSSE({ event: "agent", data: JSON.stringify(ev) });
    }
    // Attendre la fin du run pour fermer
    await waitForRun(id);
    await stream.writeSSE({ event: "end", data: JSON.stringify({ ok: true }) });
    handle.detach();
  });
});

const port = Number(process.env.FAE_DAEMON_PORT ?? 7456);

// Boot guard : migration vers layout campaigns/ si nécessaire (idempotent)
try {
  const cfgBoot = loadAppConfig(DATA_DIR);
  const migrationResult = ensureCampaignsLayout(DATA_DIR, cfgBoot.sharedSkillsDir);
  // Ensure grid-metadata.json existe pour toute campagne (V2). Idempotent.
  try {
    const { campaigns: cs } = listCampaigns(DATA_DIR, cfgBoot.sharedSkillsDir);
    for (const c of cs) {
      const existing = readGridMetadata(DATA_DIR, c.id, cfgBoot.sharedSkillsDir);
      if (!existing) {
        writeGridMetadata(
          DATA_DIR,
          c.id,
          {
            questionsHorsIa: [15, 16, 18, 23, 24, 26, 27, 33, 38, 39, 40, 42, 43, 47, 48, 49],
            baremeTotalMax: 105,
            version: 1,
            source: "boot-backfill",
            generatedAt: new Date().toISOString(),
          },
          cfgBoot.sharedSkillsDir
        );
        console.log(`[grid-metadata] backfill pour ${c.id}`);
      }
    }
  } catch (err) {
    console.warn("[grid-metadata] backfill échoué :", err);
  }
  if (migrationResult.status === "migrated") {
    console.log(
      `[campaigns] migration vers ${migrationResult.campaignId}/ effectuée. ` +
      `Sous-dossiers copiés : ${migrationResult.copiedDirs?.join(", ")}`
    );
  } else if (migrationResult.status === "skipped_existing") {
    // silencieux : déjà migré
  } else {
    console.log(
      `[campaigns] migration ignorée : ${migrationResult.status}` +
      (migrationResult.reason ? ` (${migrationResult.reason})` : "")
    );
  }
} catch (err) {
  console.error("[campaigns] erreur migration boot:", err);
}

// Watchdog : check zombies toutes les 60s, libère les slots automatiquement
// même sans requête utilisateur. Anti-blocage long terme du calibrage.
setInterval(() => {
  try {
    const n = cleanupZombies();
    if (n > 0) {
      console.log(`[watchdog] ${n} run(s) zombie(s) nettoyé(s) en arrière-plan`);
    }
  } catch (e) {
    console.warn("[watchdog] cleanupZombies a planté :", (e as Error).message);
  }
}, 60_000).unref();

// Génère le fichier de config MCP dans DATA_DIR/.claude/mcp.json au démarrage.
// Ce fichier indique à Claude Code où trouver notre MCP server xlsx local.
// Le path vers electron/mcp-xlsx.cjs dépend de si on est en dev ou packagé,
// donc on le résout dynamiquement ici puis on écrit le JSON.
try {
  const mcpDir = resolve(DATA_DIR, ".claude");
  const mcpFile = resolve(mcpDir, "mcp.json");
  // Le binaire mcp-xlsx.cjs est dans electron/ relatif au repo (dev) ou
  // dans app.asar.unpacked/electron/ en packagé. process.env.OIF_MCP_XLSX
  // peut le surcharger explicitement (passé par main.cjs en packagé).
  let mcpXlsxPath = process.env.OIF_MCP_XLSX;
  if (!mcpXlsxPath) {
    const candidates = [
      resolve(process.cwd(), "electron", "mcp-xlsx.cjs"),
      resolve(DATA_DIR, "..", "electron", "mcp-xlsx.cjs"),
    ];
    mcpXlsxPath = candidates.find((p) => existsSync(p)) || candidates[0];
  }
  const mcpConfig = {
    mcpServers: {
      office: {
        command: process.execPath,
        args: [mcpXlsxPath],
        env: {
          FAE_DATA_DIR: DATA_DIR,
          ELECTRON_RUN_AS_NODE: "1",
        },
      },
    },
  };
  mkdirSync(mcpDir, { recursive: true });
  writeFileSync(mcpFile, JSON.stringify(mcpConfig, null, 2), "utf8");
  console.log(`[mcp] config écrite : ${mcpFile} → ${mcpXlsxPath}`);
} catch (err) {
  console.warn(`[mcp] init config échouée : ${(err as Error).message}`);
}

serve({ fetch: app.fetch, port }, (info) => {
  console.log(
    `[oif-eval-daemon] écoute sur http://localhost:${info.port} (data: ${DATA_DIR})`
  );
  const claude = findClaudeBin();
  if (!claude) {
    console.warn(
      "[oif-eval-daemon] ⚠️  claude CLI introuvable sur le PATH ; les runs échoueront."
    );
  } else {
    console.log(`[oif-eval-daemon] claude CLI : ${claude}`);
  }
});
