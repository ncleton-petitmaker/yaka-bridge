import type { AgentEvent, RunStatus } from "../server/types.js";

export const BRIDGE_PRODUCT_NAME = "Bridge";
export const BRIDGE_PROTOCOL_VERSION = 2;

export type AgentProvider = "codex-cloud" | "codex-lmstudio";
export type AgentRoutingPrivacy = "normal" | "sensitive" | "local-only";

export interface AgentRoutingPolicy {
  mode?: "cloud" | "local";
  privacy?: AgentRoutingPrivacy;
  localModel?: string;
  reason?: string;
}

export interface BridgeLocalAiPolicy {
  enabled: boolean;
  installRequired: boolean;
  provider: "lmstudio";
  model: string;
  allowUserModelOverride: boolean;
}

export interface BridgeVoicePolicy {
  enabled: boolean;
  installRequired: boolean;
  provider: "bridge-voice";
  model: string;
  defaultShortcut: string;
  allowUserShortcutOverride: boolean;
  allowUserModelOverride: boolean;
  insertMode: "bridge-fields" | "system";
}

export interface BridgeAiPolicy {
  localAi: BridgeLocalAiPolicy;
  voice: BridgeVoicePolicy;
}

export type BridgeServiceStatus =
  | "connected"
  | "paused"
  | "reconnecting"
  | "active"
  | "disconnected"
  | "codex_unready"
  | "cloud_stale"
  | "site_unreachable"
  | "local_unavailable";

export type BridgeCodexState =
  | "ready"
  | "missing"
  | "login_required"
  | "error"
  | "unknown";

export interface BridgeCodexStatus {
  ready: boolean;
  state: BridgeCodexState;
  label: string;
  detail: string;
  path?: string | null;
  version?: string | null;
  loggedIn?: boolean | null;
  authPath?: string | null;
  checkedAt: string;
  installCommand: string;
  loginCommand: string;
  diagnostic?: string;
}

export type BridgeDataStrategy = "erp-core" | "service-supabase" | "external-api";

export interface BridgeAllowedRoot {
  id: string;
  label?: string;
  path: string;
  writable?: boolean;
  scopes?: string[];
}

export interface BridgeServiceAction {
  id: string;
  label?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  requiredScopes?: string[];
  dangerous?: boolean;
  agentRouting?: AgentRoutingPolicy;
}

export interface BridgeServiceEvent {
  type: string;
  label?: string;
  description?: string;
  schema?: Record<string, unknown>;
  requiredScopes?: string[];
}

export interface BridgeServiceManifest {
  serviceId: string;
  name: string;
  slug?: string;
  description?: string;
  baseUrl: string;
  healthUrl?: string;
  launchCallbackUrl?: string;
  adminUrl?: string;
  iconUrl?: string;
  dataStrategy?: BridgeDataStrategy;
  supabaseProjectRef?: string;
  designSystem?: {
    id: string;
    name?: string;
    version?: string;
    sourceKind?: string;
    appliedAt?: string;
  };
  requiredScopes?: string[];
  defaultAgentRouting?: AgentRoutingPolicy;
  bridgeAiPolicy?: BridgeAiPolicy;
  actions?: BridgeServiceAction[];
  events?: BridgeServiceEvent[];
}

export interface BridgeServiceInstance extends BridgeServiceManifest {
  serviceInstanceId: string;
  organizationId: string;
  status?: BridgeServiceStatus;
  paused?: boolean;
  scopes: string[];
  allowedRoots?: BridgeAllowedRoot[];
  maxConcurrentJobs?: number;
  lastSeenAt?: string;
  lastError?: string;
}

export interface BridgeAccount {
  userId: string;
  email: string;
  displayName?: string;
  organizationId: string;
  organizationName?: string;
  role?: "owner" | "admin" | "member" | "operator";
}

export interface BridgeSessionInfo {
  provider: "supabase-pkce";
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  persisted?: boolean;
  lastRefreshAt?: string;
}

export interface BridgeErpBusRule {
  fromServiceId: string;
  toServiceId: string;
  actionId?: string;
  eventType?: string;
  scopes: string[];
}

export interface BridgeErpBusConfig {
  enabled: boolean;
  mode: "typed-actions-events";
  sharedCore: "organization";
  rules: BridgeErpBusRule[];
}

export interface BridgeConfig {
  controlPlaneBaseUrl?: string;
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  updateBaseUrl?: string;
  latestVersion?: string;
  minimumVersion?: string;
  installerBaseUrl?: string;
  windowsInstallerUrl?: string;
  macInstallerUrl?: string;
  /** Backward-compatible alias used by the first cloud bridge prototype. */
  cloudBaseUrl?: string;
  organizationId?: string;
  bridgeToken?: string;
  bridgeId?: string;
  installId?: string;
  deviceId?: string;
  userId?: string;
  account?: BridgeAccount;
  session?: BridgeSessionInfo;
  sessionInvalidAt?: string;
  label?: string;
  dataDir: string;
  defaultAgentProvider?: AgentProvider;
  defaultModel?: string;
  defaultLocalModel?: string;
  aiPolicy: BridgeAiPolicy;
  maxConcurrentJobs?: number;
  pollIntervalSeconds?: number;
  services: BridgeServiceInstance[];
  erpBus: BridgeErpBusConfig;
  /** Backward-compatible root list. New services should use service.allowedRoots. */
  allowedRoots?: BridgeAllowedRoot[];
  demoMode?: boolean;
}

