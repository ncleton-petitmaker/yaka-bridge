import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { hostname, homedir, platform } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { BridgeCloudClient } from "./client.js";
import {
  loadBridgeConfig,
  resolveConfigPath,
  saveBridgeConfig,
  safeSegment,
  serviceDataDir,
  serviceRoots,
} from "./config.js";
import {
  BRIDGE_PRODUCT_NAME,
  BRIDGE_PROTOCOL_VERSION,
  type BridgeCodexStatus,
  type BridgeConfig,
  type BridgePathRef,
  type BridgeRuntimeServiceState,
  type BridgeRuntimeState,
  type BridgeServiceInstance,
  type CloudBridgeJob,
} from "./types.js";
import {
  attachListener,
  cancelRun,
  getRun,
  getRunUsage,
  startRun,
  waitForRun,
} from "../server/runs.js";
import { buildEnrichedPath, findCodexBin } from "../server/agents.js";
import { setPricingDataDir } from "../server/pricing.js";

let codexStatusCache: { checkedMs: number; status: BridgeCodexStatus } | null = null;

export interface BridgeRuntimeOptions {
  command?: "run" | "once";
  configPath?: string;
  healthServer?: boolean;
  onState?: (state: BridgeRuntimeState) => void;
}

export interface BridgeRuntimeHandle {
  state(): BridgeRuntimeState;
  pollOnce(): Promise<void>;
  syncOnce(): Promise<void>;
  stop(): void;
}

class BridgeRuntime implements BridgeRuntimeHandle {
  private cfg: BridgeConfig;
  private client: BridgeCloudClient;
  private healthServer: Server | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private runningByService = new Map<string, number>();
  private lastSyncAt: string | undefined;
  private lastError: string | undefined;

  constructor(private readonly options: Required<Pick<BridgeRuntimeOptions, "configPath" | "healthServer">> & Omit<BridgeRuntimeOptions, "configPath" | "healthServer">) {
    this.cfg = loadBridgeConfig(options.configPath);
    this.client = new BridgeCloudClient(this.cfg);
  }

  async start(): Promise<void> {
    setupBridgeFileLog(this.cfg);
    ensureRuntimeDirs(this.cfg);
    setPricingDataDir(this.cfg.dataDir);
    if (this.options.healthServer) this.startLocalHealthServer();

    if (this.client.isConfigured()) {
      await this.registerAndSync().catch((err) => this.setError(err));
    }
    this.emitState();

    if (this.options.command === "once") {
      await this.pollOnce();
      return;
    }

    this.timer = setInterval(() => {
      void this.pollOnce().catch((err) => this.setError(err));
    }, (this.cfg.pollIntervalSeconds ?? 5) * 1000);
  }

  state(): BridgeRuntimeState {
    return runtimeState(this.cfg, {
      activeJobs: Array.from(this.runningByService.values()).reduce((sum, count) => sum + count, 0),
      runningByService: this.runningByService,
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError,
    });
  }

  async syncOnce(): Promise<void> {
    if (!this.client.isConfigured()) {
      this.emitState();
      return;
    }
    await refreshSupabaseSessionIfNeeded(this.cfg, this.options.configPath);
    const synced = await this.client.sync(this.state()).catch((err) => {
      this.handleAuthError(err);
      throw err;
    });
    if (synced.bridgeId && synced.bridgeId !== this.cfg.bridgeId) {
      this.cfg.bridgeId = synced.bridgeId;
    }
    if (synced.account) {
      this.cfg.account = synced.account;
      this.cfg.userId = synced.account.userId;
      this.cfg.organizationId = synced.account.organizationId;
    }
    if (synced.services?.length) this.cfg.services = synced.services;
    if (synced.erpBus) this.cfg.erpBus = synced.erpBus;
    if (synced.updateBaseUrl) this.cfg.updateBaseUrl = synced.updateBaseUrl;
    if (synced.latestVersion) this.cfg.latestVersion = synced.latestVersion;
    if (synced.minimumVersion) this.cfg.minimumVersion = synced.minimumVersion;
    if (synced.installerBaseUrl) this.cfg.installerBaseUrl = synced.installerBaseUrl;
    if (synced.windowsInstallerUrl) this.cfg.windowsInstallerUrl = synced.windowsInstallerUrl;
    if (synced.macInstallerUrl) this.cfg.macInstallerUrl = synced.macInstallerUrl;
    this.lastSyncAt = synced.serverTime ?? new Date().toISOString();
    this.lastError = synced.error;
    saveBridgeConfig(this.cfg, this.options.configPath);
    ensureRuntimeDirs(this.cfg);
    this.emitState();
  }

