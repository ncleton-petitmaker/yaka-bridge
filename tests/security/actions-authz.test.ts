import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callAction, type ActionContext } from "../../server/actions";

const baseContext: ActionContext = {
  dataDir: "/tmp/bridge-erp-template-test",
  actorId: "user-test",
  actorRole: "cloud-member",
  userId: "11111111-1111-4111-8111-111111111111",
};

test("purchasing import rejects calls without organization context", async () => {
  await assert.rejects(
    () => callAction("purchasing.quote.import", baseContext, {
      supplierName: "Demo Supplier",
      title: "Demo Quote",
    }),
    /organization-required/
  );
});

test("purchasing import rejects organization members without write scope", async () => {
  await assert.rejects(
    () => callAction("purchasing.quote.import", {
      ...baseContext,
      organizationId: "9c3b6f91-2074-4d6e-8c4a-3514da2d986d",
      membershipRole: "member",
      entitlements: [{
        service_id: "purchasing",
        enabled: true,
        scopes: ["service:purchasing:read"],
      }],
    }, {
      supplierName: "Demo Supplier",
      title: "Demo Quote",
    }),
    /scope-forbidden:service:purchasing:write/
  );
});

test("purchasing import rejects client-supplied organizationId", async () => {
  await assert.rejects(
    () => callAction("purchasing.quote.import", {
      ...baseContext,
      organizationId: "9c3b6f91-2074-4d6e-8c4a-3514da2d986d",
      membershipRole: "admin",
      entitlements: [],
    }, {
      organizationId: "2d3e33a8-5069-4b4d-bd72-50e11945d369",
      supplierName: "Demo Supplier",
      title: "Demo Quote",
    }),
    /Unrecognized key/
  );
});

test("agent run rejects cloud members without codex run scope", async () => {
  await assert.rejects(
    () => callAction("runs.start", {
      ...baseContext,
      organizationId: "9c3b6f91-2074-4d6e-8c4a-3514da2d986d",
      membershipRole: "member",
      entitlements: [],
    }, {
      prompt: "Do work",
    }),
    /scope-forbidden:codex:run/
  );
});

test("app config action does not expose a provider picker contract", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "yaka-app-config-action-"));
  const output = await callAction("appConfig.get", { ...baseContext, dataDir }, {});
  assert.equal(Object.prototype.hasOwnProperty.call(output as Record<string, unknown>, "availableAgentProviders"), false);
  assert.equal(Array.isArray((output as { availableModels?: unknown }).availableModels), true);
});

test("app config update is admin-only for organization contexts", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "yaka-app-config-action-"));
  await assert.rejects(
    () => callAction("appConfig.update", {
      ...baseContext,
      dataDir,
      organizationId: "9c3b6f91-2074-4d6e-8c4a-3514da2d986d",
      membershipRole: "member",
      entitlements: [],
    }, {
      model: "opus",
    }),
    /admin-required/
  );
});
