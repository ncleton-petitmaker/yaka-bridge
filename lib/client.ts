/**
 * Client API + SSE pour le daemon générique.
 *
 * En dev, les routes `/api/*` sont rewritées par Next.js vers le daemon
 * (cf. `next.config.ts`). Pour les SSE, on tape directement le daemon (le
 * proxy Next/Turbopack bufferise sinon).
 *
 * Les apps métier étendent ce module avec leurs propres helpers.
 */
import { parseSseFrame as _parseSseFrame } from "./sse";
void _parseSseFrame; // exporté plus loin pour les apps qui l'utilisent
import { apiDaemonUrl, apiFetch, withDaemonToken } from "./api-client";
import type {
  AgentEvent,
  RunRecord,
  SkillEntry,
  StartRunRequest,
  StartRunResponse,
} from "./types";

export async function health(): Promise<{
  ok: boolean;
  version: string;
  claude: string | null;
  dataDir: string;
}> {
  const r = await apiFetch("/api/health");
  if (!r.ok) throw new Error(`GET /api/health ${r.status}`);
  return await r.json();
}

export async function startRun(req: StartRunRequest): Promise<string> {
  const r = await apiFetch("/api/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`POST /api/runs ${r.status}: ${txt}`);
  }
  const j = (await r.json()) as StartRunResponse;
  return j.runId;
}

export async function getRun(runId: string): Promise<RunRecord | null> {
  const r = await apiFetch(`/api/runs/${encodeURIComponent(runId)}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GET /api/runs/${runId} ${r.status}`);
  const j = (await r.json()) as { run: RunRecord };
  return j.run;
}

export async function listRuns(): Promise<RunRecord[]> {
  const r = await apiFetch("/api/runs");
  if (!r.ok) throw new Error(`GET /api/runs ${r.status}`);
  const j = (await r.json()) as { runs: RunRecord[] };
  return j.runs;
}

export async function cancelRun(runId: string): Promise<void> {
  await apiFetch(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" });
}

export async function listSkills(
  user?: string
): Promise<{ global: SkillEntry[]; perso: SkillEntry[] }> {
  const url = user ? `/api/skills?user=${encodeURIComponent(user)}` : "/api/skills";
  const r = await apiFetch(url);
  if (!r.ok) throw new Error(`GET /api/skills ${r.status}`);
  return await r.json();
}

export async function updateSkill(
  slug: string,
  content: string
): Promise<{ skill: SkillEntry }> {
  const r = await apiFetch(`/api/skills/${encodeURIComponent(slug)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`PUT /api/skills/${slug} ${r.status}: ${txt}`);
  }
  return await r.json();
}

export interface RunStreamHandlers {
  onEvent?: (ev: AgentEvent) => void;
  onEnd?: () => void;
  onError?: (err: Error) => void;
  signal?: AbortSignal;
}

/**
 * Consomme le SSE d'un run via EventSource. On tape directement le daemon
 * (bypass Next/Turbopack qui bufferise SSE en dev). CORS est géré côté daemon.
 */
export function streamRun(
  runId: string,
  handlers: RunStreamHandlers
): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = withDaemonToken(
      apiDaemonUrl(`/api/runs/${encodeURIComponent(runId)}/events`)
    );
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
      } catch {
        // ignore frame corrompue
      }
    });
    es.addEventListener("end", () => finish());
    es.addEventListener("error", () => {
      if (es.readyState === EventSource.CLOSED) finish();
      else finish(new Error("SSE connection error"));
    });

    if (handlers.signal) {
      handlers.signal.addEventListener("abort", () => finish());
    }
  });
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------
export interface AuditEvent {
  event_id: string;
  timestamp: string;
  actor_id: string;
  actor_role?: string;
  action: string;
  resource_type: string;
  resource_id?: string;
  resource_label?: string;
  result: "success" | "failure" | "denied";
  reason?: string;
  metadata?: Record<string, unknown>;
}

export async function listAuditLogs(opts: {
  since?: string;
  user?: string;
  action?: string;
  limit?: number;
} = {}): Promise<{ events: AuditEvent[]; total: number; truncated: boolean }> {
  const qs = new URLSearchParams();
  if (opts.since) qs.set("since", opts.since);
  if (opts.user) qs.set("user", opts.user);
  if (opts.action) qs.set("action", opts.action);
  if (opts.limit) qs.set("limit", String(opts.limit));
  const url = qs.toString() ? `/api/audit/logs?${qs}` : "/api/audit/logs";
  const r = await apiFetch(url);
  if (!r.ok) throw new Error(`GET /api/audit/logs ${r.status}`);
  return await r.json();
}

// ============================================================================
// Conflict copies (sync engine detection)
// ============================================================================

/**
 * Représente un fichier "conflict copy" créé par un sync engine (OneDrive,
 * Dropbox, etc.) quand deux utilisateurs modifient la même ressource. Détectés
 * dans le dossier partagé pour avertir l'utilisateur via ConflictBanner.
 */
export interface ConflictFile {
  path: string;
  size: number;
  mtime: string;
}

/**
 * Liste les conflict copies détectées dans le dossier partagé synchronisé.
 * Si l'app n'a pas de dossier partagé configuré, l'API renvoie [].
 */
export async function listConflictCopies(path?: string): Promise<ConflictFile[]> {
  const url = path
    ? `/api/storage/conflicts?path=${encodeURIComponent(path)}`
    : "/api/storage/conflicts";
  const r = await apiFetch(url);
  if (!r.ok) throw new Error(`GET /api/storage/conflicts ${r.status}`);
  const j = (await r.json()) as { conflicts: ConflictFile[] };
  return j.conflicts;
}

export { _parseSseFrame as parseSseFrame };
