import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveBridgeAgentRouteRequest,
  selectBridgeAgentRoute,
  selectResolvedBridgeAgentRoute,
  type BridgeLocalAgentReadiness,
} from "../../bridge/agent-routing";
import {
  applyBridgeAiPolicyManifestPatch,
  applyAgentRoutingManifestPatch,
  mapAgentRoutingService,
} from "../../server/agent-routing-admin";
import { bridgeAiPolicyFromManifests, normalizeBridgeAiPolicy } from "../../bridge/ai-policy";
import { normalizeBridgeConfig } from "../../bridge/config";
import type { BridgeConfig, BridgeServiceInstance, CloudBridgeJob } from "../../bridge/types";

const cfg = {
  defaultModel: "sonnet",
  defaultLocalModel: "ibm/granite-4-micro",
} as BridgeConfig;

const readyLocal = {
  ready: true,
  codexReady: true,
  supportsOss: true,
  lmStudioAvailable: true,
  modelAvailable: true,
  model: "ibm/granite-4-micro",
} satisfies BridgeLocalAgentReadiness;

const downLocal = {
  ready: false,
  codexReady: true,
  supportsOss: true,
  lmStudioAvailable: false,
  modelAvailable: false,
  model: "ibm/granite-4-micro",
  reason: "LM Studio arrêté.",
} satisfies BridgeLocalAgentReadiness;

function service(partial: Partial<BridgeServiceInstance> = {}): BridgeServiceInstance {
  return {
    serviceId: "purchasing",
    serviceInstanceId: "org:purchasing",
    organizationId: "org",
    name: "Achats",
    baseUrl: "http://localhost:3307",
    scopes: ["codex:run"],
    actions: [],
    ...partial,
  } as BridgeServiceInstance;
}

function job(payload: Partial<CloudBridgeJob["payload"]> = {}): CloudBridgeJob {
  return {
    id: "job-1",
    leaseId: "lease-1",
    organizationId: "org",
    serviceId: "purchasing",
    scopes: ["codex:run"],
    payload: {
      prompt: "Do work",
      ...payload,
    },
  };
}

test("bridge agent routing defaults to Codex Cloud", () => {
  const route = selectBridgeAgentRoute(job(), service(), cfg);
  assert.equal(route.agentProvider, "codex-cloud");
  assert.equal(route.model, "sonnet");
  assert.equal(route.source, "default");
});

test("payload agentProvider is a hard override", () => {
  const localActionService = service({
    actions: [{ id: "ocr.extract", agentRouting: { mode: "local", privacy: "local-only" } }],
  });
  const cloudRoute = selectBridgeAgentRoute(job({ actionId: "ocr.extract", agentProvider: "codex-cloud" }), localActionService, cfg, readyLocal);
  assert.equal(cloudRoute.agentProvider, "codex-cloud");
  assert.equal(cloudRoute.source, "payload.agentProvider");

  const localRoute = selectBridgeAgentRoute(
    job({ agentProvider: "codex-lmstudio", model: "local/forced" }),
    service(),
    cfg,
    { ...readyLocal, model: "local/forced" }
  );
  assert.equal(localRoute.agentProvider, "codex-lmstudio");
  assert.equal(localRoute.localModel, "local/forced");

  assert.throws(
    () => selectBridgeAgentRoute(job({ agentProvider: "codex-lmstudio", model: "local/forced" }), service(), cfg, downLocal),
    /Routage local requis/
  );
});

test("action local routing uses LM Studio when ready", () => {
  const route = selectBridgeAgentRoute(
    job({ actionId: "ocr.extract" }),
    service({ actions: [{ id: "ocr.extract", agentRouting: { mode: "local", privacy: "normal" } }] }),
    cfg,
    readyLocal
  );
  assert.equal(route.agentProvider, "codex-lmstudio");
  assert.equal(route.localModel, "ibm/granite-4-micro");
  assert.equal(route.source, "action.agentRouting");
});

