/**
 * Client API + SSE pour le daemon OIF-Eval.
 * S'inspire d'opendesign streamViaDaemon mais simplifié.
 */
import { parseSseFrame } from "./sse";
import type {
  AgentEvent,
  ChatRequest,
  ChatRunCreated,
  DossierEntry,
  Evaluation,
  SkillEntry,
  PropositionEntry,
  FileEntry,
  VeriteSummary,
} from "./types";

export interface GridMetadata {
  questionsHorsIa: number[];
  baremeTotalMax: number;
  version: number;
}

export async function getGridMetadata(campaignId?: string): Promise<GridMetadata> {
  const url = campaignId ? `/api/grid-metadata?campaignId=${encodeURIComponent(campaignId)}` : "/api/grid-metadata";
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET grid-metadata ${r.status}`);
  return await r.json();
}

export async function overrideQuestion(
  evaluationId: string,
  questionId: number,
  scoreHuman: number,
  raison: string
): Promise<Evaluation> {
  const r = await fetch(`/api/evaluations/${encodeURIComponent(evaluationId)}/override`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "question",
      question_id: questionId,
      score_human: scoreHuman,
      raison,
    }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(err.error ?? "override échoué");
  }
  return (await r.json()).evaluation;
}

export async function overrideEligibilite(
  evaluationId: string,
  critereId: string,
  statutHuman: string,
  raison: string
): Promise<Evaluation> {
  const r = await fetch(`/api/evaluations/${encodeURIComponent(evaluationId)}/override`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "eligibilite",
      critere_id: critereId,
      statut_human: statutHuman,
      raison,
    }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(err.error ?? "override échoué");
  }
  return (await r.json()).evaluation;
}

export async function removeOverrideQuestion(
  evaluationId: string,
  questionId: number
): Promise<Evaluation> {
  const r = await fetch(`/api/evaluations/${encodeURIComponent(evaluationId)}/override`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "question", question_id: questionId }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(err.error ?? "annulation override échouée");
  }
  return (await r.json()).evaluation;
}

export async function removeOverrideEligibilite(
  evaluationId: string,
  critereId: string
): Promise<Evaluation> {
  const r = await fetch(`/api/evaluations/${encodeURIComponent(evaluationId)}/override`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "eligibilite", critere_id: critereId }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(err.error ?? "annulation override échouée");
  }
  return (await r.json()).evaluation;
}

// ============= Rapports de calibrage =============

import type {
  CalibrageReportJson,
  CalibrageReportSummary,
} from "./calibrage-types";
import type {
  CalibrageImport,
  CalibrageProgress,
} from "./calibrage-import-types";

export async function listCalibrageReports(): Promise<CalibrageReportSummary[]> {
  const r = await fetch("/api/calibrage/reports");
  if (!r.ok) throw new Error(`GET /api/calibrage/reports ${r.status}`);
  const j = (await r.json()) as { reports: CalibrageReportSummary[] };
  return j.reports;
}

export async function getCalibrageReport(filename: string): Promise<{
  json: CalibrageReportJson | null;
  markdown: string | null;
}> {
  const r = await fetch(
    `/api/calibrage/reports/${encodeURIComponent(filename)}`
  );
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(err.error ?? "lecture échouée");
  }
  return await r.json();
}

export async function genPropositionsFromReport(
  filename: string
): Promise<{ runId: string; expectedPropositions: number }> {
  const r = await fetch(
    `/api/calibrage/reports/${encodeURIComponent(filename)}/gen-propositions`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }
  );
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(err.error ?? "génération échouée");
  }
  return await r.json();
}

/**
 * Démarre un nouveau calibrage en background sur un bundle importé.
 * L'erreur "already_running" est renvoyée telle quelle dans le message pour
 * que l'UI puisse la reconnaître et afficher un message clair.
 */
export async function startCalibrageWithImport(
  importId: string,
  opts: { modeCompat?: boolean } = {} // DEBUG à retirer avant livraison
): Promise<{ runId: string }> {
  const r = await fetch("/api/calibrage/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ importId, modeCompat: opts.modeCompat }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(err.error ?? "démarrage échoué");
  }
  return await r.json();
}

export interface CurrentCalibrageRun {
  runId: string;
  importId: string | null;
  status: "running" | "succeeded" | "failed" | "cancelled";
  startedAt: number;
  evaluationsDone: number;
  evaluationsTotal: number;
  lastProgress?: CalibrageProgress;
}

/**
 * Renvoie le calibrage actuellement en cours côté daemon, ou null s'il n'y
 * en a pas. Permet à l'UI de récupérer un run après reload de page ou
 * changement d'onglet.
 */
export async function getCurrentCalibrageRun(): Promise<CurrentCalibrageRun | null> {
  const r = await fetch("/api/calibrage/runs/current");
  if (!r.ok) return null;
  const j = (await r.json()) as { run: CurrentCalibrageRun | null };
  return j.run;
}

/**
 * Annule un calibrage en cours (tue le processus enfant côté daemon).
 */
export async function cancelCalibrageRun(runId: string): Promise<void> {
  const r = await fetch(
    `/api/calibrage/runs/${encodeURIComponent(runId)}/cancel`,
    { method: "POST" }
  );
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(err.error ?? "annulation échouée");
  }
}

// ============= Bundles d'import calibrage =============

/**
 * Uploade un ZIP de calibrage. Renvoie le manifeste parsé (importId, dossiers,
 * warnings). En cas d'erreur de parsing ou validation, throw avec le message
 * du backend.
 */
export async function importCalibrageBundle(file: File): Promise<CalibrageImport> {
  const fd = new FormData();
  fd.append("file", file);
  // On tape DIRECTEMENT le daemon (port 7456) au lieu du proxy Next, qui a une
  // limite de body de 1 Mo par défaut et fait planter l'upload sur des bundles
  // de plusieurs Mo de PDFs. Le daemon écoute sur localhost en dev comme en prod.
  const daemonPort = process.env.NEXT_PUBLIC_FAE_DAEMON_PORT ?? "7456";
  const r = await fetch(`http://localhost:${daemonPort}/api/calibrage/imports`, {
    method: "POST",
    body: fd,
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(err.error ?? "import échoué");
  }
  return (await r.json()) as CalibrageImport;
}

