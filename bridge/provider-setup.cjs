const { app, BrowserWindow, shell } = require("electron");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { bridgeDesignCss, bridgeLogoDataUri, loadBridgeDesign } = require("./theme.cjs");

const CODEX = {
  title: "ChatGPT Codex",
  installTitle: "Installation de ChatGPT Codex",
  authTitle: "Connexion au compte ChatGPT",
  doneTitle: "Bridge est prêt avec ChatGPT Codex",
};

const LMSTUDIO = {
  title: "Moteur local",
  installTitle: "Installation du moteur local",
  doneTitle: "Bridge est prêt avec le moteur local",
  baseUrl: "http://127.0.0.1:1234/v1",
  apiBaseUrl: "http://127.0.0.1:1234/api/v1",
  defaultModel: "ibm/granite-4-micro",
  defaultContextLength: 32768,
  defaultModelDownload: {
    model: "https://huggingface.co/lmstudio-community/granite-4.0-micro-GGUF",
    quantization: "Q4_K_M",
  },
  macArm64DmgUrl: "https://lmstudio.ai/download/latest/darwin/arm64",
};
const MAC_LMSTUDIO_APP = "/Applications/LM Studio.app";

const VOICE = {
  title: "Dictée locale",
  installTitle: "Installation de la dictée locale",
  doneTitle: "Bridge est prêt avec la dictée locale",
  defaultModel: "parakeet-tdt-0.6b-v3-int8",
};

const VOICE_MODELS = {
  "parakeet-tdt-0.6b-v3-int8": {
    id: "parakeet-tdt-0.6b-v3-int8",
    label: "Parakeet V3",
    directory: "parakeet-tdt-0.6b-v3-int8",
    aliases: ["parakeet-tdt-0.6b-v3", "parakeet-v3", "parakeet-v3-int8"],
    url: "https://blob.handy.computer/parakeet-v3-int8.tar.gz",
    sha256: "43d37191602727524a7d8c6da0eef11c4ba24320f5b4730f1a2497befc2efa77",
    sizeMb: 456,
    languages: ["fr", "en", "de", "es", "it", "pt", "nl", "sv", "ru", "uk"],
    recommended: true,
  },
};

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function bridgeLogoHtml(design) {
  const logo = bridgeLogoDataUri(design);
  if (!logo) return `<div class="logo logo-text">${escapeHtml(design.logoText || "B")}</div>`;
  return `<div class="logo"><img src="${logo}" alt="Yaka Bridge" /></div>`;
}

async function runCodexSetup() {
  return showCodexSetupWindow();
}

async function runBridgeSetup(options = {}) {
  const codex = await showCodexSetupWindow();
  const policy = options.aiPolicy?.localAi || options.localAi || {};
  const voicePolicy = options.aiPolicy?.voice || options.voice || {};
  let local = null;
  let voice = null;
  if (policy.enabled || policy.installRequired) {
    local = await showLmStudioSetupWindow(policy);
  }
  if (voicePolicy.enabled || voicePolicy.installRequired) {
    voice = await showVoiceSetupWindow(voicePolicy);
  }
  return {
    ok: Boolean(codex?.ok && (local ? local.ok : true) && (voice ? voice.ok : true)),
    codex,
    local: local || undefined,
    voice: voice || undefined,
  };
}

async function runLocalAiSetup(policy = {}) {
  return showLmStudioSetupWindow(policy);
}

async function runVoiceSetup(policy = {}) {
  return showVoiceSetupWindow(policy);
}

function findWingetBin() {
  const candidates = [
    "winget",
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Microsoft", "WindowsApps", "winget.exe")
      : null,
  ].filter(Boolean);
  for (const candidate of candidates) {
    const r = spawnSync(candidate, ["--version"], {
      timeout: 3000,
      encoding: "utf8",
      windowsHide: true,
    });
    if (r.status === 0) return candidate;
  }
  return null;
}

function findBrewBin() {
  const candidates = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew", "brew"];
  for (const candidate of candidates) {
    const r = spawnSync(candidate, ["--version"], { timeout: 3000, encoding: "utf8" });
    if (r.status === 0) return candidate;
  }
  return null;
}

function reloadWindowsPath() {
  if (process.platform !== "win32") return;
  try {
    const r = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')",
      ],
      { encoding: "utf8", timeout: 5000, windowsHide: true },
    );
    if (r.status === 0 && r.stdout.trim()) {
      process.env.PATH = r.stdout.trim();
      process.env.Path = process.env.PATH;
    }
  } catch {
    // Best effort.
  }
}

const WINGET_OK_CODES = new Set([0, -1978335189, 2316632107]);
function isWingetSuccess(code) {
  return WINGET_OK_CODES.has(code);
}

function runLogged(command, args, onProgress) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const child = spawn(command, args, {
      stdio: "pipe",
      windowsHide: true,
    });
    const parse = (chunk) => {
      const raw = chunk.toString();
      stderr += raw;
      for (const part of raw.split(/\r?\n/)) {
        const line = part.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
        if (!line) continue;
        const percentMatch = line.match(/(\d+)\s*%/);
        const percent = percentMatch ? Math.min(99, Number(percentMatch[1])) : null;
        let stage = null;
        if (/download|t[eé]l[eé]charg/i.test(line)) stage = "Téléchargement...";
        else if (/verify|hash|v[eé]rifi/i.test(line)) stage = "Vérification...";
        else if (/install|extract|instal/i.test(line)) stage = "Installation...";
        else if (/success|complete|termin/i.test(line)) stage = "Finalisation...";
        onProgress?.({ log: line, stage, percent });
      }
    };
    child.stdout?.on("data", parse);
    child.stderr?.on("data", parse);
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

async function installCodex(onProgress) {
  if (process.platform === "win32") {
    const winget = findWingetBin();
    if (!winget) throw new Error("Installe App Installer depuis le Microsoft Store puis réessaie.");
    const { code, stderr } = await runLogged(
      winget,
      [
        "install",
        "--id",
        "OpenAI.Codex",
        "--exact",
        "--silent",
        "--accept-package-agreements",
        "--accept-source-agreements",
        "--source",
        "winget",
      ],
      onProgress,
    );
    if (!isWingetSuccess(code)) throw new Error(`Installation Codex échouée (code ${code}). ${stderr.slice(0, 300)}`);
    reloadWindowsPath();
    ensureCodexFileStore();
    return;
  }
  if (process.platform === "darwin") {
    const brew = findBrewBin();
    if (!brew) throw new Error("Installe Homebrew depuis brew.sh puis réessaie.");
    const { code, stderr } = await runLogged(brew, ["install", "--cask", "codex"], onProgress);
    if (code !== 0) throw new Error(`Installation Codex échouée (code ${code}). ${stderr.slice(0, 300)}`);
    ensureCodexFileStore();
    return;
  }
  throw new Error("Installation automatique disponible sur Windows et macOS.");
}

async function installLmStudio(onProgress) {
  if (findLmsBin()) return;
  try {
    await installLmStudioHeadless(onProgress);
    if (findLmsBin()) return;
  } catch (err) {
    onProgress?.({
      stage: "Installation headless indisponible, essai du paquet desktop...",
      log: err?.message ?? String(err),
    });
  }

  if (process.platform === "win32") {
    const winget = findWingetBin();
    if (!winget) throw new Error("Installe App Installer depuis le Microsoft Store puis réessaie.");
    const { code, stderr } = await runLogged(
      winget,
      [
        "install",
        "--id",
        "ElementLabs.LMStudio",
        "--exact",
        "--silent",
        "--accept-package-agreements",
        "--accept-source-agreements",
        "--source",
        "winget",
      ],
      onProgress,
    );
    if (!isWingetSuccess(code)) throw new Error(`Installation du moteur local échouée (code ${code}). ${stderr.slice(0, 300)}`);
    reloadWindowsPath();
    return;
  }
  if (process.platform === "darwin") {
    if (findLmStudioApp()) return;
    const unsupportedApp = findUnsupportedLmStudioApp();
    if (unsupportedApp) {
      await installExistingLmStudioApp(unsupportedApp, onProgress);
      return;
    }
    await installLmStudioDmg(onProgress);
    return;
  }
  throw new Error("Installation automatique disponible sur Windows et macOS.");
}

async function installLmStudioHeadless(onProgress) {
  onProgress?.({ stage: "Installation du moteur local en arrière-plan...", percent: 24 });
  if (process.platform === "win32") {
    const { code, stderr } = await runLogged(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "irm https://lmstudio.ai/install.ps1 | iex",
      ],
      onProgress,
    );
    reloadWindowsPath();
    if (code !== 0) throw new Error(`Installation headless LM Studio échouée (code ${code}). ${stderr.slice(0, 300)}`);
    return;
  }

  if (process.platform === "darwin" || process.platform === "linux") {
    const workDir = fs.mkdtempSync(path.join(app.getPath("temp"), "bridge-lmstudio-headless-"));
    const installerPath = path.join(workDir, "install-lmstudio.sh");
    try {
      await downloadFileWithProgress(
        "https://lmstudio.ai/install.sh",
        installerPath,
        "Téléchargement du moteur local headless...",
        onProgress,
      );
      fs.chmodSync(installerPath, 0o755);
      const { code, stderr } = await runLogged("bash", [installerPath], onProgress);
      if (code !== 0) throw new Error(`Installation headless LM Studio échouée (code ${code}). ${stderr.slice(0, 300)}`);
      return;
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }

  throw new Error("Installation headless LM Studio disponible sur Windows, macOS et Linux.");
}