test("routing priority is payload policy, then action, then service default", () => {
  const actionWins = selectBridgeAgentRoute(
    job({ actionId: "ocr.extract" }),
    service({
      defaultAgentRouting: { mode: "cloud", privacy: "normal" },
      actions: [{ id: "ocr.extract", agentRouting: { mode: "local", privacy: "normal", localModel: "local/action" } }],
    }),
    cfg,
    { ...readyLocal, model: "local/action" }
  );
  assert.equal(actionWins.agentProvider, "codex-lmstudio");
  assert.equal(actionWins.localModel, "local/action");
  assert.equal(actionWins.source, "action.agentRouting");

  const payloadWins = selectBridgeAgentRoute(
    job({
      actionId: "ocr.extract",
      agentRouting: { mode: "cloud", privacy: "normal" },
    }),
    service({
      defaultAgentRouting: { mode: "local", privacy: "normal", localModel: "local/service" },
      actions: [{ id: "ocr.extract", agentRouting: { mode: "local", privacy: "normal", localModel: "local/action" } }],
    }),
    cfg,
    { ...readyLocal, model: "local/action" }
  );
  assert.equal(payloadWins.agentProvider, "codex-cloud");
  assert.equal(payloadWins.source, "payload.agentRouting");

  const serviceDefault = selectBridgeAgentRoute(
    job(),
    service({ defaultAgentRouting: { mode: "local", privacy: "normal", localModel: "local/service" } }),
    cfg,
    { ...readyLocal, model: "local/service" }
  );
  assert.equal(serviceDefault.agentProvider, "codex-lmstudio");
  assert.equal(serviceDefault.localModel, "local/service");
  assert.equal(serviceDefault.source, "service.defaultAgentRouting");
});

test("normal local routing fails when local readiness fails", () => {
  const request = resolveBridgeAgentRouteRequest(
    job({ actionId: "ocr.extract" }),
    service({ actions: [{ id: "ocr.extract", agentRouting: { mode: "local", privacy: "normal" } }] }),
    cfg
  );
  assert.throws(() => selectResolvedBridgeAgentRoute(request, downLocal), /Routage local requis/);
});

test("sensitive and local-only routing fail instead of falling back to cloud", () => {
  const sensitiveRequest = resolveBridgeAgentRouteRequest(
    job({ actionId: "ocr.extract" }),
    service({ actions: [{ id: "ocr.extract", agentRouting: { mode: "local", privacy: "sensitive" } }] }),
    cfg
  );
  assert.throws(() => selectResolvedBridgeAgentRoute(sensitiveRequest, downLocal), /Routage local requis/);

  const localOnlyRequest = resolveBridgeAgentRouteRequest(
    job({ agentRouting: { mode: "local", privacy: "local-only" } }),
    service(),
    cfg
  );
  assert.throws(() => selectResolvedBridgeAgentRoute(localOnlyRequest, downLocal), /Routage local requis/);
});

test("local-only privacy implies local routing even when mode is omitted", () => {
  const request = resolveBridgeAgentRouteRequest(
    job({ agentRouting: { privacy: "local-only" } }),
    service(),
    cfg
  );
  assert.equal(request.requestedMode, "local");
  assert.throws(() => selectResolvedBridgeAgentRoute(request, downLocal), /Routage local requis/);

  const next = applyAgentRoutingManifestPatch({}, {
    defaultAgentRouting: { privacy: "local-only" },
  });
  assert.deepEqual(next.defaultAgentRouting, { mode: "local", privacy: "local-only" });
});

test("local routing keeps local model distinct from cloud model", () => {
  const route = selectBridgeAgentRoute(
    job({
      model: "sonnet",
      actionId: "ocr.extract",
    }),
    service({ actions: [{ id: "ocr.extract", agentRouting: { mode: "local", localModel: "local/ocr", privacy: "normal" } }] }),
    cfg,
    { ...readyLocal, model: "local/ocr" }
  );
  assert.equal(route.agentProvider, "codex-lmstudio");
  assert.equal(route.localModel, "local/ocr");
  assert.equal(route.model, undefined);
});