export async function listCalibrageImports(): Promise<CalibrageImport[]> {
  const r = await fetch("/api/calibrage/imports");
  if (!r.ok) throw new Error(`GET imports ${r.status}`);
  const j = (await r.json()) as { imports: CalibrageImport[] };
  return j.imports;
}

export async function getCalibrageImport(id: string): Promise<CalibrageImport> {
  const r = await fetch(`/api/calibrage/imports/${encodeURIComponent(id)}`);
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(err.error ?? "lecture échouée");
  }
  return (await r.json()) as CalibrageImport;
}

export async function deleteCalibrageImport(id: string): Promise<void> {
  const r = await fetch(`/api/calibrage/imports/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(err.error ?? "suppression échouée");
  }
}

/**
 * Override admin du mapping colonnes xlsx -> Q skill pour un import.
 * `mapping` : `{ "col_<positionXlsx>": <qId> | null }`. null = ignorer la
 * colonne. Renvoie le manifest mis à jour pour que l'UI rafraîchisse l'état.
 */
export async function updateCalibrageImportMapping(
  id: string,
  mapping: Record<string, number | null>
): Promise<CalibrageImport> {
  const r = await fetch(
    `/api/calibrage/imports/${encodeURIComponent(id)}/mapping`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mapping }),
    }
  );
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(err.error ?? "mise à jour du mapping échouée");
  }
  return (await r.json()) as CalibrageImport;
}

/**
 * Déclenche le téléchargement du template xlsx via une navigation
 * directe (le daemon stream le binaire en attachment).
 */
export function downloadCalibrageTemplate(): void {
  if (typeof window === "undefined") return;
  const daemonOrigin =
    window.location.hostname
      ? `http://${window.location.hostname}:7456`
      : "http://localhost:7456";
  window.location.href = `${daemonOrigin}/api/calibrage/template.xlsx`;
}

export async function deleteCalibrageReport(filename: string): Promise<void> {
  const r = await fetch(
    `/api/calibrage/reports/${encodeURIComponent(filename)}`,
    { method: "DELETE" }
  );
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(err.error ?? "suppression échouée");
  }
}