  async pollOnce(): Promise<void> {
    if (!this.client.isConfigured()) {
      this.emitState();
      return;
    }

    await refreshSupabaseSessionIfNeeded(this.cfg, this.options.configPath);
    const res = await this.client.poll(capabilities(this.cfg)).catch((err) => {
      this.handleAuthError(err);
      throw err;
    });
    this.lastSyncAt = res.serverTime ?? new Date().toISOString();
    if (!res.jobs?.length) {
      this.lastError = undefined;
      this.emitState();
      return;
    }
    console.log(`[bridge] ${res.jobs.length} job(s) reçu(s) du Control Plane.`);

    const maxGlobal = this.cfg.maxConcurrentJobs ?? 10;
    const runnable = res.jobs.filter((job) => {
      const service = serviceForJob(this.cfg, job);
      if (!service || service.paused) return false;
      const running = this.runningByService.get(service.serviceId) ?? 0;
      return running < (service.maxConcurrentJobs ?? 10);
    });
    const capacity = Math.max(0, maxGlobal - this.state().activeJobs);
    if (!runnable.length || capacity <= 0) {
      console.warn(`[bridge] aucun job exécutable après bail: runnable=${runnable.length}, capacity=${capacity}.`);
      await Promise.all(
        res.jobs.map((job) =>
          this.completeSkippedJob(job, runnable.length ? "Capacité Bridge saturée." : "Service Bridge local indisponible ou en pause.")
        )
      );
      return;
    }

    await Promise.all(
      runnable
        .slice(0, capacity)
        .map((job) => this.runCloudJob(job))
    );
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.healthServer?.close();
  }

  private async registerAndSync(): Promise<void> {
    await refreshSupabaseSessionIfNeeded(this.cfg, this.options.configPath);
    const registered = await this.client.register(capabilities(this.cfg)).catch((err) => {
      this.handleAuthError(err);
      throw err;
    });
    if (registered.bridgeId && registered.bridgeId !== this.cfg.bridgeId) {
      this.cfg.bridgeId = registered.bridgeId;
      saveBridgeConfig(this.cfg, this.options.configPath);
    }
    await this.syncOnce();
    console.log(
      `[bridge] ${this.cfg.label ?? this.cfg.installId} connecté à ${this.cfg.controlPlaneBaseUrl} (org ${this.cfg.organizationId ?? "n/a"})`
    );
  }