async function installExistingLmStudioApp(sourceApp, onProgress) {
  const source = safeRealpath(sourceApp) || sourceApp;
  if (!source || !fs.existsSync(source)) throw new Error("Copie locale de LM Studio introuvable.");
  if (findLmStudioApp()) return;
  onProgress?.({ stage: "Déplacement de LM Studio dans /Applications...", percent: 82 });
  await copyLmStudioAppToApplications(source, onProgress);
}

async function installLmStudioDmg(onProgress) {
  if (os.arch() !== "arm64") {
    const brew = findBrewBin();
    if (brew) {
      const { code, stderr } = await runLogged(brew, ["install", "--cask", "lm-studio"], onProgress);
      if (code !== 0) throw new Error(`Installation du moteur local échouée (code ${code}). ${stderr.slice(0, 300)}`);
      return;
    }
    throw new Error("Installation LM Studio automatique disponible sur Mac Apple Silicon. Sur Mac Intel, installe LM Studio manuellement.");
  }

  const workDir = fs.mkdtempSync(path.join(app.getPath("temp"), "bridge-lmstudio-"));
  const dmgPath = path.join(workDir, "LM-Studio.dmg");
  const mountDir = path.join(workDir, "mount");
  fs.mkdirSync(mountDir, { recursive: true });
  try {
    await downloadFileWithProgress(
      process.env.BRIDGE_LMSTUDIO_MAC_DMG_URL || LMSTUDIO.macArm64DmgUrl,
      dmgPath,
      "Téléchargement de LM Studio...",
      onProgress,
    );
    onProgress?.({ stage: "Montage de LM Studio...", percent: 88 });
    const attach = await runLogged("hdiutil", ["attach", dmgPath, "-nobrowse", "-readonly", "-mountpoint", mountDir], onProgress);
    if (attach.code !== 0) throw new Error(`Montage LM Studio échoué (code ${attach.code}). ${attach.stderr.slice(0, 300)}`);

    const sourceApp = findAppBundleInDir(mountDir);
    if (!sourceApp) throw new Error("Le DMG LM Studio ne contient pas d'application installable.");
    onProgress?.({ stage: "Installation de LM Studio dans /Applications...", percent: 94 });
    await copyLmStudioAppToApplications(sourceApp, onProgress);
    onProgress?.({ stage: "LM Studio installé.", percent: 100 });
  } finally {
    spawnSync("hdiutil", ["detach", mountDir, "-force"], { timeout: 10_000, encoding: "utf8" });
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

async function copyLmStudioAppToApplications(sourceApp, onProgress) {
  const targetApp = MAC_LMSTUDIO_APP;
  const source = safeRealpath(sourceApp) || sourceApp;
  if (safeRealpath(targetApp) === source && isSupportedMacAppPath(targetApp)) return;

  const copyCommand = `/bin/rm -rf ${shellQuote(targetApp)} && /usr/bin/ditto ${shellQuote(source)} ${shellQuote(targetApp)}`;
  const canWriteApplications = canWriteDir(path.dirname(targetApp));
  if (canWriteApplications) {
    fs.rmSync(targetApp, { recursive: true, force: true });
    const copy = await runLogged("ditto", [source, targetApp], onProgress);
    if (copy.code !== 0) throw new Error(`Copie LM Studio échouée (code ${copy.code}). ${copy.stderr.slice(0, 300)}`);
    return;
  }

  onProgress?.({ stage: "macOS demande l'autorisation d'installation..." });
  const script = `do shell script ${JSON.stringify(copyCommand)} with administrator privileges`;
  const copy = await runLogged("osascript", ["-e", script], onProgress);
  if (copy.code !== 0) {
    throw new Error(`Copie LM Studio dans /Applications échouée (code ${copy.code}). ${copy.stderr.slice(0, 300)}`);
  }
}

function findAppBundleInDir(dir) {
  const stack = [dir];
  while (stack.length) {
    const current = stack.shift();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory() && entry.name.endsWith(".app")) return fullPath;
      if (entry.isDirectory() && !entry.name.startsWith(".")) stack.push(fullPath);
    }
  }
  return null;
}

async function downloadFileWithProgress(url, targetPath, stage, onProgress) {
  const res = await fetch(url, { cache: "no-store", redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`Téléchargement refusé (HTTP ${res.status}).`);
  const total = Number(res.headers.get("content-length") || 0);
  let downloaded = 0;
  let lastEmit = 0;
  const progress = new Transform({
    transform(chunk, _encoding, callback) {
      downloaded += chunk.length;
      const now = Date.now();
      if (now - lastEmit > 500) {
        lastEmit = now;
        const percent = total ? Math.min(86, Math.round((downloaded / total) * 86)) : null;
        onProgress?.({
          stage,
          percent,
          log: total
            ? `${Math.round(downloaded / 1024 / 1024)} / ${Math.round(total / 1024 / 1024)} Mo`
            : `${Math.round(downloaded / 1024 / 1024)} Mo`,
        });
      }
      callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body), progress, fs.createWriteStream(targetPath));
}

function findLmsBin() {
  const home = os.homedir();
  const candidates = [];
  if (process.platform === "win32") {
    candidates.push("lms");
    candidates.push("lms.exe");
    if (process.env.USERPROFILE) {
      candidates.push(path.join(process.env.USERPROFILE, ".lmstudio", "bin", "lms.exe"));
      candidates.push(path.join(process.env.USERPROFILE, ".lmstudio", "bin", "lms"));
    }
    if (process.env.LOCALAPPDATA) {
      candidates.push(path.join(process.env.LOCALAPPDATA, "Programs", "LM Studio", "lms.exe"));
      candidates.push(path.join(process.env.LOCALAPPDATA, "Programs", "LM Studio", "resources", "app", ".webpack", "lms.exe"));
      candidates.push(path.join(process.env.LOCALAPPDATA, "Programs", "LM Studio", "resources", "app", ".webpack", "main", "lms.exe"));
    }
  } else {
    candidates.push("lms");
    candidates.push(path.join(home, ".lmstudio", "bin", "lms"));
    candidates.push("/opt/homebrew/bin/lms");
    candidates.push("/usr/local/bin/lms");
  }
  for (const candidate of candidates) {
    const res = spawnSync(candidate, ["--version"], {
      timeout: 3000,
      encoding: "utf8",
      windowsHide: true,
    });
    if (res.status === 0) return candidate;
  }
  const finder = process.platform === "win32" ? "where.exe" : "which";
  const res = spawnSync(finder, ["lms"], {
    timeout: 3000,
    encoding: "utf8",
    windowsHide: true,
  });
  if (res.status === 0 && res.stdout.trim()) return res.stdout.trim().split(/\r?\n/)[0].trim();
  return null;
}

function findLmStudioApp() {
  if (process.platform === "darwin") {
    return isSupportedMacAppPath(MAC_LMSTUDIO_APP) ? MAC_LMSTUDIO_APP : null;
  }
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    const p = path.join(process.env.LOCALAPPDATA, "Programs", "LM Studio", "LM Studio.exe");
    return fs.existsSync(p) ? p : null;
  }
  return null;
}

function findUnsupportedLmStudioApp() {
  if (process.platform !== "darwin") return null;
  const candidates = [
    MAC_LMSTUDIO_APP,
    path.join(os.homedir(), "Applications", "LM Studio.app"),
  ];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    if (isSupportedMacAppPath(candidate)) continue;
    return safeRealpath(candidate) || candidate;
  }
  return null;
}

function isSupportedMacAppPath(appPath) {
  if (process.platform !== "darwin" || !fs.existsSync(appPath)) return false;
  if (isSymlink(appPath)) return false;
  const resolved = safeRealpath(appPath);
  return Boolean(resolved && resolved.startsWith("/Applications/"));
}

