/**
 * Parser `codex exec --json` (JSONL) -> AgentEvent typé.
 * Format vérifié sur codex-cli 0.135.0 (juin 2026) :
 *   - {type:"thread.started", thread_id}
 *   - {type:"turn.started"}
 *   - {type:"item.started"|"item.updated"|"item.completed", item:{id,type,...}}
 *   - {type:"turn.completed", usage:{input_tokens,cached_input_tokens,output_tokens,reasoning_output_tokens}}
 *   - {type:"turn.failed", error:{message}}
 *   - {type:"error", message}
 *
 * Types d'items : agent_message, reasoning, command_execution, file_change,
 * mcp_tool_call, web_search, todo_list.
 *
 * On mappe vers l'union AgentEvent invariante du template (text_delta,
 * tool_use_start/end, tool_result, usage, error...) : l'UI runs/SSE
 * existante consomme le flux sans changement.
 */
import type { AgentEvent, UsageInfo } from "./types.js";

/** Tronque les sorties de commandes pour ne pas gonfler la mémoire des runs. */
function clip(value: unknown, max = 4000): unknown {
  if (typeof value !== "string") return value;
  return value.length > max ? value.slice(0, max) + `… [tronqué, ${value.length} chars]` : value;
}

export class CodexStreamParser {
  private buffer = "";
  /**
   * Compteur de tours : sert d'identifiant de message pour l'agrégation
   * usage côté runs.ts (chaque turn.completed est unique, pas de dédup
   * nécessaire contrairement au double-émission de Claude Code).
   */
  private turnCount = 0;
  /** Thread codex de la session (utile pour `codex exec resume` plus tard). */
  threadId: string | null = null;
  /**
   * Dernier message d'erreur émis : codex envoie souvent {type:"error"} puis
   * {type:"turn.failed"} avec le même message, on dédoublonne pour l'UI.
   */
  private lastErrorMessage: string | null = null;

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
      // Ligne non-JSON (logs parasites de codex sur stdout) : raw pour debug
      return [{ kind: "raw", raw: line, ts: Date.now() }];
    }
    return this.dispatch(json);
  }

  private dispatch(j: any): AgentEvent[] | null {
    const ts = Date.now();

    switch (j.type) {
      case "thread.started": {
        this.threadId = typeof j.thread_id === "string" ? j.thread_id : null;
        return [{ kind: "status", status: "session démarrée", raw: this.threadId, ts }];
      }

      case "turn.started": {
        this.turnCount++;
        return [{ kind: "message_start", ts }];
      }

      case "turn.completed": {
        const out: AgentEvent[] = [];
        const u = j.usage;
        if (u && typeof u === "object") {
          const usage: UsageInfo = {
            // codex ne renvoie pas le modèle dans l'event : runs.ts retombe
            // sur le modèle demandé au lancement.
            model: "",
            input_tokens: Number(u.input_tokens ?? 0) || 0,
            output_tokens: Number(u.output_tokens ?? 0) || 0,
            cache_read: Number(u.cached_input_tokens ?? 0) || 0,
            cache_create_5m: 0,
            cache_create_1h: 0,
            message_id: `turn_${this.turnCount}`,
          };
          if (usage.input_tokens || usage.output_tokens || usage.cache_read) {
            out.push({ kind: "usage", usage, ts });
          }
        }
        out.push({ kind: "message_stop", ts });
        return out;
      }

      case "turn.failed": {
        const msg =
          typeof j.error?.message === "string" ? j.error.message : "Le tour Codex a échoué.";
        if (msg === this.lastErrorMessage) return null;
        this.lastErrorMessage = msg;
        return [{ kind: "error", error: msg, ts }];
      }

      case "error": {
        const msg = typeof j.message === "string" ? j.message : JSON.stringify(j);
        this.lastErrorMessage = msg;
        return [{ kind: "error", error: msg, ts }];
      }

      case "item.started":
      case "item.updated":
      case "item.completed":
        return this.handleItem(j.type, j.item, ts);

      default:
        return [{ kind: "raw", raw: j, ts }];
    }
  }

  private handleItem(
    phase: "item.started" | "item.updated" | "item.completed",
    item: any,
    ts: number
  ): AgentEvent[] | null {
    if (!item || typeof item !== "object") return null;
    const id = String(item.id ?? `item_${ts}`);

    switch (item.type) {
      case "agent_message": {
        // codex --json n'émet pas de deltas token par token : le texte du
        // message arrive entier à item.completed. On l'émet en text_delta
        // unique, l'UI accumule comme pour un stream classique.
        if (phase !== "item.completed") return null;
        return typeof item.text === "string" && item.text
          ? [{ kind: "text_delta", text: item.text, ts }]
          : null;
      }

      case "reasoning": {
        if (phase !== "item.completed") return null;
        return typeof item.text === "string" && item.text
          ? [{ kind: "thinking_delta", text: item.text, ts }]
          : null;
      }

      case "command_execution": {
        const input = typeof item.command === "string" ? item.command : undefined;
        if (phase === "item.started") {
          return [{ kind: "tool_use_start", tool: { id, name: "shell", input }, ts }];
        }
        if (phase === "item.completed") {
          return [
            { kind: "tool_use_end", tool: { id, name: "shell", input }, ts },
            {
              kind: "tool_result",
              tool: {
                id,
                name: "shell",
                output: {
                  exit_code: item.exit_code,
                  status: item.status,
                  output: clip(item.aggregated_output),
                },
              },
              ts,
            },
          ];
        }
        return null;
      }

      case "mcp_tool_call": {
        const name = [item.server, item.tool].filter(Boolean).join(".") || "mcp";
        if (phase === "item.started") {
          return [{ kind: "tool_use_start", tool: { id, name, input: item.arguments }, ts }];
        }
        if (phase === "item.completed") {
          return [
            { kind: "tool_use_end", tool: { id, name, input: item.arguments }, ts },
            {
              kind: "tool_result",
              tool: { id, name, output: clip(item.result ?? item.status) },
              ts,
            },
          ];
        }
        return null;
      }

      case "web_search": {
        if (phase !== "item.completed") return null;
        return [{ kind: "tool_use_end", tool: { id, name: "web_search", input: item.query }, ts }];
      }

      case "file_change": {
        if (phase !== "item.completed") return null;
        return [{ kind: "tool_use_end", tool: { id, name: "file_change", input: item.changes }, ts }];
      }

      case "todo_list":
        // Plan interne codex : trop bruyant pour l'UI, on ignore.
        return null;

      default:
        return phase === "item.completed" ? [{ kind: "raw", raw: item, ts }] : null;
    }
  }
}