  private async runCloudJob(job: CloudBridgeJob): Promise<void> {
    const service = serviceForJob(this.cfg, job);
    if (!service) {
      await this.client.completeJob({
        organizationId: job.organizationId,
        serviceId: job.serviceId,
        jobId: job.id,
        leaseId: job.leaseId,
        localRunId: "",
        status: "failed",
        error: `Service Bridge inconnu: ${job.serviceId}`,
      }).catch(() => null);
      return;
    }

    this.incrementService(service.serviceId);
    service.status = "active";
    service.lastError = undefined;
    service.lastSeenAt = new Date().toISOString();
    this.emitState();

    const payload = job.payload;
    const cwd = resolvePathRef(this.cfg, service, payload.cwd) ?? serviceDataDir(this.cfg, service.serviceId);
    const serviceRoot = serviceDataDir(this.cfg, service.serviceId);
    const addDirs = new Set<string>([serviceRoot]);
    for (const ref of payload.addDirs ?? []) {
      const dir = resolvePathRef(this.cfg, service, ref);
      if (dir) addDirs.add(dir);
    }
    let localRunId = "";
    let seq = 0;
    try {
      const assets = await prepareJobAssets(this.cfg, service, job);
      const run = startRun({
        prompt: payload.prompt,
        cwd,
        tag: payload.tag ?? `${service.serviceId}-${job.id}`,
        model: payload.model ?? this.cfg.defaultModel,
        addDirs: Array.from(addDirs),
        allowedTools: payload.allowedTools,
        maxTurns: payload.maxTurns,
        images: assets.images,
        outputSchema: assets.outputSchema,
        sandbox: normalizeJobSandbox(job, service),
        includeMcp: payload.includeMcp ?? Boolean(payload.mcpProxyBaseUrl || service.baseUrl),
        mcpProxyBaseUrl: payload.mcpProxyBaseUrl ?? service.baseUrl,
        mcpProxyAccessToken: payload.mcpProxyAccessToken ?? this.cfg.bridgeToken ?? this.cfg.session?.accessToken,
        ephemeral: payload.ephemeral ?? true,
      });
      localRunId = run.id;
      attachListener(run.id, (event) => {
        seq += 1;
        void this.client.sendRunEventBatch({
          organizationId: job.organizationId,
          serviceId: service.serviceId,
          serviceInstanceId: service.serviceInstanceId,
          deviceId: this.cfg.deviceId,
          userId: job.userId ?? this.cfg.userId ?? this.cfg.account?.userId,
          jobId: job.id,
          leaseId: job.leaseId,
          localRunId: run.id,
          status: getRun(run.id)?.status,
          events: [{ seq, event }],
          usage: getRunUsage(run.id),
        }).catch((err) => {
          console.warn(`[bridge] event batch échoué: ${(err as Error).message}`);
        });
      });
      const finalRun = await waitForRun(run.id);
      service.status = finalRun?.status === "succeeded" ? "connected" : "disconnected";
      const finalError = finalRun?.status === "failed" ? runFailureMessage(finalRun) : undefined;
      await this.client.completeJob({
        organizationId: job.organizationId,
        serviceId: service.serviceId,
        serviceInstanceId: service.serviceInstanceId,
        deviceId: this.cfg.deviceId,
        userId: job.userId ?? this.cfg.userId ?? this.cfg.account?.userId,
        jobId: job.id,
        leaseId: job.leaseId,
        localRunId: run.id,
        status: finalRun?.status ?? "failed",
        error: finalError,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      service.status = "disconnected";
      service.lastError = message;
      if (localRunId) cancelRun(localRunId);
      await this.client.sendRunEventBatch({
        organizationId: job.organizationId,
        serviceId: service.serviceId,
        serviceInstanceId: service.serviceInstanceId,
        deviceId: this.cfg.deviceId,
        userId: job.userId ?? this.cfg.userId ?? this.cfg.account?.userId,
        jobId: job.id,
        leaseId: job.leaseId,
        localRunId,
        status: "failed",
        events: [],
        error: message,
      }).catch(() => null);
      await this.client.completeJob({
        organizationId: job.organizationId,
        serviceId: service.serviceId,
        serviceInstanceId: service.serviceInstanceId,
        deviceId: this.cfg.deviceId,
        userId: job.userId ?? this.cfg.userId ?? this.cfg.account?.userId,
        jobId: job.id,
        leaseId: job.leaseId,
        localRunId,
        status: "failed",
        error: message,
      }).catch(() => null);
    } finally {
      this.decrementService(service.serviceId);
      if (!this.stopped && service.status === "active") service.status = "connected";
      service.lastSeenAt = new Date().toISOString();
      this.emitState();
    }
  }

  private handleAuthError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    if (!isInvalidBridgeAuthMessage(message)) return;
    delete this.cfg.session;
    delete this.cfg.bridgeToken;
    this.cfg.sessionInvalidAt = new Date().toISOString();
    this.lastError = "Session Bridge expirée. Reconnecte ton compte Bridge dans l'onglet Identifiants.";
    saveBridgeConfig(this.cfg, this.options.configPath);
    this.emitState();
  }

  private async completeSkippedJob(job: CloudBridgeJob, error: string): Promise<void> {
    await this.client.completeJob({
      organizationId: job.organizationId,
      serviceId: job.serviceId,
      serviceInstanceId: job.serviceInstanceId,
      deviceId: this.cfg.deviceId,
      userId: job.userId ?? this.cfg.userId ?? this.cfg.account?.userId,
      jobId: job.id,
      leaseId: job.leaseId,
      localRunId: "",
      status: "failed",
      error,
    }).catch((err) => this.setError(err));
  }

  private incrementService(serviceId: string): void {
    this.runningByService.set(serviceId, (this.runningByService.get(serviceId) ?? 0) + 1);
  }

  private decrementService(serviceId: string): void {
    const next = Math.max(0, (this.runningByService.get(serviceId) ?? 0) - 1);
    if (next === 0) this.runningByService.delete(serviceId);
    else this.runningByService.set(serviceId, next);
  }

  private setError(err: unknown): void {
    this.lastError = err instanceof Error ? err.message : String(err);
    console.warn(`[bridge] ${this.lastError}`);
    this.emitState();
  }

  private emitState(): void {
    this.options.onState?.(this.state());
  }

  private startLocalHealthServer(): void {
    if (this.healthServer) return;
    const port = Number(process.env.BRIDGE_HEALTH_PORT ?? process.env.APP_BRIDGE_HEALTH_PORT ?? process.env.NEXT_PUBLIC_DAEMON_PORT ?? "7707") || 7707;
    this.healthServer = createServer((req, res) => {
      const origin = req.headers.origin;
      res.setHeader("access-control-allow-origin", typeof origin === "string" ? origin : "*");
      res.setHeader("access-control-allow-methods", "GET, OPTIONS");
      res.setHeader("access-control-allow-headers", "content-type, authorization");
      res.setHeader("access-control-allow-private-network", "true");
      res.setHeader("vary", "origin");
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === "GET" && (req.url === "/api/health" || req.url === "/health")) {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(this.state()));
        return;
      }
      res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "not-found" }));
    });
    this.healthServer.on("error", (err) => {
      this.setError(`health local indisponible sur 127.0.0.1:${port}: ${(err as Error).message}`);
    });
    this.healthServer.listen(port, "127.0.0.1", () => {
      console.log(`[bridge] health local: http://127.0.0.1:${port}/api/health`);
    });
  }
}