function isSymlink(filePath) {
  try {
    return fs.lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

function safeRealpath(filePath) {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return null;
  }
}

function canWriteDir(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

async function probeLmStudioModels(timeoutMs = 1800) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${LMSTUDIO.baseUrl}/models`, { cache: "no-store", signal: controller.signal });
    const payload = await res.json().catch(() => null);
    const data = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
    const models = Array.from(new Set(data.map((item) => typeof item === "string" ? item : item?.id).filter(Boolean))).sort();
    return { ok: res.ok, models };
  } catch (err) {
    return { ok: false, models: [], error: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function startLmStudioServer(onProgress) {
  const ready = await probeLmStudioModels();
  if (ready.ok) return ready;
  let lms = await ensureLmStudioCliReady(onProgress);
  if (!lms) {
    const appPath = findLmStudioApp();
    if (appPath) {
      await launchLmStudioHidden(appPath, onProgress);
      onProgress?.({ stage: "Initialisation du moteur local en arrière-plan..." });
      await sleep(2500);
      lms = await ensureLmStudioCliReady(onProgress);
    } else {
      throw new Error("LM Studio doit être installé dans /Applications pour activer le moteur local.");
    }
  }

  if (!lms) {
    throw new Error("La commande LM Studio `lms` est introuvable après installation.");
  }

  onProgress?.({ stage: "Démarrage du moteur local..." });
  const daemon = await runLogged(lms, ["daemon", "up"], onProgress);
  if (daemon.code !== 0) {
    onProgress?.({ log: daemon.stderr.slice(0, 300), stage: "Démarrage du service LM Studio..." });
  }
  onProgress?.({ stage: "Démarrage du serveur local..." });
  const started = await runLogged(lms, ["server", "start", "--port", "1234"], onProgress);
  if (started.code !== 0) {
    const afterFailure = await probeLmStudioModels();
    if (!afterFailure.ok) throw new Error(`Démarrage du serveur LM Studio échoué. ${started.stderr.slice(0, 300)}`);
  }

  for (let i = 0; i < 60; i += 1) {
    await sleep(500);
    const status = await probeLmStudioModels();
    if (status.ok) return status;
  }
  throw new Error("Le serveur local LM Studio ne répond pas encore sur 127.0.0.1:1234.");
}

async function ensureLmStudioModel(model, onProgress) {
  const target = String(model || LMSTUDIO.defaultModel).trim() || LMSTUDIO.defaultModel;
  const contextLength = LMSTUDIO.defaultContextLength;
  let status = await probeLmStudioModels();
  const lms = await ensureLmStudioCliReady(onProgress);
  if (!lms) {
    throw new Error(`Modèle local requis absent: ${target}. La commande LM Studio \`lms\` est introuvable après installation.`);
  }
  if (status.ok && status.models.includes(target)) {
    const apiModel = await findLmStudioApiModel(target);
    if (apiModel && Number(apiModel.loaded_context_length || 0) >= contextLength) {
      return { ok: true, model: target, models: status.models };
    }
    onProgress?.({ stage: "Agrandissement du contexte local...", log: `${target} -> ${contextLength}` });
    await runLogged(lms, ["unload", target], onProgress);
  }

  let localModelKey = findLmStudioLocalModelKey(lms, target);
  if (!localModelKey) {
    await downloadLmStudioModel(target, onProgress);
    localModelKey = findLmStudioLocalModelKey(lms, target) || target;
  }

  const loadKey = localModelKey || target;
  onProgress?.({ stage: "Chargement du modèle local...", log: `${loadKey} (${contextLength} tokens)` });
  const { code, stderr } = await runLogged(
    lms,
    ["load", loadKey, "--identifier", target, "--context-length", String(contextLength), "--yes"],
    onProgress,
  );
  if (code !== 0) throw new Error(`Chargement du modèle local échoué (${target}). ${stderr.slice(0, 300)}`);
  status = await probeLmStudioModels();
  if (!status.models.includes(target)) {
    throw new Error(`Le modèle ${target} n'est pas visible dans LM Studio après chargement.`);
  }
  return { ok: true, model: target, models: status.models };
}

async function downloadLmStudioModel(target, onProgress) {
  const request = lmStudioDownloadRequest(target);
  onProgress?.({ stage: "Téléchargement du modèle local...", log: request.model });
  const started = await fetchLmStudioJson("/models/download", {
    method: "POST",
    body: JSON.stringify(request),
  });
  if (!started.ok) {
    throw new Error(`Téléchargement du modèle local refusé (${target}). ${started.error}`);
  }
  const payload = started.payload || {};
  if (payload.status === "already_downloaded" || payload.status === "completed") return payload;
  if (!payload.job_id) {
    throw new Error(`Téléchargement du modèle local impossible (${target}). Réponse LM Studio sans job_id.`);
  }

  const deadline = Date.now() + 90 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(1500);
    const status = await fetchLmStudioJson(`/models/download/status/${encodeURIComponent(payload.job_id)}`);
    if (!status.ok) {
      throw new Error(`Suivi du téléchargement LM Studio impossible (${target}). ${status.error}`);
    }
    const job = status.payload || {};
    emitLmStudioDownloadProgress(job, onProgress);
    if (job.status === "completed") return job;
    if (job.status === "failed") {
      throw new Error(`Téléchargement du modèle local échoué (${target}).`);
    }
    if (job.status === "paused") {
      throw new Error(`Téléchargement du modèle local en pause (${target}).`);
    }
  }
  throw new Error(`Téléchargement du modèle local trop long (${target}).`);
}

function lmStudioDownloadRequest(target) {
  if (normalizeModelKey(target) === normalizeModelKey(LMSTUDIO.defaultModel)) {
    return { ...LMSTUDIO.defaultModelDownload };
  }
  return { model: target };
}

function emitLmStudioDownloadProgress(job, onProgress) {
  const total = Number(job.total_size_bytes || 0);
  const downloaded = Number(job.downloaded_bytes || 0);
  const percent = total ? Math.min(99, Math.round((downloaded / total) * 99)) : undefined;
  const parts = [];
  if (downloaded) parts.push(`${Math.round(downloaded / 1024 / 1024)} Mo`);
  if (total) parts.push(`/ ${Math.round(total / 1024 / 1024)} Mo`);
  if (job.bytes_per_second) parts.push(`${Math.round(Number(job.bytes_per_second) / 1024 / 1024)} Mo/s`);
  onProgress?.({
    stage: "Téléchargement du modèle local...",
    percent,
    log: parts.join(" "),
  });
}

async function fetchLmStudioJson(pathname, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(options.timeoutMs || 15_000));
  try {
    const { timeoutMs: _timeoutMs, headers: optionHeaders, ...fetchOptions } = options;
    const headers = {
      "content-type": "application/json",
      ...(optionHeaders || {}),
    };
    const res = await fetch(`${LMSTUDIO.apiBaseUrl}${pathname}`, {
      cache: "no-store",
      ...fetchOptions,
      headers,
      signal: controller.signal,
    });
    const text = await res.text().catch(() => "");
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { message: text };
      }
    }
    if (!res.ok) {
      const error = payload?.error || payload?.message || text || `HTTP ${res.status}`;
      return { ok: false, status: res.status, payload, error };
    }
    return { ok: true, status: res.status, payload };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function findLmStudioApiModel(target) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1800);
  try {
    const res = await fetch("http://127.0.0.1:1234/api/v0/models", { cache: "no-store", signal: controller.signal });
    if (!res.ok) return null;
    const payload = await res.json().catch(() => null);
    const data = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
    return data.find((item) => item?.id === target || item?.identifier === target || item?.modelKey === target) || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function ensureLmStudioCliReady(onProgress) {
  let lms = findLmsBin();
  if (lms) return lms;
  const appPath = findLmStudioApp();
  if (!appPath) return null;
  onProgress?.({ stage: "Initialisation du CLI LM Studio..." });
  const packagedCli = findPackagedLmStudioCli();
  if (packagedCli) {
    const boot = await runLogged(packagedCli, ["bootstrap"], onProgress);
    reloadWindowsPath();
    lms = findLmsBin();
    if (lms) return lms;
    if (boot.code === 0) return packagedCli;
  }
  await launchLmStudioHidden(appPath, onProgress);
  await sleep(2500);
  if (packagedCli) {
    await runLogged(packagedCli, ["bootstrap"], onProgress);
    reloadWindowsPath();
  }
  return findLmsBin() || packagedCli || null;
}

async function launchLmStudioHidden(appPath, onProgress) {
  if (!appPath) return;
  onProgress?.({ stage: "Initialisation invisible de LM Studio..." });
  if (process.platform === "darwin") {
    await runLogged("open", ["-gj", appPath], onProgress);
    try {
      await runLogged("osascript", ["-e", 'tell application "LM Studio" to hide'], onProgress);
    } catch {
      // Best effort: the headless daemon path does not depend on hiding the app.
    }
    return;
  }
  if (process.platform === "win32") {
    spawn(appPath, [], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
    return;
  }
  onProgress?.({ stage: "Lancement graphique ignoré : mode headless requis." });
}

function findPackagedLmStudioCli() {
  const candidates = [];
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, "Programs", "LM Studio", "resources", "app", ".webpack", "lms.exe"));
    candidates.push(path.join(process.env.LOCALAPPDATA, "Programs", "LM Studio", "resources", "app", ".webpack", "main", "lms.exe"));
  }
  if (process.platform === "darwin" && findLmStudioApp()) {
    candidates.push(path.join(MAC_LMSTUDIO_APP, "Contents", "Resources", "app", ".webpack", "lms"));
    candidates.push(path.join(MAC_LMSTUDIO_APP, "Contents", "Resources", "app", ".webpack", "main", "lms"));
  }
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function readLmStudioLocalModels(lms) {
  const res = spawnSync(lms, ["ls", "--json"], {
    timeout: 8000,
    encoding: "utf8",
    windowsHide: true,
  });
  if (res.status !== 0 || !res.stdout.trim()) return [];
  try {
    const payload = JSON.parse(res.stdout);
    return Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.models)
        ? payload.models
        : Array.isArray(payload?.data)
          ? payload.data
          : [];
  } catch {
    return [];
  }
}

