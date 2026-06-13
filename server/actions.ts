import { z } from "zod";
import { existsSync } from "node:fs";
import { findClaudeBin } from "./agents.js";
import { assertAgentProviderReady, getAgentStatus } from "./agents-status.js";
import {
  AVAILABLE_MODELS,
  codexRunModelOptions,
  loadAppConfig,
  saveAppConfig,
  type AgentProvider,
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
import { allowedRunRoots, assertInsideRoots } from "./path-guard.js";
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
import { getSupabasePublicConfig, getSupabaseServerClient } from "./supabase.js";
import type { BridgeEntitlement, BridgeRole } from "./authz.js";

export interface ActionContext {
  dataDir: string;
  actorId?: string;
  actorRole?: string;
  userId?: string;
  organizationId?: string;
  membershipRole?: BridgeRole;
  entitlements?: BridgeEntitlement[];
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
  requiredServiceScopes?: Array<{ serviceId: string; scopes: string[] }>;
  requiredAnyScopes?: string[];
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
      app_version: ctx.appVersion ?? process.env["{{APP_NAME_KEBAB_UPPER}}_APP_VERSION"] ?? "0.0.1",
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
  agentProvider: z.enum(["codex-cloud", "codex-lmstudio"]).optional(),
  localModel: z.string().optional(),
  addDirs: z.array(z.string()).optional(),
  allowedTools: z.array(z.string()).optional(),
  maxTurns: z.number().int().min(1).max(100).optional(),
  cwd: z.string().optional(),
}).strict();

type StartRunInput = z.infer<typeof StartRunSchema>;

const UpdateAppConfigSchema = z.object({
  agentProvider: z.enum(["codex-cloud", "codex-lmstudio"]).optional(),
  model: z.string().optional(),
  localModel: z.string().optional(),
  databaseProvider: z.literal("supabase").optional(),
  supabaseUrl: z.string().url().or(z.literal("")).optional(),
  supabaseAnonKey: z.string().optional(),
  inputDir: z.string().optional(),
  outputDir: z.string().optional(),
  auditLogDir: z.string().optional(),
  maxConcurrentRuns: z.number().int().min(1).max(50).optional(),
  automations: z.object({
    gmailSupplierInvoices: z.object({
      enabled: z.boolean().optional(),
      periodStart: z.string().optional(),
      periodEnd: z.string().optional(),
      supplierTypes: z.array(z.string()).optional(),
      excludedSupplierTypes: z.array(z.string()).optional(),
      gmailQuery: z.string().optional(),
      pennylaneMcpServer: z.string().optional(),
      schedule: z.enum(["manual", "daily", "weekly", "monthly"]).optional(),
    }).strict().optional(),
  }).strict().optional(),
}).strict();

const ListSkillsSchema = z.object({ user: z.string().optional() }).strict();
const WriteSkillSchema = z.object({ slug: z.string().min(1), raw: z.string().min(1) }).strict();
const AuditReadSchema = z.object({ since: z.string().optional(), user: z.string().optional(), limit: z.number().int().min(1).max(5000).optional() }).strict();
const AuditStatsSchema = z.object({ windowDays: z.number().int().min(1).max(365).optional() }).strict();
const PurchasingQuoteImportSchema = z.object({
  supplierName: z.string().min(1),
  supplierExternalRef: z.string().min(1).optional(),
  title: z.string().min(1),
  amount: z.number().nonnegative().optional(),
  currency: z.string().min(3).max(3).optional(),
  riskLevel: z.enum(["unknown", "low", "medium", "high"]).optional(),
}).strict();
const PurchasingQuoteAnalyzeSchema = z.object({
  quoteIds: z.array(z.string().uuid()).optional(),
}).strict();

type PurchasingQuoteImportInput = z.infer<typeof PurchasingQuoteImportSchema>;
type PurchasingQuoteAnalyzeInput = z.infer<typeof PurchasingQuoteAnalyzeSchema>;

