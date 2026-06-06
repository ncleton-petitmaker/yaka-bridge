import type { Context } from "hono";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { getSupabaseServerClient } from "./supabase.js";

type Severity = "info" | "warning" | "error" | "critical";
type Source = "web" | "api" | "bridge" | "run" | "auth";

type BridgeMembership = {
  organization_id: string;
  user_id: string;
  role: "owner" | "admin" | "member" | "operator";
};

type ObservabilityContext = {
  supabase: SupabaseClient;
  user: User;
  membership: BridgeMembership;
  organizationId: string;
};

const SECRET_KEY_RE = /token|password|secret|authorization|api[_-]?key|service[_-]?role|jwt|bearer|cookie|session/i;

export async function ingestObservabilityEvent(dataDir: string, c: Context): Promise<Response> {
  const ctx = await requireBridgeUser(dataDir, c);
  const body = await safeJson(c);
  await recordObservabilityEvent(ctx, body);
  return c.json({ ok: true });
}

export async function upsertSupportSession(dataDir: string, c: Context): Promise<Response> {
  const ctx = await requireBridgeUser(dataDir, c);
  const body = await safeJson(c);
  const row = supportSessionRow(ctx, body);
  const { error } = await ctx.supabase
    .from("bridge_support_sessions")
    .upsert(row, { onConflict: "id" });
  if (error) throw error;
  return c.json({ ok: true });
}

export async function updateSupportSession(dataDir: string, c: Context): Promise<Response> {
  const ctx = await requireBridgeUser(dataDir, c);
  const body = await safeJson(c);
  const id = c.req.param("id");
  const patch = supportSessionRow(ctx, { ...body, id });
  const { error } = await ctx.supabase
    .from("bridge_support_sessions")
    .update({
      ...patch,
      started_at: undefined,
      created_at: undefined,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("organization_id", ctx.organizationId);
  if (error) throw error;
  return c.json({ ok: true });
}

export async function observabilityOverview(dataDir: string, c: Context): Promise<Response> {
  const ctx = await requireBridgeAdmin(dataDir, c);
  const url = new URL(c.req.url);
  const severity = url.searchParams.get("severity");
  const resolved = url.searchParams.get("resolved") ?? "open";
  let query = ctx.supabase
    .from("bridge_observability_events")
    .select("*")
    .eq("organization_id", ctx.organizationId)
    .order("last_seen_at", { ascending: false })
    .limit(numberParam(url, "limit", 200));
  if (severity && severity !== "all") query = query.eq("severity", severity);
  if (resolved === "open") query = query.is("resolved_at", null);
  if (resolved === "true") query = query.not("resolved_at", "is", null);
  const { data, error } = await query;
  if (error) throw error;
  const events = data ?? [];
  return c.json({
    events,
    generatedAt: new Date().toISOString(),
    stats: {
      open: events.filter((event) => !event.resolved_at).length,
      bySeverity: countBy(events, "severity"),
      bySource: countBy(events, "source"),
    },
  });
}

export async function supportSessionsOverview(dataDir: string, c: Context): Promise<Response> {
  const ctx = await requireBridgeAdmin(dataDir, c);
  const url = new URL(c.req.url);
  const minutes = numberParam(url, "minutes", 360);
  const since = new Date(Date.now() - minutes * 60_000).toISOString();
  const { data, error } = await ctx.supabase
    .from("bridge_support_sessions")
    .select("*")
    .eq("organization_id", ctx.organizationId)
    .gte("last_seen_at", since)
    .order("last_seen_at", { ascending: false })
    .limit(numberParam(url, "limit", 80));
  if (error) throw error;
  return c.json({ sessions: data ?? [], generatedAt: new Date().toISOString() });
}

export async function supportSessionDetail(dataDir: string, c: Context): Promise<Response> {
  const ctx = await requireBridgeAdmin(dataDir, c);
  const id = c.req.param("id");
  const { data: session, error: sessionError } = await ctx.supabase
    .from("bridge_support_sessions")
    .select("*")
    .eq("organization_id", ctx.organizationId)
    .eq("id", id)
    .maybeSingle();
  if (sessionError) throw sessionError;
  if (!session) return c.json({ error: "support-session-not-found" }, 404);
  const { data: observations, error } = await ctx.supabase
    .from("bridge_observability_events")
    .select("*")
    .eq("organization_id", ctx.organizationId)
    .eq("support_session_id", id)
    .order("last_seen_at", { ascending: false })
    .limit(80);
  if (error) throw error;
  return c.json({ session, observations: observations ?? [], generatedAt: new Date().toISOString() });
}

export async function resolveObservabilityEvent(dataDir: string, c: Context): Promise<Response> {
  const ctx = await requireBridgeAdmin(dataDir, c);
  const id = c.req.param("id");
  const { error } = await ctx.supabase
    .from("bridge_observability_events")
    .update({
      resolved_at: new Date().toISOString(),
      resolved_by: ctx.user.id,
      updated_at: new Date().toISOString(),
    })
    .eq("organization_id", ctx.organizationId)
    .eq("id", id);
  if (error) throw error;
  return c.json({ ok: true });
}

async function recordObservabilityEvent(ctx: ObservabilityContext, body: Record<string, unknown>): Promise<void> {
  const severity = normalizeSeverity(body.severity);
  const source = normalizeSource(body.source);
  const category = cleanText(body.category, "general", 80);
  const message = cleanText(body.message, "Observation", 1200);
  const fingerprint = cleanText(body.fingerprint, `${source}:${category}:${message}`.slice(0, 240), 240);
  const now = new Date().toISOString();
  const payload = sanitizePayload(body.context ?? body.payload ?? {});

  const { data: existing, error: selectError } = await ctx.supabase
    .from("bridge_observability_events")
    .select("id, count, severity, resolved_at")
    .eq("organization_id", ctx.organizationId)
    .eq("fingerprint", fingerprint)
    .maybeSingle();
  if (selectError) throw selectError;

  const row = {
    organization_id: ctx.organizationId,
    user_id: ctx.user.id,
    service_id: stringOrNull(body.serviceId),
    job_id: stringOrNull(body.jobId),
    device_id: stringOrNull(body.deviceId),
    support_session_id: stringOrNull(body.supportSessionId),
    replay_session_id: stringOrNull(body.replaySessionId),
    replay_session_url: stringOrNull(body.replaySessionUrl),
    severity,
    source,
    category,
    message,
    route: stringOrNull(body.route),
    app_version: stringOrNull(body.appVersion),
    fingerprint,
    payload,
    last_seen_at: now,
    updated_at: now,
  };

  if (existing?.id) {
    const { error } = await ctx.supabase
      .from("bridge_observability_events")
      .update({
        ...row,
        count: Math.max(1, Number(existing.count ?? 1) + 1),
        severity: strongestSeverity(String(existing.severity), severity),
        resolved_at: existing.resolved_at && severityRank(severity) >= severityRank("error")
          ? null
          : existing.resolved_at,
      })
      .eq("id", existing.id);
    if (error) throw error;
    return;
  }

  const { error } = await ctx.supabase
    .from("bridge_observability_events")
    .insert({ ...row, first_seen_at: now });
  if (error) throw error;
}

async function requireBridgeAdmin(dataDir: string, c: Context): Promise<ObservabilityContext> {
  const ctx = await requireBridgeUser(dataDir, c);
  if (ctx.membership.role !== "owner" && ctx.membership.role !== "admin") {
    throw new Error("reserved-to-bridge-admin");
  }
  return ctx;
}

async function requireBridgeUser(dataDir: string, c: Context): Promise<ObservabilityContext> {
  const supabase = getSupabaseServerClient(dataDir);
  const token = bearerToken(c);
  if (!token) throw new Error("authorization bearer requis");
  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData.user) throw userError ?? new Error("session invalide");
  const requestedOrgId = stringOrNull((await safeJson(c, false)).organizationId) ?? c.req.header("x-bridge-organization-id") ?? undefined;
  let query = supabase
    .from("bridge_memberships")
    .select("organization_id,user_id,role")
    .eq("user_id", userData.user.id)
    .limit(1);
  if (requestedOrgId) query = query.eq("organization_id", requestedOrgId);
  const { data, error } = await query;
  if (error) throw error;
  const membership = data?.[0] as BridgeMembership | undefined;
  if (!membership) throw new Error("compte non autorisé sur cette organisation");
  return {
    supabase,
    user: userData.user,
    membership,
    organizationId: membership.organization_id,
  };
}

function supportSessionRow(ctx: ObservabilityContext, body: Record<string, unknown>): Record<string, unknown> {
  return stripUndefined({
    id: stringOrUndefined(body.id),
    organization_id: ctx.organizationId,
    user_id: ctx.user.id,
    service_id: stringOrNull(body.currentServiceId ?? body.serviceId),
    job_id: stringOrNull(body.currentJobId ?? body.jobId),
    replay_session_id: stringOrNull(body.replaySessionId),
    replay_session_url: stringOrNull(body.replaySessionUrl),
    current_route: stringOrNull(body.currentRoute),
    app_version: stringOrNull(body.appVersion),
    user_agent: stringOrNull(body.userAgent),
    viewport: stringOrNull(body.viewport),
    last_seen_at: new Date().toISOString(),
    metadata: sanitizePayload(body.context ?? {}),
  });
}

async function safeJson(c: Context, consume = true): Promise<Record<string, unknown>> {
  if (!consume || c.req.method === "GET") return {};
  try {
    const body = await c.req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function bearerToken(c: Context): string | null {
  const header = c.req.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1] ?? null;
}

function sanitizePayload(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]";
  if (value == null) return value;
  if (typeof value === "string") return sanitizeText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizePayload(item, depth + 1));
  if (typeof value !== "object") return String(value);
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY_RE.test(key) ? "[redacted]" : sanitizePayload(entry, depth + 1);
  }
  return out;
}

