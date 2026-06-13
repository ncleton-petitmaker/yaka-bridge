/**
 * Probe le statut de Codex CLI et de LM Studio.
 * Utilisé par /api/agents pour la page Paramètres et les diagnostics Bridge.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { findCodexBin } from "./agents.js";
import {
  DEFAULT_AGENT_PROVIDER,
  DEFAULT_LOCAL_MODEL,
  LMSTUDIO_BASE_URL,
  normalizeAgentProvider,
  type AgentProvider,
  type AppConfig,
} from "./app-config.js";

export interface LmStudioStatus {
  id: "lmstudio";
  name: "LM Studio";
  baseUrl: string;
  available: boolean;
  configuredModel: string;
  modelAvailable: boolean;
  models: string[];
  error?: string;
}

export interface AgentStatus {
  id: "codex";
  name: "Codex";
  provider: AgentProvider;
  available: boolean;
  path: string | null;
  version: string | null;
  loggedIn: boolean | null;
  supportsOss: boolean | null;
  lmStudio: LmStudioStatus;
  error?: string;
}

const CODEX_AUTH_FILES = ["auth.json", "auth-v2.json", "credentials.json"] as const;
const LMSTUDIO_TIMEOUT_MS = 1500;

function execProbe(
  bin: string,
  args: string[],
  timeoutMs = 5000
): Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { shell: false });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ ok: false, stdout: out, stderr: err + "\n[timeout]", code: null });
    }, timeoutMs);
    child.stdout?.on("data", (b) => (out += b.toString()));
    child.stderr?.on("data", (b) => (err += b.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout: out, stderr: err, code });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout: out, stderr: err + "\n" + e.message, code: null });
    });
  });
}

export async function probeLmStudioStatus(
  configuredModel = DEFAULT_LOCAL_MODEL,
  fetchImpl: typeof fetch = fetch
): Promise<LmStudioStatus> {
  const status: LmStudioStatus = {
    id: "lmstudio",
    name: "LM Studio",
    baseUrl: LMSTUDIO_BASE_URL,
    available: false,
    configuredModel,
    modelAvailable: false,
    models: [],
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LMSTUDIO_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${LMSTUDIO_BASE_URL}/models`, {
      cache: "no-store",
      signal: controller.signal,
    });
    const payload = (await res.json().catch(() => null)) as unknown;
    const models = parseLmStudioModels(payload);
    const modelAvailable = models.includes(configuredModel);
    return {
      ...status,
      available: res.ok,
      models,
      modelAvailable,
      error: res.ok
        ? modelAvailable
          ? undefined
          : models.length
            ? `Modèle local absent dans LM Studio: ${configuredModel}.`
            : "LM Studio est joignable mais aucun modèle n'est chargé."
        : `LM Studio a répondu HTTP ${res.status}.`,
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ...status,
      error: aborted
        ? `LM Studio ne répond pas sur ${LMSTUDIO_BASE_URL}.`
        : `LM Studio injoignable sur ${LMSTUDIO_BASE_URL}.`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function getAgentStatus(
  config?: Pick<AppConfig, "agentProvider" | "localModel">
): Promise<AgentStatus> {
  const provider = normalizeAgentProvider(config?.agentProvider ?? DEFAULT_AGENT_PROVIDER);
  const configuredModel = config?.localModel?.trim() || DEFAULT_LOCAL_MODEL;
  const lmStudio = await probeLmStudioStatus(configuredModel);
  const bin = findCodexBin();
  if (!bin) {
    return {
      id: "codex",
      name: "Codex",
      provider,
      available: false,
      path: null,
      version: null,
      loggedIn: null,
      supportsOss: null,
      lmStudio,
      error: "Binaire `codex` introuvable sur le PATH. Installez Codex CLI puis connectez-le au compte ChatGPT avec `codex login`.",
    };
  }

  const v = await execProbe(bin, ["--version"], 5000);
  const versionMatch = `${v.stdout}\n${v.stderr}`.match(/(\d+\.\d+\.\d+)/);
  const version = versionMatch ? versionMatch[1] : null;
  const help = v.ok ? await execProbe(bin, ["exec", "--help"], 5000) : null;
  const helpText = `${help?.stdout ?? ""}\n${help?.stderr ?? ""}`;
  const supportsOss = help ? /--oss\b/.test(helpText) && /--local-provider\b/.test(helpText) : null;

  let loggedIn: boolean | null = null;
  if (v.ok) {
    loggedIn = await probeCodexLogin(bin);
  }

  const cloudReady = Boolean(v.ok && loggedIn);
  const localReady = Boolean(v.ok && supportsOss && lmStudio.available && lmStudio.modelAvailable);
  return {
    id: "codex",
    name: "Codex",
    provider,
    available: provider === "codex-lmstudio" ? localReady : cloudReady,
    path: bin,
    version,
    loggedIn,
    supportsOss,
    lmStudio,
    error: buildAgentError({
      provider,
      versionOk: v.ok,
      versionError: v.stderr.slice(0, 500) || v.stdout.slice(0, 500),
      loggedIn,
      supportsOss,
      lmStudio,
    }),
  };
}

export async function assertAgentProviderReady(
  config: Pick<AppConfig, "agentProvider" | "localModel">
): Promise<AgentStatus> {
  const status = await getAgentStatus(config);
  if (!status.available) {
    const providerLabel = status.provider === "codex-lmstudio" ? "Codex local LM Studio" : "ChatGPT Codex";
    throw new Error(status.error || `${providerLabel} indisponible.`);
  }
  return status;
}

function parseLmStudioModels(payload: unknown): string[] {
  const data = Array.isArray(payload)
    ? payload
    : typeof payload === "object" && payload !== null && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : [];
  return Array.from(
    new Set(
      data
        .map((item) => {
          if (typeof item === "string") return item;
          if (typeof item === "object" && item !== null && typeof (item as { id?: unknown }).id === "string") {
            return (item as { id: string }).id;
          }
          return "";
        })
        .map((id) => id.trim())
        .filter(Boolean)
    )
  ).sort((a, b) => a.localeCompare(b));
}

async function probeCodexLogin(bin: string): Promise<boolean> {
  const status = await execProbe(bin, ["login", "status"], 5000);
  if (status.ok) return true;
  const authPath = codexAuthPath();
  return Boolean(authPath);
}

function codexAuthPath(): string | null {
  if (process.env.CODEX_OAUTH_TOKEN || process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY) return "env";
  const root = process.env.CODEX_HOME || path.join(process.env.HOME || process.env.USERPROFILE || homedir(), ".codex");
  for (const file of CODEX_AUTH_FILES) {
    const p = path.join(root, file);
    if (!existsSync(p)) continue;
    try {
      const content = readFileSync(p, "utf8").trim();
      if (content) return p;
    } catch {
      // ignore
    }
  }
  return null;
}

function buildAgentError(input: {
  provider: AgentProvider;
  versionOk: boolean;
  versionError: string;
  loggedIn: boolean | null;
  supportsOss: boolean | null;
  lmStudio: LmStudioStatus;
}): string | undefined {
  if (!input.versionOk) return input.versionError || "`codex --version` a échoué.";
  if (input.provider === "codex-lmstudio") {
    if (!input.supportsOss) return "Cette version de Codex CLI ne supporte pas encore `--oss --local-provider`.";
    if (!input.lmStudio.available) return input.lmStudio.error;
    if (!input.lmStudio.modelAvailable) return input.lmStudio.error;
    return undefined;
  }
  if (!input.loggedIn) return "Codex CLI est installé mais `codex login` semble requis pour ChatGPT Codex.";
  return undefined;
}
