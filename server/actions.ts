import { z } from "zod";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { findClaudeBin } from "./agents.js";
import { getAgentStatus } from "./agents-status.js";
import {
  AVAILABLE_MODELS,
  loadAppConfig,
  saveAppConfig,
  type AppConfig,
} from "./app-config.js";
import {
  appendAuditEvent,
  computeAuditStats,
  readAuditEvents,
  verifyAuditLogIntegrity,
  type AuditEventInput,
} from "./audit-log.js";
import { getPricingMetadata } from "./pricing.js";
import {
  attachListener,
  cancelRun,
  getRun,
  getRunUsage,
  listRuns,
  startRun,
} from "./runs.js";
import {
  listGlobalSkills,
  listPersoSkills,
  writeGlobalSkill,
} from "./skills.js";
import { getSupabasePublicConfig } from "./supabase.js";

export interface ActionContext {
  dataDir: string;
  actorId?: string;
  actorRole?: string;
  clientIp?: string;
  appVersion?: string;
  signal?: AbortSignal;
}

export interface ActionAuditSpec {
  action: string;
  resourceType: string;
  dangerous?: boolean;
  adminOnly?: boolean;
}

export interface AppAction<I = unknown, O = unknown> {
  id: string;
  description: string;
  inputSchema: z.ZodType<I>;
  inputJsonSchema: Record<string, unknown>;
  audit?: ActionAuditSpec;
  handler(ctx: ActionContext, input: I): Promise<O> | O;
}

function objectSchema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

function actor(ctx: ActionContext): { actor_id: string; actor_role: string } {
  return {
    actor_id: ctx.actorId ?? "local-agent",
    actor_role: ctx.actorRole ?? "agent",
  };
}

function audit(ctx: ActionContext, spec: ActionAuditSpec, result: "success" | "failure", metadata?: Record<string, unknown>, resourceId?: string): void {
  try {
    const cfg = loadAppConfig(ctx.dataDir);
    const a = actor(ctx);
    const input: AuditEventInput = {
      actor_id: a.actor_id,
      actor_role: a.actor_role,
      action: spec.action,
      resource_type: spec.resourceType,
      resource_id: resourceId,
      result,
      app_version: ctx.appVersion ?? process.env["{{APP_NAME_KEBAB_UPPER}}_APP_VERSION"] ?? "{{VERSION}}",
      client_ip: ctx.clientIp ?? "mcp/local",
      metadata,
    };
    appendAuditEvent(ctx.dataDir, input, cfg.auditLogDir);
  } catch (err) {
    console.warn("[actions:audit] failed:", err);
  }
}

const EmptySchema = z.object({}).strict();
const IdSchema = z.object({ id: z.string().min(1) }).strict();

const StartRunSchema = z.object({
  prompt: z.string().min(1),
  tag: z.string().optional(),
  model: z.string().optional(),
  addDirs: z.array(z.string()).optional(),
  allowedTools: z.array(z.string()).optional(),
  maxTurns: z.number().int().min(1).max(100).optional(),
  cwd: z.string().optional(),
}).strict();

type StartRunInput = z.infer<typeof StartRunSchema>;

const UpdateAppConfigSchema = z.object({
  model: z.string().optional(),
  databaseProvider: z.literal("supabase").optional(),
  supabaseUrl: z.string().url().or(z.literal("")).optional(),
  supabaseAnonKey: z.string().optional(),
  inputDir: z.string().optional(),
  outputDir: z.string().optional(),
  auditLogDir: z.string().optional(),
  maxConcurrentRuns: z.number().int().min(1).max(50).optional(),
  requiredDirs: z.array(z.object({
    key: z.string(),
    label: z.string(),
    subdirs: z.array(z.string()).optional(),
  })).optional(),
}).strict();

const ListSkillsSchema = z.object({ user: z.string().optional() }).strict();
const WriteSkillSchema = z.object({ slug: z.string().min(1), raw: z.string().min(1) }).strict();
const AuditReadSchema = z.object({ since: z.string().optional(), user: z.string().optional(), limit: z.number().int().min(1).max(5000).optional() }).strict();
const AuditStatsSchema = z.object({ windowDays: z.number().int().min(1).max(365).optional() }).strict();

