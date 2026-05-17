/**
 * Types partagés UI ↔ daemon (mirroir compact de `server/types.ts`).
 *
 * Le template volontairement ne définit *pas* les types métier (entités du
 * domaine). Les apps ajoutent leurs propres types dans ce fichier ou dans un
 * sous-module — voir `docs/customization-guide.md`.
 */
export type AgentEventKind =
  | "status"
  | "text_delta"
  | "thinking_delta"
  | "tool_use_start"
  | "tool_use_input"
  | "tool_use_end"
  | "tool_result"
  | "message_start"
  | "message_stop"
  | "result"
  | "usage"
  | "error"
  | "stderr"
  | "rate_limit"
  | "raw";

export interface UsageInfo {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_create_5m: number;
  cache_create_1h: number;
  message_id?: string;
}

export interface AgentEvent {
  kind: AgentEventKind;
  text?: string;
  status?: string;
  tool?: { id: string; name: string; input?: unknown; output?: unknown };
  result?: { success: boolean; output?: string; durationMs?: number; costUsd?: number };
  usage?: UsageInfo;
  error?: string;
  raw?: unknown;
  ts: number;
}

export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface RunRecord {
  id: string;
  prompt: string;
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  cwd: string;
  events: AgentEvent[];
  tag?: string;
}

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

export interface StartRunRequest {
  prompt: string;
  tag?: string;
  model?: string;
  addDirs?: string[];
  allowedTools?: string[];
  maxTurns?: number;
}

export interface StartRunResponse {
  runId: string;
}