function findLmStudioLocalModelKey(lms, target) {
  const items = readLmStudioLocalModels(lms);
  const normalizedTarget = normalizeModelKey(target);
  for (const item of items) {
    const candidates = lmStudioModelKeyCandidates(item);
    const exact = candidates.find((candidate) => normalizeModelKey(candidate) === normalizedTarget);
    if (exact) return exact;
  }
  return null;
}

function lmStudioModelKeyCandidates(item) {
  if (typeof item === "string") return [item];
  if (!item || typeof item !== "object") return [];
  return [
    item.modelKey,
    item.model_key,
    item.key,
    item.path,
    item.identifier,
    item.id,
    item.name,
    item.displayName,
    item.display_name,
  ].filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim());
}

function normalizeModelKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\\/g, "/")
    .replace(/[@:]/g, "/")
    .replace(/\/+/g, "/");
}

function voiceModelsDir() {
  if (process.env.BRIDGE_VOICE_MODELS_DIR) return process.env.BRIDGE_VOICE_MODELS_DIR;
  try {
    return path.join(app.getPath("userData"), "voice-models");
  } catch {
    return path.join(os.homedir(), "Bridge", "voice-models");
  }
}

function voiceModelInfo(model) {
  const target = String(model || VOICE.defaultModel).trim() || VOICE.defaultModel;
  for (const info of Object.values(VOICE_MODELS)) {
    if (info.id === target || info.directory === target || info.aliases.includes(target)) return info;
  }
  const base = VOICE_MODELS[VOICE.defaultModel];
  return {
    id: target,
    directory: target,
    aliases: [],
    label: target,
    url: null,
    sha256: null,
    sizeMb: 0,
    languages: [],
    recommended: false,
    directoryHint: base.directory,
  };
}

function voiceModelPath(model) {
  const info = voiceModelInfo(model);
  return path.join(voiceModelsDir(), info.directory);
}

