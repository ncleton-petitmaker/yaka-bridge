#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import os from "node:os";
import { join } from "node:path";

const DEFAULT_MODEL = "ibm/granite-4-micro";
const BASE_URL = "http://127.0.0.1:1234/v1";
const args = process.argv.slice(2);
const model = valueAfter("--model") || DEFAULT_MODEL;
const prepare = args.includes("--prepare");
const runCodex = args.includes("--run-codex");
const timeoutMs = Number(valueAfter("--timeout-ms") || 120_000);

main().catch((err) => {
  console.error(`[lmstudio-smoke] ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});

async function main() {
  const codex = requireBin("codex");
  const version = run(codex, ["--version"], 8_000);
  if (version.status !== 0) throw new Error(`codex --version failed: ${compact(version)}`);
  const help = run(codex, ["exec", "--help"], 8_000);
  const helpText = `${help.stdout}\n${help.stderr}`;
  if (!/--oss\b/.test(helpText) || !/--local-provider\b/.test(helpText)) {
    throw new Error("Codex CLI does not expose --oss --local-provider.");
  }
  console.log(`[lmstudio-smoke] Codex OK: ${version.stdout.trim() || version.stderr.trim()}`);

  const lms = findBin("lms");
  if (!lms) {
    throw new Error("lms CLI not found. Install LM Studio, open it once, then enable its CLI.");
  }
  console.log(`[lmstudio-smoke] lms OK: ${lms}`);

  let models = await probeModels().catch(() => null);
  if (!models) {
    console.log("[lmstudio-smoke] LM Studio server not reachable; starting lms server on port 1234.");
    const start = run(lms, ["server", "start", "--port", "1234"], 20_000);
    if (start.status !== 0) throw new Error(`lms server start failed: ${compact(start)}`);
    models = await waitForModels(15_000);
  }

  if (!models.includes(model)) {
    if (!prepare) {
      throw new Error(
        `Model not loaded: ${model}. Run \`npm run smoke:lmstudio -- --prepare --model ${model}\` to download/load it.`
      );
    }
    console.log(`[lmstudio-smoke] Preparing model ${model}. This can download a large file.`);
    const get = run(lms, ["get", model], timeoutMs);
    if (get.status !== 0) throw new Error(`lms get failed: ${compact(get)}`);
    const load = run(lms, ["load", model, "--identifier", model], timeoutMs);
    if (load.status !== 0) throw new Error(`lms load failed: ${compact(load)}`);
    models = await waitForModel(model, 30_000);
  }
  console.log(`[lmstudio-smoke] LM Studio model ready: ${model}`);

  if (runCodex) {
    const exec = run(
      codex,
      ["exec", "--oss", "--local-provider", "lmstudio", "--model", model, "--json", "Réponds exactement: ok"],
      timeoutMs,
    );
    if (exec.status !== 0) throw new Error(`codex local exec failed: ${compact(exec)}`);
    console.log("[lmstudio-smoke] codex local exec OK");
  }
}

async function waitForModels(timeout) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const models = await probeModels().catch(() => null);
    if (models) return models;
    await sleep(500);
  }
  throw new Error(`LM Studio did not answer on ${BASE_URL}/models.`);
}

async function waitForModel(target, timeout) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const models = await probeModels().catch(() => []);
    if (models.includes(target)) return models;
    await sleep(750);
  }
  throw new Error(`LM Studio did not expose model ${target}.`);
}

async function probeModels() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const res = await fetch(`${BASE_URL}/models`, { cache: "no-store", signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    const data = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
    return Array.from(new Set(data.map((item) => typeof item === "string" ? item : item?.id).filter(Boolean))).sort();
  } finally {
    clearTimeout(timer);
  }
}

function requireBin(name) {
  const bin = findBin(name);
  if (!bin) throw new Error(`${name} not found on PATH.`);
  return bin;
}

function findBin(name) {
  for (const candidate of binCandidates(name)) {
    const probe = run(candidate, ["--version"], 4_000, { quiet: true });
    if (probe.status === 0) return candidate;
  }
  const probe = run(process.platform === "win32" ? "where.exe" : "which", [name], 4_000, { quiet: true });
  if (probe.status !== 0 || !probe.stdout.trim()) return null;
  return probe.stdout.trim().split(/\r?\n/)[0];
}

function binCandidates(name) {
  if (name !== "lms") return [name];
  if (process.platform === "win32") {
    return [
      "lms",
      "lms.exe",
      process.env.USERPROFILE ? join(process.env.USERPROFILE, ".lmstudio", "bin", "lms.exe") : null,
      process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs", "LM Studio", "lms.exe") : null,
    ].filter(Boolean);
  }
  return [
    "lms",
    join(os.homedir(), ".lmstudio", "bin", "lms"),
    "/opt/homebrew/bin/lms",
    "/usr/local/bin/lms",
  ];
}

function run(command, commandArgs, timeout, options = {}) {
  const res = spawnSync(command, commandArgs, {
    encoding: "utf8",
    timeout,
    windowsHide: true,
  });
  if (!options.quiet && res.error) {
    return { status: res.status ?? 1, stdout: res.stdout || "", stderr: `${res.stderr || ""}\n${res.error.message}` };
  }
  return { status: res.status ?? (res.error ? 1 : 0), stdout: res.stdout || "", stderr: res.stderr || "" };
}

function compact(result) {
  return `${result.stderr || result.stdout}`.trim().slice(0, 800);
}

function valueAfter(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
