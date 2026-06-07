const { app, BrowserWindow, Menu, nativeImage, shell, Tray, ipcMain, safeStorage } = require("electron");
const { spawnSync } = require("node:child_process");
const { createServer } = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

let autoUpdater = null;
try {
  ({ autoUpdater } = require("electron-updater"));
} catch {
  autoUpdater = null;
}

process.env.APP_BRIDGE_ELECTRON = "1";
process.env.APP_BRIDGE_VERSION = process.env.APP_BRIDGE_VERSION || app.getVersion();

const PRODUCT_NAME = "Bridge";
const PROTOCOL_VERSION = 2;
const HEALTH_PORT = Number(process.env.BRIDGE_HEALTH_PORT || process.env.APP_BRIDGE_HEALTH_PORT || "7707") || 7707;
const BRIDGE_ONLINE_THRESHOLD_SECONDS =
  Number(process.env.BRIDGE_ONLINE_THRESHOLD_SECONDS || "90") || 90;
const CONFIG_PATH =
  process.env.BRIDGE_CONFIG ||
  process.env.APP_BRIDGE_CONFIG ||
  path.join(os.homedir(), ".bridge", "config.json");
const DATA_DIR =
  process.env.BRIDGE_DATA_DIR ||
  process.env.APP_DATA_DIR ||
  path.join(os.homedir(), PRODUCT_NAME, "data");

let statusWindow = null;
let tray = null;
let isQuitting = false;
let localHealthServer = null;
let localHealthReady = false;
let bridgeError = null;
let ipcRegistered = false;
let runtimeHandle = null;
let runtimeState = null;
let localStatuses = {};
let localActivity = [];
let autoUpdateStarted = false;
let autoUpdateInterval = null;
let updateDownloaded = false;
let codexStatusCache = null;
let updateState = {
  enabled: false,
  status: "idle",
  feedUrl: "",
  currentVersion: app.getVersion(),
  availableVersion: "",
  lastCheckedAt: "",
  lastError: "",
};

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showStatusWindow();
    syncServices();
  });
}

app.on("open-url", (event) => {
  event.preventDefault();
  showStatusWindow();
  syncServices();
});

app.on("before-quit", () => {
  isQuitting = true;
  try {
    runtimeHandle?.stop?.();
    localHealthServer?.close();
    if (autoUpdateInterval) clearInterval(autoUpdateInterval);
  } catch {
    // no-op
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && isQuitting) app.quit();
});

app.whenReady().then(() => {
  ensureDirs();
  registerBridgeProtocol();
  createTray();
  startRuntimeIfAvailable();
  startLocalHealthServer();
  startAutoUpdates();
  showStatusWindow();
  refreshExternalStatuses();
  setInterval(refreshExternalStatuses, 15_000);
});

app.on("activate", () => showStatusWindow());

