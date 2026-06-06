import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, resolve } from "node:path";
import {
  BRIDGE_PRODUCT_NAME,
  type BridgeAllowedRoot,
  type BridgeConfig,
  type BridgeErpBusConfig,
  type BridgeSessionInfo,
  type BridgeServiceInstance,
} from "./types.js";

const DEFAULT_CONFIG_DIR = ".bridge";
const DEFAULT_DATA_DIR = resolve(homedir(), BRIDGE_PRODUCT_NAME, "data");
const SECURE_SECRETS_KEY = "_secureSecrets";

interface SecureBridgeSecrets {
  version: 1;
  provider: "electron-safe-storage";
  ciphertext: string;
}

interface BridgeSecretPayload {
  bridgeToken?: string;
  session?: Pick<BridgeSessionInfo, "accessToken" | "refreshToken">;
}

type PersistedBridgeConfig = Partial<BridgeConfig> & {
  [SECURE_SECRETS_KEY]?: SecureBridgeSecrets;
};

export function defaultBridgeConfigPath(): string {
  return resolve(homedir(), DEFAULT_CONFIG_DIR, "config.json");
}

export function defaultBridgeDataDir(): string {
  return DEFAULT_DATA_DIR;
}

export function resolveConfigPath(argv: string[] = process.argv.slice(2)): string {
  const fromArg = valueAfter(argv, "--config");
  return resolve(fromArg ?? process.env.BRIDGE_CONFIG ?? process.env.APP_BRIDGE_CONFIG ?? defaultBridgeConfigPath());
}

export function loadBridgeConfig(path = resolveConfigPath()): BridgeConfig {
  if (!existsSync(path)) {
    return normalizeBridgeConfig({});
  }
  const parsed = hydrateSecureBridgeSecrets(JSON.parse(readFileSync(path, "utf8")) as PersistedBridgeConfig);
  const cfg = normalizeBridgeConfig(parsed);
  validateBridgeConfig(cfg);
  return cfg;
}