export const appActions = {
  "health.get": {
    id: "health.get",
    description: "Get daemon health, version, data directory and Claude binary status.",
    inputSchema: EmptySchema,
    inputJsonSchema: objectSchema({}),
    handler: (ctx: ActionContext) => ({
      ok: true,
      ts: new Date().toISOString(),
      version: ctx.appVersion ?? process.env["{{APP_NAME_KEBAB_UPPER}}_APP_VERSION"] ?? "{{VERSION}}",
      claude: findClaudeBin(),
      dataDir: ctx.dataDir,
      dataDirExists: existsSync(ctx.dataDir),
      database: getSupabasePublicConfig(ctx.dataDir),
      pricing: getPricingMetadata(),
    }),
  },
  "agents.status": {
    id: "agents.status",
    description: "Return local Claude Code CLI status.",
    inputSchema: EmptySchema,
    inputJsonSchema: objectSchema({}),
    handler: async () => ({ agents: [await getAgentStatus()] }),
  },
  "appConfig.get": {
    id: "appConfig.get",
    description: "Read app configuration and available models.",
    inputSchema: EmptySchema,
    inputJsonSchema: objectSchema({}),
    handler: (ctx: ActionContext) => ({
      config: loadAppConfig(ctx.dataDir),
      availableModels: AVAILABLE_MODELS,
      database: getSupabasePublicConfig(ctx.dataDir),
    }),
  },
  "appConfig.update": {
    id: "appConfig.update",
    description: "Update app configuration. Same operation as the settings UI.",
    inputSchema: UpdateAppConfigSchema,
    inputJsonSchema: objectSchema({
      model: { type: "string" },
      databaseProvider: { type: "string", enum: ["supabase"] },
      supabaseUrl: { type: "string" },
      supabaseAnonKey: { type: "string" },
      inputDir: { type: "string" },
      outputDir: { type: "string" },
      auditLogDir: { type: "string" },
      maxConcurrentRuns: { type: "number" },
      requiredDirs: { type: "array", items: { type: "object" } },
    }),
    audit: { action: "app-config.update", resourceType: "app-config" },
    handler: (ctx: ActionContext, input: Partial<AppConfig>) => {
      const config = saveAppConfig(ctx.dataDir, input);
      return { config };
    },
  },
  "runs.start": {
    id: "runs.start",
    description: "Start a Claude Code run. Long-running progress is available via runs.get/list and SSE in the UI.",
    inputSchema: StartRunSchema,
    inputJsonSchema: objectSchema({
      prompt: { type: "string" },
      tag: { type: "string" },
      model: { type: "string" },
      addDirs: { type: "array", items: { type: "string" } },
      allowedTools: { type: "array", items: { type: "string" } },
      maxTurns: { type: "number" },
      cwd: { type: "string" },
    }, ["prompt"]),
    audit: { action: "run.start", resourceType: "run" },
    handler: (ctx: ActionContext, input: StartRunInput) => {
      const cfg = loadAppConfig(ctx.dataDir);
      const cwd = input.cwd ? resolve(input.cwd) : ctx.dataDir;
      const run = startRun({
        prompt: input.prompt,
        cwd,
        tag: input.tag,
        model: input.model ?? cfg.model,
        addDirs: input.addDirs,
        allowedTools: input.allowedTools,
        maxTurns: input.maxTurns,
      });
      return { run };
    },
  },
  "runs.list": {
    id: "runs.list",
    description: "List in-memory runs and their statuses.",
    inputSchema: EmptySchema,
    inputJsonSchema: objectSchema({}),
    handler: () => ({ runs: listRuns() }),
  },
  "runs.get": {
    id: "runs.get",
    description: "Get one run by id.",
    inputSchema: IdSchema,
    inputJsonSchema: objectSchema({ id: { type: "string" } }, ["id"]),
    handler: (_ctx: ActionContext, input: { id: string }) => ({ run: getRun(input.id) }),
  },
  "runs.usage": {
    id: "runs.usage",
    description: "Get token/cost usage for one run.",
    inputSchema: IdSchema,
    inputJsonSchema: objectSchema({ id: { type: "string" } }, ["id"]),
    handler: (_ctx: ActionContext, input: { id: string }) => ({ usage: getRunUsage(input.id) }),
  },
  "runs.cancel": {
    id: "runs.cancel",
    description: "Cancel a running Claude Code run by id. Same action as the UI stop button.",
    inputSchema: IdSchema,
    inputJsonSchema: objectSchema({ id: { type: "string" } }, ["id"]),
    audit: { action: "run.cancel", resourceType: "run", dangerous: true },
    handler: (_ctx: ActionContext, input: { id: string }) => {
      cancelRun(input.id);
      return { ok: true, id: input.id };
    },
  },
  "skills.list": {
    id: "skills.list",
    description: "List global and personal skills loaded by the app.",
    inputSchema: ListSkillsSchema,
    inputJsonSchema: objectSchema({ user: { type: "string" } }),
    handler: (ctx: ActionContext, input: { user?: string }) => {
      const user = input.user ?? "default";
      return { global: listGlobalSkills(ctx.dataDir), perso: listPersoSkills(ctx.dataDir, user) };
    },
  },
  "skills.writeGlobal": {
    id: "skills.writeGlobal",
    description: "Write or replace a global skill markdown file.",
    inputSchema: WriteSkillSchema,
    inputJsonSchema: objectSchema({ slug: { type: "string" }, raw: { type: "string" } }, ["slug", "raw"]),
    audit: { action: "skill.write-global", resourceType: "skill", adminOnly: true },
    handler: (ctx: ActionContext, input: { slug: string; raw: string }) => ({ skill: writeGlobalSkill(ctx.dataDir, input.slug, input.raw) }),
  },
  "audit.read": {
    id: "audit.read",
    description: "Read audit log events.",
    inputSchema: AuditReadSchema,
    inputJsonSchema: objectSchema({ since: { type: "string" }, user: { type: "string" }, limit: { type: "number" } }),
    handler: (ctx: ActionContext, input: { since?: string; user?: string; limit?: number }) => ({
      events: readAuditEvents(ctx.dataDir, {
        from: input.since,
        actor_id: input.user,
        limit: input.limit,
      }),
    }),
  },
  "audit.stats": {
    id: "audit.stats",
    description: "Compute audit statistics over a rolling window.",
    inputSchema: AuditStatsSchema,
    inputJsonSchema: objectSchema({ windowDays: { type: "number" } }),
    handler: (ctx: ActionContext, input: { windowDays?: number }) => ({ stats: computeAuditStats(ctx.dataDir, input.windowDays ?? 7) }),
  },
  "audit.verify": {
    id: "audit.verify",
    description: "Verify chained SHA-256 audit log integrity.",
    inputSchema: z.object({ user: z.string().optional(), date: z.string().optional() }).strict(),
    inputJsonSchema: objectSchema({ user: { type: "string" }, date: { type: "string" } }),
    handler: (ctx: ActionContext) => ({ integrity: verifyAuditLogIntegrity(ctx.dataDir) }),
  },
} satisfies Record<string, AppAction<any, any>>;

export type AppActionId = keyof typeof appActions;

export function listActions(): AppAction[] {
  return Object.values(appActions) as AppAction[];
}

export async function callAction(id: string, ctx: ActionContext, rawInput: unknown): Promise<unknown> {
  const action = appActions[id as AppActionId] as AppAction | undefined;
  if (!action) throw new Error(`Unknown action: ${id}`);
  const input = action.inputSchema.parse(rawInput ?? {});
  if (action.audit?.adminOnly && ctx.actorRole !== "admin") {
    audit(ctx, action.audit, "failure", { actionId: id, reason: "admin-only" });
    throw new Error(`Action admin requise: ${id}`);
  }
  try {
    const result = await action.handler(ctx, input);
    if (action.audit) {
      const resourceId = typeof input === "object" && input && "id" in input ? String((input as { id?: unknown }).id) : undefined;
      audit(ctx, action.audit, "success", { actionId: id }, resourceId);
    }
    return result;
  } catch (err) {
    if (action.audit) audit(ctx, action.audit, "failure", { actionId: id, error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

// Keep attachListener reachable to generated domain actions that want to reuse
// the generic SSE fan-out without importing from runs.ts directly.
export { attachListener };