/** Event poussé par le daemon pour un run de calibrage. */
export interface CalibrageStreamEvent {
  ts: number;
  kind: "stdout" | "stderr" | "end" | "error" | "progress";
  text?: string;
  exitCode?: number | null;
  /** Présent uniquement quand kind === "progress". */
  progress?: CalibrageProgress;
}

/**
 * Branche un EventSource sur le SSE d'un calibrage. Retourne une fonction
 * pour fermer la connexion. Les events sont relayés via onEvent ;
 * la fermeture propre déclenche un event { kind: "end" }.
 */
export function streamCalibrageRun(
  runId: string,
  onEvent: (e: CalibrageStreamEvent) => void
): () => void {
  const daemonOrigin =
    typeof window !== "undefined" && window.location.hostname
      ? `http://${window.location.hostname}:7456`
      : "http://localhost:7456";
  const url = `${daemonOrigin}/api/calibrage/runs/${runId}/stream`;
  const es = new EventSource(url);
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    es.close();
  };

  es.addEventListener("calibrage", (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as CalibrageStreamEvent;
      onEvent(data);
    } catch {
      // ignore malformed frames
    }
  });
  es.addEventListener("progress", (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as CalibrageStreamEvent;
      onEvent(data);
    } catch {
      // ignore malformed frames
    }
  });
  es.addEventListener("end", (e: MessageEvent) => {
    try {
      // l'event "end" peut contenir { exitCode } ou { ok: true }
      const data = JSON.parse(e.data) as { exitCode?: number | null };
      onEvent({
        ts: Date.now(),
        kind: "end",
        exitCode: typeof data.exitCode === "number" ? data.exitCode : null,
      });
    } catch {
      onEvent({ ts: Date.now(), kind: "end" });
    }
    close();
  });
  es.addEventListener("error", () => {
    if (es.readyState === EventSource.CLOSED) {
      onEvent({ ts: Date.now(), kind: "end" });
    } else {
      onEvent({ ts: Date.now(), kind: "error", text: "Erreur de connexion" });
    }
    close();
  });

  return close;
}

// =================================================

export async function getRunsConcurrency(): Promise<{
  running: number;
  max: number;
  canStart: number;
}> {
  const r = await fetch("/api/runs/concurrency");
  if (!r.ok) throw new Error(`GET concurrency ${r.status}`);
  return await r.json();
}

export async function batchEvaluations(
  dossierIds: string[]
): Promise<{
  launched: { dossier_id: string; run_id: string }[];
  skipped: { dossier_id: string; reason: string }[];
  runningTotal: number;
  max: number;
}> {
  const r = await fetch("/api/runs/batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dossier_ids: dossierIds }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(err.error ?? "batch échoué");
  }
  return await r.json();
}

export async function batchNotations(
  dossierIds: string[]
): Promise<{
  launched: { dossier_id: string; run_id: string }[];
  skipped: { dossier_id: string; reason: string }[];
  runningTotal: number;
  max: number;
}> {
  const r = await fetch("/api/runs/batch-notation", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dossier_ids: dossierIds }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(err.error ?? "batch notation échoué");
  }
  return await r.json();
}

