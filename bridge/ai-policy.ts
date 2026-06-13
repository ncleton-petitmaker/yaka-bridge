import type { BridgeAiPolicy, BridgeLocalAiPolicy, BridgeVoicePolicy } from "./types.js";

export const DEFAULT_LOCAL_AI_MODEL = "openai/gpt-oss-20b";
export const DEFAULT_VOICE_MODEL = "parakeet-tdt-0.6b-v3-int8";
export const DEFAULT_VOICE_SHORTCUT = "CommandOrControl+Shift+Space";

export const DEFAULT_BRIDGE_AI_POLICY: BridgeAiPolicy = {
  localAi: {
    enabled: false,
    installRequired: false,
    provider: "lmstudio",
    model: DEFAULT_LOCAL_AI_MODEL,
    allowUserModelOverride: false,
  },
  voice: {
    enabled: false,
    installRequired: false,
    provider: "bridge-voice",
    model: DEFAULT_VOICE_MODEL,
    defaultShortcut: DEFAULT_VOICE_SHORTCUT,
    allowUserShortcutOverride: true,
    allowUserModelOverride: false,
    insertMode: "system",
  },
};

export function normalizeBridgeAiPolicy(value: unknown): BridgeAiPolicy {
  const input = objectOrEmpty(value);
  return {
    localAi: normalizeLocalAiPolicy(input.localAi),
    voice: normalizeVoicePolicy(input.voice),
  };
}

export function normalizeLocalAiPolicy(value: unknown): BridgeLocalAiPolicy {
  const input = objectOrEmpty(value);
  const enabled = input.enabled === true;
  return {
    enabled,
    installRequired: input.installRequired === true || enabled,
    provider: "lmstudio",
    model: cleanString(input.model, 220) ?? DEFAULT_LOCAL_AI_MODEL,
    allowUserModelOverride: input.allowUserModelOverride === true,
  };
}

export function normalizeVoicePolicy(value: unknown): BridgeVoicePolicy {
  const input = objectOrEmpty(value);
  const enabled = input.enabled === true;
  return {
    enabled,
    installRequired: input.installRequired === true || enabled,
    provider: "bridge-voice",
    model: cleanString(input.model, 220) ?? DEFAULT_VOICE_MODEL,
    defaultShortcut: cleanString(input.defaultShortcut, 120) ?? DEFAULT_VOICE_SHORTCUT,
    allowUserShortcutOverride: input.allowUserShortcutOverride === false ? false : true,
    allowUserModelOverride: input.allowUserModelOverride === true,
    insertMode: input.insertMode === "bridge-fields" ? "bridge-fields" : "system",
  };
}

export function bridgeAiPolicyFromManifests(manifests: unknown[]): BridgeAiPolicy {
  for (const manifest of manifests) {
    const policy = objectOrEmpty(manifest).bridgeAiPolicy;
    if (policy && typeof policy === "object" && !Array.isArray(policy)) return normalizeBridgeAiPolicy(policy);
  }
  return normalizeBridgeAiPolicy(undefined);
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function cleanString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}
