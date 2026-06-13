import type {
  AgentProvider,
  AgentRoutingPolicy,
  AgentRoutingPrivacy,
  BridgeConfig,
  BridgeServiceInstance,
  CloudBridgeJob,
} from "./types.js";

const DEFAULT_LOCAL_MODEL = "ibm/granite-4-micro";

export interface BridgeLocalAgentReadiness {
  ready: boolean;
  codexReady: boolean;
  supportsOss: boolean;
  lmStudioAvailable: boolean;
  modelAvailable: boolean;
  model: string;
  reason?: string;
  models?: string[];
}

export interface BridgeAgentRouteRequest {
  requestedMode: "cloud" | "local";
  source: "payload.agentProvider" | "payload.agentRouting" | "action.agentRouting" | "service.defaultAgentRouting" | "default";
  hardOverride: boolean;
  policy?: AgentRoutingPolicy;
  privacy: AgentRoutingPrivacy;
  cloudModel?: string;
  localModel?: string;
  reason?: string;
}

export interface BridgeAgentRoute {
  agentProvider: AgentProvider;
  model?: string;
  localModel?: string;
  selectedModel?: string;
  requestedMode: "cloud" | "local";
  source: BridgeAgentRouteRequest["source"];
  privacy: AgentRoutingPrivacy;
  reason?: string;
}

export function resolveBridgeAgentRouteRequest(
  job: CloudBridgeJob,
  service: BridgeServiceInstance,
  cfg: Pick<BridgeConfig, "defaultModel" | "defaultLocalModel">,
): BridgeAgentRouteRequest {
  const payload = job.payload;
  const cloudModel = cleanString(payload.model) ?? cfg.defaultModel;

  if (payload.agentProvider === "codex-cloud") {
    return {
      requestedMode: "cloud",
      source: "payload.agentProvider",
      hardOverride: true,
      privacy: "normal",
      cloudModel,
      reason: "Provider forcé par le job.",
    };
  }

  if (payload.agentProvider === "codex-lmstudio") {
    const localModel = cleanString(payload.localModel) ?? cleanString(payload.model) ?? cfg.defaultLocalModel ?? DEFAULT_LOCAL_MODEL;
    return {
      requestedMode: "local",
      source: "payload.agentProvider",
      hardOverride: true,
      privacy: "normal",
      localModel,
      reason: "Provider local forcé par le job.",
    };
  }

  const actionId = cleanString(payload.actionId) ?? cleanString(payload.metadata?.actionId);
  const action = actionId ? service.actions?.find((candidate) => candidate.id === actionId) : undefined;
  const selected =
    normalizePolicy(payload.agentRouting)
      ? { source: "payload.agentRouting" as const, policy: normalizePolicy(payload.agentRouting) }
      : normalizePolicy(action?.agentRouting)
        ? { source: "action.agentRouting" as const, policy: normalizePolicy(action?.agentRouting) }
        : normalizePolicy(service.defaultAgentRouting)
          ? { source: "service.defaultAgentRouting" as const, policy: normalizePolicy(service.defaultAgentRouting) }
          : { source: "default" as const, policy: undefined };

  const policy = selected.policy;
  const privacy = normalizePrivacy(policy?.privacy);
  const requestedMode = policy?.mode === "local" || (!policy?.mode && privacy === "local-only") ? "local" : "cloud";
  const localModel = policy?.localModel?.trim() || cleanString(payload.localModel) || cfg.defaultLocalModel || DEFAULT_LOCAL_MODEL;

  return {
    requestedMode,
    source: selected.source,
    hardOverride: false,
    policy,
    privacy,
    cloudModel,
    localModel,
    reason: policy?.reason,
  };
}

export function selectBridgeAgentRoute(
  job: CloudBridgeJob,
  service: BridgeServiceInstance,
  cfg: Pick<BridgeConfig, "defaultModel" | "defaultLocalModel">,
  readiness?: BridgeLocalAgentReadiness,
): BridgeAgentRoute {
  const request = resolveBridgeAgentRouteRequest(job, service, cfg);
  return selectResolvedBridgeAgentRoute(request, readiness);
}

export function selectResolvedBridgeAgentRoute(
  request: BridgeAgentRouteRequest,
  readiness?: BridgeLocalAgentReadiness,
): BridgeAgentRoute {
  if (request.requestedMode === "cloud") {
    return {
      agentProvider: "codex-cloud",
      model: request.cloudModel,
      selectedModel: request.cloudModel,
      requestedMode: request.requestedMode,
      source: request.source,
      privacy: request.privacy,
      reason: request.reason,
    };
  }

  if (readiness?.ready || (request.hardOverride && readiness === undefined)) {
    return {
      agentProvider: "codex-lmstudio",
      localModel: request.localModel,
      selectedModel: request.localModel,
      requestedMode: request.requestedMode,
      source: request.source,
      privacy: request.privacy,
      reason: request.reason,
    };
  }

  throw new Error(
    `Routage local requis mais indisponible pour ${request.localModel ?? DEFAULT_LOCAL_MODEL}: ${readiness?.reason ?? "LM Studio non prêt."}`
  );
}

function normalizePolicy(value: AgentRoutingPolicy | undefined): AgentRoutingPolicy | undefined {
  if (!value || typeof value !== "object") return undefined;
  const mode = value.mode === "local" || value.mode === "cloud" ? value.mode : undefined;
  const privacy = normalizePrivacy(value.privacy);
  const localModel = cleanString(value.localModel);
  const reason = cleanString(value.reason);
  const hasPolicy =
    Boolean(mode) ||
    value.privacy === "normal" ||
    value.privacy === "sensitive" ||
    value.privacy === "local-only" ||
    Boolean(localModel) ||
    Boolean(reason);
  if (!hasPolicy) return undefined;
  return {
    ...(mode ? { mode } : {}),
    privacy,
    ...(localModel ? { localModel } : {}),
    ...(reason ? { reason } : {}),
  };
}

function normalizePrivacy(value: unknown): AgentRoutingPrivacy {
  return value === "sensitive" || value === "local-only" ? value : "normal";
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