export async function listDossiers(): Promise<DossierEntry[]> {
  const r = await fetch("/api/dossiers");
  if (!r.ok) throw new Error(`GET /api/dossiers ${r.status}`);
  const j = (await r.json()) as { dossiers: DossierEntry[] };
  return j.dossiers;
}

export async function startRun(req: ChatRequest): Promise<string> {
  const r = await fetch("/api/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`POST /api/runs ${r.status}: ${txt}`);
  }
  const j = (await r.json()) as ChatRunCreated;
  return j.runId;
}

export async function cancelRun(runId: string): Promise<void> {
  await fetch(`/api/runs/${runId}/cancel`, { method: "POST" });
}

export async function listSkills(user?: string): Promise<{ global: SkillEntry[]; perso: SkillEntry[] }> {
  const url = user ? `/api/skills?user=${encodeURIComponent(user)}` : "/api/skills";
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET /api/skills ${r.status}`);
  return await r.json();
}

// ============= Campagnes =============

export interface CampaignEntry {
  id: string;
  label: string;
  status: "draft" | "active" | "archived";
  createdAt: string;
  basedOn: string | null;
  dateOuverture?: string;
  dateCloture?: string;
}

export async function listCampaigns(): Promise<{
  campaigns: CampaignEntry[];
  activeId: string | null;
}> {
  const r = await fetch("/api/campaigns");
  if (!r.ok) throw new Error(`GET /api/campaigns ${r.status}`);
  return await r.json();
}

export async function getCampaignDetail(id: string): Promise<{
  campaign: CampaignEntry;
  manifest: {
    skillHashes: Record<string, string>;
    schemaHash: string | null;
    createdAt: string;
    basedOn: string | null;
  } | null;
  stats: { evaluations: number; propositionsTotal: number; propositionsPromues: number };
  skills: { filename: string; size: number; hash: string }[];
}> {
  const r = await fetch(`/api/campaigns/${encodeURIComponent(id)}`);
  if (!r.ok) throw new Error(`GET /api/campaigns/${id} ${r.status}`);
  return await r.json();
}

export async function createCampaign(opts: {
  id: string;
  label: string;
  basedOn: string | null;
  dateOuverture?: string;
  dateCloture?: string;
  activate?: boolean;
}): Promise<{ campaign: CampaignEntry }> {
  const r = await fetch("/api/campaigns", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(err.error ?? "création échouée");
  }
  return await r.json();
}

export async function activateCampaign(
  id: string
): Promise<{ activeId: string; archivedId: string | null }> {
  const r = await fetch(`/api/campaigns/${encodeURIComponent(id)}/activate`, {
    method: "POST",
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(err.error ?? "activation échouée");
  }
  return await r.json();
}

export async function archiveCampaign(id: string): Promise<void> {
  const r = await fetch(`/api/campaigns/${encodeURIComponent(id)}/archive`, {
    method: "POST",
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(err.error ?? "archivage échoué");
  }
}

export async function exportCampaignZip(id: string): Promise<{ blob: Blob; filename: string }> {
  const r = await fetch(`/api/campaigns/${encodeURIComponent(id)}/export`);
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(err.error ?? "export échoué");
  }
  const blob = await r.blob();
  const cd = r.headers.get("Content-Disposition") ?? "";
  const m = cd.match(/filename="([^"]+)"/);
  const filename = m?.[1] ?? `campagne-${id}.zip`;
  return { blob, filename };
}

export async function exportDebugBundle(): Promise<{ buffer: ArrayBuffer; filename: string }> {
  const r = await fetch("/api/debug-bundle/export");
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(err.error ?? "génération du diagnostic échouée");
  }
  const buffer = await r.arrayBuffer();
  const cd = r.headers.get("Content-Disposition") ?? "";
  const m = cd.match(/filename="([^"]+)"/);
  const filename = m?.[1] ?? "oif-eval-debug.zip";
  return { buffer, filename };
}

export async function importCampaignZip(
  file: File,
  opts: { id?: string; label?: string } = {}
): Promise<{ campaignId: string; warnings: string[] }> {
  const fd = new FormData();
  fd.append("file", file);
  const qs = new URLSearchParams();
  if (opts.id) qs.set("id", opts.id);
  if (opts.label) qs.set("label", opts.label);
  const r = await fetch(`/api/campaigns/import?${qs.toString()}`, {
    method: "POST",
    body: fd,
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(err.error ?? "import échoué");
  }
  return await r.json();
}

export async function getCampaignSkill(
  campaignId: string,
  skillName: string
): Promise<{ content: string }> {
  const r = await fetch(
    `/api/campaigns/${encodeURIComponent(campaignId)}/skills/${encodeURIComponent(skillName)}`
  );
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(err.error ?? "lecture échouée");
  }
  return await r.json();
}

export async function updateCampaignSkill(
  campaignId: string,
  skillName: string,
  content: string
): Promise<{ ok: true; hash?: string }> {
  const r = await fetch(
    `/api/campaigns/${encodeURIComponent(campaignId)}/skills/${encodeURIComponent(skillName)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    }
  );
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(err.error ?? "mise à jour échouée");
  }
  return await r.json();
}