function registerBridgeProtocol() {
  try {
    app.setAsDefaultProtocolClient("bridge");
  } catch (err) {
    pushActivity(`Protocole bridge:// indisponible: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function startAutoUpdates({ reconfigure = false } = {}) {
  if (!autoUpdater) {
    updateState = { ...updateState, enabled: false, status: "module-missing", lastError: "electron-updater indisponible" };
    return;
  }
  if (!app.isPackaged && process.env.BRIDGE_AUTO_UPDATE_IN_DEV !== "1") {
    updateState = { ...updateState, enabled: false, status: "disabled-dev" };
    return;
  }
  const feedUrl = updateFeedBaseUrl(loadConfig());
  if (!feedUrl) {
    updateState = { ...updateState, enabled: false, status: "missing-feed" };
    updateTrayMenu();
    refreshStatusWindow();
    return;
  }
  if (autoUpdateStarted && !reconfigure && updateState.feedUrl === feedUrl) return;

  autoUpdateStarted = true;
  updateDownloaded = false;
  updateState = {
    ...updateState,
    enabled: true,
    status: "configured",
    feedUrl,
    lastError: "",
  };

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = process.env.BRIDGE_UPDATE_ALLOW_PRERELEASE === "1";
  autoUpdater.setFeedURL({ provider: "generic", url: feedUrl });
  attachAutoUpdateHandlers();
  scheduleAutoUpdateCheck(3_000);
  if (!autoUpdateInterval) {
    const intervalMs = Number(process.env.BRIDGE_UPDATE_CHECK_INTERVAL_MS || 60 * 60 * 1000);
    autoUpdateInterval = setInterval(() => scheduleAutoUpdateCheck(), Math.max(intervalMs, 15 * 60 * 1000));
  }
  updateTrayMenu();
  refreshStatusWindow();
}

function attachAutoUpdateHandlers() {
  if (autoUpdater.__bridgeHandlersAttached) return;
  autoUpdater.__bridgeHandlersAttached = true;
  autoUpdater.on("checking-for-update", () => setUpdateState("checking"));
  autoUpdater.on("update-not-available", () => setUpdateState("up-to-date"));
  autoUpdater.on("update-available", (info) => {
    updateState.availableVersion = info?.version || "";
    setUpdateState("downloading");
    pushActivity(`Mise à jour Bridge ${updateState.availableVersion || ""} détectée.`);
  });
  autoUpdater.on("download-progress", (progress) => {
    updateState.status = `downloading ${Math.round(progress?.percent || 0)}%`;
    refreshStatusWindow();
    updateTrayMenu();
  });
  autoUpdater.on("update-downloaded", (info) => {
    updateDownloaded = true;
    updateState.availableVersion = info?.version || updateState.availableVersion;
    setUpdateState("downloaded");
    pushActivity("Mise à jour Bridge téléchargée. Installation automatique dès que Bridge est disponible.");
    maybeInstallDownloadedUpdate();
  });
  autoUpdater.on("error", (err) => {
    updateState.lastError = err instanceof Error ? err.message : String(err);
    setUpdateState("error");
    pushActivity(`Mise à jour Bridge échouée: ${updateState.lastError}`);
  });
}

function setUpdateState(status) {
  updateState = {
    ...updateState,
    enabled: true,
    status,
    lastCheckedAt: new Date().toISOString(),
  };
  updateTrayMenu();
  refreshStatusWindow();
}

function scheduleAutoUpdateCheck(delayMs = 0) {
  if (!autoUpdater || !updateState.enabled) return;
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      updateState.lastError = err instanceof Error ? err.message : String(err);
      setUpdateState("error");
    });
  }, delayMs);
}

function maybeInstallDownloadedUpdate() {
  if (!autoUpdater || !updateDownloaded) return;
  const activeJobs = Number(runtimeState?.activeJobs || 0);
  if (activeJobs > 0) {
    setUpdateState("waiting-for-idle");
    return;
  }
  setUpdateState("installing");
  isQuitting = true;
  setTimeout(() => {
    autoUpdater.quitAndInstall(false, true);
  }, 750);
}

function updateFeedBaseUrl(cfg) {
  const explicit = cleanExternalUrl(process.env.BRIDGE_UPDATE_BASE_URL || process.env.BRIDGE_AUTO_UPDATE_URL || cfg.updateBaseUrl);
  if (explicit) return explicit;
  const supabaseUrl = cleanExternalUrl(cfg.supabaseUrl);
  return supabaseUrl ? `${supabaseUrl}/storage/v1/object/public/bridge-updates` : null;
}

function ensureDirs() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  } catch {
    // no-op
  }
}

function trayIconPath() {
  for (const candidate of [
    path.join(__dirname, "..", "..", "public", "icon-32.png"),
    path.join(__dirname, "..", "public", "icon-32.png"),
    path.join(__dirname, "..", "..", "public", "icon-512.png"),
    path.join(__dirname, "..", "public", "icon-512.png"),
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function createTray() {
  if (tray) return;
  const iconPath = trayIconPath();
  const image = iconPath
    ? nativeImage.createFromPath(iconPath).resize({ width: process.platform === "darwin" ? 18 : 16 })
    : nativeImage.createEmpty();
  if (process.platform === "darwin") image.setTemplateImage(true);
  tray = new Tray(image);
  tray.setToolTip(PRODUCT_NAME);
  tray.on("click", () => showStatusWindow());
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  const state = localStatusPayload();
  const connectedCount = state.services.filter((service) => service.status === "connected" || service.status === "active").length;
  const codexLabel = state.codex?.ready ? "Codex prêt" : `Codex: ${state.codex?.label || "à vérifier"}`;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Afficher Bridge", click: () => showStatusWindow() },
    {
      label: `${connectedCount}/${state.services.length} services connectés`,
      enabled: false,
    },
    { label: localHealthReady ? "Bridge détectable localement" : "Démarrage local...", enabled: false },
    { label: codexLabel, enabled: false },
    { label: updateState.enabled ? `Mises à jour: ${updateState.status}` : "Mises à jour: non configurées", enabled: false },
    { type: "separator" },
    { label: "Synchroniser", click: () => syncServices() },
    {
      label: "Quitter",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]));
}

function startRuntimeIfAvailable() {
  const runtimePath = path.join(__dirname, "runtime.cjs");
  if (!fs.existsSync(runtimePath)) {
    pushActivity("Runtime Codex indisponible en dev non buildé.");
    return;
  }
  try {
    const runtime = require(runtimePath);
    runtime.startBridgeRuntime({
      command: "run",
      configPath: CONFIG_PATH,
      healthServer: false,
      onState: (state) => {
        runtimeState = state;
        bridgeError = state.lastError || null;
        maybeInstallDownloadedUpdate();
        refreshStatusWindow();
        updateTrayMenu();
      },
    }).then((handle) => {
      runtimeHandle = handle;
      runtimeState = handle.state();
      pushActivity("Runtime Codex démarré.");
      refreshStatusWindow();
    }).catch((err) => {
      bridgeError = err instanceof Error ? err.message : String(err);
      pushActivity(`Runtime Codex arrêté: ${bridgeError}`);
      refreshStatusWindow();
    });
  } catch (err) {
    bridgeError = err instanceof Error ? err.message : String(err);
    pushActivity(`Runtime Codex indisponible: ${bridgeError}`);
  }
}

function startLocalHealthServer() {
  if (localHealthServer) return;
  localHealthServer = createServer((req, res) => {
    const origin = req.headers.origin;
    res.setHeader("access-control-allow-origin", typeof origin === "string" ? origin : "*");
    res.setHeader("access-control-allow-methods", "GET, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type, authorization");
    res.setHeader("access-control-allow-private-network", "true");
    res.setHeader("vary", "origin");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "GET" && (req.url === "/api/health" || req.url === "/health")) {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(localStatusPayload()));
      return;
    }
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "not-found" }));
  });
  localHealthServer.on("error", (err) => {
    localHealthReady = false;
    bridgeError = `Port local ${HEALTH_PORT} indisponible : ${err.message}`;
    pushActivity(bridgeError);
    try {
      localHealthServer?.close();
    } catch {
      // no-op
    }
    localHealthServer = null;
    updateTrayMenu();
    refreshStatusWindow();
    setTimeout(startLocalHealthServer, 5_000);
  });
  localHealthServer.listen(HEALTH_PORT, "127.0.0.1", () => {
    localHealthReady = true;
    pushActivity(`Bridge détectable localement sur 127.0.0.1:${HEALTH_PORT}.`);
    updateTrayMenu();
    refreshStatusWindow();
  });
}

function localStatusPayload() {
  const cfg = loadConfig();
  const base = runtimeState || stateFromConfig(cfg);
  const codex = getCodexStatus();
  return {
    ...base,
    codex,
    authenticated: Boolean(base.authenticated && !isStoredSessionInvalid(cfg)),
    controlPlaneConfigured: Boolean(base.controlPlaneConfigured && !isStoredSessionInvalid(cfg)),
    services: base.services.map((service) => serviceWithDisplayStatus(base, service, codex)),
    localHealthReady,
    bridgeError,
    autoUpdate: updateState,
    activity: localActivity.slice(0, 30),
  };
}

function stateFromConfig(cfg) {
  return {
    ok: true,
    bridge: true,
    productName: PRODUCT_NAME,
    protocolVersion: PROTOCOL_VERSION,
    version: process.env.APP_BRIDGE_VERSION || app.getVersion() || "dev",
    label: cfg.label || os.hostname(),
    account: cfg.account,
    organizationId: cfg.organizationId || cfg.account?.organizationId,
    installId: cfg.installId,
    deviceId: cfg.deviceId || cfg.installId,
    bridgeId: cfg.bridgeId,
    dataDir: cfg.dataDir,
    controlPlaneConfigured: Boolean(cfg.controlPlaneBaseUrl && (cfg.bridgeToken || cfg.session?.accessToken)),
    authenticated: Boolean(cfg.session?.accessToken || cfg.bridgeToken),
    codex: getCodexStatus(),
    controlPlaneBaseUrl: cfg.controlPlaneBaseUrl || cfg.cloudBaseUrl || process.env.BRIDGE_DEFAULT_CONTROL_PLANE_URL || "",
    demoMode: cfg.demoMode === true,
    services: cfg.services.map((service) => ({
      serviceId: service.serviceId,
      serviceInstanceId: service.serviceInstanceId,
      name: service.name,
      baseUrl: service.baseUrl,
      healthUrl: service.healthUrl,
      status: service.paused ? "paused" : service.status || "disconnected",
      scopes: service.scopes || [],
      runningJobs: 0,
      lastSeenAt: service.lastSeenAt,
      lastError: service.lastError,
      actions: service.actions || [],
      events: service.events || [],
    })),
    erpBus: cfg.erpBus,
    activeJobs: 0,
    ts: new Date().toISOString(),
  };
}

function getCodexStatus({ force = false } = {}) {
  const now = Date.now();
  if (!force && codexStatusCache && now - codexStatusCache.checkedMs < 15_000) {
    return codexStatusCache.status;
  }

  const installCommand = "npm install -g @openai/codex";
  const loginCommand = "codex login";
  const checkedAt = new Date().toISOString();
  const authPath = path.join(os.homedir(), ".codex", "auth.json");
  const bin = findCodexExecutable();

  const finish = (status) => {
    codexStatusCache = {
      checkedMs: now,
      status: {
        installCommand,
        loginCommand,
        checkedAt,
        ...status,
      },
    };
    return codexStatusCache.status;
  };

  if (!bin) {
    return finish({
      ready: false,
      state: "missing",
      label: "Codex non installé",
      detail: "Installe Codex CLI puis connecte-le pour que Bridge puisse exécuter les agents.",
      path: null,
      version: null,
      loggedIn: null,
      authPath,
    });
  }

  const versionProbe = runCodexProbe(bin, ["--version"], 5_000);
  const versionOutput = `${versionProbe.stdout || ""}\n${versionProbe.stderr || ""}`.trim();
  const version = versionOutput.match(/(\d+\.\d+\.\d+)/)?.[1] || versionOutput.split(/\s+/).find(Boolean) || null;
  if (!versionProbe.ok) {
    return finish({
      ready: false,
      state: "error",
      label: "Codex à vérifier",
      detail: "Codex est détecté, mais le test de version échoue.",
      path: bin,
      version,
      loggedIn: null,
      authPath,
      diagnostic: compactProbeError(versionProbe),
    });
  }

  const loginProbe = runCodexProbe(bin, ["login", "status"], 5_000);
  const loginOutput = `${loginProbe.stdout || ""}\n${loginProbe.stderr || ""}`.trim();
  const authFileExists = fs.existsSync(authPath);
  const loggedIn =
    loginProbe.ok ||
    /logged in|connect[eé]|authenticated|chatgpt|api key/i.test(loginOutput) ||
    (!/not logged|not authenticated|login required|no login|not signed/i.test(loginOutput) && authFileExists);

  if (!loggedIn) {
    return finish({
      ready: false,
      state: "login_required",
      label: "Connexion Codex requise",
      detail: "Codex est installé, mais il n'est pas connecté à un compte OpenAI.",
      path: bin,
      version,
      loggedIn: false,
      authPath,
      diagnostic: loginOutput || "codex login status ne confirme pas de session active.",
    });
  }

  return finish({
    ready: true,
    state: "ready",
    label: "Codex prêt",
    detail: "Codex CLI est installé et connecté. Les agents Bridge peuvent tourner sur cet ordinateur.",
    path: bin,
    version,
    loggedIn: true,
    authPath: authFileExists ? authPath : null,
    diagnostic: loginOutput || undefined,
  });
}

function resetCodexStatusCache() {
  codexStatusCache = null;
  return getCodexStatus({ force: true });
}

function buildCodexPath() {
  const home = os.homedir();
  const appData = process.env.APPDATA || (home ? path.join(home, "AppData", "Roaming") : "");
  const localAppData = process.env.LOCALAPPDATA || (home ? path.join(home, "AppData", "Local") : "");
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const extras = [
    "/usr/local/bin",
    "/opt/homebrew/bin",
    home ? path.join(home, ".local", "bin") : null,
    home ? path.join(home, ".npm-global", "bin") : null,
    home ? path.join(home, ".codex", "bin") : null,
    appData ? path.join(appData, "npm") : null,
    localAppData ? path.join(localAppData, "Programs", "nodejs") : null,
    programFiles ? path.join(programFiles, "nodejs") : null,
    programFilesX86 ? path.join(programFilesX86, "nodejs") : null,
  ].filter(Boolean);
  return [process.env.PATH, process.env.Path, ...extras].filter(Boolean).join(path.delimiter);
}

function findCodexExecutable() {
  const enrichedPath = buildCodexPath();
  const which = spawnSync(process.platform === "win32" ? "where" : "which", ["codex"], {
    encoding: "utf8",
    shell: false,
    env: { ...process.env, PATH: enrichedPath, Path: enrichedPath },
    timeout: 3_000,
  });
  if (which.status === 0) {
    const found = String(which.stdout || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (found && fs.existsSync(found)) return found;
  }

  for (const candidate of knownCodexPaths()) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function knownCodexPaths() {
  const home = os.homedir();
  const appData = process.env.APPDATA || (home ? path.join(home, "AppData", "Roaming") : "");
  const localAppData = process.env.LOCALAPPDATA || (home ? path.join(home, "AppData", "Local") : "");
  if (process.platform === "win32") {
    return [
      appData ? path.join(appData, "npm", "codex.cmd") : null,
      appData ? path.join(appData, "npm", "codex.ps1") : null,
      localAppData ? path.join(localAppData, "Programs", "nodejs", "codex.cmd") : null,
      home ? path.join(home, ".local", "bin", "codex.exe") : null,
      home ? path.join(home, ".codex", "bin", "codex.exe") : null,
    ].filter(Boolean);
  }
  return [
    "/usr/local/bin/codex",
    "/opt/homebrew/bin/codex",
    home ? path.join(home, ".local", "bin", "codex") : null,
    home ? path.join(home, ".npm-global", "bin", "codex") : null,
    home ? path.join(home, ".codex", "bin", "codex") : null,
  ].filter(Boolean);
}

function runCodexProbe(bin, args, timeout) {
  const shellForCmd = process.platform === "win32" && /\.(cmd|bat)$/i.test(bin);
  try {
    const res = spawnSync(bin, args, {
      encoding: "utf8",
      shell: shellForCmd,
      env: { ...process.env, PATH: buildCodexPath(), Path: buildCodexPath() },
      timeout,
    });
    return {
      ok: res.status === 0,
      status: res.status,
      stdout: res.stdout || "",
      stderr: res.stderr || "",
      error: res.error?.message || "",
    };
  } catch (err) {
    return {
      ok: false,
      status: null,
      stdout: "",
      stderr: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function compactProbeError(probe) {
  return [probe.error, probe.stderr, probe.stdout]
    .filter(Boolean)
    .join("\n")
    .slice(0, 500);
}

function isStoredSessionInvalid(cfg) {
  return Boolean(cfg.sessionInvalidAt && !cfg.session?.accessToken && !cfg.bridgeToken);
}

function loadConfig() {
  const fallback = defaultConfig();
  try {
    if (!fs.existsSync(CONFIG_PATH)) return fallback;
    const parsed = hydrateSecureBridgeSecrets(JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")));
    return normalizeConfig({ ...fallback, ...parsed });
  } catch {
    return fallback;
  }
}

function saveConfig(next) {
  const cfg = normalizeConfig(next);
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(prepareBridgeConfigForDisk(cfg), null, 2)}\n`, "utf8");
  return cfg;
}

function hydrateSecureBridgeSecrets(input) {
  const secure = input?._secureSecrets;
  if (!secure || secure.version !== 1 || secure.provider !== "electron-safe-storage" || !secure.ciphertext) return input;
  if (!safeStorage?.isEncryptionAvailable()) return input;
  try {
    const payload = JSON.parse(safeStorage.decryptString(Buffer.from(secure.ciphertext, "base64")));
    return {
      ...input,
      bridgeToken: payload.bridgeToken || input.bridgeToken,
      session: input.session || payload.session
        ? {
            provider: input.session?.provider || "supabase-pkce",
            ...(input.session || {}),
            ...(payload.session || {}),
            persisted: input.session?.persisted ?? true,
          }
        : undefined,
    };
  } catch {
    return input;
  }
}

function prepareBridgeConfigForDisk(cfg) {
  const payload = {
    bridgeToken: cfg.bridgeToken,
    session: {
      accessToken: cfg.session?.accessToken,
      refreshToken: cfg.session?.refreshToken,
    },
  };
  const hasSecrets = Boolean(payload.bridgeToken || payload.session.accessToken || payload.session.refreshToken);
  const base = { ...cfg };
  delete base._secureSecrets;
  if (!hasSecrets || !safeStorage?.isEncryptionAvailable()) {
    return Object.fromEntries(Object.entries(base).filter(([, value]) => value !== undefined));
  }

  const persisted = {
    ...base,
    bridgeToken: undefined,
    session: cfg.session
      ? {
          ...cfg.session,
          accessToken: undefined,
          refreshToken: undefined,
          persisted: true,
        }
      : undefined,
    _secureSecrets: {
      version: 1,
      provider: "electron-safe-storage",
      ciphertext: safeStorage.encryptString(JSON.stringify(payload)).toString("base64"),
    },
  };
  return Object.fromEntries(Object.entries(persisted).filter(([, value]) => value !== undefined));
}

function defaultConfig() {
  return normalizeConfig({
    dataDir: DATA_DIR,
    installId: stableInstallId(),
    deviceId: stableInstallId(),
    label: os.hostname(),
    controlPlaneBaseUrl: process.env.BRIDGE_DEFAULT_CONTROL_PLANE_URL || undefined,
    cloudBaseUrl: process.env.BRIDGE_DEFAULT_CONTROL_PLANE_URL || undefined,
    demoMode: process.env.BRIDGE_DEMO_MODE === "1",
    services: [],
    erpBus: {
      enabled: true,
      mode: "typed-actions-events",
      sharedCore: "organization",
      rules: [
        {
          fromServiceId: "crm",
          toServiceId: "purchasing",
          eventType: "core.customer.updated",
          scopes: ["erp:events:publish", "erp:events:consume"],
        },
      ],
    },
  });
}

function normalizeConfig(cfg) {
  const dataDir = cfg.dataDir || DATA_DIR;
  const organizationId = cfg.organizationId || cfg.account?.organizationId;
  const services = pruneLegacyDemoServices(Array.isArray(cfg.services) ? cfg.services : [], cfg);
  return {
    ...cfg,
    dataDir,
    cloudBaseUrl: cfg.controlPlaneBaseUrl || cfg.cloudBaseUrl || process.env.BRIDGE_DEFAULT_CONTROL_PLANE_URL,
    controlPlaneBaseUrl: cfg.controlPlaneBaseUrl || cfg.cloudBaseUrl || process.env.BRIDGE_DEFAULT_CONTROL_PLANE_URL,
    updateBaseUrl: cfg.updateBaseUrl || process.env.BRIDGE_UPDATE_BASE_URL || process.env.BRIDGE_AUTO_UPDATE_URL,
    installId: cfg.installId || stableInstallId(),
    deviceId: cfg.deviceId || cfg.installId || stableInstallId(),
    label: cfg.label || os.hostname(),
    services: services.map((service) => ({
      ...service,
      organizationId: service.organizationId || organizationId || "unknown-org",
      serviceInstanceId: service.serviceInstanceId || `${organizationId || "unknown-org"}:${service.serviceId}`,
      scopes: Array.isArray(service.scopes) ? service.scopes : [],
      actions: Array.isArray(service.actions) ? service.actions : [],
      events: Array.isArray(service.events) ? service.events : [],
      status: service.paused ? "paused" : service.status || "disconnected",
    })),
    erpBus: cfg.erpBus || { enabled: true, mode: "typed-actions-events", sharedCore: "organization", rules: [] },
    demoMode: cfg.demoMode === true || process.env.BRIDGE_DEMO_MODE === "1",
  };
}

function pruneLegacyDemoServices(services, cfg) {
  if (process.env.BRIDGE_ALLOW_DEMO_SERVICES === "1") return services;
  return services.filter((service) => {
    const legacyId = service?.serviceId === "crm" || service?.serviceId === "purchasing";
    const legacyUrl = typeof service?.baseUrl === "string" && service.baseUrl.includes("localhost:3307");
    return !(legacyId && legacyUrl);
  });
}

function stableInstallId() {
  try {
    const p = path.join(path.dirname(CONFIG_PATH), "install-id");
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf8").trim();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const id = cryptoRandomId();
    fs.writeFileSync(p, id, "utf8");
    return id;
  } catch {
    return os.hostname();
  }
}

function cryptoRandomId() {
  return require("node:crypto").randomUUID();
}

function serviceWithDisplayStatus(base, service, codex = getCodexStatus()) {
  const display = resolveServiceDisplayStatus(base, service, codex);
  return {
    ...service,
    status: display.status,
    cloudStatus: display.cloudStatus,
    siteStatus: display.siteStatus,
    statusReason: display.reason,
    bridgeLastActivityAt: display.lastActivityAt,
    bridgeLastActivityAgeSeconds: display.ageSeconds,
  };
}

function resolveServiceDisplayStatus(base, service, codex = getCodexStatus()) {
  const local = localStatuses[service.serviceId];
  const lastActivityAt = latestIso(service.lastSeenAt, base.lastSyncAt);
  const ageSeconds = isoAgeSeconds(lastActivityAt);
  const cloudFresh = typeof ageSeconds === "number" && ageSeconds <= BRIDGE_ONLINE_THRESHOLD_SECONDS;

  if (service.paused || local === "paused") {
    return {
      status: "paused",
      cloudStatus: cloudFresh ? "fresh" : "stale",
      siteStatus: local || "",
      reason: "Service en pause.",
      lastActivityAt,
      ageSeconds,
    };
  }

  if (!localHealthReady) {
    return {
      status: "local_unavailable",
      cloudStatus: cloudFresh ? "fresh" : "stale",
      siteStatus: local || "",
      reason: `Le port local ${HEALTH_PORT} n'est pas prêt. Le site web ne peut pas détecter Bridge.`,
      lastActivityAt,
      ageSeconds,
    };
  }

  if (serviceRequiresCodex(service) && !codex.ready) {
    return {
      status: "codex_unready",
      cloudStatus: cloudFresh ? "fresh" : "stale",
      siteStatus: local || "",
      reason: codex.detail || "Codex n'est pas prêt sur cet ordinateur.",
      lastActivityAt,
      ageSeconds,
    };
  }

  if (local === "active" || local === "reconnecting" || service.status === "active") {
    return {
      status: local === "reconnecting" ? "reconnecting" : "active",
      cloudStatus: cloudFresh ? "fresh" : "stale",
      siteStatus: local || "",
      reason: "Bridge travaille sur ce service.",
      lastActivityAt,
      ageSeconds,
    };
  }

  if (base.controlPlaneConfigured || base.authenticated) {
    if (!lastActivityAt) {
      return {
        status: "cloud_stale",
        cloudStatus: "missing",
        siteStatus: local || "",
        reason: "Aucun heartbeat cloud récent. Clique sur R ou reconnecte le compte Bridge.",
        lastActivityAt,
        ageSeconds,
      };
    }
    if (!cloudFresh) {
      return {
        status: "cloud_stale",
        cloudStatus: "stale",
        siteStatus: local || "",
        reason: `Dernier heartbeat cloud ${formatRelativeAge(lastActivityAt)}. Le site peut afficher Bridge à connecter.`,
        lastActivityAt,
        ageSeconds,
      };
    }
  }

  if (local === "site_unreachable" || local === "disconnected") {
    return {
      status: "site_unreachable",
      cloudStatus: cloudFresh ? "fresh" : "stale",
      siteStatus: "unreachable",
      reason: "Bridge est actif, mais le site du service ne répond pas.",
      lastActivityAt,
      ageSeconds,
    };
  }

  return {
    status: "connected",
    cloudStatus: cloudFresh ? "fresh" : "unknown",
    siteStatus: local || "ok",
    reason: lastActivityAt ? `Bridge vu ${formatRelativeAge(lastActivityAt)}.` : "Bridge local prêt.",
    lastActivityAt,
    ageSeconds,
  };
}

function serviceRequiresCodex(service) {
  const scopes = new Set([
    ...(Array.isArray(service.scopes) ? service.scopes : []),
    ...(Array.isArray(service.requiredScopes) ? service.requiredScopes : []),
    ...(Array.isArray(service.actions)
      ? service.actions.flatMap((action) => Array.isArray(action.requiredScopes) ? action.requiredScopes : [])
      : []),
  ].map((scope) => String(scope)));
  if (scopes.has("bridge:jobs")) return true;
  for (const scope of scopes) {
    if (scope === "codex:run" || scope.startsWith("codex:")) return true;
  }
  return false;
}

function latestIso(...values) {
  let latest = "";
  let latestMs = 0;
  for (const value of values) {
    const ms = Date.parse(String(value || ""));
    if (Number.isFinite(ms) && ms > latestMs) {
      latest = String(value);
      latestMs = ms;
    }
  }
  return latest;
}

function isoAgeSeconds(value) {
  const ms = Date.parse(String(value || ""));
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.max(0, Math.round((Date.now() - ms) / 1000));
}

function formatRelativeAge(value) {
  const seconds = isoAgeSeconds(value);
  if (seconds == null) return "jamais";
  if (seconds < 5) return "à l'instant";
  if (seconds < 60) return `il y a ${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.round(hours / 24);
  return `il y a ${days} j`;
}

async function refreshExternalStatuses() {
  const cfg = loadConfig();
  for (const service of cfg.services) {
    if (service.paused) {
      localStatuses[service.serviceId] = "paused";
      continue;
    }
    if (!service.healthUrl) {
      if (localStatuses[service.serviceId] !== "active" && localStatuses[service.serviceId] !== "reconnecting") {
        delete localStatuses[service.serviceId];
      }
      continue;
    }
    const current = localStatuses[service.serviceId];
    if (current === "active" || current === "reconnecting") continue;
    try {
      const ok = await probe(service.healthUrl);
      if (ok) delete localStatuses[service.serviceId];
      else localStatuses[service.serviceId] = "site_unreachable";
    } catch {
      localStatuses[service.serviceId] = "site_unreachable";
    }
  }
  refreshStatusWindow();
  updateTrayMenu();
}

async function probe(url) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), 2500);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: "no-store" });
    return res.ok;
  } finally {
    clearTimeout(id);
  }
}

async function syncServices() {
  if (runtimeHandle?.syncOnce) {
    await runtimeHandle.syncOnce().catch((err) => {
      bridgeError = err instanceof Error ? err.message : String(err);
    });
    startAutoUpdates({ reconfigure: true });
    pushActivity("Synchronisation demandée.");
    refreshStatusWindow();
    return;
  }

  const cfg = loadConfig();
  if (!cfg.controlPlaneBaseUrl || !cfg.bridgeToken) {
    pushActivity("Mode démo: aucun Control Plane configuré.");
    refreshStatusWindow();
    return;
  }
  try {
    await syncServicesFromControlPlane(cfg);
    startAutoUpdates({ reconfigure: true });
    pushActivity("Services synchronisés.");
    bridgeError = null;
  } catch (err) {
    bridgeError = err instanceof Error ? err.message : String(err);
    pushActivity(`Synchronisation échouée: ${bridgeError}`);
  }
  refreshStatusWindow();
}

async function signIn(input = {}) {
  const controlPlaneBaseUrl = cleanExternalUrl(input.controlPlaneBaseUrl);
  if (!controlPlaneBaseUrl) return { ok: false, error: "URL Bridge entreprise invalide." };

  const email = String(input.email || "").trim();
  const password = String(input.password || "");
  if (!email || !password) return { ok: false, error: "Email et mot de passe requis." };

  localActivity.unshift({ message: "Connexion au compte Bridge...", ts: new Date().toISOString() });
  refreshStatusWindow();

  try {
    const authConfig = await discoverBridgeAuthConfig(controlPlaneBaseUrl, input);
    const session = await supabasePasswordSignIn(authConfig, email, password);
    const cfg = loadConfig();
    cfg.controlPlaneBaseUrl = controlPlaneBaseUrl;
    cfg.cloudBaseUrl = controlPlaneBaseUrl;
    cfg.supabaseUrl = authConfig.supabaseUrl;
    cfg.supabaseAnonKey = authConfig.supabaseAnonKey;
    cfg.session = session;
    delete cfg.sessionInvalidAt;
    cfg.account = {
      userId: session.user?.id || session.user?.sub || email,
      email,
      displayName: session.user?.user_metadata?.name || session.user?.user_metadata?.full_name,
      organizationId: cfg.organizationId || cfg.account?.organizationId || "",
      organizationName: cfg.account?.organizationName,
      role: cfg.account?.role,
    };
    cfg.userId = cfg.account.userId;
    cfg.demoMode = false;
    cfg.services = pruneLegacyDemoServices(cfg.services || [], cfg);
    saveConfig(cfg);

    const synced = await syncServicesFromControlPlane(cfg);
    startAutoUpdates({ reconfigure: true });
    restartRuntime();
    pushActivity(`Compte Bridge connecté: ${email}`);
    return { ok: true, account: synced.account || cfg.account, services: synced.services || cfg.services };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    bridgeError = message;
    pushActivity(`Connexion échouée: ${message}`);
    refreshStatusWindow();
    return { ok: false, error: message };
  }
}

async function discoverBridgeAuthConfig(controlPlaneBaseUrl, input) {
  const providedSupabaseUrl = cleanExternalUrl(input.supabaseUrl);
  const providedAnonKey = String(input.supabaseAnonKey || "").trim();
  if (providedSupabaseUrl && providedAnonKey) {
    return { supabaseUrl: providedSupabaseUrl, supabaseAnonKey: providedAnonKey };
  }

  const res = await fetch(`${controlPlaneBaseUrl.replace(/\/+$/, "")}/bridge/auth/config`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Configuration auth indisponible (${res.status}).`);
  const json = await res.json();
  const supabaseUrl = providedSupabaseUrl || cleanExternalUrl(json.supabaseUrl);
  const supabaseAnonKey = providedAnonKey || String(json.supabaseAnonKey || "").trim();
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error("Le Control Plane ne publie pas encore la configuration Supabase publique.");
  }
  return { supabaseUrl, supabaseAnonKey };
}

