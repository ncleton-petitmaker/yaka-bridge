import type { Hono } from "hono";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

interface ControlPlaneStore {
  services: any[];
  erpBus: any;
  devices: any[];
  jobs: any[];
  jobEvents: any[];
  busEvents: any[];
  launchTickets: any[];
  audit: any[];
}

export function registerBridgeControlPlaneRoutes(app: Hono, dataDir: string): void {
  app.get("/bridge/auth/config", (c) => {
    return c.json({
      ok: true,
      supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_PUBLIC_URL ?? process.env.SUPABASE_URL,
      supabaseAnonKey:
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
        process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
        process.env.SUPABASE_ANON_KEY,
    });
  });

  app.post("/bridge/register", async (c) => {
    const body = await readPayload(c);
    const store = loadStore(dataDir);
    const deviceId = body.deviceId ?? body.installId ?? randomUUID();
    const bridgeId = body.bridgeId ?? `bridge_${deviceId}`;
    upsertDevice(store, {
      bridgeId,
      deviceId,
      installId: body.installId,
      label: body.label,
      capabilities: body.capabilities ?? {},
      lastSeenAt: new Date().toISOString(),
    });
    saveStore(dataDir, store);
    return c.json({ ok: true, bridgeId, serverTime: new Date().toISOString() });
  });

  app.post("/bridge/sync", async (c) => {
    const body = await readPayload(c);
    const store = loadStore(dataDir);
    if (body.deviceId || body.installId) {
      upsertDevice(store, {
        bridgeId: body.bridgeId,
        deviceId: body.deviceId ?? body.installId,
        installId: body.installId,
        label: body.label,
        state: body.state,
        lastSeenAt: new Date().toISOString(),
      });
      saveStore(dataDir, store);
    }
    return c.json({
      ok: true,
      services: store.services,
      erpBus: store.erpBus,
      serverTime: new Date().toISOString(),
    });
  });

  app.post("/bridge/services", (c) => {
    const store = loadStore(dataDir);
    return c.json({ ok: true, services: store.services, erpBus: store.erpBus, serverTime: new Date().toISOString() });
  });

  app.post("/bridge/browser-session", async (c) => {
    const envelope = await readEnvelope(c);
    const payload = envelope.payload ?? {};
    const browserSessionId = String(payload.browserSessionId ?? "").trim();
    if (!/^[A-Za-z0-9_-]{24,160}$/.test(browserSessionId)) {
      return c.json({ ok: false, error: "invalid-browser-session" }, 400);
    }
    const store = loadStore(dataDir);
    const state = payload.state && typeof payload.state === "object" ? payload.state : {};
    const existing = store.devices.find((candidate) =>
      candidate.deviceId === (envelope.deviceId ?? payload.deviceId ?? envelope.installId ?? payload.installId)
    );
    upsertDevice(store, {
      bridgeId: envelope.bridgeId ?? payload.bridgeId,
      deviceId: envelope.deviceId ?? payload.deviceId ?? envelope.installId ?? payload.installId,
      installId: envelope.installId ?? payload.installId,
      label: payload.label ?? state.label,
      capabilities: {
        ...(existing?.capabilities ?? {}),
        ...state,
        browserSession: {
          id: browserSessionId,
          seen_at: new Date().toISOString(),
          return_url: typeof payload.returnUrl === "string" ? payload.returnUrl.slice(0, 600) : null,
        },
      },
      lastSeenAt: new Date().toISOString(),
    });
    saveStore(dataDir, store);
    return c.json({ ok: true, serverTime: new Date().toISOString() });
  });

  app.post("/bridge/launch-ticket", async (c) => {
    const envelope = await readEnvelope(c);
    const request = envelope.payload ?? {};
    const store = loadStore(dataDir);
    const service = store.services.find((candidate) => candidate.serviceId === request.serviceId);
    if (!service || service.enabled === false) return c.json({ ok: false, error: "service-not-found" }, 404);
    const token = randomBytes(32).toString("base64url");
    const ticket = {
      id: randomUUID(),
      organizationId: envelope.organizationId ?? service.organizationId,
      userId: envelope.userId,
      serviceId: service.serviceId,
      serviceInstanceId: service.serviceInstanceId,
      deviceId: envelope.deviceId,
      ticketHash: sha256(token),
      returnTo: request.returnTo,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      usedAt: null,
      createdAt: new Date().toISOString(),
    };
    store.launchTickets.push(ticket);
    store.audit.push(audit(envelope, "bridge.launch-ticket.create", "launch-ticket", ticket.id, "success", { serviceId: service.serviceId }));
    saveStore(dataDir, store);
    const separator = service.launchCallbackUrl?.includes("?") ? "&" : "?";
    const launchUrl = service.launchCallbackUrl
      ? `${service.launchCallbackUrl}${separator}ticket=${encodeURIComponent(token)}`
      : `${service.baseUrl}${service.baseUrl.includes("?") ? "&" : "?"}bridge_ticket=${encodeURIComponent(token)}`;
    return c.json({ ok: true, ticketId: ticket.id, launchUrl, expiresAt: ticket.expiresAt });
  });

  app.post("/bridge/jobs/poll", async (c) => {
    const envelope = await readEnvelope(c);
    const body = envelope.payload ?? {};
    const serviceIds = new Set(Array.isArray(body.serviceIds) ? body.serviceIds : []);
    const store = loadStore(dataDir);
    const now = Date.now();
    if (envelope.deviceId || envelope.installId || body.deviceId || body.installId) {
      upsertDevice(store, {
        bridgeId: envelope.bridgeId ?? body.bridgeId,
        deviceId: envelope.deviceId ?? body.deviceId ?? envelope.installId ?? body.installId,
        installId: envelope.installId ?? body.installId,
        label: body.label,
        capabilities: body.capabilities ?? {},
        state: body.state,
        lastSeenAt: new Date(now).toISOString(),
      });
    }
    const jobs = store.jobs
      .filter((job) => job.status === "queued")
      .filter((job) => serviceIds.size === 0 || serviceIds.has(job.serviceId))
      .slice(0, 5)
      .map((job) => {
        job.status = "leased";
        job.leaseId = randomUUID();
        job.deviceId = envelope.deviceId;
        job.leasedUntil = new Date(now + 2 * 60_000).toISOString();
        job.updatedAt = new Date().toISOString();
        return {
          id: job.id,
          leaseId: job.leaseId,
          organizationId: job.organizationId,
          serviceId: job.serviceId,
          serviceInstanceId: job.serviceInstanceId,
          userId: job.userId,
          scopes: job.scopes ?? [],
          payload: job.payload,
        };
      });
    saveStore(dataDir, store);
    return c.json({ ok: true, jobs, serverTime: new Date(now).toISOString() });
  });

  app.post("/bridge/jobs/events", async (c) => {
    const envelope = await readEnvelope(c);
    const batch = envelope.payload ?? {};
    const store = loadStore(dataDir);
    for (const item of batch.events ?? []) {
      store.jobEvents.push({
        id: store.jobEvents.length + 1,
        organizationId: batch.organizationId ?? envelope.organizationId,
        serviceId: batch.serviceId,
        jobId: batch.jobId,
        leaseId: batch.leaseId,
        localRunId: batch.localRunId,
        seq: item.seq,
        status: batch.status,
        event: item.event,
        usage: batch.usage,
        error: batch.error,
        createdAt: new Date().toISOString(),
      });
    }
    saveStore(dataDir, store);
    return c.json({ ok: true });
  });

  app.post("/bridge/jobs/complete", async (c) => {
    const envelope = await readEnvelope(c);
    const payload = envelope.payload ?? {};
    const store = loadStore(dataDir);
    const job = store.jobs.find((candidate) => candidate.id === payload.jobId && candidate.leaseId === payload.leaseId);
    if (!job) return c.json({ ok: false, error: "job-not-found" }, 404);
    job.status = payload.status;
    job.localRunId = payload.localRunId;
    job.error = payload.error;
    job.completedAt = new Date().toISOString();
    job.updatedAt = new Date().toISOString();
    store.audit.push(audit(envelope, "bridge.job.complete", "bridge-job", job.id, payload.error ? "failure" : "success", { serviceId: payload.serviceId, status: payload.status }));
    saveStore(dataDir, store);
    return c.json({ ok: true });
  });

  app.post("/bridge/bus/events", async (c) => {
    const envelope = await readEnvelope(c);
    const event = envelope.payload ?? {};
    const store = loadStore(dataDir);
    if (!busEventAllowed(store, event.organizationId ?? envelope.organizationId, event.sourceServiceId, event.type)) {
      store.audit.push(audit(envelope, "bridge.bus.event.publish", "bridge-bus-event", event.type, "failure", { reason: "permission-denied" }));
      saveStore(dataDir, store);
      return c.json({ ok: false, error: "permission-denied" }, 403);
    }
    const row = {
      id: randomUUID(),
      ...event,
      organizationId: event.organizationId ?? envelope.organizationId,
      occurredAt: event.occurredAt ?? new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };
    store.busEvents.push(row);
    store.audit.push(audit(envelope, "bridge.bus.event.publish", "bridge-bus-event", row.id, "success", { type: row.type }));
    saveStore(dataDir, store);
    return c.json({ ok: true, event: row });
  });

  app.post("/bridge/bus/actions/call", async (c) => {
    const envelope = await readEnvelope(c);
    const call = envelope.payload ?? {};
    const store = loadStore(dataDir);
    const allowed = store.erpBus?.rules?.some((rule: any) =>
      rule.fromServiceId === call.sourceServiceId &&
      rule.toServiceId === call.targetServiceId &&
      (!rule.actionId || rule.actionId === call.actionId)
    );
    if (!allowed) {
      store.audit.push(audit(envelope, "bridge.bus.action.call", "bridge-action", call.actionId, "failure", { reason: "permission-denied" }));
      saveStore(dataDir, store);
      return c.json({ ok: false, error: "permission-denied" }, 403);
    }
    store.audit.push(audit(envelope, "bridge.bus.action.call", "bridge-action", call.actionId, "success", {
      sourceServiceId: call.sourceServiceId,
      targetServiceId: call.targetServiceId,
    }));
    saveStore(dataDir, store);
    return c.json({
      ok: true,
      output: {
        accepted: true,
        actionId: call.actionId,
        targetServiceId: call.targetServiceId,
        handledAt: new Date().toISOString(),
      },
    });
  });
}

