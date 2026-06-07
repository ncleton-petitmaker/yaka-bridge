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

const DATA_DIR_ENV_VAR = process.env.BRIDGE_MCP_DATA_DIR_ENV_VAR ?? "{{DATA_DIR_ENV_VAR}}";
const APP_SLUG = process.env.BRIDGE_MCP_SERVER_NAME ?? "{{APP_NAME_KEBAB}}";
const APP_VERSION = process.env.BRIDGE_MCP_APP_VERSION ?? process.env["{{APP_NAME_KEBAB_UPPER}}_APP_VERSION"] ?? "{{VERSION}}";
const MCP_PROXY_BASE_URL = process.env.BRIDGE_MCP_PROXY_BASE_URL?.replace(/\/+$/, "") ?? "";
const MCP_PROXY_ACCESS_TOKEN = process.env.BRIDGE_MCP_PROXY_ACCESS_TOKEN ?? "";

interface JsonRpcRequest {
  jsonrpc?: "2.0";
  id?: string | number | null;
  method: string;
  params?: any;
}

function dataDir(): string {
  return resolve(process.env.BRIDGE_MCP_DATA_DIR ?? process.env[DATA_DIR_ENV_VAR] ?? "./data");
}

function toolNameForAction(actionId: string): string {
  return actionId.replace(/\./g, "__");
}

function actionIdFromToolName(name: string): string | null {
  const normalized = name.replace(/^prix[-_]achats[-_]be__/, "").replace(/^bridge__/, "");
  return normalized.replace(/__/g, ".");
}

async function toolsList() {
  if (MCP_PROXY_BASE_URL) return proxyToolsList();
  return listActions().map((action) => ({
    name: toolNameForAction(action.id),
    description: action.description,
    inputSchema: action.inputJsonSchema,
  }));
}

async function proxyToolsList() {
  const res = await fetch(`${MCP_PROXY_BASE_URL}/api/actions`, {
    headers: proxyHeaders(),
  });
  if (!res.ok) throw new Error(`Registry actions indisponible (${res.status})`);
  const data = await res.json() as { actions?: Array<{ id: string; description?: string; inputSchema?: Record<string, unknown>; inputJsonSchema?: Record<string, unknown>; audit?: { dangerous?: boolean; adminOnly?: boolean } }> };
  return (data.actions ?? []).map((action) => ({
    name: toolNameForAction(action.id),
    description: action.description ?? action.id,
    inputSchema: action.inputSchema ?? action.inputJsonSchema ?? { type: "object", properties: {}, additionalProperties: false },
    dangerous: action.audit?.dangerous,
    adminOnly: action.audit?.adminOnly,
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
      return result(req.id, { tools: await toolsList() });

    case "tools/call": {
      const name = String(req.params?.name ?? "");
      const actionId = actionIdFromToolName(name);
      if (!actionId) return error(req.id, -32602, `Unknown tool: ${name}`);
      try {
        const output = MCP_PROXY_BASE_URL
          ? await proxyCallAction(actionId, req.params?.arguments ?? {})
          : await callAction(actionId, ctx(), req.params?.arguments ?? {});
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

async function proxyCallAction(actionId: string, args: unknown) {
  if (!MCP_PROXY_ACCESS_TOKEN) throw new Error("Token Bridge manquant pour appeler le service MCP proxy.");
  const res = await fetch(`${MCP_PROXY_BASE_URL}/api/actions/${encodeURIComponent(actionId)}`, {
    method: "POST",
    headers: proxyHeaders({ json: true }),
    body: JSON.stringify(args ?? {}),
  });
  const data = await res.json().catch(() => ({})) as { ok?: boolean; output?: unknown; error?: string };
  if (!res.ok || data.ok === false) {
    throw new Error(data.error ?? `Action ${actionId} échouée (${res.status})`);
  }
  return data.output ?? data;
}

function proxyHeaders(opts: { json?: boolean } = {}): Record<string, string> {
  const headers: Record<string, string> = {};
  if (MCP_PROXY_ACCESS_TOKEN) {
    headers.Authorization = `Bearer ${MCP_PROXY_ACCESS_TOKEN}`;
    headers["x-bridge-token"] = MCP_PROXY_ACCESS_TOKEN;
  }
  if (opts.json) headers["Content-Type"] = "application/json";
  return headers;
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

process.stderr.write(`[${APP_SLUG}:mcp] ready dataDir=${dataDir()} proxy=${MCP_PROXY_BASE_URL || "local"}\n`);