async function supabasePasswordSignIn(authConfig, email, password) {
  const res = await fetch(`${authConfig.supabaseUrl.replace(/\/+$/, "")}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: authConfig.supabaseAnonKey,
      authorization: `Bearer ${authConfig.supabaseAnonKey}`,
    },
    body: JSON.stringify({ email, password }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error_description || json.msg || json.error || `Auth HTTP ${res.status}`);
  return {
    provider: "supabase-pkce",
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: json.expires_in ? new Date(Date.now() + Number(json.expires_in) * 1000).toISOString() : undefined,
    persisted: true,
    lastRefreshAt: new Date().toISOString(),
    user: json.user,
  };
}

async function refreshSupabaseSessionIfNeeded(cfg) {
  if (!cfg.session?.refreshToken || !cfg.supabaseUrl || !cfg.supabaseAnonKey) return cfg;
  const expiresAt = cfg.session.expiresAt ? Date.parse(cfg.session.expiresAt) : 0;
  if (expiresAt && expiresAt - Date.now() > 60_000) return cfg;
  const res = await fetch(`${cfg.supabaseUrl.replace(/\/+$/, "")}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: cfg.supabaseAnonKey,
      authorization: `Bearer ${cfg.supabaseAnonKey}`,
    },
    body: JSON.stringify({ refresh_token: cfg.session.refreshToken }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = json.error_description || json.msg || json.error || `Refresh HTTP ${res.status}`;
    if (isInvalidBridgeAuthMessage(message)) {
      clearExpiredBridgeSession(cfg, "Session Bridge expirée. Reconnecte ton compte Bridge.");
      throw new Error("Session Bridge expirée. Reconnecte ton compte Bridge dans l'onglet Identifiants.");
    }
    throw new Error(message);
  }
  cfg.session.accessToken = json.access_token;
  cfg.session.refreshToken = json.refresh_token || cfg.session.refreshToken;
  cfg.session.expiresAt = json.expires_in ? new Date(Date.now() + Number(json.expires_in) * 1000).toISOString() : cfg.session.expiresAt;
  cfg.session.lastRefreshAt = new Date().toISOString();
  saveConfig(cfg);
  return cfg;
}