export interface BridgeControlPlaneEnvelope<TPayload = unknown> {
  organizationId?: string;
  bridgeId?: string;
  installId?: string;
  deviceId?: string;
  userId?: string;
  sentAt: string;
  payload: TPayload;
}

export interface BridgeControlPlaneSyncResponse {
  ok: boolean;
  bridgeId?: string;
  account?: BridgeAccount;
  services?: BridgeServiceInstance[];
  erpBus?: BridgeErpBusConfig;
  aiPolicy?: BridgeAiPolicy;
  updateBaseUrl?: string;
  latestVersion?: string;
  minimumVersion?: string;
  installerBaseUrl?: string;
  windowsInstallerUrl?: string;
  macInstallerUrl?: string;
  serverTime?: string;
  error?: string;
}

export interface CloudBridgeJob {
  id: string;
  leaseId: string;
  organizationId: string;
  serviceId: string;
  serviceInstanceId?: string;
  userId?: string;
  scopes?: string[];
  payload: BridgeJobPayload;
}

export interface BridgeJobPayload {
  prompt: string;
  actionId?: string;
  cwd?: BridgePathRef;
  addDirs?: BridgePathRef[];
  agentProvider?: AgentProvider;
  agentRouting?: AgentRoutingPolicy;
  model?: string;
  localModel?: string;
  maxTurns?: number;
  allowedTools?: string[];
  imageUrls?: string[];
  outputSchema?: Record<string, unknown>;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  includeMcp?: boolean;
  mcpProxyBaseUrl?: string;
  mcpProxyAccessToken?: string;
  ephemeral?: boolean;
  tag?: string;
  metadata?: Record<string, unknown>;
}

export type BridgePathRef =
  | string
  | {
      rootId?: string;
      relativePath?: string;
    };

export interface BridgeRunEventBatch {
  organizationId?: string;
  serviceId: string;
  serviceInstanceId?: string;
  deviceId?: string;
  userId?: string;
  jobId: string;
  leaseId: string;
  localRunId: string;
  status?: RunStatus;
  events: Array<{
    seq: number;
    event: AgentEvent;
  }>;
  usage?: unknown;
  error?: string;
}

export interface BridgeJobCompletePayload {
  organizationId?: string;
  serviceId: string;
  serviceInstanceId?: string;
  deviceId?: string;
  userId?: string;
  jobId: string;
  leaseId: string;
  localRunId: string;
  status: string;
  error?: string;
}

export interface BridgeLaunchTicketRequest {
  serviceId: string;
  serviceInstanceId?: string;
  returnTo?: string;
}

export interface BridgeLaunchTicketResponse {
  ok: boolean;
  launchUrl?: string;
  ticketId?: string;
  expiresAt?: string;
  error?: string;
}

export interface BridgeBusEvent {
  id?: string;
  organizationId: string;
  sourceServiceId: string;
  type: string;
  resourceType?: string;
  resourceId?: string;
  payload: Record<string, unknown>;
  occurredAt?: string;
}

export interface BridgeRuntimeServiceState {
  serviceId: string;
  serviceInstanceId: string;
  name: string;
  baseUrl: string;
  healthUrl?: string;
  status: BridgeServiceStatus;
  scopes: string[];
  runningJobs: number;
  lastSeenAt?: string;
  lastError?: string;
  actions: BridgeServiceAction[];
  events: BridgeServiceEvent[];
}

export interface BridgeRuntimeState {
  ok: true;
  bridge: true;
  productName: typeof BRIDGE_PRODUCT_NAME;
  protocolVersion: typeof BRIDGE_PROTOCOL_VERSION;
  version: string;
  label?: string;
  account?: BridgeAccount;
  organizationId?: string;
  installId?: string;
  deviceId?: string;
  bridgeId?: string;
  dataDir: string;
  controlPlaneConfigured: boolean;
  authenticated: boolean;
  codex?: BridgeCodexStatus;
  aiPolicy: BridgeAiPolicy;
  update?: {
    latestVersion?: string;
    minimumVersion?: string;
    updateRequired: boolean;
    currentVersion: string;
  };
  demoMode: boolean;
  services: BridgeRuntimeServiceState[];
  erpBus: BridgeErpBusConfig;
  activeJobs: number;
  lastSyncAt?: string;
  lastError?: string;
  ts: string;
}
