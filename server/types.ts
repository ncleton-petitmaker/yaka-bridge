/**
 * Types partagés entre daemon et UI.
 * Adaptés du pattern opendesign (claude-stream-json) au format Claude Code 2.x.
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

/**
 * Usage tokens reportés par Claude pour un tour d'assistant.
 * Source : `message_start.message.usage` ou `assistant.message.usage` du
 * stream-json du CLI. Plusieurs events `usage` peuvent être émis dans un même
 * run (un par tour Claude) ; le consommateur agrège.
 */
export interface UsageInfo {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_create_5m: number;
  cache_create_1h: number;
  /**
   * Identifiant Anthropic du message source (ex: "msg_01XXX..."). Quand
   * Claude Code émet plusieurs usage pour un même tour (start partiel +
   * assistant final), tous portent le même id : permet au consommateur de
   * dédupliquer en gardant la dernière émission (qui a le `output_tokens`
   * cumulé final).
   */
  message_id?: string;
}

export interface AgentEvent {
  kind: AgentEventKind;
  /** Texte streamé (text_delta / thinking_delta) */
  text?: string;
  /** Statut "requesting", "completed", etc. */
  status?: string;
  /** Tool use info */
  tool?: {
    id: string;
    name: string;
    input?: unknown;
    output?: unknown;
  };
  /** Résultat final */
  result?: {
    success: boolean;
    output?: string;
    durationMs?: number;
    costUsd?: number;
  };
  /** Tokens consommés (kind === "usage"). */
  usage?: UsageInfo;
  /** Erreur */
  error?: string;
  /** Event brut Claude (debug) */
  raw?: unknown;
  /** Horodatage côté daemon */
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
  /** Liste des events accumulés (pour replay sur reconnexion SSE) */
  events: AgentEvent[];
  /**
   * Tag libre fourni par le caller, utilisé comme nom de fichier pour
   * persister les events sur disque (`<dataDir>/runs/<tag>.events.jsonl`).
   * Si absent, les events ne sont pas persistés.
   */
  tag?: string;
}

export interface ChatRequest {
  /** Prompt à envoyer à Claude Code via stdin */
  message: string;
  /** Profil utilisateur connecté (pour charger ses skills perso) */
  user?: string;
  /** Modèle à utiliser, par défaut "sonnet" */
  model?: string;
  /** Dossier de travail (cwd du subprocess), relatif à data/ */
  workdir?: string;
  /** Tag libre pour la persistance des events (cf. RunRecord.tag) */
  tag?: string;
}

export interface ChatRunCreated {
  runId: string;
}
