import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_BRIDGE_AI_POLICY } from "../../bridge/ai-policy";
import { buildCodexArgs } from "../../server/agents";
import { loadAppConfig, saveAppConfig } from "../../server/app-config";
import { probeLmStudioStatus } from "../../server/agents-status";

const require = createRequire(import.meta.url);

function valueAfter(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

test("buildCodexArgs keeps Codex Cloud args unchanged", () => {
  const args = buildCodexArgs({ model: "sonnet", includeMcp: false });
  assert.equal(args.includes("--oss"), false);
  assert.equal(args.includes("--local-provider"), false);
  assert.equal(valueAfter(args, "--model"), "sonnet");
  assert.equal(valueAfter(args, "--sandbox"), "read-only");
});

test("buildCodexArgs enables LM Studio OSS mode with the local model", () => {
  const args = buildCodexArgs({
    agentProvider: "codex-lmstudio",
    model: "sonnet",
    localModel: "local/test-model",
    includeMcp: false,
    sandbox: "workspace-write",
  });
  assert.equal(args.includes("--oss"), true);
  assert.equal(valueAfter(args, "--local-provider"), "lmstudio");
  assert.equal(valueAfter(args, "--model"), "local/test-model");
  assert.equal(valueAfter(args, "--sandbox"), "workspace-write");
});

test("buildCodexArgs preserves MCP overrides and sandbox in LM Studio mode", () => {
  const args = buildCodexArgs({
    agentProvider: "codex-lmstudio",
    localModel: "ibm/granite-4-micro",
    includeMcp: true,
    sandbox: "workspace-write",
  });
  assert.equal(args.includes("--oss"), true);
  assert.equal(valueAfter(args, "--sandbox"), "workspace-write");
  assert.ok(args.some((arg) => arg.includes("mcp_servers.")));
});

test("app config defaults older files to Codex Cloud and persists local fields", () => {
  const dir = mkdtempSync(join(tmpdir(), "yaka-app-config-"));
  try {
    const loaded = loadAppConfig(dir);
    assert.equal(loaded.agentProvider, "codex-cloud");
    assert.equal(loaded.localModel, "ibm/granite-4-micro");

    saveAppConfig(dir, {
      agentProvider: "codex-lmstudio",
      localModel: "local/persisted-model",
    });
    const reloaded = loadAppConfig(dir);
    assert.equal(reloaded.agentProvider, "codex-lmstudio");
    assert.equal(reloaded.localModel, "local/persisted-model");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("packaged Bridge setup defaults LM Studio to the portable admin model", () => {
  const source = readFileSync(resolve(process.cwd(), "bridge", "electron-main.cjs"), "utf8");
  assert.match(source, /const DEFAULT_AI_POLICY[\s\S]*model: "ibm\/granite-4-micro"/);
});

test("local AI and voice are opt-in until the admin policy enables installation", () => {
  assert.equal(DEFAULT_BRIDGE_AI_POLICY.localAi.enabled, false);
  assert.equal(DEFAULT_BRIDGE_AI_POLICY.localAi.installRequired, false);
  assert.equal(DEFAULT_BRIDGE_AI_POLICY.localAi.model, "ibm/granite-4-micro");
  assert.equal(DEFAULT_BRIDGE_AI_POLICY.voice.enabled, false);
  assert.equal(DEFAULT_BRIDGE_AI_POLICY.voice.installRequired, false);

  const source = readFileSync(resolve(process.cwd(), "bridge", "electron-main.cjs"), "utf8");
  assert.match(source, /Installer \/ préparer LM Studio et le modèle/);
  assert.match(source, /Changer le raccourci push-to-talk/);
  assert.doesNotMatch(source, /data-provisioning-required/);
  assert.match(source, /await ensureAdminProvisioning\(loadConfig\(\), \{ silent \}\);\n\s+registerVoiceShortcut\(\);/);
});

test("Bridge packaging unpacks the push-to-talk sidecar executable", () => {
  const builderConfig = require(resolve(process.cwd(), "electron-builder.bridge.cjs"));
  assert.ok(Array.isArray(builderConfig.asarUnpack));
  assert.ok(builderConfig.asarUnpack.includes("dist/bridge/bridge-voice/**"));

  const source = readFileSync(resolve(process.cwd(), "bridge", "electron-main.cjs"), "utf8");
  assert.match(source, /app\.asar\.unpacked/);
});

test("admin-required local setup windows cannot be cancelled silently", () => {
  const provider = readFileSync(resolve(process.cwd(), "bridge", "provider-setup.cjs"), "utf8");
  assert.match(provider, /const mandatory = policy\.mandatory === true/);
  assert.match(provider, /closable: !mandatory/);
  assert.match(provider, /modal: Boolean\(mandatory && parentWindow\)/);
  assert.match(provider, /Installation requise par votre organisation/);
  assert.match(provider, /if \(mandatory\) return send\(\{ phase: "error"/);

  const main = readFileSync(resolve(process.cwd(), "bridge", "electron-main.cjs"), "utf8");
  assert.match(main, /mandatory: true/);
  assert.match(main, /parentWindow/);
});

test("voice shortcut saving reports activation state instead of a false success", () => {
  const source = readFileSync(resolve(process.cwd(), "bridge", "electron-main.cjs"), "utf8");
  assert.match(source, /function voiceShortcutSaveResult/);
  assert.match(source, /warning: voice\.shortcutError/);
  assert.match(source, /Raccourci enregistré, activation à terminer/);
});

test("LM Studio diagnostic reports offline server", async () => {
  const offlineFetch: typeof fetch = async () => {
    throw new Error("ECONNREFUSED");
  };
  const status = await probeLmStudioStatus("ibm/granite-4-micro", offlineFetch);
  assert.equal(status.available, false);
  assert.equal(status.modelAvailable, false);
  assert.match(status.error ?? "", /LM Studio injoignable/);
});

test("LM Studio diagnostic reports empty model list", async () => {
  const emptyFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const status = await probeLmStudioStatus("ibm/granite-4-micro", emptyFetch);
  assert.equal(status.available, true);
  assert.equal(status.modelAvailable, false);
  assert.deepEqual(status.models, []);
});

test("LM Studio diagnostic finds configured model", async () => {
  const modelsFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ data: [{ id: "ibm/granite-4-micro" }, { id: "local/other" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const status = await probeLmStudioStatus("ibm/granite-4-micro", modelsFetch);
  assert.equal(status.available, true);
  assert.equal(status.modelAvailable, true);
  assert.deepEqual(status.models, ["ibm/granite-4-micro", "local/other"]);
});