export function saveBridgeConfig(cfg: BridgeConfig, path = resolveConfigPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(prepareBridgeConfigForDisk(normalizeBridgeConfig(cfg)), null, 2)}\n`, "utf8");
}

export function normalizeBridgeConfig(input: Partial<BridgeConfig>): BridgeConfig {
  const dataDir = resolvePath(
    input.dataDir ?? process.env.BRIDGE_DATA_DIR ?? process.env.APP_DATA_DIR ?? defaultBridgeDataDir()
  );
  const controlPlaneBaseUrl = cleanOptional(
    input.controlPlaneBaseUrl ??
      input.cloudBaseUrl ??
      process.env.BRIDGE_CONTROL_PLANE_URL ??
      process.env.APP_CLOUD_BASE_URL
  );
  const supabaseUrl = cleanOptional(input.supabaseUrl ?? process.env.BRIDGE_SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL);
  const supabaseAnonKey = cleanOptional(
    input.supabaseAnonKey ??
      process.env.BRIDGE_SUPABASE_ANON_KEY ??
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  );
  const updateBaseUrl = cleanOptional(input.updateBaseUrl ?? process.env.BRIDGE_UPDATE_BASE_URL ?? process.env.BRIDGE_AUTO_UPDATE_URL);
  const organizationId = cleanOptional(input.organizationId ?? process.env.BRIDGE_ORGANIZATION_ID ?? process.env.APP_ORGANIZATION_ID);
  const bridgeToken = cleanOptional(input.bridgeToken ?? process.env.BRIDGE_TOKEN ?? process.env.APP_BRIDGE_TOKEN);
  const installId = cleanOptional(input.installId) ?? randomUUID();
  const deviceId = cleanOptional(input.deviceId) ?? installId;
  const demoMode = input.demoMode === true || process.env.BRIDGE_DEMO_MODE === "1";

  const services = normalizeServices({
    services: input.services,
    dataDir,
    organizationId: organizationId ?? "demo-org",
    legacyAllowedRoots: input.allowedRoots,
    demoMode,
  });

  return {
    controlPlaneBaseUrl,
    supabaseUrl,
    supabaseAnonKey,
    updateBaseUrl,
    cloudBaseUrl: controlPlaneBaseUrl,
    organizationId,
    bridgeToken,
    bridgeId: cleanOptional(input.bridgeId ?? process.env.BRIDGE_ID ?? process.env.APP_BRIDGE_ID),
    installId,
    deviceId,
    userId: cleanOptional(input.userId),
    account: input.account,
    session: input.session,
    label: cleanOptional(input.label) ?? hostname(),
    dataDir,
    defaultModel: cleanOptional(input.defaultModel),
    maxConcurrentJobs: clampInt(input.maxConcurrentJobs, 1, 20, 2),
    pollIntervalSeconds: clampInt(input.pollIntervalSeconds, 2, 300, 5),
    services,
    erpBus: normalizeErpBus(input.erpBus, services),
    allowedRoots: normalizeAllowedRoots(input.allowedRoots ?? [], dataDir),
    demoMode,
  };
}

export function serviceDataDir(cfg: Pick<BridgeConfig, "dataDir">, serviceId: string): string {
  return resolve(cfg.dataDir, "services", safeSegment(serviceId));
}

export function serviceRoots(cfg: BridgeConfig, service: BridgeServiceInstance): BridgeAllowedRoot[] {
  const serviceRoot: BridgeAllowedRoot = {
    id: "service-data",
    label: "Données du service",
    path: serviceDataDir(cfg, service.serviceId),
    writable: true,
    scopes: ["codex:read", "codex:write"],
  };
  return [serviceRoot, ...normalizeAllowedRoots(service.allowedRoots ?? [], serviceRoot.path)];
}

function normalizeServices(input: {
  services?: BridgeServiceInstance[];
  dataDir: string;
  organizationId: string;
  legacyAllowedRoots?: BridgeAllowedRoot[];
  demoMode: boolean;
}): BridgeServiceInstance[] {
  const source = input.services?.length ? pruneLegacyDemoServices(input.services) : [];
  const raw = source.length ? source : input.demoMode ? demoServices(input.organizationId) : [];
  return raw.map((service) => {
    const serviceId = cleanRequired(service.serviceId, "service.serviceId");
    const root = serviceDataDir({ dataDir: input.dataDir }, serviceId);
    return {
      ...service,
      serviceId,
      serviceInstanceId: cleanOptional(service.serviceInstanceId) ?? `${input.organizationId}:${serviceId}`,
      organizationId: cleanOptional(service.organizationId) ?? input.organizationId,
      baseUrl: cleanRequired(service.baseUrl, `${serviceId}.baseUrl`),
      name: cleanRequired(service.name, `${serviceId}.name`),
      status: service.paused ? "paused" : service.status ?? "disconnected",
      scopes: normalizeStringList(service.scopes),
      requiredScopes: normalizeStringList(service.requiredScopes),
      actions: service.actions ?? [],
      events: service.events ?? [],
      allowedRoots:
        service.allowedRoots && service.allowedRoots.length > 0
          ? normalizeAllowedRoots(service.allowedRoots, root)
          : input.legacyAllowedRoots && input.legacyAllowedRoots.length > 0
            ? normalizeAllowedRoots(input.legacyAllowedRoots, root)
            : [],
      maxConcurrentJobs: clampInt(service.maxConcurrentJobs, 1, 20, 1),
    };
  });
}

function normalizeAllowedRoots(roots: BridgeAllowedRoot[], basePath: string): BridgeAllowedRoot[] {
  return roots.map((root) => ({
    ...root,
    id: cleanRequired(root.id, "root.id"),
    path: resolvePath(root.path || basePath),
    writable: root.writable !== false,
    scopes: normalizeStringList(root.scopes),
  }));
}

function hydrateSecureBridgeSecrets(input: PersistedBridgeConfig): Partial<BridgeConfig> {
  const secure = input[SECURE_SECRETS_KEY];
  if (!secure) return input;

  const payload = decryptBridgeSecrets(secure);
  if (!payload) return input;

  return {
    ...input,
    bridgeToken: payload.bridgeToken ?? input.bridgeToken,
    session: input.session || payload.session
      ? {
          provider: input.session?.provider ?? "supabase-pkce",
          ...input.session,
          ...payload.session,
          persisted: input.session?.persisted ?? true,
        }
      : undefined,
  };
}

function prepareBridgeConfigForDisk(cfg: BridgeConfig): PersistedBridgeConfig {
  const base = stripSecureSecrets(cfg as PersistedBridgeConfig);
  const payload: BridgeSecretPayload = {
    bridgeToken: cfg.bridgeToken,
    session: {
      accessToken: cfg.session?.accessToken,
      refreshToken: cfg.session?.refreshToken,
    },
  };
  const encrypted = encryptBridgeSecrets(payload);
  if (!encrypted) return base;

  const persisted: PersistedBridgeConfig = {
    ...base,
    bridgeToken: undefined,
    session: cfg.session
      ? {
          provider: cfg.session.provider,
          expiresAt: cfg.session.expiresAt,
          persisted: true,
          lastRefreshAt: cfg.session.lastRefreshAt,
        }
      : undefined,
    [SECURE_SECRETS_KEY]: encrypted,
  };
  return stripUndefined(persisted);
}

function encryptBridgeSecrets(payload: BridgeSecretPayload): SecureBridgeSecrets | null {
  if (!payload.bridgeToken && !payload.session?.accessToken && !payload.session?.refreshToken) return null;
  const safeStorage = electronSafeStorage();
  if (!safeStorage?.isEncryptionAvailable()) return null;
  const ciphertext = safeStorage.encryptString(JSON.stringify(payload)).toString("base64");
  return { version: 1, provider: "electron-safe-storage", ciphertext };
}

function decryptBridgeSecrets(secure: SecureBridgeSecrets): BridgeSecretPayload | null {
  if (secure.version !== 1 || secure.provider !== "electron-safe-storage" || !secure.ciphertext) return null;
  const safeStorage = electronSafeStorage();
  if (!safeStorage?.isEncryptionAvailable()) return null;
  try {
    return JSON.parse(safeStorage.decryptString(Buffer.from(secure.ciphertext, "base64"))) as BridgeSecretPayload;
  } catch {
    return null;
  }
}

function electronSafeStorage(): {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
} | null {
  try {
    if (!process.versions.electron) return null;
    const electron = require("electron") as {
      safeStorage?: {
        isEncryptionAvailable(): boolean;
        encryptString(value: string): Buffer;
        decryptString(value: Buffer): string;
      };
    };
    return electron.safeStorage ?? null;
  } catch {
    return null;
  }
}

function stripUndefined<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T;
}

function stripSecureSecrets(input: PersistedBridgeConfig): PersistedBridgeConfig {
  const copy = { ...input };
  delete copy[SECURE_SECRETS_KEY];
  return stripUndefined(copy);
}

function normalizeErpBus(input: BridgeErpBusConfig | undefined, services: BridgeServiceInstance[]): BridgeErpBusConfig {
  if (input) {
    return {
      enabled: input.enabled !== false,
      mode: "typed-actions-events",
      sharedCore: "organization",
      rules: input.rules ?? [],
    };
  }

  const serviceIds = services.map((service) => service.serviceId);
  return {
    enabled: true,
    mode: "typed-actions-events",
    sharedCore: "organization",
    rules:
      serviceIds.length >= 2
        ? [
            {
              fromServiceId: serviceIds[0],
              toServiceId: serviceIds[1],
              eventType: "core.customer.updated",
              scopes: ["erp:events:publish", "erp:events:consume"],
            },
          ]
        : [],
  };
}

function demoServices(organizationId: string): BridgeServiceInstance[] {
  return [
    {
      serviceId: "crm",
      serviceInstanceId: `${organizationId}:crm`,
      organizationId,
      name: "CRM",
      description: "Socle clients et contacts partagé.",
      baseUrl: "http://localhost:3307/dashboard?service=crm",
      healthUrl: "http://localhost:3307/api/health",
      launchCallbackUrl: "http://localhost:3307/auth/bridge/callback",
      dataStrategy: "erp-core",
      scopes: ["erp:core:read", "erp:events:publish", "codex:run"],
      requiredScopes: ["erp:core:read"],
      actions: [
        {
          id: "customer.lookup",
          label: "Rechercher client",
          description: "Expose une recherche client typée aux autres modules.",
          requiredScopes: ["erp:core:read"],
        },
      ],
      events: [
        {
          type: "core.customer.updated",
          label: "Client mis à jour",
          description: "Émis lorsqu'un client commun change.",
          requiredScopes: ["erp:events:publish"],
        },
      ],
    },
    {
      serviceId: "purchasing",
      serviceInstanceId: `${organizationId}:purchasing`,
      organizationId,
      name: "Achats",
      description: "Module achats connecté au socle ERP.",
      baseUrl: "http://localhost:3307/runs?service=purchasing",
      healthUrl: "http://localhost:3307/api/health",
      launchCallbackUrl: "http://localhost:3307/auth/bridge/callback",
      dataStrategy: "service-supabase",
      scopes: ["erp:core:read", "erp:events:consume", "codex:run"],
      requiredScopes: ["erp:core:read", "erp:events:consume"],
      actions: [
        {
          id: "supplier.quote.import",
          label: "Importer offre",
          description: "Importe une offre fournisseur avec isolation service.",
          requiredScopes: ["codex:run"],
        },
      ],
      events: [
        {
          type: "purchasing.quote.imported",
          label: "Offre importée",
          requiredScopes: ["erp:events:publish"],
        },
      ],
    },
  ];
}

function validateBridgeConfig(cfg: BridgeConfig): void {
  if (cfg.controlPlaneBaseUrl) {
    const url = new URL(cfg.controlPlaneBaseUrl);
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      throw new Error("controlPlaneBaseUrl doit être HTTPS hors tests locaux.");
    }
  }
  for (const service of cfg.services) {
    new URL(service.baseUrl);
    if (service.healthUrl) new URL(service.healthUrl);
    if (service.launchCallbackUrl) new URL(service.launchCallbackUrl);
  }
}

function pruneLegacyDemoServices(services: BridgeServiceInstance[]): BridgeServiceInstance[] {
  if (process.env.BRIDGE_ALLOW_DEMO_SERVICES === "1") return services;
  return services.filter((service) => {
    const legacyId = service.serviceId === "crm" || service.serviceId === "purchasing";
    const legacyUrl = typeof service.baseUrl === "string" && service.baseUrl.includes("localhost:3307");
    return !(legacyId && legacyUrl);
  });
}

function resolvePath(value: string): string {
  const home = homedir();
  const expanded = value
    .replace(/^~(?=$|[\\/])/, home)
    .replace(/^%USERPROFILE%(?=$|[\\/])/i, process.env.USERPROFILE ?? home)
    .replace(/^%APPDATA%(?=$|[\\/])/i, process.env.APPDATA ?? resolve(home, ".config"));
  return resolve(expanded);
}

function cleanRequired(value: unknown, name: string): string {
  const clean = cleanOptional(value);
  if (!clean) throw new Error(`${name} requis`);
  return clean;
}

function cleanOptional(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.trim();
  return clean ? clean : undefined;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function valueAfter(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx < 0) return undefined;
  return argv[idx + 1];
}

export function safeSegment(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "service";
}
