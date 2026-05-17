/**
 * Parser claude-stream-json -> AgentEvent typé.
 * Format vérifié sur Claude Code 2.1.x (mai 2026) :
 *   - {type:"system", subtype:"init"|"status"|"hook_*"}
 *   - {type:"stream_event", event:{type:"message_start"|"content_block_*"|"message_*"}}
 *   - {type:"assistant", message:{...}}
 *   - {type:"user", message:{...}}              // tool_results
 *   - {type:"result", subtype:"success"|"error"}
 *   - {type:"rate_limit_event"}
 *
 * Usage tokens : extraits du sous-objet `usage` présent sur
 * `stream_event.event.message.usage` (au message_start) et sur
 * `assistant.message.usage` (à chaque tour). Émis comme event `kind:"usage"`
 * pour permettre au daemon d'agréger les coûts en temps réel.
 */
import type { AgentEvent, UsageInfo } from "./types.js";

interface ToolUseBuffer {
  id: string;
  name: string;
  inputJsonChunks: string[];
}

/**
 * Extrait un `UsageInfo` depuis un objet `message` Anthropic, ou null si
 * aucun champ usage exploitable. Tolérant aux champs absents (un message_start
 * peut avoir input_tokens=9 et cache_creation_input_tokens=50000 par ex).
 */
function extractUsage(message: any): UsageInfo | null {
  if (!message || typeof message !== "object") return null;
  const u = message.usage;
  if (!u || typeof u !== "object") return null;
  const input_tokens = Number(u.input_tokens ?? 0) || 0;
  const output_tokens = Number(u.output_tokens ?? 0) || 0;
  const cache_read = Number(u.cache_read_input_tokens ?? 0) || 0;
  // Anthropic expose 2 niveaux : `cache_creation_input_tokens` (somme totale)
  // et `cache_creation.{ephemeral_5m_input_tokens,ephemeral_1h_input_tokens}`
  // (détail par TTL). On préfère le détail s'il existe pour différencier les
  // tarifs (5m vs 1h), sinon on retombe sur la somme en l'attribuant à 5m.
  let cache_create_5m = 0;
  let cache_create_1h = 0;
  const detail = u.cache_creation;
  if (detail && typeof detail === "object") {
    cache_create_5m = Number(detail.ephemeral_5m_input_tokens ?? 0) || 0;
    cache_create_1h = Number(detail.ephemeral_1h_input_tokens ?? 0) || 0;
  }
  if (cache_create_5m === 0 && cache_create_1h === 0) {
    cache_create_5m = Number(u.cache_creation_input_tokens ?? 0) || 0;
  }
  // Aucune métrique non nulle = on n'émet pas (event vide inutile)
  if (
    input_tokens === 0 &&
    output_tokens === 0 &&
    cache_read === 0 &&
    cache_create_5m === 0 &&
    cache_create_1h === 0
  ) {
    return null;
  }
  const model = typeof message.model === "string" ? message.model : "";
  const message_id =
    typeof message.id === "string" ? message.id : undefined;
  return {
    model,
    input_tokens,
    output_tokens,
    cache_read,
    cache_create_5m,
    cache_create_1h,
    message_id,
  };
}

export class StreamParser {
  private buffer = "";
  /** index Claude content_block index -> tool_use accumulator */
  private toolUseBuffers = new Map<number, ToolUseBuffer>();

  feed(chunk: string): AgentEvent[] {
    this.buffer += chunk;
    const out: AgentEvent[] = [];
    let nlIdx: number;
    while ((nlIdx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nlIdx).trim();
      this.buffer = this.buffer.slice(nlIdx + 1);
      if (!line) continue;
      const ev = this.parseLine(line);
      if (ev) out.push(...ev);
    }
    return out;
  }

  /** Vidange en fin de stream (au cas où la dernière ligne n'a pas de \n) */
  flush(): AgentEvent[] {
    const rest = this.buffer.trim();
    this.buffer = "";
    if (!rest) return [];
    const ev = this.parseLine(rest);
    return ev ?? [];
  }