async function prepareJobAssets(
  cfg: BridgeConfig,
  service: BridgeServiceInstance,
  job: CloudBridgeJob
): Promise<{ images?: string[]; outputSchema?: string }> {
  const payload = job.payload;
  const jobDir = resolve(serviceDataDir(cfg, service.serviceId), "jobs", safeSegment(job.id));
  mkdirSync(jobDir, { recursive: true });

  let outputSchema: string | undefined;
  if (payload.outputSchema && typeof payload.outputSchema === "object") {
    outputSchema = resolve(jobDir, "output.schema.json");
    writeFileSync(outputSchema, JSON.stringify(payload.outputSchema, null, 2), "utf8");
  }

  const imageUrls = Array.isArray(payload.imageUrls) ? payload.imageUrls : [];
  const images: string[] = [];
  for (const [idx, rawUrl] of imageUrls.entries()) {
    const url = assertSafeDownloadUrl(String(rawUrl));
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`Image OCR ${idx + 1} HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > 15 * 1024 * 1024) {
      throw new Error(`Image OCR ${idx + 1} trop volumineuse (${bytes.length} octets).`);
    }
    const file = resolve(jobDir, `page-${String(idx + 1).padStart(3, "0")}.png`);
    writeFileSync(file, bytes);
    images.push(file);
  }

  return {
    images: images.length ? images : undefined,
    outputSchema,
  };
}

function assertSafeDownloadUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("Les images OCR doivent utiliser HTTPS.");
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) throw new Error("URL OCR locale interdite.");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split(".").map(Number);
    const privateIp =
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a === 127 ||
      a === 169;
    if (privateIp) throw new Error("URL OCR vers IP privée interdite.");
  }
  return url.toString();
}

async function refreshSupabaseSessionIfNeeded(cfg: BridgeConfig, configPath: string): Promise<void> {
  if (!cfg.session?.refreshToken || !cfg.supabaseUrl || !cfg.supabaseAnonKey) return;
  await withSupabaseRefreshLock(async () => {
    const fresh = loadBridgeConfig(configPath);
    if (fresh.session?.refreshToken) {
      const freshExpiresAt = fresh.session.expiresAt ? Date.parse(fresh.session.expiresAt) : 0;
      if (fresh.session.refreshToken !== cfg.session?.refreshToken && (!freshExpiresAt || freshExpiresAt - Date.now() > 60_000)) {
        Object.assign(cfg, fresh);
        return;
      }
      if (freshExpiresAt && freshExpiresAt - Date.now() > 60_000) {
        Object.assign(cfg, fresh);
        return;
      }
    }

    const expiresAt = cfg.session?.expiresAt ? Date.parse(cfg.session.expiresAt) : 0;
    if (expiresAt && expiresAt - Date.now() > 60_000) return;
    const supabaseUrl = cfg.supabaseUrl;
    const supabaseAnonKey = cfg.supabaseAnonKey;
    const session = cfg.session;
    const refreshToken = cfg.session?.refreshToken;
    if (!session || !refreshToken || !supabaseUrl || !supabaseAnonKey) return;
    const res = await fetch(`${supabaseUrl.replace(/\/+$/, "")}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        apikey: supabaseAnonKey,
        authorization: `Bearer ${supabaseAnonKey}`,
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = json.error_description || json.msg || json.error || `Refresh HTTP ${res.status}`;
      if (isInvalidBridgeAuthMessage(message)) {
        const latest = loadBridgeConfig(configPath);
        const latestExpiresAt = latest.session?.expiresAt ? Date.parse(latest.session.expiresAt) : 0;
        if (
          latest.session?.refreshToken &&
          latest.session.refreshToken !== refreshToken &&
          (!latestExpiresAt || latestExpiresAt - Date.now() > 60_000)
        ) {
          Object.assign(cfg, latest);
          return;
        }
        delete cfg.session;
        delete cfg.bridgeToken;
        cfg.sessionInvalidAt = new Date().toISOString();
        saveBridgeConfig(cfg, configPath);
        throw new Error("Session Bridge expirée. Reconnecte ton compte Bridge dans l'onglet Identifiants.");
      }
      throw new Error(message);
    }
    session.accessToken = json.access_token;
    session.refreshToken = json.refresh_token || session.refreshToken;
    session.expiresAt = json.expires_in ? new Date(Date.now() + Number(json.expires_in) * 1000).toISOString() : session.expiresAt;
    session.lastRefreshAt = new Date().toISOString();
    saveBridgeConfig(cfg, configPath);
  });
}