function isVoiceModelInstalled(model) {
  const dir = voiceModelPath(model);
  try {
    return fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

async function ensureVoiceModel(model, onProgress) {
  const info = voiceModelInfo(model);
  const targetDir = voiceModelPath(info.id);
  if (isVoiceModelInstalled(info.id)) return { ok: true, model: info.id, path: targetDir, installed: true };
  if (!info.url) {
    throw new Error(`Modèle vocal non installable automatiquement: ${info.id}.`);
  }

  const root = voiceModelsDir();
  const workDir = path.join(root, ".downloads");
  const extractDir = path.join(workDir, `${info.directory}-${Date.now()}`);
  const archivePath = path.join(workDir, `${info.directory}.tar.gz`);
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(extractDir, { recursive: true });

  try {
    onProgress?.({ stage: `Téléchargement de ${info.label} (${info.sizeMb} Mo)...`, percent: 0 });
    await downloadVoiceModelArchive(info, archivePath, onProgress);
    onProgress?.({ stage: "Vérification terminée. Extraction...", percent: 96 });
    await extractVoiceModelArchive(archivePath, extractDir, onProgress);
    const sourceDir = locateExtractedVoiceModelDir(extractDir, info.directory);
    if (!sourceDir) throw new Error(`Archive vocale invalide: dossier ${info.directory} absent.`);
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    fs.renameSync(sourceDir, targetDir);
    onProgress?.({ stage: "Modèle vocal installé.", percent: 100 });
    return { ok: true, model: info.id, path: targetDir, installed: true };
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
}

async function downloadVoiceModelArchive(info, archivePath, onProgress) {
  const res = await fetch(info.url, { cache: "no-store" });
  if (!res.ok || !res.body) throw new Error(`Téléchargement du modèle vocal refusé (HTTP ${res.status}).`);
  const total = Number(res.headers.get("content-length") || info.sizeMb * 1024 * 1024);
  const hash = createHash("sha256");
  let downloaded = 0;
  let lastEmit = 0;
  const progress = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      downloaded += chunk.length;
      const now = Date.now();
      if (now - lastEmit > 400) {
        lastEmit = now;
        const percent = total ? Math.min(95, Math.round((downloaded / total) * 95)) : null;
        onProgress?.({
          stage: "Téléchargement du modèle vocal...",
          percent,
          log: `${Math.round(downloaded / 1024 / 1024)} / ${Math.round(total / 1024 / 1024)} Mo`,
        });
      }
      callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body), progress, fs.createWriteStream(archivePath));
  const digest = hash.digest("hex");
  if (info.sha256 && digest !== info.sha256) {
    fs.rmSync(archivePath, { force: true });
    throw new Error(`Vérification SHA-256 du modèle vocal échouée (${digest}).`);
  }
}

async function extractVoiceModelArchive(archivePath, extractDir, onProgress) {
  const tarBin = process.platform === "win32" ? "tar.exe" : "tar";
  const { code, stderr } = await runLogged(tarBin, ["-xzf", archivePath, "-C", extractDir], ({ log }) => {
    onProgress?.({ stage: "Extraction du modèle vocal...", log });
  });
  if (code !== 0) throw new Error(`Extraction du modèle vocal échouée (code ${code}). ${stderr.slice(0, 300)}`);
}

function locateExtractedVoiceModelDir(root, directory) {
  const direct = path.join(root, directory);
  if (fs.existsSync(direct)) return direct;
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(root, entry.name, directory);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function findCodexBin() {
  const home = os.homedir();
  if (process.platform === "win32") {
    const pkg = probeWingetCodexPackage();
    if (pkg) return pkg;
    const r = spawnSync("where.exe", ["codex"], { timeout: 3000, encoding: "utf8", windowsHide: true });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().split(/\r?\n/)[0].trim();
    for (const dir of [
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links"),
      path.join(home, ".codex", "bin"),
      path.join(home, ".cargo", "bin"),
      process.env.APPDATA && path.join(process.env.APPDATA, "npm"),
    ].filter(Boolean)) {
      for (const name of ["codex.exe", "codex.cmd", "codex.bat"]) {
        const p = path.join(dir, name);
        if (fs.existsSync(p)) return p;
      }
    }
    return null;
  }
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", path.join(home, ".codex", "bin"), path.join(home, ".local", "bin")];
  const enriched = [process.env.PATH, ...extra].filter(Boolean).join(path.delimiter);
  const r = spawnSync("which", ["codex"], {
    env: { ...process.env, PATH: enriched },
    timeout: 3000,
    encoding: "utf8",
  });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  for (const dir of extra) {
    const p = path.join(dir, "codex");
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function probeWingetCodexPackage() {
  if (!process.env.LOCALAPPDATA) return null;
  const pkgRoot = path.join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Packages");
  let entries = [];
  try {
    entries = fs.readdirSync(pkgRoot);
  } catch {
    return null;
  }
  const isCodexExe = (file) => {
    const lower = file.toLowerCase();
    if (!lower.endsWith(".exe")) return false;
    if (lower.includes("command-runner") || lower.includes("sandbox-setup")) return false;
    return lower === "codex.exe" || /^codex[-_]/.test(lower);
  };
  const findInDir = (dir, depth) => {
    let files;
    try {
      files = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const f of files) {
      if (f.isFile() && isCodexExe(f.name)) return path.join(dir, f.name);
    }
    if (depth <= 0) return null;
    for (const f of files) {
      if (!f.isDirectory()) continue;
      const found = findInDir(path.join(dir, f.name), depth - 1);
      if (found) return found;
    }
    return null;
  };
  const packages = entries
    .filter((entry) => /^OpenAI\.Codex/i.test(entry))
    .map((entry) => {
      const dir = path.join(pkgRoot, entry);
      let mtime = 0;
      try {
        mtime = fs.statSync(dir).mtimeMs;
      } catch {
        // ignore
      }
      return { dir, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
  for (const { dir } of packages) {
    const found = findInDir(dir, 2);
    if (found) return found;
  }
  return null;
}

function ensureCodexFileStore() {
  const codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  fs.mkdirSync(codexHome, { recursive: true });
  const cfgPath = path.join(codexHome, "config.toml");
  let content = "";
  try {
    content = fs.readFileSync(cfgPath, "utf8");
  } catch {
    // New config.
  }
  if (/^\s*cli_auth_credentials_store\s*=/m.test(content)) {
    content = content.replace(/^\s*cli_auth_credentials_store\s*=.*$/m, 'cli_auth_credentials_store = "file"');
  } else {
    content = `cli_auth_credentials_store = "file"\n${content}`;
  }
  fs.writeFileSync(cfgPath, content, "utf8");
}

function codexAuthFilePath() {
  const codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  return path.join(codexHome, "auth.json");
}

function codexAuthenticated() {
  return fs.existsSync(codexAuthFilePath());
}

async function runCodexDeviceLogin(send) {
  ensureCodexFileStore();
  const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
  const ISSUER = "https://auth.openai.com";
  const TOKEN_URL = "https://auth.openai.com/oauth/token";
  const VERIFICATION_URL = `${ISSUER}/codex/device`;
  const postJson = async (url, body, asForm) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      return await fetch(url, {
        method: "POST",
        headers: asForm
          ? { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }
          : { "Content-Type": "application/json", Accept: "application/json" },
        body: asForm ? new URLSearchParams(body).toString() : JSON.stringify(body),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  send({ phase: "auth-waiting", text: "Demande d'un code de connexion..." });
  const request = await postJson(`${ISSUER}/api/accounts/deviceauth/usercode`, { client_id: CLIENT_ID }, false);
  if (request.status !== 200) throw new Error(`Connexion OpenAI impossible (HTTP ${request.status}).`);
  const dc = await request.json();
  const userCode = dc.user_code;
  const deviceAuthId = dc.device_auth_id;
  const pollInterval = Math.max(3, Number.parseInt(dc.interval ?? "5", 10)) * 1000;
  if (!userCode || !deviceAuthId) throw new Error("Code de connexion incomplet.");
  send({ phase: "auth-device-code", userCode, url: VERIFICATION_URL });
  await shell.openExternal(VERIFICATION_URL).catch(() => {});

  const maxWaitMs = 15 * 60 * 1000;
  const start = Date.now();
  let codeResp = null;
  while (Date.now() - start < maxWaitMs) {
    await sleep(pollInterval);
    const poll = await postJson(
      `${ISSUER}/api/accounts/deviceauth/token`,
      { device_auth_id: deviceAuthId, user_code: userCode },
      false,
    ).catch(() => null);
    if (!poll) continue;
    if (poll.status === 200) {
      codeResp = await poll.json();
      break;
    }
    if (poll.status === 403 || poll.status === 404) continue;
    throw new Error(`Connexion OpenAI interrompue (HTTP ${poll.status}).`);
  }
  if (!codeResp) throw new Error("Délai dépassé : connexion non validée.");

  const authorizationCode = codeResp.authorization_code;
  const codeVerifier = codeResp.code_verifier;
  if (!authorizationCode || !codeVerifier) throw new Error("Réponse de connexion incomplète.");
  const tokenResp = await postJson(
    TOKEN_URL,
    {
      grant_type: "authorization_code",
      code: authorizationCode,
      redirect_uri: `${ISSUER}/deviceauth/callback`,
      client_id: CLIENT_ID,
      code_verifier: codeVerifier,
    },
    true,
  );
  const raw = await tokenResp.text();
  if (tokenResp.status !== 200) throw new Error(`Connexion OpenAI refusée (HTTP ${tokenResp.status}).`);
  const tokens = JSON.parse(raw);
  const accessToken = tokens.access_token;
  if (!accessToken) throw new Error("Token OpenAI absent.");
  const idToken = typeof tokens.id_token === "string" ? tokens.id_token : null;
  const refreshToken = typeof tokens.refresh_token === "string" ? tokens.refresh_token : null;
  const authPath = codexAuthFilePath();
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  const authJson = {
    OPENAI_API_KEY: null,
    tokens: {
      id_token: idToken,
      access_token: accessToken,
      refresh_token: refreshToken,
      account_id: accountIdFromJwt(idToken) || accountIdFromJwt(accessToken) || null,
    },
    last_refresh: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
  };
  const tmp = `${authPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(authJson, null, 2), "utf8");
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // no-op Windows
  }
  fs.renameSync(tmp, authPath);
}

function accountIdFromJwt(jwt) {
  try {
    const parts = String(jwt || "").split(".");
    if (parts.length < 2) return null;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - b64.length % 4);
    const claims = JSON.parse(Buffer.from(b64 + pad, "base64").toString("utf8"));
    const auth = claims["https://api.openai.com/auth"];
    return typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : null;
  } catch {
    return null;
  }
}

function showCodexSetupWindow() {
  const needsInstall = !findCodexBin();
  const alreadyAuthenticated = !needsInstall && codexAuthenticated();
  const design = loadBridgeDesign();
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 560,
      height: 600,
      resizable: false,
      minimizable: false,
      maximizable: false,
      center: true,
      title: "Configuration ChatGPT Codex",
      backgroundColor: design.bg,
      show: true,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      },
    });
    win.setMenuBarVisibility(false);
    const channel = `codex-setup-action-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const { ipcMain } = require("electron");
    win.loadURL(`data:text/html;charset=utf-8;base64,${Buffer.from(setupHtml(needsInstall, alreadyAuthenticated, channel, design), "utf8").toString("base64")}`);

    const send = (state) => {
      if (win.isDestroyed()) return;
      win.webContents
        .executeJavaScript(`window.__bridgeCodexState && window.__bridgeCodexState(${JSON.stringify(state)})`)
        .catch(() => {});
    };

    let settled = false;
    let retryFn = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      ipcMain.removeAllListeners(channel);
      try {
        if (!win.isDestroyed()) win.close();
      } catch {
        // ignore
      }
      resolve({ ok: result !== "quit", result });
    };

    async function runInstallThenAuth() {
      send({ phase: "installing", stage: "Démarrage..." });
      try {
        await installCodex(({ log, stage, percent }) => send({ phase: "installing", log, stage, percent }));
        send({ phase: "install-done" });
        await sleep(500);
        await runAuth();
      } catch (err) {
        send({ phase: "install-error", error: err?.message ?? String(err) });
        retryFn = runInstallThenAuth;
      }
    }

    async function runAuth() {
      send({ phase: "auth-waiting" });
      try {
        await runCodexDeviceLogin(send);
        send({ phase: "auth-done" });
        await sleep(900);
        send({ phase: "done" });
        await sleep(500);
        finish("done");
      } catch (err) {
        send({ phase: "auth-error", error: err?.message ?? String(err) });
        retryFn = runAuth;
      }
    }

    ipcMain.on(channel, async (_event, action) => {
      if (action === "quit") return finish("quit");
      if (action === "retry" && retryFn) {
        const fn = retryFn;
        retryFn = null;
        await fn();
      }
      if (action === "start") {
        if (needsInstall) await runInstallThenAuth();
        else await runAuth();
      }
    });

    win.webContents.once("did-finish-load", () => {
      setTimeout(() => {
        if (alreadyAuthenticated) {
          send({ phase: "already-ready" });
          setTimeout(() => finish("done"), 700);
        } else if (needsInstall) runInstallThenAuth();
        else runAuth();
      }, 250);
    });
    win.on("closed", () => finish("quit"));
  });
}

function showLmStudioSetupWindow(policy = {}) {
  const model = String(policy.model || LMSTUDIO.defaultModel).trim() || LMSTUDIO.defaultModel;
  const mandatory = policy.mandatory === true;
  const focusWindow = policy.focus !== false;
  const parentWindow = policy.parentWindow || BrowserWindow.getFocusedWindow() || undefined;
  const lmsBin = findLmsBin();
  const lmStudioApp = findLmStudioApp();
  const needsAppInstall = mandatory && process.platform === "darwin" && !lmStudioApp;
  const needsInstall = needsAppInstall || (!lmsBin && !lmStudioApp);
  const needsCliActivation = !needsInstall && !lmsBin && Boolean(lmStudioApp);
  const design = loadBridgeDesign();
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 560,
      height: 560,
      resizable: false,
      minimizable: false,
      maximizable: false,
      closable: !mandatory,
      parent: parentWindow,
      modal: false,
      alwaysOnTop: false,
      center: true,
      title: "Préparation du moteur local",
      backgroundColor: design.bg,
      show: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      },
    });
    win.once("ready-to-show", () => {
      if (win.isDestroyed()) return;
      if (focusWindow) win.show();
      else win.showInactive();
    });
    win.setMenuBarVisibility(false);
    const channel = `local-ai-setup-action-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const { ipcMain } = require("electron");
    win.loadURL(`data:text/html;charset=utf-8;base64,${Buffer.from(lmStudioSetupHtml({ needsInstall, needsCliActivation, model, channel, design, mandatory }), "utf8").toString("base64")}`);

    const send = (state) => {
      if (win.isDestroyed()) return;
      win.webContents
        .executeJavaScript(`window.__bridgeLocalAiState && window.__bridgeLocalAiState(${JSON.stringify(state)})`)
        .catch(() => {});
    };

    let settled = false;
    let retryFn = null;
    let canClose = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      canClose = true;
      ipcMain.removeAllListeners(channel);
      try {
        if (!win.isDestroyed()) win.close();
      } catch {
        // ignore
      }
      resolve({ ok: result !== "quit", result, model });
    };

    async function runLocalSetup() {
      try {
        send({ phase: "installing", stage: needsInstall ? "Installation..." : "Vérification..." });
        if (needsInstall) {
          await installLmStudio(({ log, stage, percent }) => send({ phase: "installing", log, stage, percent }));
          send({ phase: "install-done" });
          await sleep(500);
        } else if (needsCliActivation) {
          send({ phase: "install-done", stage: "LM Studio détecté. Bridge va ouvrir l'app pour activer le moteur local." });
        } else {
          send({ phase: "install-done", stage: "Déjà installé" });
        }
        send({ phase: "server", stage: "Démarrage du serveur local..." });
        await startLmStudioServer(({ log, stage }) => send({ phase: "server", log, stage }));
        send({ phase: "model", stage: "Chargement du modèle..." });
        await ensureLmStudioModel(model, ({ log, stage, percent }) => send({ phase: "model", log, stage, percent }));
        send({ phase: "done" });
        await sleep(700);
        finish("done");
      } catch (err) {
        send({ phase: "error", error: err?.message ?? String(err) });
        retryFn = runLocalSetup;
      }
    }

    ipcMain.on(channel, async (_event, action) => {
      if (action === "quit") {
        if (mandatory) return send({ phase: "error", error: "Installation requise par votre organisation." });
        return finish("quit");
      }
      if (action === "retry" && retryFn) {
        const fn = retryFn;
        retryFn = null;
        await fn();
      }
    });

    win.webContents.once("did-finish-load", () => setTimeout(runLocalSetup, 250));
    win.on("close", (event) => {
      if (mandatory && !canClose) {
        event.preventDefault();
        send({ phase: "error", error: "Installation requise par votre organisation." });
      }
    });
    win.on("closed", () => finish("quit"));
  });
}

function lmStudioSetupHtml({ needsInstall, needsCliActivation, model, channel, design, mandatory = false }) {
  const installDescription = needsInstall
    ? "Installation automatique demandée par votre organisation."
    : needsCliActivation
      ? "LM Studio est installé. Bridge vérifie maintenant le CLI et le serveur local."
      : "Déjà installé sur ce poste.";
  const logoHtml = bridgeLogoHtml(design);
  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <title>Préparation du moteur local</title>
  <style>
    * { box-sizing: border-box; }
    ${bridgeDesignCss(design)}
    body { margin: 0; height: 100vh; overflow: hidden; background: var(--bg); color: var(--text); font-family: var(--font-sans); }
    header { height: 76px; padding: 18px 28px; display: flex; align-items: center; gap: 12px; background: var(--panel); border-bottom: 1px solid var(--border); }
    .logo { width: 38px; height: 38px; border-radius: var(--radius); display: grid; place-items: center; background: var(--icon-bg); border: 1px solid var(--icon-border); overflow: hidden; box-shadow: 0 1px 2px rgb(28 27 26 / 0.08); }
    .logo img { width: 100%; height: 100%; display: block; object-fit: cover; }
    .logo-text { background: var(--accent); color: var(--on-accent); font-weight: 800; }
    .eyebrow { font-size: 10px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: var(--soft); }
    h1 { margin: 2px 0 0; font-size: 17px; line-height: 1.2; }
    main { height: calc(100vh - 144px); overflow-y: auto; padding: 24px 28px 18px; }
    footer { height: 68px; padding: 16px 28px; background: var(--panel); border-top: 1px solid var(--border); display: flex; justify-content: flex-end; gap: 10px; }
    .steps { display: grid; gap: 16px; }
    .step { display: flex; gap: 14px; align-items: flex-start; }
    .step-icon { width: 34px; height: 34px; border-radius: 50%; flex: 0 0 auto; display: grid; place-items: center; font-size: 14px; font-weight: 800; background: var(--secondary); color: var(--soft); }
    .step-icon.running { background: var(--accent-tint); color: var(--accent); animation: pulse 1.3s ease-in-out infinite; }
    .step-icon.done { background: var(--green-bg); color: var(--green); animation: none; }
    .step-icon.error { background: var(--red-bg); color: var(--red); animation: none; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .55; } }
    .step-body { min-width: 0; flex: 1; }
    .step-title { font-size: 14px; font-weight: 700; margin-bottom: 4px; }
    .step-title.muted { color: var(--soft); }
    .step-desc { color: var(--muted); font-size: 12.5px; line-height: 1.55; }
    .log { display: none; max-height: 82px; overflow: auto; margin-top: 8px; padding: 7px 8px; border-radius: 7px; background: var(--log-bg); color: var(--soft); font: 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; }
    button { border: 0; border-radius: 7px; padding: 8px 17px; font: inherit; font-size: 13px; font-weight: 650; cursor: pointer; }
    .primary { background: var(--accent); color: var(--on-accent); }
    .secondary { background: var(--secondary); color: var(--text); }
    code { background: var(--secondary); color: var(--text); padding: 2px 6px; border-radius: 5px; }
  </style>
</head>
<body>
  <header>${logoHtml}<div><div class="eyebrow">Bridge</div><h1>Préparation du moteur local</h1></div></header>
  <main>
    <div class="steps">
      <div class="step"><div class="step-icon ${needsInstall ? "running" : "done"}" id="icon-install">${needsInstall ? "1" : "✓"}</div><div class="step-body"><div class="step-title" id="title-install">${LMSTUDIO.installTitle}</div><div class="step-desc" id="desc-install">${escapeHtml(installDescription)}</div><div class="log" id="log-install"></div></div></div>
      <div class="step"><div class="step-icon pending" id="icon-server">${needsInstall ? "2" : "1"}</div><div class="step-body"><div class="step-title muted" id="title-server">Démarrage local</div><div class="step-desc" id="desc-server">Bridge démarre le moteur local sur ce poste.</div><div class="log" id="log-server"></div></div></div>
      <div class="step"><div class="step-icon pending" id="icon-model">${needsInstall ? "3" : "2"}</div><div class="step-body"><div class="step-title muted" id="title-model">Modèle local</div><div class="step-desc" id="desc-model">Modèle demandé : <code>${escapeHtml(model)}</code></div><div class="log" id="log-model"></div></div></div>
      <div class="step"><div class="step-icon pending" id="icon-done">${needsInstall ? "4" : "3"}</div><div class="step-body"><div class="step-title muted" id="title-done">${LMSTUDIO.doneTitle}</div><div class="step-desc" id="desc-done">Finalisation automatique.</div></div></div>
    </div>
  </main>
  <footer>${mandatory ? '<span class="step-desc" style="margin-right:auto;align-self:center">Installation requise par votre organisation.</span>' : "<button class=\"secondary\" onclick=\"window.bridgeLocalAiSetup.action('quit')\">Annuler</button>"}<button class="primary" id="btn-retry" style="display:none" onclick="window.bridgeLocalAiSetup.action('retry')">Réessayer</button></footer>
  <script>
    const { ipcRenderer } = require("electron");
    window.bridgeLocalAiSetup = { action: (name) => ipcRenderer.send(${JSON.stringify(channel)}, name) };
    function setIcon(id, cls, text) { const el = document.getElementById(id); if (!el) return; el.className = 'step-icon ' + cls; if (text != null) el.textContent = text; }
    function setText(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }
    function log(id, line) { const el = document.getElementById(id); if (!el || !line) return; el.style.display = 'block'; el.textContent = (el.textContent + '\\n' + line).slice(-600).trim(); el.scrollTop = el.scrollHeight; }
    window.__bridgeLocalAiState = function(s) {
      if (s.phase === 'installing') { setIcon('icon-install', 'running'); setText('title-install', 'Installation en cours...'); if (s.stage) setText('desc-install', s.stage); log('log-install', s.log); }
      if (s.phase === 'install-done') { setIcon('icon-install', 'done', '✓'); setText('title-install', 'Installation terminée'); setText('desc-install', s.stage || 'Moteur local installé.'); }
      if (s.phase === 'server') { setIcon('icon-server', 'running'); document.getElementById('title-server').className = 'step-title'; if (s.stage) setText('desc-server', s.stage); log('log-server', s.log); }
      if (s.phase === 'model') { setIcon('icon-server', 'done', '✓'); setIcon('icon-model', 'running'); document.getElementById('title-model').className = 'step-title'; if (s.stage) setText('desc-model', s.stage); log('log-model', s.log); }
      if (s.phase === 'done') { setIcon('icon-server', 'done', '✓'); setIcon('icon-model', 'done', '✓'); setIcon('icon-done', 'done', '✓'); document.getElementById('title-done').className = 'step-title'; setText('title-done', 'Configuration terminée'); setText('desc-done', 'Bridge peut utiliser le moteur local.'); }
      if (s.phase === 'error') { setIcon('icon-done', 'error', '!'); setText('title-done', 'Configuration à terminer'); setText('desc-done', s.error || 'Erreur inconnue.'); document.getElementById('btn-retry').style.display = 'inline-block'; }
    };
  </script>
</body>
</html>`;
}

function showVoiceSetupWindow(policy = {}) {
  const info = voiceModelInfo(policy.model);
  const mandatory = policy.mandatory === true;
  const focusWindow = policy.focus !== false;
  const parentWindow = policy.parentWindow || BrowserWindow.getFocusedWindow() || undefined;
  const design = loadBridgeDesign();
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 560,
      height: 500,
      resizable: false,
      minimizable: false,
      maximizable: false,
      closable: true,
      parent: parentWindow,
      modal: false,
      alwaysOnTop: false,
      center: true,
      title: "Préparation de la dictée locale",
      backgroundColor: design.bg,
      show: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      },
    });
    win.once("ready-to-show", () => {
      if (win.isDestroyed()) return;
      if (focusWindow) win.show();
      else win.showInactive();
    });
    win.setMenuBarVisibility(false);
    const channel = `voice-setup-action-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const { ipcMain } = require("electron");
    win.loadURL(`data:text/html;charset=utf-8;base64,${Buffer.from(voiceSetupHtml(info, channel, design, mandatory), "utf8").toString("base64")}`);

    const send = (state) => {
      if (win.isDestroyed()) return;
      win.webContents
        .executeJavaScript(`window.__bridgeVoiceState && window.__bridgeVoiceState(${JSON.stringify(state)})`)
        .catch(() => {});
    };

    let settled = false;
    let retryFn = null;
    let canClose = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      canClose = true;
      ipcMain.removeAllListeners(channel);
      try {
        if (!win.isDestroyed()) win.close();
      } catch {
        // ignore
      }
      resolve({ ok: result !== "quit", result, model: info.id, path: voiceModelPath(info.id) });
    };

    async function runVoiceSetup() {
      try {
        if (isVoiceModelInstalled(info.id)) {
          send({ phase: "done", stage: "Modèle vocal déjà installé." });
          await sleep(600);
          finish("done");
          return;
        }
        send({ phase: "download", stage: `Téléchargement de ${info.label}...`, percent: 0 });
        await ensureVoiceModel(info.id, ({ log, stage, percent }) => send({ phase: "download", log, stage, percent }));
        send({ phase: "done" });
        await sleep(700);
        finish("done");
      } catch (err) {
        send({ phase: "error", error: err?.message ?? String(err) });
        retryFn = runVoiceSetup;
      }
    }

    ipcMain.on(channel, async (_event, action) => {
      if (action === "quit") {
        if (mandatory) return send({ phase: "error", error: "Installation requise par votre organisation." });
        return finish("quit");
      }
      if (action === "retry" && retryFn) {
        const fn = retryFn;
        retryFn = null;
        await fn();
      }
    });

    win.webContents.once("did-finish-load", () => setTimeout(runVoiceSetup, 250));
    win.on("close", (event) => {
      if (mandatory && !canClose) {
        send({ phase: "error", error: "Installation requise par votre organisation." });
      }
    });
    win.on("closed", () => finish("quit"));
  });
}

function voiceSetupHtml(info, channel, design, mandatory = false) {
  const logoHtml = bridgeLogoHtml(design);
  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <title>Préparation de la dictée locale</title>
  <style>
    * { box-sizing: border-box; }
    ${bridgeDesignCss(design)}
    body { margin: 0; height: 100vh; overflow: hidden; background: var(--bg); color: var(--text); font-family: var(--font-sans); }
    header { height: 76px; padding: 18px 28px; display: flex; align-items: center; gap: 12px; background: var(--panel); border-bottom: 1px solid var(--border); }
    .logo { width: 38px; height: 38px; border-radius: var(--radius); display: grid; place-items: center; background: var(--icon-bg); border: 1px solid var(--icon-border); overflow: hidden; box-shadow: 0 1px 2px rgb(28 27 26 / 0.08); }
    .logo img { width: 100%; height: 100%; display: block; object-fit: cover; }
    .logo-text { background: var(--accent); color: var(--on-accent); font-weight: 800; }
    .eyebrow { font-size: 10px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: var(--soft); }
    h1 { margin: 2px 0 0; font-size: 17px; line-height: 1.2; }
    main { height: calc(100vh - 144px); overflow-y: auto; padding: 24px 28px 18px; }
    footer { height: 68px; padding: 16px 28px; background: var(--panel); border-top: 1px solid var(--border); display: flex; justify-content: flex-end; gap: 10px; }
    .steps { display: grid; gap: 16px; }
    .step { display: flex; gap: 14px; align-items: flex-start; }
    .step-icon { width: 34px; height: 34px; border-radius: 50%; flex: 0 0 auto; display: grid; place-items: center; font-size: 14px; font-weight: 800; background: var(--secondary); color: var(--soft); }
    .step-icon.running { background: var(--accent-tint); color: var(--accent); animation: pulse 1.3s ease-in-out infinite; }
    .step-icon.done { background: var(--green-bg); color: var(--green); animation: none; }
    .step-icon.error { background: var(--red-bg); color: var(--red); animation: none; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .55; } }
    .step-body { min-width: 0; flex: 1; }
    .step-title { font-size: 14px; font-weight: 700; margin-bottom: 4px; }
    .step-title.muted { color: var(--soft); }
    .step-desc { color: var(--muted); font-size: 12.5px; line-height: 1.55; }
    .progress-wrap { margin-top: 10px; }
    .progress-track { height: 10px; overflow: hidden; border-radius: 999px; background: var(--secondary); }
    .progress-fill { height: 100%; width: 0%; border-radius: 999px; background: var(--accent); transition: width var(--t-fast) var(--ease); }
    .progress-fill.indeterminate { width: 35%; animation: slide 1.5s ease-in-out infinite; }
    @keyframes slide { 0% { transform: translateX(-180%); } 100% { transform: translateX(340%); } }
    .progress-status { margin-top: 5px; display: flex; justify-content: space-between; color: var(--muted); font-size: 11.5px; }
    .log { display: none; max-height: 82px; overflow: auto; margin-top: 8px; padding: 7px 8px; border-radius: 7px; background: var(--log-bg); color: var(--soft); font: 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; }
    button { border: 0; border-radius: 7px; padding: 8px 17px; font: inherit; font-size: 13px; font-weight: 650; cursor: pointer; }
    .primary { background: var(--accent); color: var(--on-accent); }
    .secondary { background: var(--secondary); color: var(--text); }
    code { background: var(--secondary); color: var(--text); padding: 2px 6px; border-radius: 5px; }
  </style>
</head>
<body>
  <header>${logoHtml}<div><div class="eyebrow">Bridge</div><h1>Préparation de la dictée locale</h1></div></header>
  <main>
    <div class="steps">
      <div class="step"><div class="step-icon running" id="icon-download">1</div><div class="step-body"><div class="step-title" id="title-download">${VOICE.installTitle}</div><div class="step-desc" id="desc-download">Modèle demandé : <code>${escapeHtml(info.label)}</code> · ${info.sizeMb} Mo</div><div class="progress-wrap"><div class="progress-track"><div class="progress-fill indeterminate" id="progress-fill"></div></div><div class="progress-status"><span id="progress-stage">Démarrage...</span><span id="progress-pct"></span></div></div><div class="log" id="log-download"></div></div></div>
      <div class="step"><div class="step-icon pending" id="icon-done">2</div><div class="step-body"><div class="step-title muted" id="title-done">${VOICE.doneTitle}</div><div class="step-desc" id="desc-done">Finalisation automatique.</div></div></div>
    </div>
  </main>
  <footer>${mandatory ? '<span class="step-desc" style="margin-right:auto;align-self:center">Installation requise par votre organisation.</span>' : "<button class=\"secondary\" onclick=\"window.bridgeVoiceSetup.action('quit')\">Annuler</button>"}<button class="primary" id="btn-retry" style="display:none" onclick="window.bridgeVoiceSetup.action('retry')">Réessayer</button></footer>
  <script>
    const { ipcRenderer } = require("electron");
    window.bridgeVoiceSetup = { action: (name) => ipcRenderer.send(${JSON.stringify(channel)}, name) };
    function setIcon(id, cls, text) { const el = document.getElementById(id); if (!el) return; el.className = 'step-icon ' + cls; if (text != null) el.textContent = text; }
    function setText(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }
    function log(id, line) { const el = document.getElementById(id); if (!el || !line) return; el.style.display = 'block'; el.textContent = (el.textContent + '\\n' + line).slice(-700).trim(); el.scrollTop = el.scrollHeight; }
    window.__bridgeVoiceState = function(s) {
      if (s.phase === 'download') { setIcon('icon-download', 'running'); const fill = document.getElementById('progress-fill'); if (s.percent != null) { fill.classList.remove('indeterminate'); fill.style.width = s.percent + '%'; setText('progress-pct', s.percent + '%'); } if (s.stage) setText('progress-stage', s.stage); log('log-download', s.log); }
      if (s.phase === 'done') { setIcon('icon-download', 'done', '✓'); setIcon('icon-done', 'done', '✓'); document.getElementById('title-done').className = 'step-title'; setText('title-done', 'Configuration terminée'); setText('desc-done', s.stage || 'La dictée locale est disponible sur ce poste.'); const fill = document.getElementById('progress-fill'); fill.classList.remove('indeterminate'); fill.style.width = '100%'; fill.style.background = 'var(--green)'; setText('progress-pct', '100%'); }
      if (s.phase === 'error') { setIcon('icon-download', 'error', '!'); setText('title-download', 'Installation à terminer'); setText('desc-download', s.error || 'Erreur inconnue.'); document.getElementById('btn-retry').style.display = 'inline-block'; }
    };
  </script>
</body>
</html>`;
}

