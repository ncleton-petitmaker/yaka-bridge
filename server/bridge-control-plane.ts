import type { Hono } from "hono";
import type { Context } from "hono";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  hasServiceScope,
  isAdminRole,
  normalizeAuthError,
  requireOrganizationMember,
  type AuthzContext,
} from "./authz.js";
import { bearerToken } from "./cloud-auth.js";
import { getSupabaseServerClient } from "./supabase.js";
import { bridgeAiPolicyFromManifests } from "../bridge/ai-policy.js";

type BridgeAuthKind = "supabase" | "bridge-token";

interface BridgeAuthContext {
  kind: BridgeAuthKind;
  supabase: SupabaseClient;
  organizationId: string;
  bridgeId?: string;
  deviceId?: string;
  userId?: string;
  serviceIds: string[];
  scopes: string[];
  membership?: AuthzContext["membership"];
  authz?: AuthzContext;
  tokenId?: string;
}

interface SignedBridgeTokenPayload {
  jti: string;
  organizationId: string;
  bridgeId: string;
  deviceId: string;
  userId?: string;
  serviceIds?: string[];
  scopes?: string[];
  exp: number;
  iat?: number;
}

const BRIDGE_AUTH_CONTEXT_KEY = "bridgeAuth";
const TOKEN_PREFIX = "brg_";
const MAX_RETURN_TO_LENGTH = 900;