function isInvalidBridgeAuthMessage(message: string): boolean {
  return /invalid refresh token|refresh token not found|refresh_token_not_found|token not found|session_id claim in jwt does not exist/i.test(message);
}

function withSupabaseRefreshLock(fn: () => Promise<void>): Promise<void> {
  const key = "__bridgeSupabaseRefreshLock";
  const globalState = globalThis as typeof globalThis & Record<string, Promise<void> | undefined>;
  const previous = globalState[key] || Promise.resolve();
  const next = previous.catch(() => undefined).then(fn);
  const locked = next.finally(() => {
    if (globalState[key] === locked) delete globalState[key];
  });
  globalState[key] = locked;
  return next;
}

export async function startBridgeRuntime(options: BridgeRuntimeOptions = {}): Promise<BridgeRuntimeHandle> {
  const runtime = new BridgeRuntime({
    command: options.command ?? "run",
    configPath: options.configPath ?? resolveConfigPath(),
    healthServer: options.healthServer ?? true,
    onState: options.onState,
  });
  await runtime.start();
  return runtime;
}

function setupBridgeFileLog(cfg: BridgeConfig): void {
  try {
    mkdirSync(cfg.dataDir, { recursive: true });
    const logPath = resolve(cfg.dataDir, "bridge.log");
    const stamp = () => new Date().toISOString();
    const write = (level: string, args: unknown[]) => {
      try {
        const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
        appendFileSync(logPath, `${stamp()} [${level}] ${line}\n`);
      } catch {
        // Logging must never stop the bridge.
      }
    };
    for (const level of ["log", "warn", "error"] as const) {
      const original = console[level].bind(console);
      console[level] = (...args: unknown[]) => {
        write(level, args);
        original(...args);
      };
    }
    process.on("uncaughtException", (err) => write("uncaught", [err?.stack ?? String(err)]));
    process.on("unhandledRejection", (err) => write("unhandled", [String(err)]));
  } catch {
    // Continue without file logs.
  }
}