function sanitizeText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, "sk-[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, "[jwt redacted]")
    .replace(/\bsb(?:p|s)_[A-Za-z0-9_-]{20,}\b/g, "[supabase key redacted]")
    .slice(0, 4000);
}

function cleanText(value: unknown, fallback: string, max: number): string {
  const raw = typeof value === "string" && value.trim() ? value.trim() : fallback;
  return sanitizeText(raw).slice(0, max);
}

function normalizeSeverity(value: unknown): Severity {
  if (value === "critical") return "critical";
  if (value === "error") return "error";
  if (value === "warning") return "warning";
  return "info";
}

function normalizeSource(value: unknown): Source {
  if (value === "web" || value === "api" || value === "bridge" || value === "run" || value === "auth") return value;
  return "api";
}

function strongestSeverity(a: string, b: Severity): Severity {
  const normalizedA = normalizeSeverity(a);
  return severityRank(normalizedA) >= severityRank(b) ? normalizedA : b;
}

function severityRank(value: Severity | string): number {
  if (value === "critical") return 4;
  if (value === "error") return 3;
  if (value === "warning") return 2;
  return 1;
}

function countBy(rows: Array<Record<string, unknown>>, key: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const value = String(row[key] ?? "unknown");
    out[value] = (out[value] ?? 0) + 1;
  }
  return out;
}

function numberParam(url: URL, key: string, fallback: number): number {
  const n = Number(url.searchParams.get(key));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stripUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}
