import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCodexArgs } from "../../server/agents";
import { loadAppConfig, saveAppConfig } from "../../server/app-config";
import { probeLmStudioStatus } from "../../server/agents-status";

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
    localModel: "openai/gpt-oss-20b",
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
    assert.equal(loaded.localModel, "openai/gpt-oss-20b");

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

test("LM Studio diagnostic reports offline server", async () => {
  const offlineFetch: typeof fetch = async () => {
    throw new Error("ECONNREFUSED");
  };
  const status = await probeLmStudioStatus("openai/gpt-oss-20b", offlineFetch);
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
  const status = await probeLmStudioStatus("openai/gpt-oss-20b", emptyFetch);
  assert.equal(status.available, true);
  assert.equal(status.modelAvailable, false);
  assert.deepEqual(status.models, []);
});

test("LM Studio diagnostic finds configured model", async () => {
  const modelsFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ data: [{ id: "openai/gpt-oss-20b" }, { id: "local/other" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const status = await probeLmStudioStatus("openai/gpt-oss-20b", modelsFetch);
  assert.equal(status.available, true);
  assert.equal(status.modelAvailable, true);
  assert.deepEqual(status.models, ["local/other", "openai/gpt-oss-20b"]);
});