async function readPayload(c: any): Promise<any> {
  const envelope = await readEnvelope(c);
  return envelope.payload ?? envelope;
}

async function readEnvelope(c: any): Promise<any> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

function storePath(dataDir: string): string {
  return resolve(dataDir, "bridge-control-plane.json");
}

function loadStore(dataDir: string): ControlPlaneStore {
  const p = storePath(dataDir);
  if (!existsSync(p)) return defaultStore();
  try {
    return { ...defaultStore(), ...JSON.parse(readFileSync(p, "utf8")) };
  } catch {
    return defaultStore();
  }
}

function saveStore(dataDir: string, store: ControlPlaneStore): void {
  const p = storePath(dataDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function defaultStore(): ControlPlaneStore {
  const organizationId = "demo-org";
  const services = [
    {
      organizationId,
      serviceId: "crm",
      serviceInstanceId: `${organizationId}:crm`,
      name: "CRM",
      description: "Socle clients et contacts partagé.",
      baseUrl: "http://localhost:3307/dashboard?service=crm",
      healthUrl: "http://localhost:7707/api/health",
      launchCallbackUrl: "http://localhost:3307/auth/bridge/callback",
      dataStrategy: "erp-core",
      scopes: ["erp:core:read", "erp:events:publish", "codex:run"],
      actions: [{ id: "customer.lookup", label: "Rechercher client", requiredScopes: ["erp:core:read"] }],
      events: [{ type: "core.customer.updated", label: "Client mis à jour", requiredScopes: ["erp:events:publish"] }],
      enabled: true,
    },
    {
      organizationId,
      serviceId: "purchasing",
      serviceInstanceId: `${organizationId}:purchasing`,
      name: "Achats",
      description: "Module achats connecté au socle ERP.",
      baseUrl: "http://localhost:3307/runs?service=purchasing",
      healthUrl: "http://localhost:7707/api/health",
      launchCallbackUrl: "http://localhost:3307/auth/bridge/callback",
      dataStrategy: "service-supabase",
      scopes: ["erp:core:read", "erp:events:consume", "codex:run"],
      actions: [{ id: "supplier.quote.import", label: "Importer offre", requiredScopes: ["codex:run"] }],
      events: [{ type: "purchasing.quote.imported", label: "Offre importée", requiredScopes: ["erp:events:publish"] }],
      enabled: true,
    },
  ];
  return {
    services,
    erpBus: {
      enabled: true,
      mode: "typed-actions-events",
      sharedCore: "organization",
      rules: [
        {
          fromServiceId: "crm",
          toServiceId: "purchasing",
          eventType: "core.customer.updated",
          scopes: ["erp:events:publish", "erp:events:consume"],
        },
        {
          fromServiceId: "purchasing",
          toServiceId: "crm",
          actionId: "customer.lookup",
          scopes: ["erp:core:read"],
        },
      ],
    },
    devices: [],
    jobs: [],
    jobEvents: [],
    busEvents: [],
    launchTickets: [],
    audit: [],
  };
}

function upsertDevice(store: ControlPlaneStore, device: any): void {
  const id = device.deviceId ?? device.installId;
  const existing = store.devices.find((candidate) => candidate.deviceId === id);
  if (existing) Object.assign(existing, device);
  else store.devices.push({ id: randomUUID(), ...device, deviceId: id, createdAt: new Date().toISOString() });
}

function busEventAllowed(store: ControlPlaneStore, organizationId: string, sourceServiceId: string, type: string): boolean {
  if (!store.erpBus?.enabled) return false;
  return store.erpBus.rules?.some((rule: any) =>
    rule.fromServiceId === sourceServiceId &&
    rule.eventType === type &&
    (!organizationId || rule.organizationId == null || rule.organizationId === organizationId)
  );
}

function audit(envelope: any, action: string, resourceType: string, resourceId: string, result: "success" | "failure", metadata: Record<string, unknown>): any {
  return {
    id: randomUUID(),
    organizationId: envelope.organizationId,
    actorUserId: envelope.userId,
    actorDeviceId: envelope.deviceId,
    action,
    resourceType,
    resourceId,
    result,
    metadata,
    createdAt: new Date().toISOString(),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
