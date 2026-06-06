#!/usr/bin/env node
/**
 * Serveur MCP stdio minimal pour l'app générée.
 *
 * Il expose le registry `server/actions.ts` comme tools MCP. C'est le socle
 * agentic-first : l'UI et les agents passent par les mêmes handlers serveur.
 */
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { callAction, listActions, type ActionContext } from "./actions.js";

const DATA_DIR_ENV_VAR = "{{DATA_DIR_ENV_VAR}}";
const APP_SLUG = "{{APP_NAME_KEBAB}}";
const APP_VERSION = process.env["{{APP_NAME_KEBAB_UPPER}}_APP_VERSION"] ?? "{{VERSION}}";

interface JsonRpcRequest {
  jsonrpc?: "2.0";
  id?: string | number | null;
  method: string;
  params?: any;
}

function dataDir(): string {
  return resolve(process.env[DATA_DIR_ENV_VAR] ?? "./data");
}

function toolNameForAction(actionId: string): string {
  return `${APP_SLUG}__${actionId.replace(/\./g, "__")}`;
}

function actionIdFromToolName(name: string): string | null {
  const prefix = `${APP_SLUG}__`;
  if (!name.startsWith(prefix)) return null;
  return name.slice(prefix.length).replace(/__/g, ".");
}

function toolsList() {
  return listActions().map((action) => ({
    name: toolNameForAction(action.id),
    description: action.description,
    inputSchema: action.inputJsonSchema,
  }));
}

function ctx(): ActionContext {
  return {
    dataDir: dataDir(),
    actorId: process.env.MCP_ACTOR_ID ?? "mcp-agent",
    actorRole: process.env.MCP_ACTOR_ROLE ?? "agent",
    clientIp: "mcp/stdio",
    appVersion: APP_VERSION,
  };
}

function send(msg: unknown) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function result(id: JsonRpcRequest["id"], value: unknown) {
  send({ jsonrpc: "2.0", id, result: value });
}

function error(id: JsonRpcRequest["id"], code: number, message: string, data?: unknown) {
  send({ jsonrpc: "2.0", id, error: { code, message, data } });
}

async function handle(req: JsonRpcRequest) {
  if (req.id == null && req.method.startsWith("notifications/")) return;

  switch (req.method) {
    case "initialize":
      return result(req.id, {
        protocolVersion: req.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: APP_SLUG, version: APP_VERSION },
      });

    case "tools/list":
      return result(req.id, { tools: toolsList() });

    case "tools/call": {
      const name = String(req.params?.name ?? "");
      const actionId = actionIdFromToolName(name);
      if (!actionId) return error(req.id, -32602, `Unknown tool prefix: ${name}`);
      try {
        const output = await callAction(actionId, ctx(), req.params?.arguments ?? {});
        return result(req.id, {
          content: [
            {
              type: "text",
              text: JSON.stringify(output, null, 2),
            },
          ],
          structuredContent: output,
        });
      } catch (err) {
        return result(req.id, {
          isError: true,
          content: [
            {
              type: "text",
              text: err instanceof Error ? err.message : String(err),
            },
          ],
        });
      }
    }

    default:
      return error(req.id, -32601, `Method not found: ${req.method}`);
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let req: JsonRpcRequest;
  try {
    req = JSON.parse(line);
  } catch (err) {
    return error(null, -32700, "Parse error", err instanceof Error ? err.message : String(err));
  }
  handle(req).catch((err) => error(req.id, -32000, err instanceof Error ? err.message : String(err)));
});

process.stderr.write(`[${APP_SLUG}:mcp] ready dataDir=${dataDir()}\n`);