export async function deleteCampaign(id: string): Promise<void> {
  const r = await fetch(`/api/campaigns/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(err.error ?? "suppression échouée");
  }
}

// =====================================

export async function listPropositions(): Promise<PropositionEntry[]> {
  const r = await fetch("/api/propositions");
  if (!r.ok) throw new Error(`GET /api/propositions ${r.status}`);
  const j = (await r.json()) as { propositions: PropositionEntry[] };
  return j.propositions;
}

export interface PropositionPreviewData {
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

export async function previewProposition(
  filename: string
): Promise<PropositionPreviewData> {
  const r = await fetch(
    `/api/propositions/${encodeURIComponent(filename)}/preview`
  );
  if (!r.ok) throw new Error(`preview ${r.status}`);
  return (await r.json()) as PropositionPreviewData;
}

export async function revertPromotion(
  filename: string,
  admin: string,
  commentaire?: string
): Promise<{ ok: true; restoredSkill?: string }> {
  const r = await fetch(
    `/api/propositions/${encodeURIComponent(filename)}/revert`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ admin, commentaire }),
    }
  );
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`revert ${r.status}: ${txt}`);
  }
  return (await r.json()) as { ok: true; restoredSkill?: string };
}

export async function decidePropositions(
  filename: string,
  decision: "promouvoir" | "rejeter",
  admin: string,
  commentaire?: string
): Promise<PropositionEntry> {
  const r = await fetch(`/api/propositions/${encodeURIComponent(filename)}/decide`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision, admin, commentaire }),
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`decide ${r.status}: ${txt}`);
  }
  const j = (await r.json()) as { proposition: PropositionEntry };
  return j.proposition;
}

export async function listDossierFiles(dossierId: string): Promise<FileEntry[]> {
  const r = await fetch(`/api/dossiers/${encodeURIComponent(dossierId)}/files`);
  if (!r.ok) throw new Error(`GET files ${r.status}`);
  const j = (await r.json()) as { files: FileEntry[] };
  return j.files;
}

export function fileUrl(dossierId: string, filename: string): string {
  return `/api/dossiers/${encodeURIComponent(dossierId)}/files/${encodeURIComponent(filename)}`;
}

export interface DossierEventsResponse {
  runId: string | null;
  status: "idle" | "running" | "succeeded" | "failed" | "cancelled";
  events: AgentEvent[];
  startedAt: number | null;
  endedAt: number | null;
}

export async function loadDossierEvents(dossierId: string): Promise<DossierEventsResponse> {
  const r = await fetch(`/api/dossiers/${encodeURIComponent(dossierId)}/events`);
  if (!r.ok) return { runId: null, status: "idle", events: [], startedAt: null, endedAt: null };
  return (await r.json()) as DossierEventsResponse;
}

export async function loadVerite(dossierId: string): Promise<VeriteSummary | null> {
  const r = await fetch(`/api/dossiers/${encodeURIComponent(dossierId)}/verite`);
  if (!r.ok) return null;
  return (await r.json()) as VeriteSummary;
}

export async function loadEvaluation(dossierId: string): Promise<Evaluation | null> {
  const r = await fetch(`/api/evaluations/${encodeURIComponent(dossierId)}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GET evaluation ${r.status}`);
  return (await r.json()) as Evaluation;
}

export interface RunStreamHandlers {
  onEvent?: (ev: AgentEvent) => void;
  onEnd?: () => void;
  onError?: (err: Error) => void;
  signal?: AbortSignal;
}

/**
 * Consomme le SSE d'un run via EventSource natif (au lieu de fetch+reader).
 * Bypass du proxy Next.js Turbopack qui bufferise les SSE en dev :
 * on appelle directement le daemon Hono sur :7456 (CORS déjà géré côté daemon).
 */
export function streamRun(runId: string, handlers: RunStreamHandlers): Promise<void> {
  return new Promise((resolve, reject) => {
    const daemonOrigin =
      typeof window !== "undefined" && window.location.hostname
        ? `http://${window.location.hostname}:7456`
        : "http://localhost:7456";
    const url = `${daemonOrigin}/api/runs/${runId}/events`;
    const es = new EventSource(url);
    let ended = false;

    const cleanup = () => {
      es.close();
    };

    const finish = (err?: Error) => {
      if (ended) return;
      ended = true;
      cleanup();
      if (err) {
        handlers.onError?.(err);
        reject(err);
      } else {
        handlers.onEnd?.();
        resolve();
      }
    };

    es.addEventListener("agent", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as AgentEvent;
        handlers.onEvent?.(data);
      } catch (err) {
        // ignore parse errors on individual frames
      }
    });

    es.addEventListener("end", () => finish());
    es.addEventListener("error", (e) => {
      // EventSource émet 'error' aussi à la fermeture serveur normale
      // (readyState === CLOSED). On finish() proprement dans ce cas.
      if (es.readyState === EventSource.CLOSED) {
        finish();
      } else {
        // erreur de connexion réelle
        finish(new Error("SSE connection error"));
      }
    });

    if (handlers.signal) {
      handlers.signal.addEventListener("abort", () => {
        finish();
      });
    }
  });
}