function isInvalidBridgeAuthMessage(message) {
  return /invalid refresh token|refresh token not found|refresh_token_not_found|token not found|session_id claim in jwt does not exist/i.test(String(message || ""));
}

function clearExpiredBridgeSession(cfg, reason) {
  delete cfg.session;
  delete cfg.bridgeToken;
  cfg.sessionInvalidAt = new Date().toISOString();
  bridgeError = reason;
  saveConfig(cfg);
  runtimeState = null;
  pushActivity(reason);
}

async function syncServicesFromControlPlane(cfg) {
  await refreshSupabaseSessionIfNeeded(cfg);
  const res = await postControlPlane(cfg, "bridge/sync", localStatusPayload());
  if (Array.isArray(res.services)) cfg.services = res.services;
  if (res.account) {
    cfg.account = res.account;
    cfg.userId = res.account.userId;
    cfg.organizationId = res.account.organizationId;
  }
  if (res.erpBus) cfg.erpBus = res.erpBus;
  if (res.updateBaseUrl) cfg.updateBaseUrl = res.updateBaseUrl;
  bridgeError = res.error || null;
  saveConfig(cfg);
  refreshStatusWindow();
  updateTrayMenu();
  return res;
}

async function openService(serviceId) {
  const cfg = loadConfig();
  const service = cfg.services.find((candidate) => candidate.serviceId === serviceId);
  if (!service) return { ok: false, error: "service-not-found" };
  localStatuses[serviceId] = "reconnecting";
  refreshStatusWindow();

  let target = serviceLaunchBaseUrl(service);
  if (!target) return { ok: false, error: "service-url-invalid" };
  try {
    await refreshSupabaseSessionIfNeeded(cfg);
    if (runtimeHandle?.syncOnce) {
      await runtimeHandle.syncOnce().catch((err) => {
        bridgeError = err instanceof Error ? err.message : String(err);
      });
    }
    if (cfg.controlPlaneBaseUrl && (cfg.bridgeToken || cfg.session?.accessToken)) {
      const ticket = await postControlPlane(cfg, "bridge/launch-ticket", {
        serviceId: service.serviceId,
        serviceInstanceId: service.serviceInstanceId,
      });
      if (ticket.launchUrl) {
        const launchUrl = cleanExternalUrl(ticket.launchUrl);
        if (!launchUrl) throw new Error("Launch ticket URL invalide.");
        target = serviceLaunchUrl(service, launchUrl);
      }
    }
    await shell.openExternal(target);
    delete localStatuses[serviceId];
    pushActivity(`${service.name} ouvert.`);
    return { ok: true, launchUrl: target };
  } catch (err) {
    localStatuses[serviceId] = "disconnected";
    const message = err instanceof Error ? err.message : String(err);
    pushActivity(`Ouverture ${service.name} échouée: ${message}`);
    return { ok: false, error: message };
  } finally {
    refreshStatusWindow();
  }
}

