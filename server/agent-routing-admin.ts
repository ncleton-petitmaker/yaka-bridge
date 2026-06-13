import type { AgentRoutingPolicy } from "../bridge/types.js";
import { normalizeBridgeAiPolicy } from "../bridge/ai-policy.js";
import type { BridgeAiPolicy } from "../bridge/types.js";

export interface AgentRoutingActionPatch {
  id: string;
  agentRouting?: AgentRoutingPolicy | null;
}

export interface AgentRoutingServicePatch {
  defaultAgentRouting?: AgentRoutingPolicy | null;
  actions?: AgentRoutingActionPatch[];
}

export interface BridgeAiPolicyPatch {
  aiPolicy?: Partial<BridgeAiPolicy> | null;
}

export function normalizeAgentRoutingPolicy(value: unknown): AgentRoutingPolicy | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const mode = input.mode === "cloud" || input.mode === "local" ? input.mode : undefined;
  const privacy =
    input.privacy === "sensitive" || input.privacy === "local-only" || input.privacy === "normal"
      ? input.privacy
      : undefined;
  const resolvedMode = mode ?? (privacy === "local-only" ? "local" : undefined);
  const localModel = cleanString(input.localModel, 200);
  const reason = cleanString(input.reason, 300);
  const out: AgentRoutingPolicy = {
    ...(resolvedMode ? { mode: resolvedMode } : {}),
    ...(privacy ? { privacy } : {}),
    ...(localModel ? { localModel } : {}),
    ...(reason ? { reason } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

export function applyAgentRoutingManifestPatch(
  manifest: Record<string, unknown>,
  patch: AgentRoutingServicePatch
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...manifest };
  if ("defaultAgentRouting" in patch) {
    const policy = normalizeAgentRoutingPolicy(patch.defaultAgentRouting);
    if (policy) next.defaultAgentRouting = policy;
    else delete next.defaultAgentRouting;
  }

  if (Array.isArray(patch.actions)) {
    const actions = normalizeActions(next.actions);
    for (const actionPatch of patch.actions) {
      const id = cleanString(actionPatch.id, 160);
      if (!id) continue;
      let action = actions.find((candidate) => candidate.id === id);
      if (!action) {
        action = { id };
        actions.push(action);
      }
      if ("agentRouting" in actionPatch) {
        const policy = normalizeAgentRoutingPolicy(actionPatch.agentRouting);
        if (policy) action.agentRouting = policy;
        else delete action.agentRouting;
      }
    }
    next.actions = actions;
  }

  return next;
}

export function applyBridgeAiPolicyManifestPatch(
  manifest: Record<string, unknown>,
  patch: BridgeAiPolicyPatch
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...manifest };
  if ("aiPolicy" in patch) {
    next.bridgeAiPolicy = normalizeBridgeAiPolicy(patch.aiPolicy);
  }
  return next;
}

export function mapAgentRoutingService(row: Record<string, unknown>): Record<string, unknown> {
  const manifest = objectOrEmpty(row.manifest);
  const actions = normalizeActions(manifest.actions).map((action) => ({
    id: action.id,
    label: cleanString(action.label, 160),
    description: cleanString(action.description, 600),
    agentRouting: normalizeAgentRoutingPolicy(action.agentRouting),
  }));
  return {
    serviceId: String(row.service_id ?? row.serviceId ?? ""),
    serviceInstanceId: row.service_instance_id ?? row.serviceInstanceId ?? null,
    name: String(row.name ?? ""),
    description: row.description ?? null,
    bridgeAiPolicy: normalizeBridgeAiPolicy(manifest.bridgeAiPolicy),
    defaultAgentRouting: normalizeAgentRoutingPolicy(manifest.defaultAgentRouting),
    actions,
  };
}

function normalizeActions(value: unknown): Array<Record<string, unknown> & { id: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => objectOrEmpty(item))
    .map((item) => ({ ...item, id: cleanString(item.id, 160) ?? "" }))
    .filter((item) => item.id);
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function cleanString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}