function setupHtml(needsInstall, alreadyAuthenticated, channel, design) {
  const logoHtml = bridgeLogoHtml(design);
  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <title>Configuration ChatGPT Codex</title>
  <style>
    * { box-sizing: border-box; }
    ${bridgeDesignCss(design)}
    body { margin: 0; height: 100vh; overflow: hidden; background: var(--bg); color: var(--text); font-family: var(--font-sans); }
    header { height: 76px; padding: 18px 28px; display: flex; align-items: center; gap: 12px; background: var(--panel); border-bottom: 1px solid var(--border); }
    .logo { width: 38px; height: 38px; border-radius: var(--radius); display: grid; place-items: center; background: var(--icon-bg); border: 1px solid var(--icon-border); overflow: hidden; box-shadow: 0 1px 2px rgb(28 27 26 / 0.08); }
    .logo img { width: 100%; height: 100%; display: block; object-fit: cover; }
    .logo-text { background: var(--accent); color: var(--on-accent); font-weight: 800; }
    .eyebrow { font-size: 10px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: var(--soft); }
    h1 { margin: 2px 0 0; font-size: 17px; line-height: 1.2; }
    main { height: calc(100vh - 144px); overflow-y: auto; padding: 24px 28px 18px; }
    footer { height: 68px; padding: 16px 28px; background: var(--panel); border-top: 1px solid var(--border); display: flex; justify-content: flex-end; gap: 10px; }
    .steps { display: grid; gap: 16px; }
    .step { display: flex; gap: 14px; align-items: flex-start; }
    .step-icon { width: 34px; height: 34px; border-radius: 50%; flex: 0 0 auto; display: grid; place-items: center; font-size: 14px; font-weight: 800; background: var(--secondary); color: var(--soft); }
    .step-icon.running { background: var(--accent-tint); color: var(--accent); animation: pulse 1.3s ease-in-out infinite; }
    .step-icon.done { background: var(--green-bg); color: var(--green); animation: none; }
    .step-icon.error { background: var(--red-bg); color: var(--red); animation: none; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .55; } }
    .step-body { min-width: 0; flex: 1; }
    .step-title { font-size: 14px; font-weight: 700; margin-bottom: 4px; }
    .step-title.muted { color: var(--soft); }
    .step-desc { color: var(--muted); font-size: 12.5px; line-height: 1.55; }
    .progress-wrap { display: none; margin-top: 10px; }
    .progress-track { height: 10px; overflow: hidden; border-radius: 999px; background: var(--secondary); }
    .progress-fill { height: 100%; width: 0%; border-radius: 999px; background: var(--accent); transition: width var(--t-fast) var(--ease); }
    .progress-fill.indeterminate { width: 35%; animation: slide 1.5s ease-in-out infinite; }
    @keyframes slide { 0% { transform: translateX(-180%); } 100% { transform: translateX(340%); } }
    .progress-status { margin-top: 5px; display: flex; justify-content: space-between; color: var(--muted); font-size: 11.5px; }
    .log { display: none; max-height: 82px; overflow: auto; margin-top: 8px; padding: 7px 8px; border-radius: 7px; background: var(--log-bg); color: var(--soft); font: 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; }
    .code { display: inline-block; margin: 10px 0; padding: 10px 18px; border-radius: 8px; background: var(--accent-tint); color: var(--accent); font: 700 26px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; letter-spacing: 3px; user-select: all; }
    button { border: 0; border-radius: 7px; padding: 8px 17px; font: inherit; font-size: 13px; font-weight: 650; cursor: pointer; }
    .primary { background: var(--accent); color: var(--on-accent); }
    .secondary { background: var(--secondary); color: var(--text); }
  </style>