function serviceLaunchBaseUrl(service) {
  if (service.serviceId === "achat") return "https://achat.rossinienergy.yaka-bridge.com";
  return cleanExternalUrl(service.baseUrl);
}

function serviceLaunchUrl(service, launchUrl) {
  if (service.serviceId !== "achat") return launchUrl;
  try {
    const parsed = new URL(launchUrl);
    if (parsed.hostname === "rossinienergy.yaka-bridge.com") {
      parsed.hostname = "achat.rossinienergy.yaka-bridge.com";
      return parsed.toString();
    }
  } catch {
    // Garde l'URL de base du service si le ticket est malformé.
  }
  return launchUrl;
}

async function postControlPlane(cfg, route, payload) {
  const url = `${String(cfg.controlPlaneBaseUrl).replace(/\/+$/, "")}/${route.replace(/^\/+/, "")}`;
  const headers = {
    "content-type": "application/json",
    "x-bridge-protocol-version": String(PROTOCOL_VERSION),
    "x-bridge-organization-id": cfg.organizationId || cfg.account?.organizationId || "",
    "x-bridge-id": cfg.bridgeId || "",
    "x-bridge-install-id": cfg.installId || "",
    "x-bridge-device-id": cfg.deviceId || "",
    "x-bridge-user-id": cfg.userId || cfg.account?.userId || "",
    "x-bridge-token": cfg.bridgeToken || "",
  };
  if (cfg.session?.accessToken) headers.authorization = `Bearer ${cfg.session.accessToken}`;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      organizationId: cfg.organizationId || cfg.account?.organizationId,
      bridgeId: cfg.bridgeId,
      installId: cfg.installId,
      deviceId: cfg.deviceId,
      userId: cfg.userId || cfg.account?.userId,
      sentAt: new Date().toISOString(),
      payload,
    }),
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    if (res.status === 401 && cfg.session?.accessToken) {
      clearExpiredBridgeSession(cfg, "Session Bridge expirée. Reconnecte ton compte Bridge.");
    }
    throw new Error(`${route} HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

function signOut() {
  const cfg = loadConfig();
  delete cfg.account;
  delete cfg.session;
  delete cfg.userId;
  cfg.organizationId = undefined;
  cfg.services = [];
  saveConfig(cfg);
  restartRuntime();
  pushActivity("Compte Bridge déconnecté.");
  refreshStatusWindow();
}

function restartRuntime() {
  try {
    runtimeHandle?.stop?.();
  } catch {
    // no-op
  }
  runtimeHandle = null;
  runtimeState = null;
  startRuntimeIfAvailable();
}

function revealDataDir() {
  ensureDirs();
  return shell.openPath(DATA_DIR);
}

function pushActivity(message) {
  localActivity.unshift({ message, ts: new Date().toISOString() });
  localActivity = localActivity.slice(0, 30);
}

function showStatusWindow() {
  if (statusWindow && !statusWindow.isDestroyed()) {
    statusWindow.show();
    statusWindow.focus();
    refreshStatusWindow();
    return;
  }
  statusWindow = new BrowserWindow({
    width: 760,
    height: 560,
    minWidth: 680,
    minHeight: 480,
    title: PRODUCT_NAME,
    resizable: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "bridge-preload.cjs"),
    },
  });
  if (!ipcRegistered) {
    ipcRegistered = true;
    ipcMain.handle("bridge:get-status", () => localStatusPayload());
    ipcMain.handle("bridge:sync", () => syncServices());
    ipcMain.handle("bridge:sign-in", (_event, input) => signIn(input));
    ipcMain.handle("bridge:open-service", (_event, serviceId) => openService(serviceId));
    ipcMain.handle("bridge:reconnect-service", (_event, serviceId) => openService(serviceId));
    ipcMain.handle("bridge:refresh-codex", () => {
      const codex = resetCodexStatusCache();
      refreshStatusWindow();
      updateTrayMenu();
      return codex;
    });
    ipcMain.handle("bridge:open-codex-help", () => shell.openExternal("https://help.openai.com/en/articles/11381614-api-codex-cli-and-sign-in-with-chatgpt"));
    ipcMain.handle("bridge:sign-out", () => signOut());
    ipcMain.handle("bridge:reveal-data-dir", () => revealDataDir());
  }
  statusWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(statusHtml())}`);
}