  private parseLine(line: string): AgentEvent[] | null {
    let json: any;
    try {
      json = JSON.parse(line);
    } catch {
      // ligne non-JSON, ignorer (ou émettre raw pour debug)
      return [{ kind: "raw", raw: line, ts: Date.now() }];
    }
    return this.dispatch(json);
  }

  private dispatch(j: any): AgentEvent[] | null {
    const ts = Date.now();

    if (j.type === "system") {
      if (j.subtype === "status" && typeof j.status === "string") {
        return [{ kind: "status", status: j.status, ts }];
      }
      // ignore init, hook_*, etc. (trop bruyant)
      return null;
    }

    if (j.type === "stream_event" && j.event) {
      return this.handleStreamEvent(j.event, ts);
    }

    if (j.type === "assistant") {
      // `assistant.message.usage` contient le `usage` final pour ce tour
      // (input + cache + output_tokens cumulé). On émet : la dédup par
      // `message_id` côté daemon garantit qu'un tour qui a aussi été émis
      // via message_start n'est compté qu'une fois.
      const usage = extractUsage(j.message);
      if (usage) return [{ kind: "usage", usage, ts }];
      return null;
    }

    if (j.type === "user" && j.message?.content) {
      // contient les tool_results
      const results: AgentEvent[] = [];
      const blocks = Array.isArray(j.message.content) ? j.message.content : [];
      for (const blk of blocks) {
        if (blk.type === "tool_result") {
          results.push({
            kind: "tool_result",
            tool: {
              id: blk.tool_use_id,
              name: "(reply)",
              output: blk.content,
            },
            ts,
          });
        }
      }
      return results;
    }

    if (j.type === "result") {
      return [
        {
          kind: "result",
          result: {
            success: j.subtype === "success" && !j.is_error,
            output: typeof j.result === "string" ? j.result : undefined,
            durationMs: j.duration_ms,
            costUsd: j.total_cost_usd,
          },
          ts,
        },
      ];
    }

    if (j.type === "rate_limit_event") {
      return [{ kind: "rate_limit", raw: j.rate_limit_info, ts }];
    }

    return null;
  }

  private handleStreamEvent(event: any, ts: number): AgentEvent[] | null {
    switch (event.type) {
      case "message_start": {
        // On émet `usage` ici aussi : c'est la première occurrence où on
        // connaît `input_tokens` + caches (le `assistant` event qui clôture
        // le tour les ré-émettra avec `output_tokens` final). La dédup par
        // `message_id` côté daemon (runs.ts) évite de doubler.
        const out: AgentEvent[] = [{ kind: "message_start", ts }];
        const usage = extractUsage(event.message);
        if (usage) out.push({ kind: "usage", usage, ts });
        return out;
      }
      case "message_stop":
        return [{ kind: "message_stop", ts }];
      case "content_block_start": {
        const block = event.content_block;
        if (block?.type === "tool_use") {
          const idx = event.index;
          this.toolUseBuffers.set(idx, {
            id: block.id,
            name: block.name,
            inputJsonChunks: [],
          });
          return [
            {
              kind: "tool_use_start",
              tool: { id: block.id, name: block.name },
              ts,
            },
          ];
        }
        return null;
      }
      case "content_block_delta": {
        const delta = event.delta;
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          return [{ kind: "text_delta", text: delta.text, ts }];
        }
        if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
          return [{ kind: "thinking_delta", text: delta.thinking, ts }];
        }
        if (delta?.type === "input_json_delta") {
          const buf = this.toolUseBuffers.get(event.index);
          if (buf && typeof delta.partial_json === "string") {
            buf.inputJsonChunks.push(delta.partial_json);
          }
          return null;
        }
        return null;
      }
      case "content_block_stop": {
        const buf = this.toolUseBuffers.get(event.index);
        if (buf) {
          let input: unknown = undefined;
          try {
            input = JSON.parse(buf.inputJsonChunks.join(""));
          } catch {
            input = { _raw: buf.inputJsonChunks.join("") };
          }
          this.toolUseBuffers.delete(event.index);
          return [
            {
              kind: "tool_use_end",
              tool: { id: buf.id, name: buf.name, input },
              ts,
            },
          ];
        }
        return null;
      }
      default:
        return null;
    }
  }
}