</head>
<body>
  <header>${logoHtml}<div><div class="eyebrow">Bridge</div><h1>Configuration ChatGPT Codex</h1></div></header>
  <main>
    <div class="steps">
      <div class="step"><div class="step-icon ${needsInstall ? "running" : "done"}" id="icon-install">${needsInstall ? "1" : "✓"}</div><div class="step-body"><div class="step-title" id="title-install">${CODEX.installTitle}</div><div class="step-desc" id="desc-install">${needsInstall ? "Installation automatique en cours..." : "Déjà installé sur ce poste."}</div><div class="progress-wrap" id="progress-wrap"><div class="progress-track"><div class="progress-fill indeterminate" id="progress-fill"></div></div><div class="progress-status"><span id="progress-stage">Démarrage...</span><span id="progress-pct"></span></div></div><div class="log" id="log-install"></div></div></div>
      <div class="step"><div class="step-icon pending" id="icon-auth">${needsInstall ? "2" : "1"}</div><div class="step-body"><div class="step-title muted" id="title-auth">${CODEX.authTitle}</div><div class="step-desc" id="desc-auth">${alreadyAuthenticated ? "Compte déjà connecté sur ce poste." : "Préparation..."}</div><div class="log" id="log-auth"></div></div></div>
      <div class="step"><div class="step-icon pending" id="icon-done">${needsInstall ? "3" : "2"}</div><div class="step-body"><div class="step-title muted" id="title-done">${CODEX.doneTitle}</div><div class="step-desc" id="desc-done">Finalisation automatique.</div></div></div>
    </div>
  </main>
  <footer><button class="secondary" onclick="window.bridgeCodexSetup.action('quit')">Annuler</button><button class="primary" id="btn-retry" style="display:none" onclick="window.bridgeCodexSetup.action('retry')">Réessayer</button></footer>
  <script>
    const { ipcRenderer } = require("electron");
    window.bridgeCodexSetup = { action: (name) => ipcRenderer.send(${JSON.stringify(channel)}, name) };
    function setIcon(id, cls, text) { const el = document.getElementById(id); if (!el) return; el.className = 'step-icon ' + cls; if (text != null) el.textContent = text; }
    function setText(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }
    function setHtml(id, html) { const el = document.getElementById(id); if (el) el.innerHTML = html; }
    function log(id, line) { const el = document.getElementById(id); if (!el || !line) return; el.style.display = 'block'; el.textContent = (el.textContent + '\\n' + line).slice(-600).trim(); el.scrollTop = el.scrollHeight; }
    window.__bridgeCodexState = function(s) {
      if (s.phase === 'installing') { setIcon('icon-install', 'running'); setText('title-install', 'Installation en cours...'); document.getElementById('progress-wrap').style.display = 'block'; const fill = document.getElementById('progress-fill'); if (s.percent != null) { fill.classList.remove('indeterminate'); fill.style.width = s.percent + '%'; setText('progress-pct', s.percent + '%'); } if (s.stage) setText('progress-stage', s.stage); log('log-install', s.log); }
      if (s.phase === 'install-done') { setIcon('icon-install', 'done', '✓'); setText('title-install', 'Installation terminée'); const fill = document.getElementById('progress-fill'); fill.classList.remove('indeterminate'); fill.style.width = '100%'; fill.style.background = 'var(--green)'; setText('progress-pct', '100%'); setText('progress-stage', 'Terminé'); }
      if (s.phase === 'install-error') { setIcon('icon-install', 'error', '!'); setText('title-install', "Échec d'installation"); setText('desc-install', s.error || 'Erreur inconnue.'); document.getElementById('btn-retry').style.display = 'inline-block'; }
      if (s.phase === 'auth-waiting') { setIcon('icon-auth', 'running'); document.getElementById('title-auth').className = 'step-title'; setText('desc-auth', s.text || 'Connexion en cours...'); log('log-auth', s.log); }
      if (s.phase === 'auth-device-code') { setIcon('icon-auth', 'running'); document.getElementById('title-auth').className = 'step-title'; setHtml('desc-auth', 'Une page va s\\'ouvrir. Saisis ce code :<br><span class="code">' + (s.userCode || '') + '</span><br>La connexion se termine automatiquement après validation.'); }
      if (s.phase === 'auth-done') { setIcon('icon-auth', 'done', '✓'); setText('title-auth', 'Connexion réussie'); setHtml('desc-auth', '<span style="color:var(--green);font-weight:700">Compte connecté.</span>'); setIcon('icon-done', 'running'); document.getElementById('title-done').className = 'step-title'; }
      if (s.phase === 'already-ready') { setIcon('icon-install', 'done', '✓'); setText('title-install', 'Déjà installé'); setText('desc-install', 'Trouvé sur ce poste.'); setIcon('icon-auth', 'done', '✓'); document.getElementById('title-auth').className = 'step-title'; setText('title-auth', 'Déjà connecté'); setHtml('desc-auth', '<span style="color:var(--green);font-weight:700">Compte prêt.</span>'); setIcon('icon-done', 'done', '✓'); document.getElementById('title-done').className = 'step-title'; setText('title-done', 'Configuration terminée'); }
      if (s.phase === 'auth-error') { setIcon('icon-auth', 'error', '!'); setText('title-auth', 'Échec de connexion'); setText('desc-auth', s.error || 'La connexion a échoué.'); document.getElementById('btn-retry').style.display = 'inline-block'; }
      if (s.phase === 'done') { setIcon('icon-done', 'done', '✓'); setText('title-done', 'Configuration terminée'); }
    };
  </script>
</body>
</html>`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  runCodexSetup,
  runBridgeSetup,
  runLocalAiSetup,
  runVoiceSetup,
  ensureCodexFileStore,
  findCodexBin,
  findLmsBin,
  findLmStudioApp,
  probeLmStudioModels,
  startLmStudioServer,
  ensureVoiceModel,
  isVoiceModelInstalled,
  voiceModelPath,
  voiceModelsDir,
  voiceModelInfo,
};