function refreshStatusWindow() {
  if (!statusWindow || statusWindow.isDestroyed()) return;
  statusWindow.webContents.send("bridge:status", localStatusPayload());
}

function statusHtml() {
  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Bridge</title>
  <style>
    * { box-sizing: border-box; }
    :root { color-scheme: light; --bg:#f7f7f4; --fg:#171716; --muted:#6f726d; --line:#d9d9d2; --panel:#ffffff; --green:#1e8f56; --grey:#9b9f98; --amber:#ba7a18; --blue:#2b63a8; --red:#b34236; }
    body { margin: 0; min-height: 100vh; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--fg); }
    main { display: grid; grid-template-rows: auto auto 1fr; min-height: 100vh; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 18px 22px 14px; border-bottom: 1px solid var(--line); background: #fbfbf8; }
    .brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
    .mark { width: 34px; height: 34px; flex: 0 0 auto; display: block; }
    h1 { font-size: 18px; line-height: 1.1; margin: 0; letter-spacing: 0; }
    .subtitle { color: var(--muted); font-size: 12px; margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .top-actions { display: flex; gap: 8px; align-items: center; }
    .status-pill { display: inline-flex; align-items: center; gap: 6px; min-height: 28px; border: 1px solid var(--line); border-radius: 999px; background: #fff; padding: 4px 9px; font-size: 12px; font-weight: 700; color: var(--muted); white-space: nowrap; }
    .status-pill::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--grey); }
    .status-pill.ready { color: var(--green); border-color: #b8ddc7; background: #f4fbf7; }
    .status-pill.ready::before { background: var(--green); }
    .status-pill.warning { color: var(--amber); border-color: #ead7bb; background: #fffaf1; }
    .status-pill.warning::before { background: var(--amber); }
    .status-pill.version::before { display: none; }
    button { border: 1px solid var(--line); border-radius: 7px; background: #fff; color: var(--fg); padding: 8px 10px; font-size: 13px; font-weight: 650; cursor: pointer; min-height: 34px; }
    button:hover { border-color: #b9bbb3; }
    button:disabled { opacity: .55; cursor: progress; }
    button.primary { background: #171716; color: #fff; border-color: #171716; }
    button.icon { width: 34px; padding: 0; display: grid; place-items: center; }
    nav { display: flex; gap: 4px; padding: 10px 22px 0; background: #fbfbf8; }
    nav button { border-color: transparent; background: transparent; color: var(--muted); min-height: 32px; }
    nav button.active { color: var(--fg); background: #e8e8e1; border-color: #d0d0c8; }
    section { display: none; padding: 18px 22px 22px; overflow: auto; }
    section.active { display: block; }
    .services { display: grid; gap: 8px; }
    .login-hero { min-height: 320px; display: grid; align-content: center; justify-content: center; }
    .login-hero .login-form { width: min(460px, calc(100vw - 64px)); }
    .login-hero .codex-card { width: min(460px, calc(100vw - 64px)); margin-top: 10px; }
    .codex-card { display: grid; grid-template-columns: 18px 1fr auto; gap: 12px; align-items: center; border: 1px solid var(--line); background: #fff; border-radius: 8px; padding: 12px; }
    .codex-card .codex-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
    .codex-card.ready { border-color: #cfe6d7; background: #fbfffc; }
    .codex-card.missing, .codex-card.login_required, .codex-card.error { border-color: #ead7bb; background: #fffaf1; }
    .codex-card.ready .dot { background: var(--green); box-shadow: 0 0 0 4px #e2f2e8; }
    .codex-card.missing .dot, .codex-card.login_required .dot, .codex-card.error .dot { background: var(--amber); box-shadow: 0 0 0 4px #f6eddc; }
    .codex-card code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--fg); background: #f0f0ea; padding: 2px 4px; border-radius: 4px; }
    .service-row { display: grid; grid-template-columns: 18px 1fr auto; gap: 12px; align-items: center; border: 1px solid var(--line); background: var(--panel); border-radius: 8px; padding: 12px; min-height: 72px; position: relative; overflow: hidden; }
    .service-row.active::before, .service-row.reconnecting::before { content:""; position:absolute; left:-30%; right:-30%; bottom:0; height:2px; background: linear-gradient(90deg, transparent, var(--blue), transparent); animation: move 1.15s linear infinite; }
    @keyframes move { from { transform: translateX(-30%); } to { transform: translateX(30%); } }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--grey); box-shadow: 0 0 0 4px #ecece8; }
    .connected .dot { background: var(--green); box-shadow: 0 0 0 4px #e2f2e8; }
    .service-row.active .dot, .service-row.reconnecting .dot { background: var(--blue); box-shadow: 0 0 0 4px #e3edf9; }
    .service-row.paused .dot { background: var(--grey); }
    .service-row.cloud_stale .dot { background: var(--amber); box-shadow: 0 0 0 4px #f6eddc; }
    .service-row.disconnected .dot { background: var(--red); box-shadow: 0 0 0 4px #f5e6e3; }
    .service-row.site_unreachable .dot { background: var(--red); box-shadow: 0 0 0 4px #f5e6e3; }
    .service-row.local_unavailable .dot { background: var(--red); box-shadow: 0 0 0 4px #f5e6e3; }
    .service-row.codex_unready .dot { background: var(--amber); box-shadow: 0 0 0 4px #f6eddc; }
    .service-main { min-width: 0; }
    .service-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .service-title strong { font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .state { color: var(--muted); font-size: 12px; text-transform: lowercase; }
    .meta { color: var(--muted); font-size: 12px; margin-top: 5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .service-actions { display: flex; gap: 8px; align-items: center; }
    .grid { display: grid; gap: 12px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .panel { border: 1px solid var(--line); background: var(--panel); border-radius: 8px; padding: 14px; }
    .panel h2 { font-size: 13px; margin: 0 0 10px; }
    .login-form { display: grid; gap: 10px; margin-bottom: 12px; }
    .login-form label { display: grid; gap: 5px; color: var(--muted); font-size: 12px; }
    .login-form input { width: 100%; border: 1px solid var(--line); border-radius: 7px; min-height: 34px; padding: 7px 9px; font: inherit; color: var(--fg); background: #fff; }
    .login-form details { border: 1px solid var(--line); border-radius: 7px; padding: 8px; display: grid; gap: 8px; }
    .login-form summary { cursor: pointer; color: var(--muted); font-size: 12px; }
    .form-message { min-height: 18px; margin: 0; color: var(--red); font-size: 12px; }
    .kv { display: grid; grid-template-columns: 130px minmax(0, 1fr); gap: 8px; color: var(--muted); font-size: 12px; }
    .kv strong { color: var(--fg); font-weight: 600; overflow-wrap: anywhere; }
    .activity { display: grid; gap: 8px; }
    .activity-row { display: grid; grid-template-columns: 82px 1fr; gap: 10px; border-bottom: 1px solid var(--line); padding: 8px 0; font-size: 12px; color: var(--muted); }
    .activity-row strong { color: var(--fg); font-weight: 550; }
    .empty { color: var(--muted); font-size: 13px; padding: 18px 0; }
    .error { color: var(--red); font-size: 12px; margin-top: 8px; }
  </style>
</head>
<body>
  <main>
    <header>
      <div class="brand">${bridgeLogoSvg("mark")}<div><h1>Bridge</h1><div class="subtitle" id="subtitle"></div></div></div>
      <div class="top-actions"><span class="status-pill version" id="version-pill"></span><span class="status-pill" id="codex-pill"></span><button class="icon" id="sync" title="Synchroniser" aria-label="Synchroniser">R</button><button id="folder">Dossier</button></div>
    </header>
    <nav>
      <button data-tab="bridges" class="active">Bridges</button>
      <button data-tab="identity">Identifiants</button>
      <button data-tab="activity">Activité</button>
    </nav>
    <section id="bridges" class="active"><div class="services" id="services"></div><p class="error" id="error"></p></section>
    <section id="identity"><div id="login-panel"></div><div class="grid" id="identity-grid"></div></section>
    <section id="activity"><div class="activity" id="activity-list"></div></section>
  </main>
  <script>
    let current = null;
    const labels = { connected: "connecté", paused: "pause", reconnecting: "connexion", active: "actif", disconnected: "hors ligne", codex_unready: "codex à connecter", site_unreachable: "site inaccessible", cloud_stale: "à vérifier", local_unavailable: "local indisponible" };
    const codexLabels = { ready: "prêt", missing: "à installer", login_required: "connexion requise", error: "à vérifier", unknown: "inconnu" };
    function esc(value) { return String(value == null ? "" : value).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c])); }
    function render(state) {
      current = state;
      document.getElementById("subtitle").textContent = (state.account?.email || "Compte Bridge non connecté") + " · " + state.services.length + " service(s)";
      const versionPill = document.getElementById("version-pill");
      versionPill.textContent = "v" + (state.version || "dev");
      const codexPill = document.getElementById("codex-pill");
      const codexState = state.codex?.state || "unknown";
      codexPill.textContent = "Codex " + (codexLabels[codexState] || codexState);
      codexPill.className = "status-pill " + (state.codex?.ready ? "ready" : "warning");
      document.getElementById("error").textContent = state.bridgeError || state.lastError || "";
      const services = document.getElementById("services");
      if (!state.authenticated) {
        ensureLoginHero(state);
      } else {
        services.innerHTML = codexCard(state.codex) + (state.services.length ? state.services.map(service => {
        const status = service.status || "disconnected";
        const scopes = (service.scopes || []).slice(0, 3).join(" · ");
        const meta = service.statusReason || (status === "local_unavailable"
          ? "Le port local 7707 n'est pas prêt. Le site web ne peut pas encore détecter Bridge."
          : (scopes || service.baseUrl));
        const actionLabel = status === "active" || status === "reconnecting"
          ? "Ouverture..."
          : status === "connected"
            ? "Ouvrir"
            : status === "codex_unready"
              ? "Configurer Codex"
            : status === "cloud_stale"
              ? "Reconnecter"
            : service.lastSeenAt
              ? "Reconnecter"
              : "Connecter";
        const actionAttr = status === "codex_unready" ? 'data-codex-help="1"' : 'data-open="' + esc(service.serviceId) + '"';
        return '<article class="service-row ' + esc(status) + '">' +
          '<span class="dot" aria-hidden="true"></span>' +
          '<div class="service-main"><div class="service-title"><strong>' + esc(service.name) + '</strong><span class="state">' + esc(labels[status] || status) + '</span></div>' +
          '<div class="meta">' + esc(meta) + '</div></div>' +
          '<div class="service-actions"><button ' + actionAttr + ' class="primary">' + esc(actionLabel) + '</button></div>' +
        '</article>';
      }).join("") : '<p class="empty">Aucun service autorisé.</p>');
        services.querySelectorAll("[data-open]").forEach(btn => btn.addEventListener("click", () => window.bridge.openService(btn.dataset.open)));
        attachCodexActions(services);
      }

      const account = state.account || {};
      const loginPanel = document.getElementById("login-panel");
      if (state.authenticated) loginPanel.innerHTML = "";
      else ensureLoginPanel(loginPanel, "identity", state);
      attachLoginForms();
      document.getElementById("identity-grid").innerHTML =
        panel("Compte", [
          ["Email", account.email || "Non connecté"],
          ["Organisation", account.organizationName || state.organizationId || "Aucune"],
          ["Rôle", account.role || "-"],
          ["Session", state.authenticated ? "persistante" : "non connectée"]
        ]) +
        panel("Appareil", [
          ["Nom", state.label || ""],
          ["Device", state.deviceId || ""],
          ["Install", state.installId || ""],
          ["Données", state.dataDir || ""]
        ]) +
        panel("Accès", [
          ["Services", String(state.services.length)],
          ["Bus ERP", state.erpBus?.enabled ? "actif" : "inactif"],
          ["Jobs actifs", String(state.activeJobs || 0)],
          ["Protocole", String(state.protocolVersion || 2)]
        ]) +
        codexIdentityPanel(state.codex) +
        (state.authenticated ? '<div class="panel"><h2>Session</h2><button id="signout">Déconnecter</button></div>' : "");
      document.getElementById("signout")?.addEventListener("click", () => window.bridge.signOut());
      attachCodexActions(document);

      const activity = state.activity || [];
      document.getElementById("activity-list").innerHTML = activity.length ? activity.map(item =>
        '<div class="activity-row"><span>' + new Date(item.ts).toLocaleTimeString("fr-FR") + '</span><strong>' + esc(item.message) + '</strong></div>'
      ).join("") : '<p class="empty">Aucune activité récente.</p>';
    }
    function codexCard(codex = {}) {
      const state = codex.state || "unknown";
      const version = codex.version ? " · " + codex.version : "";
      const command = state === "missing"
        ? (codex.installCommand || "npm install -g @openai/codex") + "\\n" + (codex.loginCommand || "codex login")
        : (codex.loginCommand || "codex login");
      const action = codex.ready
        ? '<button data-codex-refresh="1">Tester Codex</button>'
        : '<button data-codex-copy="' + esc(command) + '">Copier commande</button><button data-codex-help="1">Aide Codex</button><button data-codex-refresh="1">Tester</button>';
      return '<article class="codex-card ' + esc(state) + '">' +
        '<span class="dot" aria-hidden="true"></span>' +
        '<div class="service-main"><div class="service-title"><strong>Codex</strong><span class="state">' + esc(codexLabels[state] || state) + esc(version) + '</span></div>' +
        '<div class="meta">' + esc(codex.detail || "Statut Codex non vérifié.") + '</div></div>' +
        '<div class="codex-actions">' + action + '</div>' +
      '</article>';
    }
    function codexIdentityPanel(codex = {}) {
      return panel("Codex", [
        ["État", codex.label || "Non vérifié"],
        ["Version", codex.version || "-"],
        ["Chemin", codex.path || "-"],
        ["Session", codex.loggedIn === true ? "connectée" : codex.loggedIn === false ? "à connecter" : "-"]
      ]);
    }
    function attachCodexActions(root) {
      root.querySelectorAll("[data-codex-refresh]").forEach((btn) => {
        if (btn.dataset.bound === "1") return;
        btn.dataset.bound = "1";
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          await window.bridge.refreshCodex();
          btn.disabled = false;
        });
      });
      root.querySelectorAll("[data-codex-help]").forEach((btn) => {
        if (btn.dataset.bound === "1") return;
        btn.dataset.bound = "1";
        btn.addEventListener("click", () => window.bridge.openCodexHelp());
      });
      root.querySelectorAll("[data-codex-copy]").forEach((btn) => {
        if (btn.dataset.bound === "1") return;
        btn.dataset.bound = "1";
        btn.addEventListener("click", async () => {
          await navigator.clipboard?.writeText?.(btn.dataset.codexCopy || "");
          btn.textContent = "Copié";
          setTimeout(() => { btn.textContent = "Copier commande"; }, 1500);
        });
      });
    }
    function ensureLoginHero(state) {
      const services = document.getElementById("services");
      if (services.querySelector("#login-form-main")) return;
      services.innerHTML = '<div class="login-hero">' + loginForm("main", state, readLoginDraft()) + codexCard(state.codex) + '</div>';
      attachCodexActions(services);
    }
    function ensureLoginPanel(container, suffix, state) {
      if (container.querySelector("#login-form-" + suffix)) return;
      container.innerHTML = loginForm(suffix, state, readLoginDraft());
    }
    function readLoginDraft() {
      const form = document.activeElement?.closest?.(".login-form") || document.querySelector(".login-form");
      if (!form) return {};
      const values = Object.fromEntries(new FormData(form).entries());
      return {
        controlPlaneBaseUrl: values.controlPlaneBaseUrl || "",
        email: values.email || "",
        password: values.password || "",
        supabaseUrl: values.supabaseUrl || "",
        supabaseAnonKey: values.supabaseAnonKey || "",
        activeName: form.contains(document.activeElement) ? document.activeElement?.getAttribute("name") : "",
        selectionStart: form.contains(document.activeElement) ? document.activeElement?.selectionStart : null,
        selectionEnd: form.contains(document.activeElement) ? document.activeElement?.selectionEnd : null,
      };
    }
    function restoreLoginFocus(draft) {
      if (!draft.activeName) return;
      const input = document.querySelector('.login-form [name="' + draft.activeName + '"]');
      if (!input) return;
      input.focus();
      if (draft.selectionStart != null && draft.selectionEnd != null && typeof input.setSelectionRange === "function") {
        try { input.setSelectionRange(draft.selectionStart, draft.selectionEnd); } catch {}
      }
    }
    function loginForm(suffix, state, draft = {}) {
      const url = draft.controlPlaneBaseUrl || state.controlPlaneBaseUrl || "";
      return '<form id="login-form-' + esc(suffix) + '" class="panel login-form">' +
        '<h2>Compte Bridge</h2>' +
        '<label>URL Bridge entreprise<input name="controlPlaneBaseUrl" type="url" value="' + esc(url) + '" placeholder="https://rossinienergy.yaka-bridge.com" required /></label>' +
        '<label>Email<input name="email" type="email" value="' + esc(draft.email || "") + '" autocomplete="username" required /></label>' +
        '<label>Mot de passe<input name="password" type="password" value="' + esc(draft.password || "") + '" autocomplete="current-password" required /></label>' +
        '<details><summary>Configuration avancée</summary>' +
          '<label>URL Supabase<input name="supabaseUrl" type="url" value="' + esc(draft.supabaseUrl || "") + '" placeholder="https://api.customer.example" /></label>' +
          '<label>Clé publique Supabase<input name="supabaseAnonKey" type="password" value="' + esc(draft.supabaseAnonKey || "") + '" /></label>' +
        '</details>' +
        '<button class="primary" type="submit">Se connecter</button>' +
        '<p class="form-message" id="login-message-' + esc(suffix) + '"></p>' +
      '</form>';
    }
    function attachLoginForms() {
      document.querySelectorAll(".login-form").forEach((form) => {
        if (form.dataset.bound === "1") return;
        form.dataset.bound = "1";
        form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const button = form.querySelector("button");
        const message = form.querySelector(".form-message");
        if (button) button.disabled = true;
        if (message) message.textContent = "Connexion...";
        const values = Object.fromEntries(new FormData(form).entries());
        const res = await window.bridge.signIn(values);
        if (!res?.ok && message) message.textContent = res?.error || "Connexion impossible.";
        if (button) button.disabled = false;
      });
      });
    }
    function panel(title, rows) {
      return '<div class="panel"><h2>' + esc(title) + '</h2><div class="kv">' + rows.map(([k,v]) => '<span>' + esc(k) + '</span><strong>' + esc(v) + '</strong>').join("") + '</div></div>';
    }
    document.querySelectorAll("nav button").forEach(btn => btn.addEventListener("click", () => {
      document.querySelectorAll("nav button").forEach(b => b.classList.toggle("active", b === btn));
      document.querySelectorAll("section").forEach(s => s.classList.toggle("active", s.id === btn.dataset.tab));
    }));
    document.getElementById("sync").addEventListener("click", () => window.bridge.sync());
    document.getElementById("folder").addEventListener("click", () => window.bridge.revealDataDir());
    window.bridge.onStatus(render);
    window.bridge.getStatus().then(render);
  </script>
</body>
</html>`;
}

function cleanExternalUrl(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const localHttp = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    if (url.protocol !== "https:" && !localHttp) return null;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function bridgeLogoSvg(className = "") {
  return `<svg class="${escapeHtmlAttr(className)}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img" aria-label="Bridge">
    <rect width="1024" height="1024" rx="224" fill="#F6F1E8"/>
    <path d="M322 516h380" fill="none" stroke="#2A211B" stroke-width="54" stroke-linecap="round"/>
    <path d="M500 360v312" fill="none" stroke="#2A211B" stroke-width="42" stroke-linecap="round"/>
    <rect x="238" y="376" width="172" height="172" rx="54" fill="#2A211B"/>
    <rect x="614" y="476" width="172" height="172" rx="54" fill="#C96442"/>
    <circle cx="500" cy="516" r="58" fill="#F6F1E8" stroke="#2A211B" stroke-width="42"/>
  </svg>`;
}

function escapeHtmlAttr(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}