// ============================================================================
// Storage / sync mode (mode shared vs manual)
// ============================================================================

export type StorageType =
  | "onedrive"
  | "sharepoint"
  | "dropbox"
  | "google-drive"
  | "icloud"
  | "smb"
  | "local";

export interface StorageDetection {
  type: StorageType;
  label: string;
  tenant?: string;
  warnings: string[];
  confident: boolean;
}

export interface SyncHealth {
  processRunning: boolean;
  processName: string;
  available: "yes" | "no" | "unknown" | "not-applicable";
}

export async function detectStoragePath(
  path: string
): Promise<{ detection: StorageDetection; health: SyncHealth }> {
  const r = await fetch(`/api/storage/detect?path=${encodeURIComponent(path)}`);
  if (!r.ok) throw new Error(`GET storage/detect ${r.status}`);
  return await r.json();
}

export interface ConflictFile {
  path: string;
  size: number;
  mtime: string;
}

export async function listConflictCopies(path?: string): Promise<ConflictFile[]> {
  const url = path
    ? `/api/storage/conflicts?path=${encodeURIComponent(path)}`
    : "/api/storage/conflicts";
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET storage/conflicts ${r.status}`);
  const j = (await r.json()) as { conflicts: ConflictFile[] };
  return j.conflicts;
}

// ============================================================================
// Sync bundles ZIP (mode manuel)
// ============================================================================

export interface BundleManifest {
  type: "admin-pack" | "evaluations-pack";
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

export interface BundleImportResult {
  ok: boolean;
  manifest?: BundleManifest;
  imported: number;
  skipped: number;
  warnings: string[];
  error?: string;
}

export async function exportAdminPack(): Promise<{ blob: Blob; filename: string }> {
  const r = await fetch("/api/sync-bundles/admin-pack");
  if (!r.ok) {
    const j = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(j.error ?? "export admin pack échoué");
  }
  const cd = r.headers.get("Content-Disposition") ?? "";
  const m = cd.match(/filename="([^"]+)"/);
  const filename = m?.[1] ?? "oif-eval-admin-pack.zip";
  return { blob: await r.blob(), filename };
}

export async function importAdminPack(
  file: File,
  options?: { dryRun?: boolean; overwrite?: boolean }
): Promise<BundleImportResult> {
  const fd = new FormData();
  fd.append("file", file);
  if (options?.dryRun) fd.append("dryRun", "1");
  if (options?.overwrite) fd.append("overwrite", "1");
  const r = await fetch("/api/sync-bundles/admin-pack/import", {
    method: "POST",
    body: fd,
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(j.error ?? "import admin pack échoué");
  }
  return await r.json();
}

export async function exportEvaluationsPack(): Promise<{
  blob: Blob;
  filename: string;
}> {
  const r = await fetch("/api/sync-bundles/evaluations-pack");
  if (!r.ok) {
    const j = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(j.error ?? "export evaluations pack échoué");
  }
  const cd = r.headers.get("Content-Disposition") ?? "";
  const m = cd.match(/filename="([^"]+)"/);
  const filename = m?.[1] ?? "oif-eval-evals-pack.zip";
  return { blob: await r.blob(), filename };
}

export async function previewEvaluationsPack(): Promise<{
  evaluations: number;
  auditFiles: number;
}> {
  const r = await fetch("/api/sync-bundles/evaluations-pack?preview=1");
  if (!r.ok) throw new Error(`GET evaluations-pack preview ${r.status}`);
  return await r.json();
}

export async function importEvaluationsPack(
  file: File,
  options?: { dryRun?: boolean; overwrite?: boolean }
): Promise<BundleImportResult> {
  const fd = new FormData();
  fd.append("file", file);
  if (options?.dryRun) fd.append("dryRun", "1");
  if (options?.overwrite) fd.append("overwrite", "1");
  const r = await fetch("/api/sync-bundles/evaluations-pack/import", {
    method: "POST",
    body: fd,
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(j.error ?? "import evaluations pack échoué");
  }
  return await r.json();
}

// ============================================================================
// Dashboard admin
// ============================================================================

export interface OperatorStats {
  operator: string;
  bucketSize: number;
  validated: number;
  ineligibles: number;
  inProgress: number;
  percentDone: number;
  lastActivity?: string;
}

export interface DashboardSummary {
  poolTotal: number;
  totalTouched: number;
  totalValidated: number;
  totalIneligibles: number;
  totalInProgress: number;
  totalNotStarted: number;
  percentGlobal: number;
  operators: OperatorStats[];
  unassigned: number;
}

export interface DossierSummary {
  id: string;
  status: "a_faire" | "en_review" | "eligibilite_ok" | "valide" | "ineligible";
  evaluator: string | null;
  validatedAt?: string;
  mtime?: string;
}

export async function getDashboard(): Promise<DashboardSummary> {
  const r = await fetch("/api/dashboard/operators");
  if (!r.ok) {
    const j = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(j.error ?? `dashboard ${r.status}`);
  }
  return await r.json();
}

export async function getOperatorDossiers(operator: string): Promise<{
  operator: string;
  dossiers: DossierSummary[];
}> {
  const r = await fetch(
    `/api/dashboard/operators/${encodeURIComponent(operator)}/dossiers`
  );
  if (!r.ok) {
    const j = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(j.error ?? `operator dossiers ${r.status}`);
  }
  return await r.json();
}