test("agent routing admin helpers merge policies into service manifest", () => {
  const manifest = {
    actions: [{ id: "ocr.extract", label: "OCR" }, { id: "quote.import", label: "Import" }],
    untouched: true,
  };
  const next = applyAgentRoutingManifestPatch(manifest, {
    defaultAgentRouting: { mode: "cloud", privacy: "normal" },
    actions: [{ id: "ocr.extract", agentRouting: { mode: "local", privacy: "local-only", localModel: "local/ocr" } }],
  });
  assert.equal(next.untouched, true);
  assert.deepEqual(next.defaultAgentRouting, { mode: "cloud", privacy: "normal" });
  const mapped = mapAgentRoutingService({
    service_id: "purchasing",
    name: "Achats",
    manifest: next,
  });
  assert.deepEqual(mapped.actions, [
    {
      id: "ocr.extract",
      label: "OCR",
      description: undefined,
      agentRouting: { mode: "local", privacy: "local-only", localModel: "local/ocr" },
    },
    {
      id: "quote.import",
      label: "Import",
      description: undefined,
      agentRouting: undefined,
    },
  ]);
});

test("bridge AI policy is normalized and persisted in service manifests", () => {
  const next = applyBridgeAiPolicyManifestPatch({ untouched: true }, {
    aiPolicy: {
      localAi: {
        enabled: true,
        installRequired: true,
        provider: "lmstudio",
        model: "local/admin-model",
        allowUserModelOverride: false,
      },
      voice: {
        enabled: true,
        installRequired: true,
        provider: "bridge-voice",
        model: "parakeet-tdt-0.6b-v3-int8",
        defaultShortcut: "CommandOrControl+Alt+Space",
        allowUserShortcutOverride: true,
        allowUserModelOverride: false,
        insertMode: "bridge-fields",
      },
    },
  });
  assert.equal(next.untouched, true);
  const policy = bridgeAiPolicyFromManifests([next]);
  assert.equal(policy.localAi.enabled, true);
  assert.equal(policy.localAi.model, "local/admin-model");
  assert.equal(policy.localAi.allowUserModelOverride, false);
  assert.equal(policy.voice.enabled, true);
  assert.equal(policy.voice.model, "parakeet-tdt-0.6b-v3-int8");
  assert.equal(policy.voice.allowUserShortcutOverride, true);
});

test("admin-enabled local AI and voice imply installation on existing Bridge configs", () => {
  const policy = normalizeBridgeAiPolicy({
    localAi: { enabled: true, model: "ibm/granite-4-micro" },
    voice: { enabled: true },
  });
  assert.equal(policy.localAi.enabled, true);
  assert.equal(policy.localAi.installRequired, true);
  assert.equal(policy.localAi.model, "ibm/granite-4-micro");
  assert.equal(policy.voice.enabled, true);
  assert.equal(policy.voice.installRequired, true);
  assert.equal(policy.voice.model, "parakeet-tdt-0.6b-v3-int8");
});

test("bridge config preserves local model override only when admin allows it", () => {
  const locked = normalizeBridgeConfig({
    defaultLocalModel: "local/user-choice",
    aiPolicy: {
      localAi: {
        enabled: true,
        installRequired: true,
        provider: "lmstudio",
        model: "local/admin",
        allowUserModelOverride: false,
      },
      voice: {
        enabled: false,
        installRequired: false,
        provider: "bridge-voice",
        model: "parakeet-tdt-0.6b-v3-int8",
        defaultShortcut: "CommandOrControl+Shift+Space",
        allowUserShortcutOverride: true,
        allowUserModelOverride: false,
        insertMode: "system",
      },
    },
  });
  assert.equal(locked.defaultLocalModel, "local/admin");

  const unlocked = normalizeBridgeConfig({
    defaultLocalModel: "local/user-choice",
    aiPolicy: {
      ...locked.aiPolicy,
      localAi: {
        ...locked.aiPolicy.localAi,
        allowUserModelOverride: true,
      },
    },
  });
  assert.equal(unlocked.defaultLocalModel, "local/user-choice");
});