export function registerBridgeControlPlaneRoutes(app: Hono, dataDir: string): void {
  const bridgeUpdateInfo = () => ({
    updateBaseUrl: process.env.BRIDGE_UPDATE_BASE_URL ?? process.env.BRIDGE_AUTO_UPDATE_URL,
    latestVersion: process.env.BRIDGE_LATEST_VERSION ?? process.env.npm_package_version,
    minimumVersion: process.env.BRIDGE_MINIMUM_VERSION ?? process.env.BRIDGE_MIN_VERSION ?? process.env.npm_package_version,
    installerBaseUrl: process.env.BRIDGE_INSTALLER_BASE_URL,
    windowsInstallerUrl: process.env.BRIDGE_WINDOWS_INSTALLER_URL,
    macInstallerUrl: process.env.BRIDGE_MAC_INSTALLER_URL,
  });

  app.get("/bridge/auth/config", (c) => {
    return c.json({
      ok: true,
      supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_PUBLIC_URL ?? process.env.SUPABASE_URL,
      supabaseAnonKey:
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
        process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
        process.env.SUPABASE_ANON_KEY,
      ...bridgeUpdateInfo(),
    });
  });

  app.all("/bridge/launch-ticket/consume", async (c) => {
    applyLaunchTicketCors(c);
    if (c.req.method === "OPTIONS") {
      return c.body(null, 204);
    }
    try {
      const supabase = getSupabaseServerClient(dataDir);
      const envelope = await readEnvelope(c);
      const ticket = ticketFromEnvelope(c, envelope);
      const returnTo = normalizeReturnTo(envelope.payload?.returnTo ?? envelope.returnTo ?? c.req.query("returnTo"));
      if (!ticket) return c.json({ ok: false, error: "ticket-required" }, 400);
      const consumed = await consumeLaunchTicket(supabase, ticket, returnTo);
      return c.json({ ok: true, ticket: consumed });
    } catch (err) {
      const normalized = normalizeBridgeError(err);
      return c.json(normalized.body, normalized.status as any);
    }
  });

  app.use("/bridge/*", async (c, next) => {
    if (c.req.method === "OPTIONS" || c.req.path === "/bridge/auth/config" || c.req.path === "/bridge/launch-ticket/consume") {
      return next();
    }
    try {
      const auth = bearerToken(c)
        ? await bridgeAuthFromSupabaseSession(dataDir, c)
        : await bridgeAuthFromSignedToken(dataDir, c);
      setBridgeAuth(c, auth);
      return next();
    } catch (err) {
      const normalized = normalizeBridgeError(err);
      return c.json(normalized.body, normalized.status as any);
    }
  });

  app.post("/bridge/register", async (c) => {
    const envelope = await readEnvelope(c);
    const payload = envelope.payload ?? {};
    const auth = getBridgeAuth(c);
    const deviceId = cleanString(payload.deviceId ?? envelope.deviceId ?? payload.installId ?? envelope.installId ?? auth.deviceId);
    const installId = cleanString(payload.installId ?? envelope.installId ?? deviceId);
    const bridgeId = cleanString(payload.bridgeId ?? envelope.bridgeId ?? auth.bridgeId ?? (deviceId ? `bridge_${deviceId}` : undefined));
    if (!deviceId || !installId || !bridgeId) return c.json({ ok: false, error: "device-required" }, 400);
    assertDeviceMatchesAuth(auth, deviceId, bridgeId);
    await upsertDevice(auth, {
      bridgeId,
      deviceId,
      installId,
      label: cleanString(payload.label),
      capabilities: objectOrEmpty(payload.capabilities),
    });
    await audit(auth, "bridge.device.register", "bridge-device", deviceId, "success", { bridgeId });
    return c.json({ ok: true, bridgeId, serverTime: new Date().toISOString() });
  });

  app.post("/bridge/sync", async (c) => {
    const envelope = await readEnvelope(c);
    const payload = envelope.payload ?? {};
    const auth = getBridgeAuth(c);
    await recordDeviceHeartbeat(auth, envelope, payload);
    const [services, erpBus] = await Promise.all([listServices(auth), listErpBus(auth)]);
    return c.json({
      ok: true,
      services,
      erpBus,
      aiPolicy: bridgeAiPolicyFromManifests(services),
      ...bridgeUpdateInfo(),
      serverTime: new Date().toISOString(),
    });
  });

  app.post("/bridge/services", async (c) => {
    const auth = getBridgeAuth(c);
    const [services, erpBus] = await Promise.all([listServices(auth), listErpBus(auth)]);
    return c.json({
      ok: true,
      services,
      erpBus,
      aiPolicy: bridgeAiPolicyFromManifests(services),
      ...bridgeUpdateInfo(),
      serverTime: new Date().toISOString(),
    });
  });

  app.post("/bridge/browser-session", async (c) => {
    const envelope = await readEnvelope(c);
    const payload = envelope.payload ?? {};
    const auth = getBridgeAuth(c);
    const browserSessionId = String(payload.browserSessionId ?? "").trim();
    if (!/^[A-Za-z0-9_-]{24,160}$/.test(browserSessionId)) {
      return c.json({ ok: false, error: "invalid-browser-session" }, 400);
    }
    await recordDeviceHeartbeat(auth, envelope, {
      ...payload,
      capabilities: {
        ...objectOrEmpty(payload.state),
        browserSession: {
          id: browserSessionId,
          seen_at: new Date().toISOString(),
          return_url: typeof payload.returnUrl === "string" ? payload.returnUrl.slice(0, 600) : null,
        },
      },
    });
    return c.json({ ok: true, serverTime: new Date().toISOString() });
  });

  app.post("/bridge/launch-ticket", async (c) => {
    const envelope = await readEnvelope(c);
    const request = envelope.payload ?? {};
    const auth = getBridgeAuth(c);
    const serviceId = cleanString(request.serviceId);
    if (!serviceId) return c.json({ ok: false, error: "service-required" }, 400);
    assertBridgeServiceAccess(auth, serviceId);
    const service = await findService(auth, serviceId);
    if (!service) return c.json({ ok: false, error: "service-not-found" }, 404);
    const userId = auth.userId;
    if (!userId) return c.json({ ok: false, error: "user-required" }, 403);
    const rawTicket = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const returnTo = normalizeReturnTo(request.returnTo);
    const { data: ticket, error } = await auth.supabase
      .from("bridge_launch_tickets")
      .insert({
        organization_id: auth.organizationId,
        user_id: userId,
        service_id: service.service_id,
        service_instance_id: service.service_instance_id,
        device_id: auth.deviceId,
        ticket_hash: sha256(rawTicket),
        return_to: returnTo,
        expires_at: expiresAt,
      })
      .select("id,expires_at")
      .single();
    if (error) throw error;
    await audit(auth, "bridge.launch-ticket.create", "launch-ticket", ticket.id, "success", { serviceId });
    const callbackUrl = service.launch_callback_url || service.base_url;
    const separator = callbackUrl.includes("?") ? "&" : "?";
    return c.json({
      ok: true,
      ticketId: ticket.id,
      launchUrl: `${callbackUrl}${separator}ticket=${encodeURIComponent(rawTicket)}`,
      expiresAt: ticket.expires_at,
    });
  });

  app.post("/bridge/jobs/poll", async (c) => {
    const envelope = await readEnvelope(c);
    const payload = envelope.payload ?? {};
    const auth = getBridgeAuth(c);
    await recordDeviceHeartbeat(auth, envelope, payload);
    const requested = Array.isArray(payload.serviceIds) ? payload.serviceIds.map(String) : [];
    const serviceIds = await allowedRequestedServiceIds(auth, requested);
    if (serviceIds.length === 0) {
      return c.json({ ok: true, jobs: [], serverTime: new Date().toISOString() });
    }
    const { data, error } = await auth.supabase.rpc("bridge_poll_jobs", {
      p_organization_id: auth.organizationId,
      p_device_id: auth.deviceId ?? cleanString(envelope.deviceId ?? payload.deviceId),
      p_service_ids: serviceIds,
      p_limit: 5,
      p_lease_seconds: 120,
    });
    if (error) throw error;
    return c.json({
      ok: true,
      jobs: (data ?? []).map(mapJob),
      serverTime: new Date().toISOString(),
    });
  });

  app.post("/bridge/jobs/events", async (c) => {
    const envelope = await readEnvelope(c);
    const batch = envelope.payload ?? {};
    const auth = getBridgeAuth(c);
    const serviceId = cleanString(batch.serviceId);
    if (!serviceId) return c.json({ ok: false, error: "service-required" }, 400);
    assertBridgeServiceAccess(auth, serviceId, "codex:run");
    const rows = Array.isArray(batch.events) ? batch.events : [];
    if (rows.length > 0) {
      const { error } = await auth.supabase.from("bridge_job_events").insert(rows.map((item: any) => ({
        organization_id: auth.organizationId,
        service_id: serviceId,
        job_id: batch.jobId,
        lease_id: batch.leaseId,
        local_run_id: batch.localRunId,
        seq: Number(item.seq),
        status: cleanString(batch.status),
        event: objectOrEmpty(item.event),
        usage: batch.usage ?? null,
        error: cleanString(batch.error),
      })));
      if (error) throw error;
    }
    return c.json({ ok: true });
  });

  app.post("/bridge/jobs/complete", async (c) => {
    const envelope = await readEnvelope(c);
    const payload = envelope.payload ?? {};
    const auth = getBridgeAuth(c);
    const serviceId = cleanString(payload.serviceId);
    if (!serviceId) return c.json({ ok: false, error: "service-required" }, 400);
    assertBridgeServiceAccess(auth, serviceId, "codex:run");
    const { data, error } = await auth.supabase
      .from("bridge_jobs")
      .update({
        status: cleanString(payload.status) ?? "failed",
        local_run_id: cleanString(payload.localRunId),
        error: cleanString(payload.error),
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("organization_id", auth.organizationId)
      .eq("service_id", serviceId)
      .eq("id", payload.jobId)
      .eq("lease_id", payload.leaseId)
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (!data) return c.json({ ok: false, error: "job-not-found" }, 404);
    await audit(auth, "bridge.job.complete", "bridge-job", data.id, payload.error ? "failure" : "success", {
      serviceId,
      status: payload.status,
    });
    return c.json({ ok: true });
  });

  app.post("/bridge/bus/events", async (c) => {
    const envelope = await readEnvelope(c);
    const event = envelope.payload ?? {};
    const auth = getBridgeAuth(c);
    const sourceServiceId = cleanString(event.sourceServiceId);
    const type = cleanString(event.type);
    if (!sourceServiceId || !type) return c.json({ ok: false, error: "event-required" }, 400);
    assertBridgeServiceAccess(auth, sourceServiceId, "erp:events:publish");
    const allowed = await busEventAllowed(auth, sourceServiceId, type);
    if (!allowed) {
      await audit(auth, "bridge.bus.event.publish", "bridge-bus-event", type, "failure", { reason: "permission-denied" });
      return c.json({ ok: false, error: "permission-denied" }, 403);
    }
    const { data, error } = await auth.supabase
      .from("bridge_bus_events")
      .insert({
        organization_id: auth.organizationId,
        source_service_id: sourceServiceId,
        type,
        resource_type: cleanString(event.resourceType),
        resource_id: cleanString(event.resourceId),
        payload: objectOrEmpty(event.payload),
        occurred_at: cleanString(event.occurredAt) ?? new Date().toISOString(),
      })
      .select("*")
      .single();
    if (error) throw error;
    await audit(auth, "bridge.bus.event.publish", "bridge-bus-event", data.id, "success", { type });
    return c.json({ ok: true, event: mapBusEvent(data) });
  });

  app.post("/bridge/bus/actions/call", async (c) => {
    const envelope = await readEnvelope(c);
    const call = envelope.payload ?? {};
    const auth = getBridgeAuth(c);
    const sourceServiceId = cleanString(call.sourceServiceId);
    const targetServiceId = cleanString(call.targetServiceId);
    const actionId = cleanString(call.actionId);
    if (!sourceServiceId || !targetServiceId || !actionId) {
      return c.json({ ok: false, error: "action-required" }, 400);
    }
    assertBridgeServiceAccess(auth, sourceServiceId, "erp:events:consume");
    const allowed = await busActionAllowed(auth, sourceServiceId, targetServiceId, actionId);
    if (!allowed) {
      await audit(auth, "bridge.bus.action.call", "bridge-action", actionId, "failure", { reason: "permission-denied" });
      return c.json({ ok: false, error: "permission-denied" }, 403);
    }
    await audit(auth, "bridge.bus.action.call", "bridge-action", actionId, "success", {
      sourceServiceId,
      targetServiceId,
    });
    return c.json({
      ok: true,
      output: {
        accepted: true,
        actionId,
        targetServiceId,
        handledAt: new Date().toISOString(),
      },
    });
  });
}

function applyLaunchTicketCors(c: Context): void {
  const origin = c.req.header("origin")?.trim();
  if (origin) {
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Vary", "Origin");
  }
  c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  c.header("Access-Control-Allow-Headers", "content-type");
  c.header("Access-Control-Allow-Private-Network", "true");
}

export function createSignedBridgeToken(payload: SignedBridgeTokenPayload, secret: string): string {
  const payloadPart = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payloadPart).digest("base64url");
  return `${TOKEN_PREFIX}${payloadPart}.${signature}`;
}

export function parseSignedBridgeToken(token: string, secret: string, now = Date.now()): SignedBridgeTokenPayload {
  if (!secret) throw new Error("bridge-token-secret-required");
  if (!token.startsWith(TOKEN_PREFIX)) throw new Error("invalid-bridge-token");
  const [payloadPart, signature] = token.slice(TOKEN_PREFIX.length).split(".");
  if (!payloadPart || !signature) throw new Error("invalid-bridge-token");
  const expected = createHmac("sha256", secret).update(payloadPart).digest("base64url");
  if (!safeEquals(signature, expected)) throw new Error("invalid-bridge-token");
  const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as SignedBridgeTokenPayload;
  if (!payload.jti || !payload.organizationId || !payload.bridgeId || !payload.deviceId || !payload.exp) {
    throw new Error("invalid-bridge-token-payload");
  }
  if (payload.exp * 1000 <= now) throw new Error("expired-bridge-token");
  return payload;
}

export function bridgeTokenHash(token: string): string {
  return sha256(token);
}

async function bridgeAuthFromSupabaseSession(dataDir: string, c: Context): Promise<BridgeAuthContext> {
  const authz = await requireOrganizationMember(dataDir, c);
  return {
    kind: "supabase",
    supabase: authz.supabase,
    organizationId: authz.organizationId,
    bridgeId: headerValue(c, "x-bridge-id"),
    deviceId: headerValue(c, "x-bridge-device-id"),
    userId: authz.user.id,
    serviceIds: authz.entitlements.filter((entry) => entry.enabled).map((entry) => entry.service_id),
    scopes: Array.from(new Set(authz.entitlements.flatMap((entry) => entry.enabled ? entry.scopes : []))),
    membership: authz.membership,
    authz,
  };
}

async function bridgeAuthFromSignedToken(dataDir: string, c: Context): Promise<BridgeAuthContext> {
  const token = headerValue(c, "x-bridge-token");
  if (!token) throw new Error("unauthorized");
  const secret = process.env.BRIDGE_TOKEN_SECRET;
  if (!secret) throw new Error("bridge-token-secret-required");
  const payload = parseSignedBridgeToken(token, secret);
  if (!headerMatches(c, "x-bridge-organization-id", payload.organizationId)) throw new Error("unauthorized");
  if (!headerMatches(c, "x-bridge-id", payload.bridgeId)) throw new Error("unauthorized");
  if (!headerMatches(c, "x-bridge-device-id", payload.deviceId)) throw new Error("unauthorized");
  const supabase = getSupabaseServerClient(dataDir);
  const { data, error } = await supabase
    .from("bridge_device_tokens")
    .select("id,organization_id,bridge_id,device_id,user_id,service_ids,scopes,expires_at,revoked_at")
    .eq("token_hash", bridgeTokenHash(token))
    .maybeSingle();
  if (error) throw error;
  if (!data || data.revoked_at) throw new Error("unauthorized");
  if (new Date(String(data.expires_at)).getTime() <= Date.now()) throw new Error("unauthorized");
  if (data.organization_id !== payload.organizationId || data.bridge_id !== payload.bridgeId || data.device_id !== payload.deviceId) {
    throw new Error("unauthorized");
  }
  await supabase
    .from("bridge_device_tokens")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", data.id);
  return {
    kind: "bridge-token",
    supabase,
    organizationId: data.organization_id,
    bridgeId: data.bridge_id,
    deviceId: data.device_id,
    userId: data.user_id ?? payload.userId,
    serviceIds: Array.isArray(data.service_ids) ? data.service_ids.map(String) : [],
    scopes: Array.isArray(data.scopes) ? data.scopes.map(String) : [],
    tokenId: data.id,
  };
}

async function listServices(auth: BridgeAuthContext): Promise<any[]> {
  let query = auth.supabase
    .from("bridge_services")
    .select("*")
    .eq("organization_id", auth.organizationId)
    .eq("enabled", true)
    .order("name", { ascending: true });
  const allowed = await allowedServiceIds(auth);
  if (allowed !== null) query = query.in("service_id", allowed.length ? allowed : ["__none__"]);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map(mapService);
}

async function listErpBus(auth: BridgeAuthContext): Promise<any> {
  let query = auth.supabase
    .from("bridge_bus_permissions")
    .select("*")
    .eq("organization_id", auth.organizationId)
    .eq("enabled", true);
  const allowed = await allowedServiceIds(auth);
  if (allowed !== null) {
    const ids = allowed.length ? allowed : ["__none__"];
    query = query.or(`from_service_id.in.(${ids.join(",")}),to_service_id.in.(${ids.join(",")})`);
  }
  const { data, error } = await query;
  if (error) throw error;
  return {
    enabled: true,
    mode: "typed-actions-events",
    sharedCore: "organization",
    rules: (data ?? []).map((rule: any) => ({
      fromServiceId: rule.from_service_id,
      toServiceId: rule.to_service_id,
      actionId: rule.action_id,
      eventType: rule.event_type,
      scopes: rule.scopes ?? [],
    })),
  };
}

async function allowedServiceIds(auth: BridgeAuthContext): Promise<string[] | null> {
  if (auth.kind === "supabase" && auth.membership && isAdminRole(auth.membership.role)) return null;
  if (auth.kind === "supabase") return auth.serviceIds;
  return auth.serviceIds;
}

async function allowedRequestedServiceIds(auth: BridgeAuthContext, requested: string[]): Promise<string[]> {
  const allowed = await allowedServiceIds(auth);
  if (allowed === null) {
    if (requested.length > 0) return requested;
    const services = await listServices(auth);
    return services.map((service) => service.serviceId);
  }
  const allowedSet = new Set(allowed);
  const cleanRequested = requested.filter(Boolean);
  const selected = cleanRequested.length > 0 ? cleanRequested : allowed;
  return selected.filter((serviceId) => allowedSet.has(serviceId));
}

async function findService(auth: BridgeAuthContext, serviceId: string): Promise<any | null> {
  const { data, error } = await auth.supabase
    .from("bridge_services")
    .select("*")
    .eq("organization_id", auth.organizationId)
    .eq("service_id", serviceId)
    .eq("enabled", true)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const allowed = await allowedRequestedServiceIds(auth, [serviceId]);
  return allowed.includes(serviceId) ? data : null;
}

async function recordDeviceHeartbeat(auth: BridgeAuthContext, envelope: any, payload: any): Promise<void> {
  const deviceId = cleanString(payload.deviceId ?? envelope.deviceId ?? payload.installId ?? envelope.installId ?? auth.deviceId);
  const installId = cleanString(payload.installId ?? envelope.installId ?? deviceId);
  const bridgeId = cleanString(payload.bridgeId ?? envelope.bridgeId ?? auth.bridgeId ?? (deviceId ? `bridge_${deviceId}` : undefined));
  if (!deviceId || !installId || !bridgeId) return;
  assertDeviceMatchesAuth(auth, deviceId, bridgeId);
  await upsertDevice(auth, {
    bridgeId,
    deviceId,
    installId,
    label: cleanString(payload.label),
    capabilities: objectOrEmpty(payload.capabilities ?? payload.state),
  });
}

async function upsertDevice(
  auth: BridgeAuthContext,
  device: {
    bridgeId: string;
    deviceId: string;
    installId: string;
    label?: string;
    capabilities?: Record<string, unknown>;
  }
): Promise<void> {
  const { error } = await auth.supabase
    .from("bridge_devices")
    .upsert({
      organization_id: auth.organizationId,
      user_id: auth.userId ?? null,
      install_id: device.installId,
      device_id: device.deviceId,
      bridge_id: device.bridgeId,
      label: device.label ?? null,
      protocol_version: 2,
      capabilities: device.capabilities ?? {},
      last_seen_at: new Date().toISOString(),
    }, { onConflict: "device_id" });
  if (error) throw error;
}

function assertBridgeServiceAccess(auth: BridgeAuthContext, serviceId: string, scope?: string): void {
  if (auth.kind === "supabase" && auth.authz) {
    if (scope && !hasServiceScope(auth.authz, serviceId, scope)) throw new Error("permission-denied");
    if (!scope && !auth.serviceIds.includes(serviceId) && !isAdminRole(auth.authz.membership.role)) throw new Error("permission-denied");
    return;
  }
  if (!auth.serviceIds.includes(serviceId)) throw new Error("permission-denied");
  if (scope && !auth.scopes.includes(scope)) throw new Error("permission-denied");
}

async function busEventAllowed(auth: BridgeAuthContext, sourceServiceId: string, type: string): Promise<boolean> {
  const { data, error } = await auth.supabase
    .from("bridge_bus_permissions")
    .select("id")
    .eq("organization_id", auth.organizationId)
    .eq("from_service_id", sourceServiceId)
    .eq("event_type", type)
    .eq("enabled", true)
    .limit(1);
  if (error) throw error;
  return Boolean(data?.length);
}

async function busActionAllowed(auth: BridgeAuthContext, sourceServiceId: string, targetServiceId: string, actionId: string): Promise<boolean> {
  const { data, error } = await auth.supabase
    .from("bridge_bus_permissions")
    .select("id")
    .eq("organization_id", auth.organizationId)
    .eq("from_service_id", sourceServiceId)
    .eq("to_service_id", targetServiceId)
    .eq("action_id", actionId)
    .eq("enabled", true)
    .limit(1);
  if (error) throw error;
  return Boolean(data?.length);
}

async function consumeLaunchTicket(supabase: SupabaseClient, token: string, returnTo?: string): Promise<Record<string, unknown>> {
  const ticketHash = sha256(token);
  const { data: ticket, error } = await supabase
    .rpc("bridge_consume_launch_ticket", {
      p_ticket_hash: ticketHash,
      p_return_to: returnTo ?? null,
    })
    .maybeSingle();
  if (error) throw error;
  if (!ticket) throw new Error("invalid-ticket");
  const consumed = ticket as {
    id: string;
    organization_id: string;
    user_id: string;
    service_id: string;
    service_instance_id?: string | null;
    device_id?: string | null;
    return_to?: string | null;
    service?: unknown;
  };
  const storedReturnTo = normalizeReturnTo(consumed.return_to);
  return {
    id: consumed.id,
    organizationId: consumed.organization_id,
    userId: consumed.user_id,
    serviceId: consumed.service_id,
    serviceInstanceId: consumed.service_instance_id,
    deviceId: consumed.device_id,
    returnTo: storedReturnTo,
    service: mapNestedService(consumed.service),
  };
}

async function audit(
  auth: BridgeAuthContext,
  action: string,
  resourceType: string,
  resourceId: string,
  result: "success" | "failure",
  metadata: Record<string, unknown>
): Promise<void> {
  await auth.supabase.from("bridge_audit_log").insert({
    organization_id: auth.organizationId,
    actor_user_id: auth.userId ?? null,
    actor_device_id: auth.deviceId ?? null,
    action,
    resource_type: resourceType,
    resource_id: resourceId,
    result,
    metadata,
  });
}

async function readEnvelope(c: Context): Promise<any> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

function ticketFromEnvelope(c: Context, envelope: any): string | undefined {
  const queryTicket = cleanString(c.req.query("ticket") ?? c.req.query("bridge_ticket"));
  if (queryTicket) return queryTicket;
  return cleanString(envelope.ticket ?? envelope.bridge_ticket ?? envelope.payload?.ticket ?? envelope.payload?.bridge_ticket);
}

function setBridgeAuth(c: Context, auth: BridgeAuthContext): void {
  (c as any).set?.(BRIDGE_AUTH_CONTEXT_KEY, auth);
}

function getBridgeAuth(c: Context): BridgeAuthContext {
  const auth = (c as any).get?.(BRIDGE_AUTH_CONTEXT_KEY);
  if (!auth) throw new Error("unauthorized");
  return auth;
}

function headerValue(c: Context, key: string): string | undefined {
  const value = c.req.header(key)?.trim();
  return value || undefined;
}

function headerMatches(c: Context, header: string, expected: string): boolean {
  const provided = headerValue(c, header);
  return !provided || provided === expected;
}

function assertDeviceMatchesAuth(auth: BridgeAuthContext, deviceId: string, bridgeId: string): void {
  if (auth.deviceId && auth.deviceId !== deviceId) throw new Error("permission-denied");
  if (auth.bridgeId && auth.bridgeId !== bridgeId) throw new Error("permission-denied");
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function mapService(row: any): any {
  return {
    organizationId: row.organization_id,
    serviceId: row.service_id,
    serviceInstanceId: row.service_instance_id,
    name: row.name,
    description: row.description,
    baseUrl: row.base_url,
    healthUrl: row.health_url,
    launchCallbackUrl: row.launch_callback_url,
    adminUrl: row.admin_url,
    iconUrl: row.icon_url,
    dataStrategy: row.data_strategy,
    supabaseProjectRef: row.supabase_project_ref,
    ...(row.manifest ?? {}),
    enabled: row.enabled,
  };
}

function mapNestedService(row: any): any {
  const service = Array.isArray(row) ? row[0] : row;
  return service ? mapService(service) : null;
}

function mapJob(row: any): any {
  return {
    id: row.id,
    leaseId: row.lease_id,
    organizationId: row.organization_id,
    serviceId: row.service_id,
    serviceInstanceId: row.service_instance_id,
    userId: row.user_id,
    scopes: row.scopes ?? [],
    payload: row.payload,
  };
}

function mapBusEvent(row: any): any {
  return {
    id: row.id,
    organizationId: row.organization_id,
    sourceServiceId: row.source_service_id,
    type: row.type,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    payload: row.payload,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
  };
}

function normalizeReturnTo(value: unknown): string | undefined {
  const raw = cleanString(value);
  if (!raw) return undefined;
  if (raw.length > MAX_RETURN_TO_LENGTH) throw new Error("invalid-return-to");
  if (raw.startsWith("/") && !raw.startsWith("//")) return raw;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("invalid-return-to");
  }
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    throw new Error("invalid-return-to");
  }
  return parsed.toString();
}

function normalizeBridgeError(err: unknown): { status: number; body: { ok?: false; error: string } } {
  const normalized = normalizeAuthError(err);
  if (normalized.status !== 500) {
    return { status: normalized.status, body: { ok: false, error: normalized.body.error } };
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/unauthorized|invalid-bridge-token|expired-bridge-token|invalid-ticket/i.test(message)) {
    return { status: 401, body: { ok: false, error: "unauthorized" } };
  }
  if (/permission-denied|scope-forbidden|invalid-return-to/i.test(message)) {
    return { status: 403, body: { ok: false, error: "permission-denied" } };
  }
  if (/required|missing|secret/i.test(message)) {
    return { status: 400, body: { ok: false, error: message } };
  }
  console.error("[bridge-control-plane]", err);
  return { status: 500, body: { ok: false, error: "internal-error" } };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