export const appActions = {
  "health.get": {
    id: "health.get",
    description: "Get daemon health, version, data directory and Claude binary status.",
    inputSchema: EmptySchema,
    inputJsonSchema: objectSchema({}),
    handler: (ctx: ActionContext) => ({
      ok: true,
      ts: new Date().toISOString(),
      version: ctx.appVersion ?? process.env["{{APP_NAME_KEBAB_UPPER}}_APP_VERSION"] ?? "0.0.1",
      claude: findClaudeBin(),
      dataDir: ctx.dataDir,
      dataDirExists: existsSync(ctx.dataDir),
      database: getSupabasePublicConfig(ctx.dataDir),
      pricing: getPricingMetadata(),
    }),
  },
  "agents.status": {
    id: "agents.status",
    description: "Return ChatGPT Codex and LM Studio status.",
    inputSchema: EmptySchema,
    inputJsonSchema: objectSchema({}),
    handler: async (ctx: ActionContext) => ({ agents: [await getAgentStatus(loadAppConfig(ctx.dataDir))] }),
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
      agentProvider: { type: "string", enum: ["codex-cloud", "codex-lmstudio"] },
      model: { type: "string" },
      localModel: { type: "string" },
      databaseProvider: { type: "string", enum: ["supabase"] },
      supabaseUrl: { type: "string" },
      supabaseAnonKey: { type: "string" },
      inputDir: { type: "string" },
      outputDir: { type: "string" },
      auditLogDir: { type: "string" },
      maxConcurrentRuns: { type: "number" },
      automations: {
        type: "object",
        properties: {
          gmailSupplierInvoices: {
            type: "object",
            properties: {
              enabled: { type: "boolean" },
              periodStart: { type: "string" },
              periodEnd: { type: "string" },
              supplierTypes: { type: "array", items: { type: "string" } },
              excludedSupplierTypes: { type: "array", items: { type: "string" } },
              gmailQuery: { type: "string" },
              pennylaneMcpServer: { type: "string" },
              schedule: { type: "string", enum: ["manual", "daily", "weekly", "monthly"] },
            },
          },
        },
      },
    }),
    audit: { action: "app-config.update", resourceType: "app-config", adminOnly: true },
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
      agentProvider: { type: "string", enum: ["codex-cloud", "codex-lmstudio"] },
      localModel: { type: "string" },
      addDirs: { type: "array", items: { type: "string" } },
      allowedTools: { type: "array", items: { type: "string" } },
      maxTurns: { type: "number" },
      cwd: { type: "string" },
    }, ["prompt"]),
    requiredAnyScopes: ["codex:run"],
    audit: { action: "run.start", resourceType: "run" },
    handler: async (ctx: ActionContext, input: StartRunInput) => {
      const cfg = loadAppConfig(ctx.dataDir);
      const roots = allowedRunRoots(ctx.dataDir, cfg);
      const cwd = input.cwd ? assertInsideRoots(input.cwd, roots, input.cwd) : ctx.dataDir;
      const addDirs = input.addDirs?.map((dir) => assertInsideRoots(dir, roots, dir));
      const modelOptions = codexRunModelOptions(cfg, {
        agentProvider: input.agentProvider as AgentProvider | undefined,
        model: input.model,
        localModel: input.localModel,
      });
      await assertAgentProviderReady({
        agentProvider: modelOptions.agentProvider,
        localModel: modelOptions.localModel ?? cfg.localModel,
      });
      const run = startRun({
        prompt: input.prompt,
        cwd,
        tag: input.tag,
        agentProvider: modelOptions.agentProvider,
        model: modelOptions.model,
        localModel: modelOptions.localModel,
        addDirs,
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
  "purchasing.quote.import": {
    id: "purchasing.quote.import",
    description: "Import or update a supplier quote in the generic purchasing module.",
    inputSchema: PurchasingQuoteImportSchema,
    inputJsonSchema: objectSchema({
      supplierName: { type: "string" },
      supplierExternalRef: { type: "string" },
      title: { type: "string" },
      amount: { type: "number" },
      currency: { type: "string" },
      riskLevel: { type: "string", enum: ["unknown", "low", "medium", "high"] },
    }, ["supplierName", "title"]),
    requiredServiceScopes: [{ serviceId: "purchasing", scopes: ["service:purchasing:write"] }],
    audit: { action: "purchasing.quote.import", resourceType: "purchasing_quote" },
    handler: async (ctx: ActionContext, input: PurchasingQuoteImportInput) => {
      const organizationId = requireActionOrganization(ctx);
      const supabase = getSupabaseServerClient(ctx.dataDir);
      const supplierRef = input.supplierExternalRef ?? `supplier:${input.supplierName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
      const { data: supplier, error: supplierError } = await supabase
        .from("purchasing_suppliers")
        .upsert({
          organization_id: organizationId,
          external_ref: supplierRef,
          name: input.supplierName,
          created_by: ctx.userId ?? null,
          updated_by: ctx.userId ?? null,
        }, { onConflict: "organization_id,external_ref" })
        .select("id")
        .single();
      if (supplierError) throw supplierError;
      const quoteRef = `quote:${supplierRef}:${input.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
      const { data: quote, error: quoteError } = await supabase
        .from("purchasing_quotes")
        .upsert({
          organization_id: organizationId,
          supplier_id: supplier.id,
          external_ref: quoteRef,
          title: input.title,
          amount: input.amount,
          currency: input.currency ?? "EUR",
          status: "under_review",
          risk_level: input.riskLevel ?? "unknown",
          created_by: ctx.userId ?? null,
          updated_by: ctx.userId ?? null,
        }, { onConflict: "organization_id,external_ref" })
        .select("*")
        .single();
      if (quoteError) throw quoteError;
      return { quote };
    },
  },
  "purchasing.quote.analyze": {
    id: "purchasing.quote.analyze",
    description: "Return a concise purchasing analysis from supplier quotes.",
    inputSchema: PurchasingQuoteAnalyzeSchema,
    inputJsonSchema: objectSchema({
      quoteIds: { type: "array", items: { type: "string", format: "uuid" } },
    }),
    requiredServiceScopes: [{ serviceId: "purchasing", scopes: ["service:purchasing:read"] }],
    audit: { action: "purchasing.quote.analyze", resourceType: "purchasing_quote" },
    handler: async (ctx: ActionContext, input: PurchasingQuoteAnalyzeInput) => {
      const organizationId = requireActionOrganization(ctx);
      const supabase = getSupabaseServerClient(ctx.dataDir);
      let query = supabase
        .from("purchasing_quotes")
        .select("id,title,amount,currency,status,risk_level,purchasing_suppliers(name)")
        .eq("organization_id", organizationId)
        .order("created_at", { ascending: false })
        .limit(20);
      if (input.quoteIds?.length) query = query.in("id", input.quoteIds);
      const { data, error } = await query;
      if (error) throw error;
      const quotes = data ?? [];
      const comparable = quotes.filter((quote: any) => typeof quote.amount === "number");
      const cheapest = comparable.slice().sort((a: any, b: any) => Number(a.amount) - Number(b.amount))[0];
      return {
        quoteCount: quotes.length,
        cheapestQuote: cheapest ?? null,
        highRiskCount: quotes.filter((quote: any) => quote.risk_level === "high").length,
        recommendation: cheapest
          ? `Prioriser ${cheapest.title} pour revue detaillee, puis verifier les clauses et donnees manquantes avant validation.`
          : "Completer les montants et conditions avant de recommander un fournisseur.",
        quotes,
      };
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
  try {
    ensureActionAuthorized(ctx, action);
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

function ensureActionAuthorized(ctx: ActionContext, action: AppAction): void {
  if (action.audit?.adminOnly && ctx.organizationId && ctx.membershipRole !== "owner" && ctx.membershipRole !== "admin") {
    throw new Error("admin-required");
  }
  for (const entry of action.requiredServiceScopes ?? []) {
    if (!ctx.organizationId) throw new Error("organization-required");
    for (const scope of entry.scopes) {
      if (!hasServiceScope(ctx, entry.serviceId, scope)) {
        throw new Error(`scope-forbidden:${scope}`);
      }
    }
  }
  for (const scope of action.requiredAnyScopes ?? []) {
    if (ctx.organizationId && !hasAnyScope(ctx, scope)) {
      throw new Error(`scope-forbidden:${scope}`);
    }
  }
}

function requireActionOrganization(ctx: ActionContext): string {
  if (!ctx.organizationId) throw new Error("organization-required");
  return ctx.organizationId;
}

function hasServiceScope(ctx: ActionContext, serviceId: string, scope: string): boolean {
  if (ctx.membershipRole === "owner" || ctx.membershipRole === "admin") return true;
  return (ctx.entitlements ?? []).some((entitlement) =>
    entitlement.enabled &&
    entitlement.service_id === serviceId &&
    entitlement.scopes.includes(scope)
  );
}

function hasAnyScope(ctx: ActionContext, scope: string): boolean {
  if (ctx.membershipRole === "owner" || ctx.membershipRole === "admin") return true;
  return (ctx.entitlements ?? []).some((entitlement) =>
    entitlement.enabled &&
    entitlement.scopes.includes(scope)
  );
}