function ensureRuntimeDirs(cfg: BridgeConfig): void {
  mkdirSync(cfg.dataDir, { recursive: true });
  mkdirSync(resolve(cfg.dataDir, ".claude"), { recursive: true });
  mkdirSync(resolve(cfg.dataDir, "bus"), { recursive: true });
  for (const service of cfg.services) {
    mkdirSync(serviceDataDir(cfg, service.serviceId), { recursive: true });
    mkdirSync(resolve(serviceDataDir(cfg, service.serviceId), "runs"), { recursive: true });
    for (const root of serviceRoots(cfg, service)) {
      if (root.writable !== false) mkdirSync(root.path, { recursive: true });
    }
  }
}

function capabilities(cfg: BridgeConfig): Record<string, unknown> {
  const codex = getRuntimeCodexStatus();
  const currentVersion = process.env.APP_BRIDGE_VERSION ?? process.env.npm_package_version ?? "dev";
  return {
    app: BRIDGE_PRODUCT_NAME,
    productName: BRIDGE_PRODUCT_NAME,
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    version: currentVersion,
    host: hostname(),
    platform: platform(),
    codexAvailable: codex.ready,
    codexBin: codex.path ? "detected" : "missing",
    codex,
    update: {
      latestVersion: cfg.latestVersion,
      minimumVersion: cfg.minimumVersion,
      updateRequired: Boolean(cfg.minimumVersion && compareSemverLike(currentVersion, cfg.minimumVersion) < 0),
      currentVersion,
    },
    maxConcurrentJobs: cfg.maxConcurrentJobs ?? 10,
    erpBus: cfg.erpBus,
    services: cfg.services.map((service) => ({
      serviceId: service.serviceId,
      serviceInstanceId: service.serviceInstanceId,
      name: service.name,
      status: service.status,
      paused: service.paused === true,
      scopes: service.scopes,
      actions: service.actions ?? [],
      events: service.events ?? [],
      allowedRoots: serviceRoots(cfg, service).map((root) => ({
        id: root.id,
        label: root.label,
        writable: root.writable !== false,
        scopes: root.scopes ?? [],
      })),
    })),
  };
}

