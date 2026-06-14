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
  assert.match(source, /scheduleRequiredAdminProvisioning\("runtime-state"\)/);
  assert.match(source, /scheduleRequiredAdminProvisioning\("runtime-start"\)/);
  assert.match(source, /function scheduleRequiredAdminProvisioning/);
  assert.match(source, /function scheduleStartupAdminProvisioning/);
  assert.match(source, /await syncServices\(\{ silent: true, reason: "startup" \}\)/);
  assert.match(source, /await ensureAdminProvisioning\(loadConfig\(\), \{ silent: true, reason: "startup" \}\)/);
  assert.match(source, /await ensureAdminProvisioning\(loadConfig\(\), \{ silent, reason \}\);\n\s+registerVoiceShortcut\(\);/);
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
  assert.match(provider, /closable: true/);
  assert.match(provider, /alwaysOnTop: false/);
  assert.match(provider, /showInactive\(\)/);
  assert.match(provider, /Installation requise par votre organisation/);
  assert.match(provider, /if \(mandatory\) return send\(\{ phase: "error"/);

  const main = readFileSync(resolve(process.cwd(), "bridge", "electron-main.cjs"), "utf8");
  assert.match(main, /mandatory: true/);
  assert.match(main, /focus: !options\.silent/);
  assert.match(main, /lastAdminProvisioningPromptAt/);
  assert.match(main, /parentWindow/);
});

test("LM Studio macOS installer uses /Applications and bootstraps the CLI", () => {
  const provider = readFileSync(resolve(process.cwd(), "bridge", "provider-setup.cjs"), "utf8");
  assert.match(provider, /function installLmStudioHeadless/);
  assert.match(provider, /https:\/\/lmstudio\.ai\/install\.sh/);
  assert.match(provider, /https:\/\/lmstudio\.ai\/install\.ps1/);
  assert.match(provider, /const MAC_LMSTUDIO_APP = "\/Applications\/LM Studio\.app"/);
  assert.match(provider, /function findUnsupportedLmStudioApp/);
  assert.match(provider, /copyLmStudioAppToApplications/);
  assert.match(provider, /with administrator privileges/);
  assert.match(provider, /\.webpack", "lms"/);
  assert.match(provider, /"daemon", "up"/);
  assert.match(provider, /"get", target, "--yes"/);
  assert.match(provider, /function launchLmStudioHidden/);
  assert.match(provider, /"open", \["-gj", appPath\]/);
  assert.match(provider, /defaultContextLength: 32768/);
  assert.match(provider, /"--context-length", String\(contextLength\)/);
  assert.doesNotMatch(provider, /path\.join\(os\.homedir\(\), "Applications", "LM Studio\.app"\)[\s\S]*const targetApp/);
  assert.doesNotMatch(provider, /shell\.openPath\(appPath\)/);
});

test("admin-required provisioning blocks Bridge actions until setup is complete", () => {
  const source = readFileSync(resolve(process.cwd(), "bridge", "electron-main.cjs"), "utf8");
  assert.match(source, /async function ensureRequiredProvisioningComplete/);
  assert.match(source, /err\.bridgeProvisioningRequired = true/);
  assert.match(source, /if \(err\?\.bridgeProvisioningRequired\) throw err/);

  const openServiceStart = source.indexOf("async function openService");
  const provisioningGate = source.indexOf('const provisioning = await ensureRequiredProvisioningComplete("open-service")', openServiceStart);
  const noTicketFallback = source.indexOf("Ouverture ${service.name} sans ticket Bridge", openServiceStart);
  const openExternal = source.indexOf("await shell.openExternal(target)", openServiceStart);
  assert.ok(openServiceStart >= 0, "openService should exist");
  assert.ok(provisioningGate > openServiceStart, "openService should check required provisioning");
  assert.ok(noTicketFallback > provisioningGate, "provisioning errors must be rethrown before no-ticket fallback");
  assert.ok(openExternal > noTicketFallback, "service launch happens after the provisioning gate");

  assert.match(source, /const provisioningRequired = Boolean\(state\.requiredProvisioning\?\.required\)/);
  assert.match(source, /window\.bridge\.ensureAdminProvisioning\(\)/);
  assert.match(source, /Le setup d\\\\'installation est ouvert/);
});

test("voice shortcut saving reports activation state instead of a false success", () => {
  const source = readFileSync(resolve(process.cwd(), "bridge", "electron-main.cjs"), "utf8");
  assert.match(source, /function voiceShortcutSaveResult/);
  assert.match(source, /warning: voice\.shortcutError/);
  assert.match(source, /Raccourci enregistré, activation à terminer/);
  assert.match(source, /shortcut-recorder/);
  assert.match(source, /activeModifiers/);
  assert.match(source, /code === "Space"/);
  assert.match(source, /overflow:hidden;display:grid;grid-template-rows/);
  assert.match(source, /registerElectronVoiceShortcutMirror/);
  assert.match(source, /showVoiceOverlay\(\{ mode: "error", message \}\)/);
  assert.match(source, /event === "mic-level"/);
  assert.match(source, /__bridgeSetLevels/);
  assert.match(source, /\.recording-overlay\{height:36px;width:172px/);
  assert.match(source, /\.bar\{width:6px;background:var\(--accent\)/);
  assert.match(source, /fill="currentColor"/);
  assert.doesNotMatch(source, /handy-level/);
  assert.doesNotMatch(source, /#FAA2CA|#ffe5ee|#faa2ca/i);
});

test("local Bridge service status remains connected after opening a service", () => {
  const source = readFileSync(resolve(process.cwd(), "bridge", "electron-main.cjs"), "utf8");
  assert.match(source, /local === "connected"/);
  assert.match(source, /service\.status === "connected"/);
  assert.match(source, /localStatuses\[service\.serviceId\] = "connected"/);
  assert.match(source, /localStatuses\[serviceId\] = "active"/);
  assert.doesNotMatch(source, /status: "cloud_stale"/);
  assert.doesNotMatch(source, /if \(ok\) delete localStatuses\[service\.serviceId\]/);
  assert.doesNotMatch(source, /delete localStatuses\[serviceId\]/);
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