function compareSemverLike(a: unknown, b: unknown): number {
  const left = String(a || "").match(/\d+/g)?.map(Number) || [];
  const right = String(b || "").match(/\d+/g)?.map(Number) || [];
  if (!left.length || !right.length) return 0;
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function getRuntimeCodexStatus({ force = false } = {}): BridgeCodexStatus {
  const now = Date.now();
  if (!force && codexStatusCache && now - codexStatusCache.checkedMs < 15_000) {
    return codexStatusCache.status;
  }

  const installCommand = "npm install -g @openai/codex";
  const loginCommand = "codex login";
  const checkedAt = new Date().toISOString();
  const authPath = resolve(homedir(), ".codex", "auth.json");
  const bin = findCodexBin();

  const finish = (status: Omit<BridgeCodexStatus, "installCommand" | "loginCommand" | "checkedAt">): BridgeCodexStatus => {
    const next = {
      installCommand,
      loginCommand,
      checkedAt,
      ...status,
    };
    codexStatusCache = { checkedMs: now, status: next };
    return next;
  };

  if (!bin) {
    return finish({
      ready: false,
      state: "missing",
      label: "Codex non installé",
      detail: "Installe Codex CLI puis connecte-le pour que Bridge puisse exécuter les agents.",
      path: null,
      version: null,
      loggedIn: null,
      authPath,
    });
  }

  const versionProbe = runCodexProbe(bin, ["--version"], 5_000);
  const versionOutput = `${versionProbe.stdout || ""}\n${versionProbe.stderr || ""}`.trim();
  const version = versionOutput.match(/(\d+\.\d+\.\d+)/)?.[1] || versionOutput.split(/\s+/).find(Boolean) || null;
  if (!versionProbe.ok) {
    return finish({
      ready: false,
      state: "error",
      label: "Codex à vérifier",
      detail: "Codex est détecté, mais le test de version échoue.",
      path: bin,
      version,
      loggedIn: null,
      authPath,
      diagnostic: compactProbeError(versionProbe),
    });
  }

  const loginProbe = runCodexProbe(bin, ["login", "status"], 5_000);
  const loginOutput = `${loginProbe.stdout || ""}\n${loginProbe.stderr || ""}`.trim();
  const authFileExists = existsSync(authPath);
  const loggedIn =
    loginProbe.ok ||
    /logged in|connect[eé]|authenticated|chatgpt|api key/i.test(loginOutput) ||
    (!/not logged|not authenticated|login required|no login|not signed/i.test(loginOutput) && authFileExists);

  if (!loggedIn) {
    return finish({
      ready: false,
      state: "login_required",
      label: "Connexion Codex requise",
      detail: "Codex est installé, mais il n'est pas connecté à un compte OpenAI.",
      path: bin,
      version,
      loggedIn: false,
      authPath,
      diagnostic: loginOutput || "codex login status ne confirme pas de session active.",
    });
  }

  return finish({
    ready: true,
    state: "ready",
    label: "Codex prêt",
    detail: "Codex CLI est installé et connecté. Les agents Bridge peuvent tourner sur cet ordinateur.",
    path: bin,
    version,
    loggedIn: true,
    authPath: authFileExists ? authPath : null,
    diagnostic: loginOutput || undefined,
  });
}

function runCodexProbe(bin: string, args: string[], timeout: number): {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
  error: string;
} {
  const shellForCmd = process.platform === "win32" && /\.(cmd|bat)$/i.test(bin);
  try {
    const enrichedPath = buildEnrichedPath();
    const res = spawnSync(bin, args, {
      encoding: "utf8",
      shell: shellForCmd,
      env: { ...process.env, PATH: enrichedPath, Path: enrichedPath },
      timeout,
    });
    return {
      ok: res.status === 0,
      status: res.status,
      stdout: res.stdout || "",
      stderr: res.stderr || "",
      error: res.error?.message || "",
    };
  } catch (err) {
    return {
      ok: false,
      status: null,
      stdout: "",
      stderr: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function runFailureMessage(run: { events?: any[]; exitCode?: number | null } | null): string {
  const events = Array.isArray(run?.events) ? run.events : [];
  const parts = [...events]
    .reverse()
    .filter((event) => event?.kind === "error" || event?.kind === "stderr")
    .map((event) => String(event.error ?? event.text ?? "").trim())
    .filter(Boolean);
  const message = parts.join("\n").trim();
  if (message) return message.slice(0, 1000);
  return `Run Codex échoué${run?.exitCode != null ? ` (code ${run.exitCode})` : ""}.`;
}

function compactProbeError(probe: { error?: string; stderr?: string; stdout?: string }): string {
  return [probe.error, probe.stderr, probe.stdout]
    .filter(Boolean)
    .join("\n")
    .slice(0, 500);
}

function runtimeState(
  cfg: BridgeConfig,
  runtime: {
    activeJobs: number;
    runningByService: Map<string, number>;
    lastSyncAt?: string;
    lastError?: string;
  }
): BridgeRuntimeState {
  return {
    ok: true,
    bridge: true,
    productName: BRIDGE_PRODUCT_NAME,
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    version: process.env.APP_BRIDGE_VERSION ?? process.env.npm_package_version ?? "dev",
    label: cfg.label,
    account: cfg.account,
    organizationId: cfg.organizationId ?? cfg.account?.organizationId,
    installId: cfg.installId,
    deviceId: cfg.deviceId,
    bridgeId: cfg.bridgeId,
    dataDir: cfg.dataDir,
    controlPlaneConfigured: Boolean(cfg.controlPlaneBaseUrl && (cfg.bridgeToken || cfg.session?.accessToken)),
    authenticated: Boolean(cfg.session?.accessToken || cfg.bridgeToken),
    codex: getRuntimeCodexStatus(),
    demoMode: cfg.demoMode === true,
    services: cfg.services.map((service): BridgeRuntimeServiceState => {
      const runningJobs = runtime.runningByService.get(service.serviceId) ?? 0;
      return {
        serviceId: service.serviceId,
        serviceInstanceId: service.serviceInstanceId,
        name: service.name,
        baseUrl: service.baseUrl,
        healthUrl: service.healthUrl,
        status: service.paused ? "paused" : runningJobs > 0 ? "active" : service.status ?? "disconnected",
        scopes: service.scopes,
        runningJobs,
        lastSeenAt: service.lastSeenAt,
        lastError: service.lastError,
        actions: service.actions ?? [],
        events: service.events ?? [],
      };
    }),
    erpBus: cfg.erpBus,
    activeJobs: runtime.activeJobs,
    lastSyncAt: runtime.lastSyncAt,
    lastError: runtime.lastError,
    ts: new Date().toISOString(),
  };
}

function serviceForJob(cfg: BridgeConfig, job: CloudBridgeJob): BridgeServiceInstance | undefined {
  return cfg.services.find((service) => service.serviceId === job.serviceId || service.serviceInstanceId === job.serviceInstanceId);
}

function resolvePathRef(cfg: BridgeConfig, service: BridgeServiceInstance, ref: BridgePathRef | undefined): string | undefined {
  if (!ref) return undefined;
  const roots = serviceRoots(cfg, service);

  if (typeof ref === "string") {
    const raw = ref.trim();
    const resolved = isAbsolute(raw) ? resolve(raw) : resolve(serviceDataDir(cfg, service.serviceId), raw);
    return assertInsideRoots(resolved, roots, raw);
  }

  const rootId = ref.rootId ?? "service-data";
  const root = roots.find((candidate) => candidate.id === rootId);
  if (!root) throw new Error(`Racine bridge non autorisée pour ${service.serviceId}: ${rootId}`);
  const resolved = resolve(root.path, ref.relativePath ?? "");
  return assertInsideRoots(resolved, [root], ref.relativePath ?? "");
}

function assertInsideRoots(resolved: string, roots: ReturnType<typeof serviceRoots>, label: string): string {
  for (const root of roots) {
    const rootPath = resolve(root.path);
    const rel = relative(rootPath, resolved);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
      if (!existsSync(resolved)) return resolved;
      const realRoot = realpathSync.native(rootPath);
      const realResolved = realpathSync.native(resolved);
      const realRel = relative(realRoot, realResolved);
      if (realRel === "" || (!realRel.startsWith("..") && !isAbsolute(realRel))) return resolved;
    }
  }
  throw new Error(`Chemin hors racine autorisée: ${label}`);
}

function normalizeJobSandbox(job: CloudBridgeJob, service: BridgeServiceInstance): "read-only" | "workspace-write" | "danger-full-access" {
  const sandbox = job.payload.sandbox ?? "read-only";
  if (sandbox !== "danger-full-access") return sandbox;
  const scopes = new Set([...(job.scopes ?? []), ...(service.scopes ?? [])]);
  if (scopes.has("codex:danger-full-access")) return sandbox;
  throw new Error(`Sandbox danger-full-access refusée pour ${service.serviceId}.`);
}
