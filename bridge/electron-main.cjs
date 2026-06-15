const { app, BrowserWindow, Menu, nativeImage, shell, Tray, ipcMain, safeStorage, dialog, clipboard, globalShortcut, screen } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const { createServer } = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const {
  runCodexSetup,
  runBridgeSetup,
  runLocalAiSetup,
  runVoiceSetup,
  ensureCodexFileStore,
  findCodexBin: findInstalledCodexBin,
  findLmsBin,
  findLmStudioApp,
  probeLmStudioModels,
  startLmStudioServer,
  isVoiceModelInstalled,
  voiceModelPath,
} = require("./provider-setup.cjs");
const { bridgeDesignCss, loadBridgeDesign } = require("./theme.cjs");

let autoUpdater = null;
try {
  ({ autoUpdater } = require("electron-updater"));
} catch {
  autoUpdater = null;
}

process.env.APP_BRIDGE_ELECTRON = "1";
process.env.APP_BRIDGE_VERSION = process.env.APP_BRIDGE_VERSION || app.getVersion();

const PRODUCT_NAME = "Bridge";
app.setName(PRODUCT_NAME);
const PROTOCOL_VERSION = 2;
const DEFAULT_AI_POLICY = {
  localAi: {
    enabled: false,
    installRequired: false,
    provider: "lmstudio",
    model: "ibm/granite-4-micro",
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
};
const HEALTH_PORT = Number(process.env.BRIDGE_HEALTH_PORT || process.env.APP_BRIDGE_HEALTH_PORT || "7707") || 7707;
const BRIDGE_ONLINE_THRESHOLD_SECONDS =
  Number(process.env.BRIDGE_ONLINE_THRESHOLD_SECONDS || "90") || 90;
const SUPABASE_REFRESH_MARGIN_MS =
  Number(process.env.BRIDGE_SUPABASE_REFRESH_MARGIN_MS || 10 * 60 * 1000) || 10 * 60 * 1000;
const CONFIG_PATH =
  process.env.BRIDGE_CONFIG ||
  process.env.APP_BRIDGE_CONFIG ||
  path.join(os.homedir(), ".bridge", "config.json");
const DATA_DIR =
  process.env.BRIDGE_DATA_DIR ||
  process.env.APP_DATA_DIR ||
  path.join(os.homedir(), PRODUCT_NAME, "data");
const USER_DATA_DIR =
  process.env.BRIDGE_USER_DATA_DIR ||
  process.env.APP_BRIDGE_USER_DATA_DIR ||
  path.join(os.homedir(), PRODUCT_NAME, "electron-profile");

try {
  app.setName(PRODUCT_NAME);
  app.setPath("userData", USER_DATA_DIR);
} catch {
  // Keep startup resilient even if Electron rejects a path override.
}

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
let cloudHeartbeatInterval = null;
let cloudHeartbeatInFlight = false;
let updateDownloaded = false;
let codexStatusCache = null;
let codexStatusProbeRunning = false;
let lastCodexStatusRefreshMs = 0;
let localAiStatusCache = null;
let localAiStatusProbeRunning = false;
let lastLocalAiStatusRefreshMs = 0;
let pendingBrowserSession = null;
let lastConfigSnapshot = null;
let protocolLaunchHandled = false;
let lastProtocolLaunchAt = 0;
let adminProvisioningRunning = false;
let adminProvisioningScheduled = false;
let requiredProvisioningWindowVisible = false;
let lastAdminProvisioningPromptAt = 0;
let revealStatusAfterProvisioning = false;
let voiceProcess = null;
let voiceShortcutProcess = null;
let voiceStdoutBuffer = "";
let voiceShortcutStdoutBuffer = "";
let voiceShortcutRetryTimer = null;
let voicePending = [];
let voiceRecording = null;
let voiceBusy = false;
let voiceShortcutError = "";
let voiceShortcutValue = "";
let voiceShortcutMode = "";
let voiceShortcutElectronAccelerator = "";
let lastVoiceShortcutEventAt = 0;
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
  app.on("second-instance", (_event, argv) => {
    const handledProtocol = handleProtocolArgs(argv);
    if (!handledProtocol) showStatusWindow({ focus: true });
    syncServices();
  });
}

app.on("open-url", (event, url) => {
  event.preventDefault();
  handleProtocolUrl(url);
  hideStatusWindowAfterLaunch();
  syncServices();
});

app.on("before-quit", () => {
  isQuitting = true;
  try {
    runtimeHandle?.stop?.();
    voiceProcess?.kill?.();
    stopVoiceShortcutWatcher();
    localHealthServer?.close();
    if (autoUpdateInterval) clearInterval(autoUpdateInterval);
    if (cloudHeartbeatInterval) clearInterval(cloudHeartbeatInterval);
  } catch {
    // no-op
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && isQuitting) app.quit();
});

app.whenReady().then(() => {
  ensureDirs();
  startLocalHealthServer();
  setImmediate(() => {
    const launchedByProtocol = handleProtocolArgs(process.argv) || protocolLaunchHandled;
    registerBridgeProtocol();
    createTray();
    if (!launchedByProtocol) showStatusWindow({ focus: true });
    startRuntimeIfAvailable();
    startAutoUpdates();
    startCloudHeartbeat();
    refreshExternalStatuses();
    scheduleLocalAiStatusRefresh();
    scheduleCodexStatusRefresh();
    scheduleStartupAdminProvisioning();
    setInterval(refreshExternalStatuses, 15_000);
    setInterval(scheduleLocalAiStatusRefresh, 15_000);
  });
});

app.on("activate", () => {
  if (Date.now() - lastProtocolLaunchAt < 8_000) {
    hideStatusWindowAfterLaunch();
    return;
  }
  showStatusWindow({ focus: true });
});

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
  const feedUrl = updateFeedBaseUrl(loadConfig({ hydrateSecrets: false }));
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

  autoUpdater.autoDownload = process.env.BRIDGE_AUTO_DOWNLOAD_UPDATES !== "0";
  autoUpdater.autoInstallOnAppQuit = process.env.BRIDGE_AUTO_INSTALL_ON_QUIT === "1";
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
    pushActivity("Mise à jour Bridge téléchargée. Elle sera installée sur action utilisateur, jamais en plein travail.");
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

function currentBridgeVersion() {
  return process.env.APP_BRIDGE_VERSION || app.getVersion() || "dev";
}

function compareSemverLike(a, b) {
  const left = String(a || "").match(/\d+/g)?.map(Number) || [];
  const right = String(b || "").match(/\d+/g)?.map(Number) || [];
  if (!left.length || !right.length) return 0;
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function bridgeUpdateRequired(cfg = loadConfig({ hydrateSecrets: false })) {
  return Boolean(cfg.minimumVersion && compareSemverLike(currentBridgeVersion(), cfg.minimumVersion) < 0);
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
  if (process.env.BRIDGE_AUTO_INSTALL_UPDATES !== "1") {
    setUpdateState("downloaded");
    return;
  }
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
  if (supabaseUrl) return `${supabaseUrl}/storage/v1/object/public/bridge-updates`;
  const controlPlane = cleanExternalUrl(cfg.controlPlaneBaseUrl || cfg.cloudBaseUrl);
  if (controlPlane) {
    return null;
  }
  return null;
}

function handleProtocolArgs(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const target = args.find((arg) => typeof arg === "string" && arg.startsWith("bridge://"));
  return target ? handleProtocolUrl(target) : false;
}

function handleProtocolUrl(rawUrl) {
  if (!rawUrl) return false;
  let parsed;
  try {
    parsed = new URL(String(rawUrl));
  } catch {
    return false;
  }
  if (parsed.protocol !== "bridge:") return false;
  protocolLaunchHandled = true;
  lastProtocolLaunchAt = Date.now();
  const browserSessionId = parsed.searchParams.get("browserSessionId") || "";
  const returnUrl = parsed.searchParams.get("returnUrl") || "";
  const requestedServiceId = serviceIdFromProtocolUrl(parsed, returnUrl);
  if (browserSessionId) {
    pendingBrowserSession = {
      browserSessionId: String(browserSessionId).slice(0, 160),
      returnUrl: String(returnUrl || "").slice(0, 600),
      receivedAt: new Date().toISOString(),
      attempts: 0,
    };
    revealStatusAfterProvisioning = true;
    pushActivity("Rendez-vous navigateur reçu.");
    void flushPendingBrowserSession();
  }
  if (requestedServiceId) {
    pushActivity(`Ouverture demandée par le navigateur: ${requestedServiceId}.`);
    void openService(requestedServiceId, { browserSessionId, returnUrl, fromProtocol: true });
  }
  if (browserSessionId) {
    setTimeout(hideStatusWindowAfterLaunch, 150);
    setTimeout(hideStatusWindowAfterLaunch, 900);
  } else {
    setTimeout(() => showStatusWindow({ focus: false }), 0);
  }
  return true;
}

function serviceIdFromProtocolUrl(parsed, returnUrl) {
  const explicit = String(parsed.searchParams.get("serviceId") || "").trim();
  const cfg = loadConfig({ hydrateSecrets: false });
  if (explicit && cfg.services.some((service) => service.serviceId === explicit)) return explicit;
  let target = null;
  try {
    target = returnUrl ? new URL(returnUrl) : null;
  } catch {
    target = null;
  }
  if (!target) return "";
  return cfg.services.find((service) => {
    try {
      const serviceUrl = new URL(service.baseUrl || service.healthUrl || "");
      return serviceUrl.hostname === target.hostname;
    } catch {
      return false;
    }
  })?.serviceId || "";
}

async function flushPendingBrowserSession() {
  if (!pendingBrowserSession) return;
  const current = pendingBrowserSession;
  current.attempts = Number(current.attempts || 0) + 1;
  const cfg = loadConfig();
  if (!cfg.controlPlaneBaseUrl || (!cfg.bridgeToken && !cfg.session?.accessToken)) {
    if (current.attempts <= 5) {
      setTimeout(() => void flushPendingBrowserSession(), 1200);
    } else {
      pushActivity("Rendez-vous navigateur reçu, mais Bridge n'est pas connecté au cloud.");
    }
    return;
  }
  try {
    await postControlPlane(cfg, "bridge/browser-session", {
      browserSessionId: current.browserSessionId,
      returnUrl: current.returnUrl,
      state: localStatusPayload(),
    });
    if (pendingBrowserSession === current) pendingBrowserSession = null;
    pushActivity("Rendez-vous navigateur confirmé au cloud.");
    hideStatusWindowAfterLaunch();
    refreshStatusWindow();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (current.attempts <= 5 && /unauthorized|401|session|token|configuration|not-configured/i.test(message)) {
      setTimeout(() => void flushPendingBrowserSession(), 1200);
      return;
    }
    pushActivity(`Rendez-vous navigateur refusé: ${message}`);
  }
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
  tray.on("click", () => showStatusWindow({ focus: true }));
  updateTrayMenu();
}

function updateTrayMenu() {
  updateApplicationMenu();
  if (!tray) return;
  const state = localStatusPayload();
  const connectedCount = state.services.filter((service) => service.status === "connected" || service.status === "active").length;
  const codexLabel = state.codex?.ready ? "ChatGPT Codex prêt" : `ChatGPT Codex: ${state.codex?.label || "à vérifier"}`;
  const localAiLabel = state.localAi?.ready ? "Moteur local prêt" : `Préparer le moteur local`;
  const voiceLabel = state.voice?.ready ? "Push-to-talk prêt" : "Préparer le push-to-talk";
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Afficher Bridge", click: () => showStatusWindow({ focus: true }) },
    {
      label: `${connectedCount}/${state.services.length} services connectés`,
      enabled: false,
    },
    { label: localHealthReady ? "Bridge détectable localement" : "Démarrage local...", enabled: false },
    { label: codexLabel, enabled: false },
    { label: updateState.enabled ? `Mises à jour: ${updateState.status}` : "Mises à jour: non configurées", enabled: false },
    { type: "separator" },
    { label: "Synchroniser", click: () => syncServices() },
    { label: localAiLabel, click: () => prepareLocalAiFromMenu() },
    { label: voiceLabel, click: () => prepareVoiceFromMenu() },
    { label: "Changer le raccourci push-to-talk...", enabled: Boolean(state.voice?.allowUserShortcutOverride), click: () => changeVoiceShortcutFromMenu() },
    { label: state.voice?.recording ? "Arrêter la dictée" : "Démarrer la dictée", enabled: Boolean(state.voice?.enabled), click: () => toggleVoiceDictation() },
    {
      label: "Quitter",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]));
}

function updateApplicationMenu() {
  const state = localStatusPayload();
  const activityItems = (state.activity || []).slice(0, 8).map((item) => ({
    label: `${new Date(item.ts).toLocaleTimeString("fr-FR")}  ${item.message}`,
    enabled: false,
  }));
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: PRODUCT_NAME,
      submenu: [
        { label: "À propos de Bridge", click: () => showAboutBridge() },
        { label: `Version ${currentBridgeVersion()}`, enabled: false },
        { type: "separator" },
        { label: "Afficher Bridge", click: () => showStatusWindow({ focus: true }) },
        { type: "separator" },
        { label: "Déconnexion", enabled: Boolean(state.authenticated), click: () => signOut() },
        { type: "separator" },
        { role: "quit", label: "Quitter Bridge" },
      ],
    },
    {
      label: "Fichier",
      submenu: [
        { label: "Synchroniser", accelerator: "CmdOrCtrl+R", click: () => syncServices() },
        { label: "Ouvrir le dossier de données", click: () => revealDataDir() },
      ],
    },
    {
      label: "ChatGPT Codex",
      submenu: [
        { label: state.codex?.ready ? "ChatGPT Codex prêt" : `ChatGPT Codex: ${state.codex?.label || "à vérifier"}`, enabled: false },
        { type: "separator" },
        { label: "Tester ChatGPT Codex", click: () => { resetCodexStatusCache(); refreshStatusWindow(); updateTrayMenu(); } },
        { label: "Configurer Bridge", click: async () => { await runBridgeSetup({ aiPolicy: loadConfig().aiPolicy }); resetCodexStatusCache(); scheduleLocalAiStatusRefresh(); refreshStatusWindow(); updateTrayMenu(); } },
        { label: "Aide ChatGPT Codex", click: () => shell.openExternal("https://help.openai.com/en/articles/11381614-api-codex-cli-and-sign-in-with-chatgpt") },
      ],
    },
    {
      label: "Moteur local",
      submenu: [
        { label: state.localAi?.ready ? "LM Studio prêt" : state.localAi?.label || "LM Studio à préparer", enabled: false },
        { label: `Modèle admin: ${state.localAi?.adminModel || state.localAi?.model || "-"}`, enabled: false },
        { type: "separator" },
        { label: "Installer / préparer LM Studio et le modèle", click: () => prepareLocalAiFromMenu() },
        { label: "Tester le statut LM Studio", click: () => { scheduleLocalAiStatusRefresh(); refreshStatusWindow(); updateTrayMenu(); } },
        {
          label: "Changer le modèle local...",
          enabled: Boolean(state.localAi?.allowUserModelOverride),
          click: () => changeLocalModelFromMenu(),
        },
      ],
    },
    {
      label: "Push-to-talk",
      submenu: [
        { label: state.voice?.label || "Push-to-talk à vérifier", enabled: false },
        { label: `Modèle admin: ${state.voice?.model || "-"}`, enabled: false },
        { label: `Raccourci: ${state.voice?.shortcut || "-"}`, enabled: false },
        { type: "separator" },
        { label: "Installer / préparer la dictée locale", click: () => prepareVoiceFromMenu() },
        {
          label: "Changer le raccourci...",
          enabled: Boolean(state.voice?.allowUserShortcutOverride),
          click: () => changeVoiceShortcutFromMenu(),
        },
        { label: state.voice?.recording ? "Arrêter la dictée" : "Démarrer la dictée", enabled: Boolean(state.voice?.enabled), click: () => toggleVoiceDictation() },
        { label: "Tester le micro", enabled: Boolean(state.voice?.enabled), click: () => runVoiceSidecar(["status"], 2500) },
        { label: "Tester l'animation", click: () => showVoiceOverlay({ mode: "listening", autoClose: true }) },
      ],
    },
    {
      label: "Activité",
      submenu: activityItems.length ? activityItems : [{ label: "Aucune activité récente", enabled: false }],
    },
    {
      label: "Édition",
      submenu: [
        { role: "undo", label: "Annuler" },
        { role: "redo", label: "Rétablir" },
        { type: "separator" },
        { role: "cut", label: "Couper" },
        { role: "copy", label: "Copier" },
        { role: "paste", label: "Coller" },
      ],
    },
  ]));
}

function showAboutBridge() {
  const version = currentBridgeVersion();
  return dialog.showMessageBox({
    type: "info",
    title: "À propos de Bridge",
    message: `Bridge ${version}`,
    detail: `Version installée : ${version}`,
    buttons: ["OK"],
    defaultId: 0,
  });
}

async function prepareLocalAiFromMenu() {
  const cfg = loadConfig();
  const policy = normalizeAiPolicy(cfg.aiPolicy).localAi;
  try {
    const result = await runLocalAiSetup({
      ...policy,
      enabled: true,
      installRequired: true,
      model: effectiveLocalAiModel(policy, cfg.defaultLocalModel),
    });
    localAiStatusCache = await getLocalAiStatus(loadConfig({ hydrateSecrets: false }));
    pushActivity(result?.ok ? "Moteur local préparé." : "Préparation du moteur local interrompue.");
    refreshStatusWindow();
    updateTrayMenu();
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    bridgeError = message;
    pushActivity(`Préparation du moteur local échouée: ${message}`);
    refreshStatusWindow();
    updateTrayMenu();
    return { ok: false, error: message };
  }
}

async function prepareVoiceFromMenu() {
  const cfg = loadConfig();
  const policy = normalizeAiPolicy(cfg.aiPolicy).voice;
  try {
    const result = await runVoiceSetup({
      ...policy,
      enabled: true,
      installRequired: true,
    });
    if (result?.ok) registerVoiceShortcut();
    pushActivity(result?.ok ? "Push-to-talk local préparé." : "Préparation du push-to-talk interrompue.");
    refreshStatusWindow();
    updateTrayMenu();
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    bridgeError = message;
    pushActivity(`Préparation du push-to-talk échouée: ${message}`);
    refreshStatusWindow();
    updateTrayMenu();
    return { ok: false, error: message };
  }
}

async function changeVoiceShortcutFromMenu() {
  const cfg = loadConfig();
  const voice = getVoiceStatus(cfg);
  if (!voice.allowUserShortcutOverride) return { ok: false, error: "shortcut-locked-by-admin" };
  const nextShortcut = await showTextInputWindow({
    title: "Raccourci push-to-talk",
    label: "Raccourci",
    value: voice.shortcut || "CommandOrControl+Shift+Space",
    helper: "Appuie sur la combinaison à utiliser, puis enregistre.",
    captureShortcut: true,
  });
  const clean = String(nextShortcut || "").trim().slice(0, 120);
  if (!clean) return { ok: false, cancelled: true };
  const result = voiceShortcutSaveResult(clean);
  pushActivity(result.warning ? `Raccourci push-to-talk enregistré, activation à terminer: ${result.warning}` : `Raccourci push-to-talk configuré: ${result.shortcut}`);
  refreshStatusWindow();
  updateTrayMenu();
  return result;
}

async function changeLocalModelFromMenu() {
  const cfg = loadConfig();
  const localAi = normalizeAiPolicy(cfg.aiPolicy).localAi;
  if (!localAi.allowUserModelOverride) return { ok: false, error: "model-locked-by-admin" };
  const current = effectiveLocalAiModel(localAi, cfg.defaultLocalModel);
  const nextModel = await showTextInputWindow({
    title: "Modèle local",
    label: "Modèle LM Studio",
    value: current,
    helper: "Ce choix reste discret et n'apparaît que si l'admin autorise l'override.",
  });
  const clean = cleanLocalAiModel(nextModel);
  if (!clean) return { ok: false, cancelled: true };
  const prefs = saveLocalAiPrefs({ localModel: clean });
  cfg.defaultLocalModel = clean;
  saveConfig(cfg);
  await ensureAdminProvisioning(loadConfig(), { silent: false });
  localAiStatusCache = await getLocalAiStatus(loadConfig({ hydrateSecrets: false }));
  restartRuntime();
  pushActivity(`Modèle local utilisateur configuré: ${prefs.localModel}`);
  refreshStatusWindow();
  updateTrayMenu();
  return { ok: true, localModel: prefs.localModel };
}

function showTextInputWindow({ title, label, value, helper, captureShortcut = false }) {
  const design = loadBridgeDesign();
  return new Promise((resolve) => {
    const parentWindow =
      BrowserWindow.getFocusedWindow() ||
      (statusWindow && !statusWindow.isDestroyed() && statusWindow.isVisible() ? statusWindow : undefined);
    const win = new BrowserWindow({
      width: captureShortcut ? 680 : 520,
      height: captureShortcut ? 440 : 340,
      resizable: false,
      minimizable: false,
      maximizable: false,
      center: true,
      parent: parentWindow,
      modal: false,
      alwaysOnTop: false,
      title,
      backgroundColor: design.bg,
      show: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      },
    });
    win.setMenuBarVisibility(false);
    const channel = `bridge-text-input-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      ipcMain.removeAllListeners(channel);
      try {
        if (!win.isDestroyed()) win.close();
      } catch {
        // ignore
      }
      resolve(result);
    };
    ipcMain.on(channel, (_event, payload) => {
      if (payload?.action === "cancel") return finish(null);
      if (payload?.action === "submit") return finish(String(payload.value || ""));
    });
    win.once("ready-to-show", () => {
      if (!win.isDestroyed()) {
        win.show();
        win.focus();
      }
    });
    win.webContents.on("did-fail-load", (_event, _code, description) => {
      bridgeError = `Fenêtre ${title} indisponible: ${description}`;
      pushActivity(bridgeError);
      finish(null);
    });
    win.on("closed", () => finish(null));
    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(textInputHtml({ title, label, value, helper, channel, design, captureShortcut }))}`);
  });
}

function textInputHtml({ title, label, value, helper, channel, design, captureShortcut = false }) {
  const mainMarkup = captureShortcut
    ? `<main class="shortcut-main">
        <section class="shortcut-recorder" id="shortcut-recorder" tabindex="0" aria-label="${escapeHtmlAttr(label)}">
          <div class="shortcut-label">${escapeHtml(label)}</div>
          <input id="value" type="hidden" value="${escapeHtmlAttr(value || "")}" />
          <div class="shortcut-display" id="shortcut-display"></div>
        </section>
        <div class="helper">${escapeHtml(helper || "Maintiens les touches du raccourci à utiliser.")}</div>
      </main>`
    : `<main><label>${escapeHtml(label)}<input id="value" value="${escapeHtmlAttr(value || "")}" autofocus /></label><div class="helper">${escapeHtml(helper || "")}</div></main>`;
  const footerMarkup = captureShortcut
    ? `<footer><button class="secondary" id="clear">Effacer</button><span class="footer-spacer"></span><button class="secondary" id="cancel">Annuler</button><button class="primary" id="submit">Enregistrer</button></footer>`
    : `<footer><button class="secondary" id="cancel">Annuler</button><button class="primary" id="submit">Enregistrer</button></footer>`;
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8" /><title>${escapeHtml(title)}</title><style>
  ${bridgeDesignCss(design)}
  *{box-sizing:border-box}body{margin:0;height:100vh;background:var(--bg);color:var(--text);font-family:var(--font-sans);overflow:hidden;display:grid;grid-template-rows:76px minmax(0,1fr)82px}
  header{padding:18px 28px;background:var(--panel);border-bottom:1px solid var(--border);display:flex;align-items:center}
  h1{font-size:18px;line-height:1.2;margin:0}main{min-height:0;padding:28px;overflow:hidden}
  label{display:grid;gap:10px;font-size:13px;font-weight:700}
  input{width:100%;min-width:0;height:40px;border-radius:7px;border:1px solid var(--border);background:var(--panel);color:var(--text);font:inherit;padding:0 10px}
  .helper{margin-top:14px;color:var(--muted);font-size:12px;line-height:1.45}
  footer{padding:16px 28px;background:var(--panel);border-top:1px solid var(--border);display:flex;align-items:center;justify-content:flex-end;gap:12px}
  .footer-spacer{flex:1}
  button{min-width:112px;height:44px;border:0;border-radius:7px;padding:0 18px;font:inherit;font-size:13px;font-weight:700;cursor:pointer}
  .primary{background:var(--accent);color:var(--on-accent)}.secondary{background:var(--secondary);color:var(--text)}
  .shortcut-main{display:grid;align-content:start}
  .shortcut-recorder{min-height:156px;border:2px solid var(--accent);border-radius:12px;background:var(--panel);padding:22px 24px;display:grid;align-content:center;gap:18px;outline:none;box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 16%,transparent)}
  .shortcut-label{font-size:13px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}
  .shortcut-display{min-height:48px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .shortcut-empty{color:var(--muted);font-size:14px}
  .keycap{min-width:46px;height:44px;padding:0 16px;border-radius:8px;border:1px solid var(--border);background:var(--bg);display:inline-flex;align-items:center;justify-content:center;font-weight:800;font-size:15px;box-shadow:0 1px 0 rgba(0,0,0,.06)}
  .plus{color:var(--muted);font-weight:800}
  </style></head><body>
  <header><h1>${escapeHtml(title)}</h1></header>
  ${mainMarkup}
  ${footerMarkup}
	  <script>
	    const { ipcRenderer } = require("electron");
	    const channel = ${JSON.stringify(channel)};
	    const captureShortcut = ${JSON.stringify(captureShortcut)};
	    const input = document.getElementById('value');
	    const recorder = document.getElementById('shortcut-recorder');
	    const display = document.getElementById('shortcut-display');
	    const isMac = navigator.platform.toLowerCase().includes("mac");
	    const activeModifiers = new Set();
	    document.getElementById('cancel').addEventListener('click', () => ipcRenderer.send(channel, { action: 'cancel' }));
	    document.getElementById('submit').addEventListener('click', () => ipcRenderer.send(channel, { action: 'submit', value: input.value }));
	    document.getElementById('clear')?.addEventListener('click', () => {
	      input.value = "";
	      activeModifiers.clear();
	      renderShortcut();
	      recorder?.focus();
	    });
	    function renderShortcut(parts) {
	      if (!display) return;
	      const value = Array.isArray(parts) ? parts.join("+") : input.value;
	      const keys = String(value || "").split("+").map((part) => displayKey(part.trim())).filter(Boolean);
	      if (!keys.length) {
	        display.innerHTML = '<span class="shortcut-empty">Appuie sur le raccourci</span>';
	        return;
	      }
	      display.innerHTML = keys.map((key, index) => {
	        const safe = key.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
	        return (index ? '<span class="plus">+</span>' : '') + '<span class="keycap">' + safe + '</span>';
	      }).join("");
	    }
	    function displayKey(key) {
	      const normalized = String(key || "").trim().toLowerCase();
	      if (!normalized) return "";
	      if (normalized === "commandorcontrol" || normalized === "cmdorctrl" || normalized === "controlorcommand") return isMac ? "Command" : "Control";
	      if (normalized === "cmd" || normalized === "meta" || normalized === "super") return isMac ? "Command" : "Super";
	      if (normalized === "ctrl") return "Control";
	      if (normalized === "alt") return isMac ? "Option" : "Alt";
	      if (normalized === "option") return isMac ? "Option" : "Alt";
	      if (normalized === "esc") return "Escape";
	      if (normalized === "return") return "Enter";
	      if (normalized === "space") return "Space";
	      return key.length === 1 ? key.toUpperCase() : key.slice(0, 1).toUpperCase() + key.slice(1);
	    }
	    function modifierLabel(key) {
	      if (key === "Meta") return "Command";
	      if (key === "Control") return "Control";
	      if (key === "Alt") return isMac ? "Option" : "Alt";
	      if (key === "Shift") return "Shift";
	      return "";
	    }
	    function orderedModifiers(event) {
	      if (event?.metaKey) activeModifiers.add("Command");
	      if (event?.ctrlKey) activeModifiers.add("Control");
	      if (event?.altKey) activeModifiers.add(isMac ? "Option" : "Alt");
	      if (event?.shiftKey) activeModifiers.add("Shift");
	      return ["Command", "Control", "Option", "Alt", "Shift"].filter((part) => activeModifiers.has(part));
	    }
	    function shortcutKey(event) {
	      const code = String(event.code || "");
	      if (code === "Space") return "Space";
	      if (/^Key[A-Z]$/.test(code)) return code.slice(3);
	      if (/^Digit[0-9]$/.test(code)) return code.slice(5);
	      if (/^F\\d{1,2}$/.test(code)) return code;
	      const key = String(event.key || "");
	      if (!key || ["Meta", "Control", "Alt", "Shift"].includes(key)) return "";
	      if (key === " ") return "Space";
	      if (key === "Esc") return "Escape";
	      if (key.length === 1) return key.toUpperCase();
	      return key.slice(0, 1).toUpperCase() + key.slice(1);
	    }
	    input.addEventListener('keydown', (event) => {
	      if (event.key === 'Escape') {
	        ipcRenderer.send(channel, { action: 'cancel' });
	        return;
	      }
	      if (captureShortcut && event.key === 'Enter' && input.value) {
	        ipcRenderer.send(channel, { action: 'submit', value: input.value });
	        return;
	      }
	      if (captureShortcut) {
	        event.preventDefault();
	        const modifier = modifierLabel(event.key);
	        if (modifier) {
	          activeModifiers.add(modifier);
	          renderShortcut(orderedModifiers(event));
	          return;
	        }
	        const parts = orderedModifiers(event);
	        const key = shortcutKey(event);
	        if (key) {
	          parts.push(key);
	          input.value = parts.join("+");
	          renderShortcut(parts);
	        }
	        return;
	      }
	      if (event.key === 'Enter') ipcRenderer.send(channel, { action: 'submit', value: input.value });
	    });
	    document.addEventListener('keyup', (event) => {
	      if (!captureShortcut) return;
	      const modifier = modifierLabel(event.key);
	      if (modifier) activeModifiers.delete(modifier);
	    });
	    renderShortcut();
	    if (captureShortcut) {
	      recorder?.focus();
	    } else {
	      input.focus();
	      input.select();
	    }
	  </script></body></html>`;
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
        scheduleRequiredAdminProvisioning("runtime-state");
      },
    }).then((handle) => {
      runtimeHandle = handle;
      runtimeState = handle.state();
      pushActivity("Runtime Codex démarré.");
      refreshStatusWindow();
      scheduleRequiredAdminProvisioning("runtime-start");
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
      res.end(JSON.stringify(localStatusPayload({ localProbe: true })));
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

function localStatusPayload(options = {}) {
  const cfg = options.localProbe ? loadConfig({ hydrateSecrets: false }) : loadConfig({ hydrateSecrets: false });
  const codex = options.localProbe
    ? codexStatusCache?.status || placeholderCodexStatus()
    : getCodexStatus({ fast: true });
  const base = runtimeState || stateFromConfig(cfg, codex);
  const localAi = localAiStatusCache || placeholderLocalAiStatus(cfg);
  const voice = getVoiceStatus(cfg);
  return {
    ...base,
    codex,
    aiPolicy: cfg.aiPolicy,
    localAi,
    voice,
    requiredProvisioning: requiredProvisioningState(localAi, voice),
    authenticated: Boolean(base.authenticated && !isStoredSessionInvalid(cfg)),
    controlPlaneConfigured: Boolean(base.controlPlaneConfigured && !isStoredSessionInvalid(cfg)),
    services: base.services.map((service) => serviceWithDisplayStatus(base, service, codex)),
    localHealthReady,
    bridgeError,
    autoUpdate: updateState,
    update: {
      latestVersion: cfg.latestVersion,
      minimumVersion: cfg.minimumVersion,
      updateRequired: bridgeUpdateRequired(cfg),
      currentVersion: currentBridgeVersion(),
    },
    activity: localActivity.slice(0, 30),
  };
}

function requiredProvisioningState(localAi, voice) {
  const items = [];
  if (localAi?.enabled && localAi?.installRequired && !localAi?.ready) {
    items.push({
      id: "local-ai",
      label: "Moteur local",
      detail: localAi.detail || localAi.label || `Modèle requis: ${localAi.model || "local"}.`,
    });
  }
  if (voice?.enabled && voice?.installRequired && (!voice?.installed || !voice?.modelInstalled)) {
    items.push({
      id: "voice",
      label: "Push-to-talk",
      detail: voice.label || `Modèle vocal requis: ${voice.model || "local"}.`,
    });
  }
  return {
    required: items.length > 0,
    items,
    label: items.length ? `Installation requise: ${items.map((item) => item.label).join(", ")}` : "",
  };
}

function stateFromConfig(cfg, codex = getCodexStatus({ fast: true })) {
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
    codex,
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

function placeholderLocalAiStatus(cfg) {
  const policy = normalizeAiPolicy(cfg.aiPolicy).localAi;
  const prefs = loadLocalAiPrefs();
  const model = effectiveLocalAiModel(policy, cfg.defaultLocalModel);
  const lmsBin = findLmsBin();
  const lmStudioApp = findLmStudioApp();
  const installed = Boolean(lmsBin || lmStudioApp);
  return {
    enabled: policy.enabled,
    installRequired: policy.installRequired,
    provider: policy.provider,
    model,
    adminModel: policy.model,
    userModel: policy.allowUserModelOverride ? prefs.localModel : undefined,
    allowUserModelOverride: policy.allowUserModelOverride,
    ready: false,
    installed,
    serverReady: false,
    modelReady: false,
    models: [],
    checkedAt: "",
    label: policy.enabled ? "Moteur local en vérification" : "Moteur local désactivé",
    detail: policy.enabled ? "Bridge vérifie le moteur local en arrière-plan." : "La politique admin n'impose pas de modèle local.",
  };
}

function getVoiceStatus(cfg) {
  const policy = normalizeAiPolicy(cfg.aiPolicy).voice;
  const bin = findVoiceSidecar();
  const userPrefs = loadVoicePrefs();
  const sidecar = bin ? runVoiceSidecar(["status"], 2500) : null;
  const audioReady = sidecar?.ok === true && sidecar.audioReady === true;
  const transcriptionReady = sidecar?.transcriptionReady === true;
  const modelPath = voiceModelPath(policy.model);
  const modelInstalled = isVoiceModelInstalled(policy.model);
  const shortcutReady = Boolean(
    (voiceShortcutProcess && !voiceShortcutProcess.killed && !voiceShortcutError) ||
    (voiceShortcutMode === "electron" && voiceShortcutValue && !voiceShortcutError)
  );
  return {
    enabled: policy.enabled,
    installRequired: policy.installRequired,
    provider: policy.provider,
    model: policy.model,
    modelPath,
    modelInstalled,
    shortcut: policy.allowUserShortcutOverride ? userPrefs.shortcut || policy.defaultShortcut : policy.defaultShortcut,
    shortcutNative: toHandyShortcut(policy.allowUserShortcutOverride ? userPrefs.shortcut || policy.defaultShortcut : policy.defaultShortcut),
    shortcutReady,
    shortcutError: voiceShortcutError || undefined,
    allowUserShortcutOverride: policy.allowUserShortcutOverride,
    allowUserModelOverride: policy.allowUserModelOverride,
    insertMode: policy.insertMode,
    ready: Boolean(policy.enabled && bin && audioReady && modelInstalled && shortcutReady),
    recording: Boolean(voiceRecording),
    busy: voiceBusy,
    audioReady,
    transcriptionReady,
    installed: Boolean(bin),
    path: bin,
    error: sidecar?.ok === false ? sidecar.error : sidecar?.audioError,
    label: policy.enabled
      ? !bin
        ? "Push-to-talk à installer"
        : !modelInstalled
          ? "Modèle vocal à installer"
          : !audioReady
            ? "Micro indisponible"
            : shortcutReady
              ? "Push-to-talk prêt"
              : voiceShortcutError
                ? "Raccourci à autoriser"
                : "Raccourci en préparation"
      : "Push-to-talk désactivé",
  };
}

function voicePrefsPath() {
  return path.join(app.getPath("userData"), "voice-prefs.json");
}

function loadVoicePrefs() {
  try {
    const raw = JSON.parse(fs.readFileSync(voicePrefsPath(), "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function saveVoicePrefs(partial) {
  const next = { ...loadVoicePrefs(), ...partial, updatedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(voicePrefsPath()), { recursive: true });
  fs.writeFileSync(voicePrefsPath(), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  registerVoiceShortcut();
  refreshStatusWindow();
  return next;
}

function voiceShortcutSaveResult(shortcut) {
  const prefs = saveVoicePrefs({ shortcut });
  const voice = getVoiceStatus(loadConfig({ hydrateSecrets: false }));
  if (voice.enabled && !voice.shortcutReady) {
    return {
      ok: true,
      warning: voice.shortcutError || (voice.installed ? "Raccourci non actif." : "Push-to-talk non installé."),
      shortcut: prefs.shortcut,
      voice,
    };
  }
  return { ok: true, shortcut: prefs.shortcut, voice };
}

function localAiPrefsPath() {
  return path.join(path.dirname(CONFIG_PATH), "local-ai-prefs.json");
}

function loadLocalAiPrefs() {
  try {
    const raw = JSON.parse(fs.readFileSync(localAiPrefsPath(), "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function saveLocalAiPrefs(partial) {
  const current = loadLocalAiPrefs();
  const next = { ...current, ...partial, updatedAt: new Date().toISOString() };
  if (!next.localModel) delete next.localModel;
  fs.mkdirSync(path.dirname(localAiPrefsPath()), { recursive: true });
  fs.writeFileSync(localAiPrefsPath(), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

function findVoiceSidecar() {
  const exe = process.platform === "win32" ? "bridge-voice.exe" : "bridge-voice";
  const unpackedDir = __dirname.includes("app.asar")
    ? __dirname.replace("app.asar", "app.asar.unpacked")
    : null;
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, "bridge-voice", process.platform, exe) : null,
    process.resourcesPath ? path.join(process.resourcesPath, "app.asar.unpacked", "dist", "bridge", "bridge-voice", process.platform, exe) : null,
    unpackedDir ? path.join(unpackedDir, "bridge-voice", process.platform, exe) : null,
    path.join(__dirname, "bridge-voice", process.platform, exe),
    path.join(__dirname, "..", "bridge-voice", process.platform, exe),
    path.join(process.cwd(), "bridge-voice", "target", "release", exe),
    path.join(process.cwd(), "bridge-voice", "target", "debug", exe),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function runVoiceSidecar(args, timeout = 5000) {
  const bin = findVoiceSidecar();
  if (!bin) return { ok: false, error: "bridge-voice introuvable" };
  const res = spawnSync(bin, args, {
    encoding: "utf8",
    timeout,
    windowsHide: true,
  });
  const raw = String(res.stdout || "").trim().split(/\r?\n/).filter(Boolean).pop() || "";
  let parsed = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  if (parsed && typeof parsed === "object") return parsed;
  return {
    ok: false,
    error: res.error?.message || res.stderr?.trim() || raw || `bridge-voice exited ${res.status}`,
  };
}

function getVoiceProcess() {
  if (voiceProcess && !voiceProcess.killed) return voiceProcess;
  const bin = findVoiceSidecar();
  if (!bin) throw new Error("bridge-voice introuvable");
  voiceStdoutBuffer = "";
  voiceProcess = spawn(bin, [], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  voiceProcess.stdout.on("data", (chunk) => {
    voiceStdoutBuffer += chunk.toString();
    const lines = voiceStdoutBuffer.split(/\r?\n/);
    voiceStdoutBuffer = lines.pop() || "";
    for (const line of lines) handleVoiceProcessLine(line);
  });
  voiceProcess.stderr.on("data", (chunk) => {
    const line = chunk.toString().trim();
    if (line) pushActivity(`Dictée locale: ${line.slice(0, 180)}`);
  });
  voiceProcess.on("close", () => {
    voiceProcess = null;
    voiceRecording = null;
    for (const pending of voicePending.splice(0)) {
      clearTimeout(pending.timer);
      pending.reject(new Error("bridge-voice arrêté"));
    }
  });
  voiceProcess.on("error", (err) => {
    for (const pending of voicePending.splice(0)) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
  });
  return voiceProcess;
}

function handleVoiceProcessLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed) return;
  let parsed = null;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (parsed?.event === "mic-level" && Array.isArray(parsed.levels)) {
    updateVoiceOverlayLevels(parsed.levels);
    return;
  }
  const pending = voicePending.shift();
  if (pending) {
    clearTimeout(pending.timer);
    pending.resolve(parsed);
    return;
  }
  if (parsed.ok === false) {
    pushActivity(`Dictée locale: ${parsed.error || "commande refusée"}`);
    refreshStatusWindow();
  }
}

function sendVoiceCommand(payload, timeout = 15_000) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = getVoiceProcess();
    } catch (err) {
      reject(err);
      return;
    }
    const item = {
      resolve,
      reject,
      timer: setTimeout(() => {
        const index = voicePending.indexOf(item);
        if (index >= 0) voicePending.splice(index, 1);
        reject(new Error("bridge-voice ne répond pas"));
      }, timeout),
    };
    voicePending.push(item);
    proc.stdin.write(`${JSON.stringify(payload)}\n`, (err) => {
      if (!err) return;
      const index = voicePending.indexOf(item);
      if (index >= 0) voicePending.splice(index, 1);
      clearTimeout(item.timer);
      reject(err);
    });
  });
}

function startVoiceShortcutWatcher() {
  const cfg = loadConfig({ hydrateSecrets: false });
  const policy = normalizeAiPolicy(cfg.aiPolicy).voice;
  if (!policy.enabled) return;
  const bin = findVoiceSidecar();
  if (!bin) {
    voiceShortcutError = "bridge-voice introuvable";
    return;
  }
  if (policy.installRequired && !isVoiceModelInstalled(policy.model)) {
    stopVoiceShortcutWatcher();
    voiceShortcutError = "";
    return;
  }
  const userPrefs = loadVoicePrefs();
  const shortcut = toHandyShortcut(policy.allowUserShortcutOverride ? userPrefs.shortcut || policy.defaultShortcut : policy.defaultShortcut);
  if (!shortcut) {
    voiceShortcutError = "raccourci vocal invalide";
    return;
  }
  if (
    ((voiceShortcutProcess && !voiceShortcutProcess.killed) || voiceShortcutMode === "electron") &&
    !voiceShortcutError &&
    voiceShortcutValue === shortcut
  ) {
    return;
  }
  stopVoiceShortcutWatcher();
  voiceShortcutError = "";
  voiceShortcutValue = shortcut;
  voiceShortcutMode = "sidecar";
  voiceShortcutStdoutBuffer = "";
  registerElectronVoiceShortcutMirror(shortcut);
  const proc = spawn(bin, ["watch-shortcut", "--shortcut", shortcut], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  voiceShortcutProcess = proc;
  proc.stdout.on("data", (chunk) => {
    voiceShortcutStdoutBuffer += chunk.toString();
    const lines = voiceShortcutStdoutBuffer.split(/\r?\n/);
    voiceShortcutStdoutBuffer = lines.pop() || "";
    for (const line of lines) handleVoiceShortcutLine(line);
  });
  proc.stderr.on("data", (chunk) => {
    const message = chunk.toString().trim();
    if (message) {
      voiceShortcutError = message.slice(0, 220);
      pushActivity(`Raccourci vocal: ${message.slice(0, 180)}`);
      refreshStatusWindow();
    }
  });
  proc.on("error", (err) => {
    if (voiceShortcutProcess !== proc) return;
    voiceShortcutError = err instanceof Error ? err.message : String(err);
    refreshStatusWindow();
  });
  proc.on("close", (code) => {
    if (voiceShortcutProcess !== proc) return;
    voiceShortcutProcess = null;
    if (code !== 0 && startElectronVoiceShortcutFallback(shortcut)) {
      refreshStatusWindow();
      return;
    }
    voiceShortcutError = code === 0 ? "" : voiceShortcutError || `watcher vocal arrêté (${code})`;
    voiceShortcutMode = "";
    if (code !== 0) scheduleVoiceShortcutRetry(shortcut);
    refreshStatusWindow();
  });
}

function startElectronVoiceShortcutFallback(shortcut) {
  if (!registerElectronVoiceShortcutMirror(shortcut)) return false;
  voiceShortcutMode = "electron";
  pushActivity(`Raccourci push-to-talk actif: ${shortcut}.`);
  return true;
}

function registerElectronVoiceShortcutMirror(shortcut) {
  if (!globalShortcut || !shortcut) return false;
  try {
    const electronShortcut = toElectronAccelerator(shortcut);
    if (!electronShortcut) return false;
    if (voiceShortcutElectronAccelerator && voiceShortcutElectronAccelerator !== electronShortcut) {
      try {
        globalShortcut.unregister(voiceShortcutElectronAccelerator);
      } catch {
        // no-op
      }
      voiceShortcutElectronAccelerator = "";
    }
    if (voiceShortcutElectronAccelerator === electronShortcut && globalShortcut.isRegistered(electronShortcut)) return true;
    const registered = globalShortcut.register(electronShortcut, () => handleElectronVoiceShortcut(shortcut));
    if (!registered) {
      voiceShortcutError = `raccourci indisponible: ${electronShortcut}`;
      return false;
    }
    voiceShortcutError = "";
    voiceShortcutElectronAccelerator = electronShortcut;
    voiceShortcutValue = shortcut;
    return true;
  } catch (err) {
    voiceShortcutError = err instanceof Error ? err.message : String(err);
    return false;
  }
}

function handleElectronVoiceShortcut(shortcut) {
  const now = Date.now();
  if (now - lastVoiceShortcutEventAt < 450) return;
  lastVoiceShortcutEventAt = now;
  pushActivity(`Raccourci push-to-talk détecté: ${shortcut}.`);
  showVoiceOverlay({ mode: "listening", autoClose: false });
  void toggleVoiceDictation();
}

function stopVoiceShortcutWatcher() {
  if (voiceShortcutRetryTimer) {
    clearTimeout(voiceShortcutRetryTimer);
    voiceShortcutRetryTimer = null;
  }
  if (voiceShortcutProcess && !voiceShortcutProcess.killed) {
    try {
      voiceShortcutProcess.kill();
    } catch {
      // no-op
    }
  }
  if (voiceShortcutMode === "electron" && voiceShortcutValue) {
    try {
      globalShortcut.unregister(toElectronAccelerator(voiceShortcutValue));
    } catch {
      // no-op
    }
  }
  if (voiceShortcutElectronAccelerator) {
    try {
      globalShortcut.unregister(voiceShortcutElectronAccelerator);
    } catch {
      // no-op
    }
  }
  voiceShortcutProcess = null;
  voiceShortcutMode = "";
  voiceShortcutElectronAccelerator = "";
  voiceShortcutStdoutBuffer = "";
}

function scheduleVoiceShortcutRetry(shortcut) {
  if (voiceShortcutRetryTimer || isQuitting) return;
  voiceShortcutRetryTimer = setTimeout(() => {
    voiceShortcutRetryTimer = null;
    if (isQuitting) return;
    const cfg = loadConfig({ hydrateSecrets: false });
    const policy = normalizeAiPolicy(cfg.aiPolicy).voice;
    const userPrefs = loadVoicePrefs();
    const currentShortcut = toHandyShortcut(policy.allowUserShortcutOverride ? userPrefs.shortcut || policy.defaultShortcut : policy.defaultShortcut);
    if (policy.enabled && currentShortcut === shortcut) startVoiceShortcutWatcher();
  }, 2_000);
}

function handleVoiceShortcutLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed) return;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (parsed.event === "shortcut-watching") {
    voiceShortcutError = "";
    pushActivity(`Raccourci push-to-talk actif: ${parsed.shortcut || voiceShortcutValue}.`);
    refreshStatusWindow();
    return;
  }
  if (parsed.event !== "shortcut") return;
  lastVoiceShortcutEventAt = Date.now();
  void handleVoiceShortcutEvent(parsed.pressed === true);
}

async function handleVoiceShortcutEvent(pressed) {
  if (pressed) {
    if (!voiceRecording) await startVoiceDictation();
    return;
  }
  if (voiceRecording) await stopVoiceDictation();
}

function toHandyShortcut(shortcut) {
  const raw = String(shortcut || "").trim();
  if (!raw) return "";
  return raw
    .split("+")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .map((part) => {
      if (part === "commandorcontrol" || part === "cmdorctrl" || part === "controlorcommand") {
        return process.platform === "darwin" ? "command" : "ctrl";
      }
      if (part === "cmd" || part === "meta") return process.platform === "darwin" ? "command" : "super";
      if (part === "control") return "ctrl";
      if (part === "option") return process.platform === "darwin" ? "option" : "alt";
      if (part === "return") return "enter";
      if (part === "esc") return "escape";
      if (part === " ") return "space";
      return part;
    })
    .join("+");
}

function toElectronAccelerator(shortcut) {
  const raw = String(shortcut || "").trim();
  if (!raw) return "";
  return raw
    .split("+")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .map((part) => {
      if (part === "command") return "Command";
      if (part === "ctrl" || part === "control") return "Control";
      if (part === "option" || part === "alt") return "Alt";
      if (part === "shift") return "Shift";
      if (part === "super" || part === "meta" || part === "cmd") return process.platform === "darwin" ? "Command" : "Super";
      if (part === "space") return "Space";
      if (part === "enter") return "Enter";
      if (part === "escape") return "Esc";
      return part.length === 1 ? part.toUpperCase() : part;
    })
    .join("+");
}

function voiceRecordingsDir() {
  const dir = path.join(app.getPath("userData"), "voice-recordings");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function toggleVoiceDictation() {
  if (voiceBusy) return { ok: false, error: "voice-busy" };
  return voiceRecording ? stopVoiceDictation() : startVoiceDictation();
}

async function startVoiceDictation() {
  voiceBusy = true;
  try {
    const cfg = loadConfig({ hydrateSecrets: false });
    const voice = getVoiceStatus(cfg);
    if (!voice.enabled) throw new Error("Dictée locale désactivée par la politique admin.");
    if (!voice.installed) throw new Error("Sidecar vocal absent. Mets à jour Bridge pour activer la dictée locale.");
    if (!voice.modelInstalled) throw new Error(`Modèle vocal absent: ${voice.model}.`);
    if (!voice.audioReady) throw new Error("Micro non disponible ou autorisation macOS/Windows manquante.");
    const wavPath = path.join(voiceRecordingsDir(), `bridge-voice-${Date.now()}.wav`);
    const started = await sendVoiceCommand({ command: "start", output: wavPath }, 8_000);
    if (!started?.ok) throw new Error(started?.error || "Démarrage de l'enregistrement refusé.");
    voiceRecording = {
      wavPath,
      modelPath: voice.modelPath,
      startedAt: Date.now(),
    };
    showVoiceOverlay({ mode: "listening", autoClose: false });
    pushActivity("Dictée locale démarrée.");
    return { ok: true, state: "recording", wavPath };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    showVoiceOverlay({ mode: "error", message });
    pushActivity(`Dictée locale indisponible: ${message}`);
    return { ok: false, error: message };
  } finally {
    voiceBusy = false;
    refreshStatusWindow();
  }
}

async function stopVoiceDictation() {
  voiceBusy = true;
  const current = voiceRecording;
  voiceRecording = null;
  try {
    if (!current) return { ok: false, error: "recording-not-active" };
    showVoiceOverlay({ mode: "transcribing", autoClose: false });
    const stopped = await sendVoiceCommand({ command: "stop", model: current.modelPath }, 120_000);
    if (!stopped?.ok) throw new Error(stopped?.error || "Arrêt de l'enregistrement refusé.");
    const text = String(stopped.text || "").trim();
    if (text) {
      const paste = await pasteTranscribedText(text);
      pushActivity(paste.ok ? "Dictée locale insérée." : `Dictée locale copiée: ${paste.error}`);
    } else {
      pushActivity(stopped.speechDetected ? "Dictée locale sans texte exploitable." : "Aucune parole détectée.");
    }
    refreshStatusWindow();
    return { ok: true, state: "stopped", text, result: stopped };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    pushActivity(`Dictée locale échouée: ${message}`);
    return { ok: false, error: message };
  } finally {
    hideVoiceOverlay();
    voiceBusy = false;
    refreshStatusWindow();
  }
}

async function pasteTranscribedText(text) {
  const cfg = loadConfig({ hydrateSecrets: false });
  const voice = normalizeAiPolicy(cfg.aiPolicy).voice;
  const previousClipboard = clipboard.readText();
  clipboard.writeText(text);
  if (voice.insertMode !== "system") {
    return { ok: true, mode: "clipboard" };
  }
  try {
    const pasted = await sendVoiceCommand({ command: "paste" }, 4_000);
    setTimeout(() => {
      try {
        if (clipboard.readText() === text) clipboard.writeText(previousClipboard);
      } catch {
        // no-op
      }
    }, 900);
    if (!pasted?.ok) throw new Error(pasted?.error || "collage natif refusé");
    return { ok: true, mode: "system" };
  } catch (err) {
    return { ok: false, mode: "clipboard", error: err instanceof Error ? err.message : String(err) };
  }
}

function registerVoiceShortcut() {
  try {
    startVoiceShortcutWatcher();
  } catch (err) {
    pushActivity(`Raccourci push-to-talk non enregistré: ${err instanceof Error ? err.message : String(err)}`);
  }
}

let voiceOverlayWindow = null;
let voiceOverlayCloseTimer = null;
function showVoiceOverlay(options = {}) {
  const design = loadBridgeDesign();
  const mode = options.mode === "error" ? "error" : options.mode === "transcribing" ? "transcribing" : "listening";
  const autoClose = options.autoClose ?? mode !== "listening";
  if (voiceOverlayCloseTimer) {
    clearTimeout(voiceOverlayCloseTimer);
    voiceOverlayCloseTimer = null;
  }
  if (voiceOverlayWindow && !voiceOverlayWindow.isDestroyed()) {
    voiceOverlayWindow.loadURL(`data:text/html;charset=utf-8;base64,${Buffer.from(voiceOverlayHtml(design, options), "utf8").toString("base64")}`);
    if (autoClose) scheduleVoiceOverlayClose();
    return;
  }
  const primaryDisplay = screen.getPrimaryDisplay();
  const workArea = primaryDisplay?.workArea || { x: 0, y: 0, width: 1440, height: 900 };
  const overlayWidth = 172;
  const overlayHeight = 36;
  voiceOverlayWindow = new BrowserWindow({
    width: overlayWidth,
    height: overlayHeight,
    x: Math.round(workArea.x + (workArea.width - overlayWidth) / 2),
    y: Math.round(workArea.y + workArea.height - overlayHeight - 15),
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    show: true,
    backgroundColor: "#00000000",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  voiceOverlayWindow.loadURL(`data:text/html;charset=utf-8;base64,${Buffer.from(voiceOverlayHtml(design, options), "utf8").toString("base64")}`);
  if (autoClose) scheduleVoiceOverlayClose();
}

function scheduleVoiceOverlayClose(delay = 1600) {
  voiceOverlayCloseTimer = setTimeout(hideVoiceOverlay, delay);
}

function hideVoiceOverlay() {
  if (voiceOverlayCloseTimer) {
    clearTimeout(voiceOverlayCloseTimer);
    voiceOverlayCloseTimer = null;
  }
  try {
    if (voiceOverlayWindow && !voiceOverlayWindow.isDestroyed()) voiceOverlayWindow.close();
  } catch {
    // ignore
  } finally {
    voiceOverlayWindow = null;
  }
}

function updateVoiceOverlayLevels(levels) {
  if (!voiceOverlayWindow || voiceOverlayWindow.isDestroyed()) return;
  const values = levels
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .slice(0, 16);
  if (!values.length) return;
  const script = `window.__bridgeSetLevels && window.__bridgeSetLevels(${JSON.stringify(values)})`;
  voiceOverlayWindow.webContents.executeJavaScript(script).catch(() => {
    // The overlay can disappear while an audio packet is in flight.
  });
}

function voiceOverlayHtml(design, options = {}) {
  const mode = options.mode === "error" ? "error" : options.mode === "transcribing" ? "transcribing" : "listening";
  const label = mode === "error" ? "Micro indisponible" : mode === "transcribing" ? "Transcription..." : "";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  ${bridgeDesignCss(design)}
  html,body{margin:0;width:100%;height:100%;background:transparent;font-family:var(--font-sans);overflow:hidden}
  .recording-overlay{height:36px;width:172px;display:grid;grid-template-columns:auto 1fr auto;align-items:center;padding:6px;background:#000000cc;border-radius:18px;opacity:0;transition:opacity 300ms ease-out;box-sizing:border-box}
  .recording-overlay.fade-in{opacity:1}
  .overlay-left{display:flex;align-items:center}
  .overlay-middle{display:flex;align-items:center;justify-content:center;min-width:0}
  .overlay-right{display:flex;align-items:center;justify-content:flex-end}
  .bars-container{display:flex;align-items:end;justify-content:center;gap:3px;padding-bottom:0;height:24px;overflow:hidden}
  .bar{width:6px;background:var(--accent);max-height:20px;border-radius:2px;transition:height 80ms linear;min-height:4px;height:4px;opacity:.2}
  .transcribing-text{color:var(--paper);font-size:12px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;animation:transcribing-pulse 1.5s infinite ease-in-out;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:112px}
  .cancel-button{width:24px;height:24px;border-radius:50%;background:transparent;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:background-color 150ms ease-out,transform 100ms ease-out;flex-shrink:0}
  .cancel-button:hover{background:color-mix(in srgb,var(--accent) 22%,transparent);transform:scale(1.05)}
  .cancel-button:active{transform:scale(.95)}
  .overlay-left,.cancel-button{color:var(--accent)}
  svg{display:block}
  @keyframes transcribing-pulse{0%,100%{opacity:.6}50%{opacity:1}}
  </style></head><body><div class="recording-overlay fade-in">
    <div class="overlay-left">${handyMicrophoneSvg()}</div>
    <div class="overlay-middle">${
      mode === "listening"
        ? '<div class="bars-container">' + Array.from({ length: 9 }, () => '<div class="bar"></div>').join("") + '</div>'
        : `<div class="transcribing-text">${escapeHtml(label)}</div>`
    }</div>
    <div class="overlay-right">${mode === "listening" ? `<div class="cancel-button">${handyCancelSvg()}</div>` : ""}</div>
  </div><script>
  const smoothedLevels = Array(16).fill(0);
  const bars = Array.from(document.querySelectorAll(".bar"));
  window.__bridgeSetLevels = (levels) => {
    if (!Array.isArray(levels)) return;
    for (let i = 0; i < smoothedLevels.length; i += 1) {
      const target = Number(levels[i] || 0);
      smoothedLevels[i] = smoothedLevels[i] * 0.7 + Math.max(0, Math.min(1, target)) * 0.3;
    }
    bars.forEach((bar, index) => {
      const value = smoothedLevels[index] || 0;
      bar.style.height = Math.min(20, 4 + Math.pow(value, 0.7) * 16) + "px";
      bar.style.transition = "height 60ms ease-out, opacity 120ms ease-out";
      bar.style.opacity = String(Math.max(0.2, value * 1.7));
    });
  };
  </script></body></html>`;
}

function handyMicrophoneSvg() {
  return `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M17.1562 10.2C17.1562 8.83247 16.613 7.52099 15.646 6.554C14.679 5.58702 13.3675 5.04375 12 5.04375C10.6325 5.04375 9.32099 5.58702 8.354 6.554C7.38702 7.52099 6.84375 8.83247 6.84375 10.2C6.84375 11.1586 6.99743 11.7554 7.18689 12.1629C7.37547 12.5685 7.62633 12.848 7.94019 13.1553C8.23392 13.443 8.67357 13.8299 8.99524 14.3488C9.34195 14.9081 9.54381 15.5869 9.54382 16.4999C9.54382 17.1513 9.80245 17.7762 10.2631 18.2369C10.7237 18.6975 11.3486 18.9561 12 18.9561C12.7207 18.9561 13.268 18.6453 13.7494 18.0625C14.0462 17.7033 14.5781 17.6526 14.9374 17.9494C15.2967 18.2461 15.3473 18.7781 15.0505 19.1374C14.3214 20.0201 13.3283 20.6436 12 20.6436C10.901 20.6436 9.84705 20.2071 9.06995 19.43C8.29287 18.6529 7.85632 17.5989 7.85632 16.4999C7.85631 15.8572 7.72032 15.4953 7.56079 15.238C7.37622 14.9402 7.14072 14.7342 6.75952 14.3609C6.39843 14.0073 5.97449 13.5575 5.65686 12.8744C5.34008 12.1931 5.15625 11.3413 5.15625 10.2C5.15625 8.38492 5.87744 6.64434 7.16089 5.36089C8.44434 4.07743 10.1849 3.35625 12 3.35625C13.8151 3.35625 15.5557 4.07743 16.8391 5.36089C18.1226 6.64434 18.8438 8.38492 18.8438 10.2C18.8437 10.666 18.466 11.0437 18 11.0437C17.534 11.0437 17.1563 10.666 17.1562 10.2Z" fill="currentColor"/><path d="M14.1562 10.2C14.1562 9.62812 13.9289 9.07984 13.5245 8.67546C13.1454 8.29636 12.6399 8.07275 12.1069 8.04631L12 8.04375C11.4281 8.04375 10.8798 8.27109 10.4755 8.67546C10.0711 9.07984 9.84375 9.62812 9.84375 10.2C9.84375 10.666 9.46599 11.0437 9 11.0437C8.53401 11.0437 8.15625 10.666 8.15625 10.2C8.15625 9.18057 8.56114 8.20282 9.28198 7.48198C10.0028 6.76114 10.9806 6.35625 12 6.35625L12.1904 6.36101C13.1405 6.4081 14.0422 6.80615 14.718 7.48198C15.4389 8.20282 15.8438 9.18057 15.8438 10.2C15.8438 11.4145 15.2126 12.223 14.7751 12.8063C14.3126 13.423 14.0438 13.8146 14.0438 14.4001C14.0438 14.4785 14.0697 14.555 14.1174 14.6172C14.1652 14.6795 14.2321 14.7244 14.3079 14.7447C14.3836 14.7649 14.4639 14.7597 14.5364 14.7297C14.6088 14.6996 14.6693 14.6464 14.7085 14.5784C14.9413 14.1748 15.4573 14.0363 15.861 14.269C16.2646 14.5018 16.4032 15.0178 16.1704 15.4214C15.9456 15.8113 15.5984 16.1163 15.1827 16.2886C14.767 16.4609 14.3057 16.4911 13.871 16.3747C13.4363 16.2582 13.0521 16.0015 12.7782 15.6445C12.5043 15.2874 12.3562 14.8497 12.3563 14.3997C12.3564 13.1854 12.9875 12.377 13.4249 11.7937C13.8875 11.177 14.1562 10.7855 14.1562 10.2Z" fill="currentColor"/></svg>`;
}

function handyCancelSvg() {
  return `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true"><g fill="currentColor"><path d="m14.293 8.29297c.3905-.39052 1.0235-.39052 1.414 0s.3905 1.02354 0 1.41406l-5.99998 5.99997c-.39053.3906-1.02354.3906-1.41407 0-.39052-.3905-.39052-1.0235 0-1.414z"/><path d="m8.29295 8.29297c.39053-.39052 1.02354-.39052 1.41407 0l5.99998 6.00003c.3905.3905.3905 1.0235 0 1.414-.3905.3906-1.0235.3906-1.414 0l-6.00005-5.99997c-.39052-.39052-.39052-1.02354 0-1.41406z"/><path d="m20 12c0-4.41828-3.5817-8-8-8-4.41828 0-8 3.58172-8 8 0 4.4183 3.58172 8 8 8 4.4183 0 8-3.5817 8-8zm2 0c0 5.5228-4.4772 10-10 10-5.52285 0-10-4.4772-10-10 0-5.52285 4.47715-10 10-10 5.5228 0 10 4.47715 10 10z" opacity=".4"/></g></svg>`;
}

function scheduleLocalAiStatusRefresh() {
  const now = Date.now();
  if (localAiStatusProbeRunning || now - lastLocalAiStatusRefreshMs < 5_000) return;
  localAiStatusProbeRunning = true;
  lastLocalAiStatusRefreshMs = now;
  setTimeout(async () => {
    try {
      const cfg = loadConfig({ hydrateSecrets: false });
      localAiStatusCache = await getLocalAiStatus(cfg);
    } finally {
      localAiStatusProbeRunning = false;
      refreshStatusWindow();
      updateTrayMenu();
    }
  }, 0);
}

async function getLocalAiStatus(cfg) {
  const policy = normalizeAiPolicy(cfg.aiPolicy).localAi;
  const prefs = loadLocalAiPrefs();
  const model = effectiveLocalAiModel(policy, cfg.defaultLocalModel);
  const lmsBin = findLmsBin();
  const lmStudioApp = findLmStudioApp();
  const installed = Boolean(lmsBin || lmStudioApp);
  if (!policy.enabled) {
    return {
      ...placeholderLocalAiStatus(cfg),
      installed,
      checkedAt: new Date().toISOString(),
    };
  }
  const server = await probeLmStudioModels().catch((err) => ({ ok: false, models: [], error: err?.message || String(err) }));
  const modelReady = Boolean(server.ok && server.models.includes(model));
  return {
    enabled: policy.enabled,
    installRequired: policy.installRequired,
    provider: policy.provider,
    model,
    adminModel: policy.model,
    userModel: policy.allowUserModelOverride ? prefs.localModel : undefined,
    allowUserModelOverride: policy.allowUserModelOverride,
    ready: Boolean(installed && server.ok && modelReady),
    installed,
    serverReady: Boolean(server.ok),
    modelReady,
    models: server.models || [],
    checkedAt: new Date().toISOString(),
    label: !installed
      ? "Moteur local non installé"
      : !server.ok
        ? "Moteur local arrêté"
        : !modelReady
          ? "Modèle local absent"
          : "Moteur local prêt",
    detail: !installed
      ? "Bridge doit installer le moteur local demandé par l'organisation."
      : !server.ok
        ? "Bridge doit démarrer le serveur local LM Studio."
        : !modelReady
          ? `Modèle attendu: ${model}.`
          : `Modèle prêt: ${model}.`,
    error: server.error,
  };
}

function getCodexStatus({ force = false, fast = false } = {}) {
  const now = Date.now();
  if (!force && codexStatusCache && now - codexStatusCache.checkedMs < 60_000) {
    return codexStatusCache.status;
  }
  if (fast) {
    scheduleCodexStatusRefresh();
    return codexStatusCache?.status || placeholderCodexStatus();
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
      label: "ChatGPT Codex non installé",
      detail: "Installe Codex CLI puis connecte-le au compte ChatGPT pour que Bridge puisse exécuter les agents.",
      path: null,
      version: null,
      loggedIn: null,
      authPath,
    });
  }

  ensureCodexFileStore();
  const versionProbe = runCodexProbe(bin, ["--version"], 5_000);
  const versionOutput = `${versionProbe.stdout || ""}\n${versionProbe.stderr || ""}`.trim();
  const version = versionOutput.match(/(\d+\.\d+\.\d+)/)?.[1] || versionOutput.split(/\s+/).find(Boolean) || null;
  if (!versionProbe.ok) {
    return finish({
      ready: false,
      state: "error",
      label: "ChatGPT Codex à vérifier",
      detail: "Codex est détecté, mais le test de version échoue.",
      path: bin,
      version,
      loggedIn: null,
      authPath,
      diagnostic: compactProbeError(versionProbe),
    });
  }

  const authFileExists = fs.existsSync(authPath);
  const loginOutput = authFileExists ? "auth.json présent." : "Aucun auth.json Codex détecté.";
  const loggedIn = authFileExists;

  if (!loggedIn) {
    return finish({
      ready: false,
      state: "login_required",
      label: "Connexion ChatGPT Codex requise",
      detail: "Codex est installé, mais il n'est pas connecté au compte ChatGPT.",
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
    label: "ChatGPT Codex prêt",
    detail: "Codex CLI est installé et connecté au compte ChatGPT. Les agents Bridge peuvent tourner sur cet ordinateur.",
    path: bin,
    version,
    loggedIn: true,
    authPath: authFileExists ? authPath : null,
    diagnostic: loginOutput || undefined,
  });
}

function placeholderCodexStatus() {
  return {
    installCommand: "npm install -g @openai/codex",
    loginCommand: "codex login",
    checkedAt: "",
    ready: false,
    state: "checking",
    label: "ChatGPT Codex en vérification",
    detail: "Bridge vérifie ChatGPT Codex en arrière-plan.",
    path: null,
    version: null,
    loggedIn: null,
    authPath: path.join(os.homedir(), ".codex", "auth.json"),
  };
}

function scheduleCodexStatusRefresh() {
  const now = Date.now();
  if (codexStatusProbeRunning || now - lastCodexStatusRefreshMs < 5_000) return;
  codexStatusProbeRunning = true;
  lastCodexStatusRefreshMs = now;
  setTimeout(() => {
    try {
      getCodexStatus({ force: true });
    } finally {
      codexStatusProbeRunning = false;
      refreshStatusWindow();
      updateTrayMenu();
    }
  }, 0);
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
  const installed = findInstalledCodexBin();
  if (installed && fs.existsSync(installed)) return installed;
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

function loadConfig(options = {}) {
  const hydrateSecrets = options.hydrateSecrets !== false;
  const defaultCfg = defaultConfig();
  try {
    if (!fs.existsSync(CONFIG_PATH)) return defaultCfg;
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    const parsed = hydrateSecrets ? hydrateSecureBridgeSecrets(raw) : raw;
    const cfg = normalizeConfig({ ...defaultCfg, ...parsed });
    if (hydrateSecrets) lastConfigSnapshot = cfg;
    return cfg;
  } catch {
    return lastConfigSnapshot || defaultCfg;
  }
}

function saveConfig(next) {
  const cfg = normalizeConfig(next);
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(prepareBridgeConfigForDisk(cfg), null, 2)}\n`, "utf8");
  lastConfigSnapshot = cfg;
  return cfg;
}

function hydrateSecureBridgeSecrets(input) {
  const secure = input?._secureSecrets;
  if (!secure || secure.version !== 1 || secure.provider !== "electron-safe-storage" || !secure.ciphertext) return input;
  if (!shouldUseElectronSafeStorage()) return input;
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
  if (!hasSecrets || !shouldUseElectronSafeStorage()) {
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

function shouldUseElectronSafeStorage() {
  // Les builds Bridge client ne sont pas signés/stables pendant les itérations.
  // Sur macOS, safeStorage peut alors rendre les tokens illisibles après remplacement
  // de l'app. On garde le déchiffrement compatible, mais le chiffrement devient opt-in.
  return process.env.BRIDGE_USE_SAFE_STORAGE === "1" && Boolean(safeStorage?.isEncryptionAvailable());
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
    aiPolicy: DEFAULT_AI_POLICY,
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
  const aiPolicy = normalizeAiPolicy(cfg.aiPolicy);
  const defaultLocalModel = effectiveLocalAiModel(aiPolicy.localAi, cfg.defaultLocalModel);
  return {
    ...cfg,
    dataDir,
    cloudBaseUrl: cfg.controlPlaneBaseUrl || cfg.cloudBaseUrl || process.env.BRIDGE_DEFAULT_CONTROL_PLANE_URL,
    controlPlaneBaseUrl: cfg.controlPlaneBaseUrl || cfg.cloudBaseUrl || process.env.BRIDGE_DEFAULT_CONTROL_PLANE_URL,
    updateBaseUrl: cfg.updateBaseUrl || process.env.BRIDGE_UPDATE_BASE_URL || process.env.BRIDGE_AUTO_UPDATE_URL,
    latestVersion: cfg.latestVersion || process.env.BRIDGE_LATEST_VERSION,
    minimumVersion: cfg.minimumVersion || process.env.BRIDGE_MINIMUM_VERSION || process.env.BRIDGE_MIN_VERSION,
    installerBaseUrl: cfg.installerBaseUrl || process.env.BRIDGE_INSTALLER_BASE_URL,
    windowsInstallerUrl: cfg.windowsInstallerUrl || process.env.BRIDGE_WINDOWS_INSTALLER_URL,
    macInstallerUrl: cfg.macInstallerUrl || process.env.BRIDGE_MAC_INSTALLER_URL,
    aiPolicy,
    defaultLocalModel,
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

function normalizeAiPolicy(value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const local = input.localAi && typeof input.localAi === "object" && !Array.isArray(input.localAi) ? input.localAi : {};
  const voice = input.voice && typeof input.voice === "object" && !Array.isArray(input.voice) ? input.voice : {};
  const localEnabled = local.enabled === true;
  const voiceEnabled = voice.enabled === true;
  return {
    localAi: {
      enabled: localEnabled,
      installRequired: local.installRequired === true || localEnabled,
      provider: "lmstudio",
      model: typeof local.model === "string" && local.model.trim() ? local.model.trim().slice(0, 220) : DEFAULT_AI_POLICY.localAi.model,
      allowUserModelOverride: local.allowUserModelOverride === true,
    },
    voice: {
      enabled: voiceEnabled,
      installRequired: voice.installRequired === true || voiceEnabled,
      provider: "bridge-voice",
      model: typeof voice.model === "string" && voice.model.trim() ? voice.model.trim().slice(0, 220) : DEFAULT_AI_POLICY.voice.model,
      defaultShortcut:
        typeof voice.defaultShortcut === "string" && voice.defaultShortcut.trim()
          ? voice.defaultShortcut.trim().slice(0, 120)
          : DEFAULT_AI_POLICY.voice.defaultShortcut,
      allowUserShortcutOverride: voice.allowUserShortcutOverride === false ? false : true,
      allowUserModelOverride: voice.allowUserModelOverride === true,
      insertMode: voice.insertMode === "bridge-fields" ? "bridge-fields" : "system",
    },
  };
}

function cleanLocalAiModel(value) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 220) : "";
}

function effectiveLocalAiModel(localPolicy, configuredModel) {
  const adminModel = cleanLocalAiModel(localPolicy?.model) || DEFAULT_AI_POLICY.localAi.model;
  if (!localPolicy?.allowUserModelOverride) return adminModel;
  return cleanLocalAiModel(loadLocalAiPrefs().localModel) || cleanLocalAiModel(configuredModel) || adminModel;
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

  if (local === "active" || local === "reconnecting" || local === "connected" || local === "ok" || service.status === "active" || service.status === "connected") {
    return {
      status: local === "reconnecting" ? "reconnecting" : local === "active" || service.status === "active" ? "active" : "connected",
      cloudStatus: cloudFresh ? "fresh" : "stale",
      siteStatus: local || "ok",
      reason: local === "reconnecting" || local === "active" || service.status === "active"
        ? "Bridge travaille sur ce service."
        : "Bridge local confirme ce service.",
      lastActivityAt,
      ageSeconds,
    };
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
    cloudStatus: cloudFresh ? "fresh" : lastActivityAt ? "stale" : "missing",
    siteStatus: local || "ok",
    reason: lastActivityAt && cloudFresh ? `Bridge vu ${formatRelativeAge(lastActivityAt)}.` : "Bridge local prêt.",
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
  const cfg = loadConfig({ hydrateSecrets: false });
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
      if (ok) localStatuses[service.serviceId] = "connected";
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

function startCloudHeartbeat() {
  if (cloudHeartbeatInterval) return;
  const intervalMs = Math.max(Number(process.env.BRIDGE_CLOUD_HEARTBEAT_MS || 30_000), 10_000);
  const beat = async () => {
    if (cloudHeartbeatInFlight || isQuitting) return;
    const cfg = loadConfig();
    if (!cfg.controlPlaneBaseUrl || (!cfg.bridgeToken && !cfg.session?.accessToken)) return;
    cloudHeartbeatInFlight = true;
    try {
      await syncServices({ silent: true });
    } finally {
      cloudHeartbeatInFlight = false;
    }
  };
  setTimeout(() => void beat(), 2_000);
  cloudHeartbeatInterval = setInterval(() => void beat(), intervalMs);
}

function scheduleStartupAdminProvisioning() {
  setTimeout(async () => {
    if (isQuitting) return;
    try {
      await syncServices({ silent: true, reason: "startup" });
      await ensureAdminProvisioning(loadConfig(), { silent: true, reason: "startup" });
    } finally {
      registerVoiceShortcut();
    }
  }, 1_000);
}

async function syncServices(options = {}) {
  const silent = options.silent === true;
  const reason = options.reason || "sync";
  if (runtimeHandle?.syncOnce) {
    await runtimeHandle.syncOnce().catch((err) => {
      bridgeError = err instanceof Error ? err.message : String(err);
    });
    startAutoUpdates({ reconfigure: true });
    await ensureAdminProvisioning(loadConfig(), { silent, reason });
    registerVoiceShortcut();
    if (!silent) {
      pushActivity("Synchronisation demandée.");
      refreshStatusWindow();
    }
    return;
  }

  const cfg = loadConfig();
  if (!cfg.controlPlaneBaseUrl || (!cfg.bridgeToken && !cfg.session?.accessToken)) {
    if (!silent) {
      pushActivity("Mode démo: aucun Control Plane configuré.");
      refreshStatusWindow();
    }
    return;
  }
  try {
    await syncServicesFromControlPlane(cfg);
    startAutoUpdates({ reconfigure: true });
    if (!silent) pushActivity("Services synchronisés.");
    bridgeError = null;
  } catch (err) {
    bridgeError = err instanceof Error ? err.message : String(err);
    if (!silent) pushActivity(`Synchronisation échouée: ${bridgeError}`);
  }
  if (!silent) refreshStatusWindow();
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
    if (authConfig.updateBaseUrl) cfg.updateBaseUrl = authConfig.updateBaseUrl;
    if (authConfig.latestVersion) cfg.latestVersion = authConfig.latestVersion;
    if (authConfig.minimumVersion) cfg.minimumVersion = authConfig.minimumVersion;
    if (authConfig.installerBaseUrl) cfg.installerBaseUrl = authConfig.installerBaseUrl;
    if (authConfig.windowsInstallerUrl) cfg.windowsInstallerUrl = authConfig.windowsInstallerUrl;
    if (authConfig.macInstallerUrl) cfg.macInstallerUrl = authConfig.macInstallerUrl;
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
  return {
    supabaseUrl,
    supabaseAnonKey,
    updateBaseUrl: cleanExternalUrl(json.updateBaseUrl),
    latestVersion: typeof json.latestVersion === "string" ? json.latestVersion : undefined,
    minimumVersion: typeof json.minimumVersion === "string" ? json.minimumVersion : undefined,
    installerBaseUrl: cleanExternalUrl(json.installerBaseUrl),
    windowsInstallerUrl: cleanExternalUrl(json.windowsInstallerUrl),
    macInstallerUrl: cleanExternalUrl(json.macInstallerUrl),
  };
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
  return withSupabaseRefreshLock(async () => {
    const fresh = loadConfig();
    if (fresh.session?.refreshToken) {
      const freshExpiresAt = fresh.session.expiresAt ? Date.parse(fresh.session.expiresAt) : 0;
      if (fresh.session.refreshToken !== cfg.session.refreshToken && (!freshExpiresAt || freshExpiresAt - Date.now() > SUPABASE_REFRESH_MARGIN_MS)) {
        Object.assign(cfg, fresh);
        return cfg;
      }
      if (freshExpiresAt && freshExpiresAt - Date.now() > SUPABASE_REFRESH_MARGIN_MS) {
        Object.assign(cfg, fresh);
        return cfg;
      }
    }

    const expiresAt = cfg.session.expiresAt ? Date.parse(cfg.session.expiresAt) : 0;
    if (expiresAt && expiresAt - Date.now() > SUPABASE_REFRESH_MARGIN_MS) return cfg;
    const refreshToken = cfg.session.refreshToken;
    const res = await fetch(`${cfg.supabaseUrl.replace(/\/+$/, "")}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        apikey: cfg.supabaseAnonKey,
        authorization: `Bearer ${cfg.supabaseAnonKey}`,
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = json.error_description || json.msg || json.error || `Refresh HTTP ${res.status}`;
      if (isInvalidBridgeAuthMessage(message)) {
        const latest = loadConfig();
        const latestExpiresAt = latest.session?.expiresAt ? Date.parse(latest.session.expiresAt) : 0;
        if (
          latest.session?.refreshToken &&
          latest.session.refreshToken !== refreshToken &&
          (!latestExpiresAt || latestExpiresAt - Date.now() > SUPABASE_REFRESH_MARGIN_MS)
        ) {
          Object.assign(cfg, latest);
          return cfg;
        }
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
  });
}

function withSupabaseRefreshLock(fn) {
  const key = "__bridgeSupabaseRefreshLock";
  const previous = globalThis[key] || Promise.resolve();
  const next = previous.catch(() => null).then(fn);
  const locked = next.finally(() => {
    if (globalThis[key] === locked) delete globalThis[key];
  });
  globalThis[key] = locked;
  return next;
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
  if (res.aiPolicy) {
    cfg.aiPolicy = normalizeAiPolicy(res.aiPolicy);
    if (cfg.aiPolicy.localAi.enabled) cfg.defaultLocalModel = effectiveLocalAiModel(cfg.aiPolicy.localAi, cfg.defaultLocalModel);
  }
  const previousUpdateBaseUrl = cfg.updateBaseUrl;
  if (res.updateBaseUrl) cfg.updateBaseUrl = res.updateBaseUrl;
  if (res.latestVersion) cfg.latestVersion = res.latestVersion;
  if (res.minimumVersion) cfg.minimumVersion = res.minimumVersion;
  if (res.installerBaseUrl) cfg.installerBaseUrl = res.installerBaseUrl;
  if (res.windowsInstallerUrl) cfg.windowsInstallerUrl = res.windowsInstallerUrl;
  if (res.macInstallerUrl) cfg.macInstallerUrl = res.macInstallerUrl;
  bridgeError = res.error || null;
  saveConfig(cfg);
  await ensureAdminProvisioning(loadConfig(), { silent: true, reason: "control-plane-sync" });
  registerVoiceShortcut();
  if (cfg.updateBaseUrl && (cfg.updateBaseUrl !== previousUpdateBaseUrl || bridgeUpdateRequired(cfg))) startAutoUpdates({ reconfigure: true });
  void flushPendingBrowserSession();
  refreshStatusWindow();
  updateTrayMenu();
  return res;
}

function scheduleRequiredAdminProvisioning(reason = "policy") {
  if (adminProvisioningScheduled || adminProvisioningRunning || isQuitting) return;
  if (Date.now() - lastAdminProvisioningPromptAt < 10 * 60 * 1000) return;
  const policy = normalizeAiPolicy(loadConfig({ hydrateSecrets: false }).aiPolicy);
  const required =
    (policy.localAi.enabled && policy.localAi.installRequired) ||
    (policy.voice.enabled && policy.voice.installRequired);
  if (!required) return;
  adminProvisioningScheduled = true;
  setTimeout(async () => {
    adminProvisioningScheduled = false;
    const result = await ensureAdminProvisioning(loadConfig(), { silent: true, reason });
    if (result?.ok === false) pushActivity(`Installation requise à terminer: ${result.error || "erreur inconnue"}`);
  }, 0);
}

async function ensureAdminProvisioning(cfg = loadConfig(), options = {}) {
  const policy = normalizeAiPolicy(cfg.aiPolicy);
  const needsLocal = policy.localAi.enabled && policy.localAi.installRequired;
  const needsVoice =
    policy.voice.enabled &&
    policy.voice.installRequired &&
    (!findVoiceSidecar() || !isVoiceModelInstalled(policy.voice.model));
  if (!needsLocal && !needsVoice) return { ok: true, skipped: true };
  if (adminProvisioningRunning) return { ok: true, skipped: true, running: true };

  adminProvisioningRunning = true;
  try {
    let shouldRunLocalSetup = false;
    let shouldRunVoiceSetup = false;
    if (needsLocal) {
      const localStatus = await getLocalAiStatus(cfg);
      localAiStatusCache = localStatus;
      if (!localStatus.ready) {
        shouldRunLocalSetup = true;
      }
    }
    if (needsVoice) {
      shouldRunVoiceSetup = true;
    }
    if (!shouldRunLocalSetup && !shouldRunVoiceSetup) {
      return { ok: true, skipped: true, alreadyReady: true };
    }

    lastAdminProvisioningPromptAt = Date.now();
    let completedVisibleSetup = false;
    const shouldHideStatusForSetup = shouldRunLocalSetup || shouldRunVoiceSetup;
    if (shouldHideStatusForSetup) requiredProvisioningWindowVisible = true;
    if (shouldHideStatusForSetup && statusWindow && !statusWindow.isDestroyed()) {
      try {
        statusWindow.hide();
      } catch {
        // no-op
      }
    }
    const parentWindow = undefined;
    pushActivity("Installation requise par l'organisation.");
    if (shouldRunLocalSetup && !options.silent) pushActivity("Préparation du moteur local demandée par l'organisation.");
    if (shouldRunVoiceSetup && !options.silent) pushActivity("Préparation de la dictée locale demandée par l'organisation.");
    if (shouldRunLocalSetup) {
      const result = await runLocalAiSetup({
        ...policy.localAi,
        model: effectiveLocalAiModel(policy.localAi, cfg.defaultLocalModel),
        mandatory: true,
        focus: !options.silent,
        parentWindow,
      });
      localAiStatusCache = await getLocalAiStatus(loadConfig({ hydrateSecrets: false }));
      if (!result?.ok) throw new Error("Configuration locale interrompue.");
      completedVisibleSetup = true;
    }
    if (shouldRunVoiceSetup) {
      const result = await runVoiceSetup({ ...policy.voice, mandatory: true, focus: !options.silent, parentWindow });
      if (!result?.ok) throw new Error("Configuration de la dictée locale interrompue.");
      registerVoiceShortcut();
      completedVisibleSetup = true;
    }
    if (completedVisibleSetup) {
      void flushPendingBrowserSession();
      requiredProvisioningWindowVisible = false;
      if (revealStatusAfterProvisioning) {
        revealStatusAfterProvisioning = false;
        showStatusWindow({ focus: false });
      }
    }
    refreshStatusWindow();
    updateTrayMenu();
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    bridgeError = message;
    pushActivity(`Préparation locale échouée: ${message}`);
    refreshStatusWindow();
    updateTrayMenu();
    return { ok: false, error: message };
  } finally {
    adminProvisioningRunning = false;
  }
}

async function ensureRequiredProvisioningComplete(reason = "action") {
  const cfg = loadConfig();
  const policy = normalizeAiPolicy(cfg.aiPolicy);
  const required =
    (policy.localAi.enabled && policy.localAi.installRequired) ||
    (policy.voice.enabled && policy.voice.installRequired);
  if (!required) return { ok: true, skipped: true };
  if (adminProvisioningRunning) {
    return {
      ok: false,
      error: "Installation requise en cours. Termine l'installation demandée par votre organisation.",
    };
  }

  const result = await ensureAdminProvisioning(cfg, { silent: true, reason });
  if (!result?.ok) {
    return {
      ok: false,
      error: result?.error || "Installation requise par votre organisation.",
    };
  }

  const refreshed = loadConfig({ hydrateSecrets: false });
  const localAi = policy.localAi.enabled ? await getLocalAiStatus(refreshed) : placeholderLocalAiStatus(refreshed);
  localAiStatusCache = localAi;
  const voice = getVoiceStatus(refreshed);
  const missing = requiredProvisioningState(localAi, voice);
  if (missing.required) {
    return {
      ok: false,
      error: missing.label || "Installation requise par votre organisation.",
      requiredProvisioning: missing,
    };
  }
  return { ok: true };
}

async function openService(serviceId, options = {}) {
  let cfg = loadConfig();
  let service = cfg.services.find((candidate) => candidate.serviceId === serviceId);
  if (!service) return { ok: false, error: "service-not-found" };
  localStatuses[serviceId] = "reconnecting";
  refreshStatusWindow();

  let target = serviceLaunchBaseUrl(service);
  if (!target) return { ok: false, error: "service-url-invalid" };
  const browserSessionId = String(options.browserSessionId || "").trim().slice(0, 160) || createBrowserSessionId();
  const protocolReturnUrl = cleanExternalUrl(options.returnUrl);
  let usesLaunchTicket = false;
  try {
    try {
      await refreshSupabaseSessionIfNeeded(cfg);
      if (runtimeHandle?.syncOnce) {
        await runtimeHandle.syncOnce().catch((err) => {
          bridgeError = err instanceof Error ? err.message : String(err);
        });
        cfg = loadConfig();
        service = cfg.services.find((candidate) => candidate.serviceId === serviceId) || service;
      }
      const provisioning = await ensureRequiredProvisioningComplete("open-service");
      if (!provisioning.ok) {
        const err = new Error(provisioning.error || "Installation requise par votre organisation.");
        err.bridgeProvisioningRequired = true;
        throw err;
      }
      cfg = loadConfig();
      if (cfg.controlPlaneBaseUrl && (cfg.bridgeToken || cfg.session?.accessToken)) {
        await postControlPlane(cfg, "bridge/browser-session", {
          browserSessionId,
          returnUrl: protocolReturnUrl || target,
          state: localStatusPayload(),
        }, { timeoutMs: 2500 }).catch((err) => {
          bridgeError = err instanceof Error ? err.message : String(err);
        });
        const ticket = await postControlPlane(cfg, "bridge/launch-ticket", {
          serviceId: service.serviceId,
          serviceInstanceId: service.serviceInstanceId,
          returnTo: protocolReturnUrl || target,
        }, { timeoutMs: 4000 }).catch((err) => {
          bridgeError = err instanceof Error ? err.message : String(err);
          pushActivity(`Ouverture ${service.name} sans ticket Bridge: ${bridgeError}`);
          return null;
        });
        if (ticket?.launchUrl) {
          const launchUrl = cleanExternalUrl(ticket.launchUrl);
          if (launchUrl) {
            target = serviceLaunchUrl(service, launchUrl);
            usesLaunchTicket = true;
          } else {
            pushActivity(`Ouverture ${service.name} sans ticket Bridge: URL de ticket invalide.`);
          }
        }
      }
    } catch (err) {
      if (err?.bridgeProvisioningRequired) throw err;
      if (target) {
        bridgeError = err instanceof Error ? err.message : String(err);
        pushActivity(`Ouverture ${service.name} sans ticket Bridge: ${bridgeError}`);
      } else {
        throw err;
      }
    }
    if (usesLaunchTicket && cfg.controlPlaneBaseUrl) {
      target = appendQueryParam(target, "bridgeControlPlaneUrl", cfg.controlPlaneBaseUrl);
    }
    target = appendQueryParam(target, "browserSessionId", browserSessionId);
    await shell.openExternal(target);
    hideStatusWindowAfterLaunch();
    setTimeout(hideStatusWindowAfterLaunch, 900);
    localStatuses[serviceId] = "active";
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

function hideStatusWindowAfterLaunch() {
  if (!statusWindow || statusWindow.isDestroyed()) return;
  statusWindow.setAlwaysOnTop(false);
  if (process.platform === "darwin") {
    statusWindow.hide();
    app.hide();
  } else {
    statusWindow.minimize();
  }
}

function serviceLaunchBaseUrl(service) {
  return cleanExternalUrl(service.baseUrl);
}

function serviceLaunchUrl(service, launchUrl) {
  return launchUrl;
}

function createBrowserSessionId() {
  return `bs_${cryptoRandomId().replace(/-/g, "")}`;
}

function appendQueryParam(inputUrl, key, value) {
  try {
    const url = new URL(inputUrl);
    if (!url.searchParams.has(key)) url.searchParams.set(key, value);
    return url.toString();
  } catch {
    return inputUrl;
  }
}

async function postControlPlane(cfg, route, payload, options = {}) {
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
  let timeout = null;
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  if (controller && Number(options.timeoutMs) > 0) {
    timeout = setTimeout(() => controller.abort(), Number(options.timeoutMs));
  }
  const res = await fetch(url, {
    method: "POST",
    headers,
    signal: controller?.signal,
    body: JSON.stringify({
      organizationId: cfg.organizationId || cfg.account?.organizationId,
      bridgeId: cfg.bridgeId,
      installId: cfg.installId,
      deviceId: cfg.deviceId,
      userId: cfg.userId || cfg.account?.userId,
      sentAt: new Date().toISOString(),
      payload,
    }),
  }).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    if (res.status === 401 && cfg.session?.refreshToken && !options.afterRefresh) {
      await refreshSupabaseSessionIfNeeded(cfg);
      return postControlPlane(cfg, route, payload, { afterRefresh: true });
    }
    if (res.status === 401 && cfg.session?.refreshToken) {
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

function showStatusWindow({ focus = false } = {}) {
  if (requiredProvisioningWindowVisible) {
    if (statusWindow && !statusWindow.isDestroyed()) {
      try {
        statusWindow.hide();
      } catch {
        // no-op
      }
    }
    return statusWindow;
  }
  if (statusWindow && !statusWindow.isDestroyed()) {
    statusWindow.setAlwaysOnTop(false);
    if (focus) {
      statusWindow.show();
      statusWindow.focus();
    } else {
      statusWindow.showInactive();
    }
    refreshStatusWindow();
    return statusWindow;
  }
  statusWindow = new BrowserWindow({
    show: false,
    width: 760,
    height: 560,
    minWidth: 680,
    minHeight: 480,
    title: PRODUCT_NAME,
    resizable: true,
    alwaysOnTop: false,
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
    ipcMain.handle("bridge:setup-codex", async () => {
      const result = await runCodexSetup();
      const codex = resetCodexStatusCache();
      pushActivity(codex.ready ? "ChatGPT Codex est prêt sur ce poste." : "Configuration ChatGPT Codex à terminer.");
      refreshStatusWindow();
      updateTrayMenu();
      return { ...result, codex };
    });
    ipcMain.handle("bridge:setup", async () => {
      const cfg = loadConfig();
      const result = await runBridgeSetup({ aiPolicy: cfg.aiPolicy });
      const codex = resetCodexStatusCache();
      localAiStatusCache = await getLocalAiStatus(loadConfig({ hydrateSecrets: false }));
      pushActivity(result?.ok ? "Bridge est configuré sur ce poste." : "Configuration Bridge à terminer.");
      refreshStatusWindow();
      updateTrayMenu();
      return { ...result, codex, localAi: localAiStatusCache };
    });
    ipcMain.handle("bridge:ensure-admin-provisioning", () => ensureAdminProvisioning(loadConfig(), { silent: false }));
    ipcMain.handle("bridge:local-ai-set-model", async (_event, model) => {
      const cfg = loadConfig();
      const localAi = normalizeAiPolicy(cfg.aiPolicy).localAi;
      if (!localAi.allowUserModelOverride) return { ok: false, error: "model-locked-by-admin" };
      const clean = cleanLocalAiModel(model);
      if (!clean) return { ok: false, error: "model-required" };
      const prefs = saveLocalAiPrefs({ localModel: clean });
      cfg.defaultLocalModel = effectiveLocalAiModel(localAi, clean);
      saveConfig(cfg);
      const provisioning = await ensureAdminProvisioning(loadConfig(), { silent: false });
      localAiStatusCache = await getLocalAiStatus(loadConfig({ hydrateSecrets: false }));
      restartRuntime();
      refreshStatusWindow();
      updateTrayMenu();
      return { ok: true, localModel: prefs.localModel, localAi: localAiStatusCache, provisioning };
    });
    ipcMain.handle("bridge:voice-status", () => getVoiceStatus(loadConfig({ hydrateSecrets: false })));
    ipcMain.handle("bridge:voice-change-shortcut", () => changeVoiceShortcutFromMenu());
    ipcMain.handle("bridge:voice-set-shortcut", (_event, shortcut) => {
      const cfg = loadConfig({ hydrateSecrets: false });
      const voice = normalizeAiPolicy(cfg.aiPolicy).voice;
      if (!voice.allowUserShortcutOverride) return { ok: false, error: "shortcut-locked-by-admin" };
      const clean = String(shortcut || "").trim().slice(0, 120);
      if (!clean) return { ok: false, error: "shortcut-required" };
      return voiceShortcutSaveResult(clean);
    });
    ipcMain.handle("bridge:voice-test-overlay", () => {
      showVoiceOverlay({ mode: "listening", autoClose: true });
      return { ok: true };
    });
    ipcMain.handle("bridge:voice-toggle", () => toggleVoiceDictation());
    ipcMain.handle("bridge:voice-test-microphone", () => {
      showVoiceOverlay({ mode: "listening", autoClose: true });
      return runVoiceSidecar(["test-microphone", "--duration-ms", "800"], 5000);
    });
    ipcMain.handle("bridge:open-codex-help", () => shell.openExternal("https://help.openai.com/en/articles/11381614-api-codex-cli-and-sign-in-with-chatgpt"));
    ipcMain.handle("bridge:sign-out", () => signOut());
    ipcMain.handle("bridge:reveal-data-dir", () => revealDataDir());
  }
  statusWindow.setAlwaysOnTop(false);
  statusWindow.once("ready-to-show", () => {
    if (!statusWindow || statusWindow.isDestroyed()) return;
    statusWindow.setAlwaysOnTop(false);
    if (requiredProvisioningWindowVisible) {
      statusWindow.hide();
      return;
    }
    if (focus) {
      statusWindow.show();
      statusWindow.focus();
    } else {
      statusWindow.showInactive();
    }
  });
  statusWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(statusHtml())}`);
  return statusWindow;
}

function refreshStatusWindow() {
  if (!statusWindow || statusWindow.isDestroyed()) return;
  if (requiredProvisioningWindowVisible) {
    try {
      statusWindow.hide();
    } catch {
      // no-op
    }
    return;
  }
  statusWindow.webContents.send("bridge:status", localStatusPayload());
}

function statusHtml() {
  const design = loadBridgeDesign();
  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Bridge</title>
  <style>
    * { box-sizing: border-box; }
    ${bridgeDesignCss(design)}
    body { margin: 0; min-height: 100vh; font-family: var(--font-sans); background: var(--bg); color: var(--fg); }
    main { min-height: 100vh; }
    header { display: none; }
    .brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
    .mark { width: 34px; height: 34px; flex: 0 0 auto; display: block; }
    h1 { font-size: 18px; line-height: 1.1; margin: 0; letter-spacing: 0; }
    .subtitle { color: var(--muted); font-size: 12px; margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .top-actions { display: flex; gap: 8px; align-items: center; position: relative; }
    .status-pill { display: inline-flex; align-items: center; gap: 6px; min-height: 28px; border: 1px solid var(--line); border-radius: var(--radius-pill); background: var(--panel); padding: 4px 9px; font-size: 12px; font-weight: 700; color: var(--muted); white-space: nowrap; }
    .status-pill::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--grey); }
    .status-pill.ready { color: var(--green); border-color: var(--green-border); background: var(--green-bg); }
    .status-pill.ready::before { background: var(--green); }
    .status-pill.warning { color: var(--amber); border-color: var(--amber-border); background: var(--amber-bg); }
    .status-pill.warning::before { background: var(--amber); }
    .status-pill.version::before { display: none; }
    button { border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--panel); color: var(--fg); padding: 8px 10px; font-size: 13px; font-weight: 650; cursor: pointer; min-height: 34px; }
    button:hover { border-color: var(--border-strong); }
    button:disabled { opacity: .55; cursor: progress; }
    button.primary { background: var(--accent); color: var(--on-accent); border-color: var(--accent); }
    button.icon { width: 34px; padding: 0; display: grid; place-items: center; }
    .menu-wrap { position: relative; }
    .menu-popover { position: absolute; top: calc(100% + 8px); right: 0; width: 260px; max-height: 420px; overflow: auto; border: 1px solid var(--line); background: var(--panel); border-radius: var(--radius); box-shadow: var(--shadow); padding: 8px; z-index: 20; display: none; }
    .menu-popover.open { display: block; }
    .menu-item { width: 100%; display: flex; justify-content: space-between; align-items: center; gap: 10px; border: 0; background: transparent; text-align: left; border-radius: 7px; padding: 9px 10px; font-weight: 650; }
    .menu-item:hover { background: var(--subtle); }
    .menu-title { color: var(--muted); font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: .04em; padding: 7px 10px 5px; }
    .menu-activity { display: grid; gap: 0; margin-top: 4px; border-top: 1px solid var(--line); padding-top: 6px; }
    .menu-activity-row { display: grid; gap: 2px; border-radius: 7px; padding: 7px 10px; font-size: 12px; color: var(--muted); }
    .menu-activity-row strong { color: var(--fg); font-weight: 600; overflow-wrap: anywhere; }
    .menu-version { display: flex; justify-content: space-between; gap: 10px; padding: 9px 10px; border-radius: 7px; color: var(--muted); font-size: 12px; font-weight: 700; }
    .menu-version strong { color: var(--fg); }
    nav { display: none; }
    nav button { border-color: transparent; background: transparent; color: var(--muted); min-height: 32px; }
    nav button.active { color: var(--fg); background: var(--subtle); border-color: var(--border-strong); }
    section { display: none; padding: 54px 46px 40px; overflow: auto; }
    section.active { display: block; }
    .dashboard-intro { position: fixed; top: 16px; right: 18px; z-index: 3; display: inline-flex; gap: 8px; align-items: center; }
    .hero-panel, .health-panel { border: 1px solid var(--line); background: color-mix(in srgb, var(--paper) 86%, transparent); border-radius: var(--radius); padding: 16px; box-shadow: var(--shadow); }
    .hero-panel h2 { font-size: 22px; margin: 0 0 5px; letter-spacing: 0; }
    .hero-panel p, .health-panel p { margin: 0; color: var(--muted); font-size: 12px; }
    .health-panel { display: grid; gap: 12px; max-width: 720px; }
    .health-head { display: flex; justify-content: space-between; align-items: start; gap: 12px; }
    .health-head strong { font-size: 13px; }
    .health-score { display: inline-flex; align-items: center; gap: 6px; color: var(--green); font-weight: 800; font-size: 12px; }
    .health-score.warning { color: var(--amber); }
    .health-score::before { content:""; width: 9px; height: 9px; border-radius: 99px; background: currentColor; box-shadow: 0 0 0 4px color-mix(in srgb, currentColor 14%, transparent); }
    .health-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
    .health-stat { border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 9px; background: var(--panel); min-width: 0; }
    .health-stat span { display: block; color: var(--muted); font-size: 11px; margin-bottom: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .health-stat strong { display: block; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .codex-mini { display: inline-flex; align-items: center; gap: 7px; min-height: 28px; border: 1px solid var(--line); border-radius: var(--radius-pill); background: color-mix(in srgb, var(--paper) 82%, transparent); padding: 4px 9px; color: var(--green); font-size: 12px; font-weight: 750; box-shadow: var(--shadow); backdrop-filter: blur(12px); }
    .codex-mini.version { color: var(--muted); }
    .codex-mini.version .dot { display: none; }
    button.codex-mini { cursor: pointer; }
    .codex-mini.warning { color: var(--amber); }
    .codex-mini.error { color: var(--red); border-color: var(--red-border); background: var(--red-bg); }
    .codex-mini .dot { width: 8px; height: 8px; border-radius: 99px; background: currentColor; box-shadow: none; }
    .services { min-height: calc(100vh - 94px); display: grid; grid-template-columns: repeat(3, 128px); gap: 38px 42px; align-content: center; justify-content: center; align-items: start; }
    .services.provisioning { grid-template-columns: minmax(0, 520px); gap: 0; align-content: center; justify-content: center; }
    .provisioning-panel { width: min(520px, calc(100vw - 72px)); border: 1px solid var(--line); background: var(--panel); border-radius: var(--radius); box-shadow: var(--shadow); padding: 22px; display: grid; gap: 12px; }
    .provisioning-panel h2 { margin: 0; font-size: 22px; line-height: 1.2; letter-spacing: 0; }
    .provisioning-panel p { margin: 0; color: var(--muted); font-size: 14px; line-height: 1.45; }
    .provisioning-panel button { justify-self: start; }
    .login-hero { min-height: calc(100vh - 94px); display: grid; align-content: center; justify-content: center; }
    .login-hero .login-form { width: min(380px, calc(100vw - 64px)); }
    .login-hero .codex-card { display: none; }
    .codex-card { display: grid; grid-template-columns: 18px 1fr auto; gap: 12px; align-items: center; border: 1px solid var(--line); background: var(--panel); border-radius: var(--radius-sm); padding: 12px; margin-bottom: 12px; }
    .codex-card .codex-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
    .codex-card.ready { border-color: var(--green-border); background: var(--green-bg); }
    .codex-card.missing, .codex-card.login_required, .codex-card.error { border-color: var(--amber-border); background: var(--amber-bg); }
    .codex-card.ready .dot { background: var(--green); box-shadow: 0 0 0 4px color-mix(in srgb, var(--green) 14%, transparent); }
    .codex-card.missing .dot, .codex-card.login_required .dot, .codex-card.error .dot { background: var(--amber); box-shadow: 0 0 0 4px color-mix(in srgb, var(--amber) 14%, transparent); }
    .codex-card code { font-family: var(--font-mono); color: var(--fg); background: var(--subtle); padding: 2px 4px; border-radius: 4px; }
    .app-card { appearance: none; border: 0; background: transparent; padding: 0; color: var(--fg); min-height: 0; width: 128px; display: grid; justify-items: center; gap: 12px; text-align: center; cursor: pointer; position: relative; }
    .app-card:hover { text-decoration: none; }
    .app-card:disabled { cursor: progress; opacity: .72; }
    .app-icon { width: 118px; height: 118px; border-radius: var(--radius-sm); background: var(--panel); box-shadow: var(--shadow); display: grid; place-items: center; border: 1px solid color-mix(in srgb, var(--border) 72%, transparent); position: relative; transition: transform var(--t-fast) var(--ease), box-shadow var(--t-fast) var(--ease); }
    .app-card:hover .app-icon { transform: translateY(-2px); box-shadow: var(--shadow-hover); }
    .app-icon svg { width: 74px; height: 74px; display: block; }
    .app-card.active .app-icon::after, .app-card.reconnecting .app-icon::after { content:""; position:absolute; inset:auto 12px 10px; height:3px; border-radius:99px; background: linear-gradient(90deg, transparent, var(--blue), transparent); animation: move 1.15s linear infinite; }
    .app-card.codex_unready .app-icon, .app-card.cloud_stale .app-icon { border-color: var(--amber-border); }
    .app-card.disconnected .app-icon, .app-card.site_unreachable .app-icon, .app-card.local_unavailable .app-icon { border-color: var(--red-border); }
    .app-card.placeholder { cursor: default; opacity: .48; filter: grayscale(.12); }
    .app-card.placeholder .app-icon { box-shadow: var(--shadow); }
    .app-card.placeholder:hover .app-icon { transform: none; box-shadow: var(--shadow); }
    .app-label { display: grid; gap: 2px; width: 100%; min-width: 0; }
    .app-label strong { font-size: 16px; line-height: 1.2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .app-label span { color: var(--muted); font-size: 11px; text-transform: lowercase; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .app-badge { display: none; }
    .connected .app-badge { background: var(--green); }
    .active .app-badge, .reconnecting .app-badge { background: var(--blue); }
    .codex_unready .app-badge, .cloud_stale .app-badge { background: var(--amber); }
    .disconnected .app-badge, .site_unreachable .app-badge, .local_unavailable .app-badge { background: var(--red); }
    .service-row { display: grid; grid-template-columns: 18px 1fr auto; gap: 12px; align-items: center; border: 1px solid var(--line); background: var(--panel); border-radius: 8px; padding: 12px; min-height: 72px; position: relative; overflow: hidden; }
    .service-row.active::before, .service-row.reconnecting::before { content:""; position:absolute; left:-30%; right:-30%; bottom:0; height:2px; background: linear-gradient(90deg, transparent, var(--blue), transparent); animation: move 1.15s linear infinite; }
    @keyframes move { from { transform: translateX(-30%); } to { transform: translateX(30%); } }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--grey); box-shadow: 0 0 0 4px color-mix(in srgb, var(--grey) 14%, transparent); }
    .connected .dot { background: var(--green); box-shadow: 0 0 0 4px color-mix(in srgb, var(--green) 14%, transparent); }
    .service-row.active .dot, .service-row.reconnecting .dot { background: var(--blue); box-shadow: 0 0 0 4px color-mix(in srgb, var(--blue) 14%, transparent); }
    .service-row.paused .dot { background: var(--grey); }
    .service-row.cloud_stale .dot { background: var(--amber); box-shadow: 0 0 0 4px color-mix(in srgb, var(--amber) 14%, transparent); }
    .service-row.disconnected .dot { background: var(--red); box-shadow: 0 0 0 4px color-mix(in srgb, var(--red) 14%, transparent); }
    .service-row.site_unreachable .dot { background: var(--red); box-shadow: 0 0 0 4px color-mix(in srgb, var(--red) 14%, transparent); }
    .service-row.local_unavailable .dot { background: var(--red); box-shadow: 0 0 0 4px color-mix(in srgb, var(--red) 14%, transparent); }
    .service-row.codex_unready .dot { background: var(--amber); box-shadow: 0 0 0 4px color-mix(in srgb, var(--amber) 14%, transparent); }
    .service-main { min-width: 0; }
    .service-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .service-title strong { font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .state { color: var(--muted); font-size: 12px; text-transform: lowercase; }
    .meta { color: var(--muted); font-size: 12px; margin-top: 5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .service-actions { display: flex; gap: 8px; align-items: center; }
    .grid { display: grid; gap: 12px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .panel { border: 1px solid var(--line); background: var(--panel); border-radius: 8px; padding: 14px; }
    .panel h2 { font-size: 13px; margin: 0 0 10px; }
    .login-form { display: grid; gap: 12px; margin-bottom: 12px; border-radius: 14px; padding: 18px; box-shadow: var(--shadow); }
    .login-form h2 { font-size: 24px; margin-bottom: 2px; }
    .login-form label { display: grid; gap: 6px; color: var(--muted); font-size: 12px; font-weight: 650; }
    .login-form input { width: 100%; border: 1px solid var(--line); border-radius: var(--radius-sm); min-height: 40px; padding: 8px 10px; font: inherit; color: var(--fg); background: var(--panel); }
    .login-form input:focus { outline: 3px solid var(--accent-soft); border-color: var(--accent); }
    .login-form details { border: 1px solid var(--line); border-radius: 8px; padding: 9px; display: grid; gap: 8px; }
    .login-form summary { cursor: pointer; color: var(--muted); font-size: 12px; }
    .form-message { min-height: 18px; margin: 0; color: var(--red); font-size: 12px; }
    .kv { display: grid; grid-template-columns: 130px minmax(0, 1fr); gap: 8px; color: var(--muted); font-size: 12px; }
    .kv strong { color: var(--fg); font-weight: 600; overflow-wrap: anywhere; }
    .empty { color: var(--muted); font-size: 13px; padding: 18px 0; }
    .error { display: none; }
    @media (max-width: 760px) {
      .services { grid-template-columns: repeat(3, 104px); gap: 28px 22px; padding-top: 8px; }
      .app-card { width: 104px; }
      .app-icon { width: 96px; height: 96px; }
      .app-icon svg { width: 64px; height: 64px; }
      section { padding-inline: 20px; }
    }
    @media (max-width: 420px) {
      .services { grid-template-columns: 104px; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div class="brand">${bridgeLogoSvg("mark")}<div><h1>Bridge</h1><div class="subtitle" id="subtitle"></div></div></div>
      <div class="top-actions">
        <span class="status-pill version" id="version-pill"></span>
        <span class="status-pill" id="codex-pill"></span>
        <button class="icon" id="sync" title="Synchroniser" aria-label="Synchroniser">R</button>
        <button id="folder">Dossier</button>
        <div class="menu-wrap">
          <button class="icon" id="menu-button" title="Menu" aria-label="Menu" aria-expanded="false">⋯</button>
          <div class="menu-popover" id="menu-popover"></div>
        </div>
      </div>
    </header>
    <nav>
      <button data-tab="bridges" class="active">Apps</button>
      <button data-tab="identity">Identifiants</button>
    </nav>
    <section id="bridges" class="active"><div id="dashboard-overview"></div><div class="services" id="services"></div><p class="error" id="error"></p></section>
    <section id="identity"><div id="login-panel"></div><div class="grid" id="identity-grid"></div></section>
  </main>
  <script>
    let current = null;
    const labels = { connected: "connecté", paused: "pause", reconnecting: "connexion", active: "actif", disconnected: "hors ligne", codex_unready: "codex à connecter", site_unreachable: "site inaccessible", cloud_stale: "à vérifier", local_unavailable: "local indisponible" };
    const codexLabels = { ready: "prêt", missing: "à installer", login_required: "connexion requise", error: "à vérifier", unknown: "inconnu" };
    function esc(value) { return String(value == null ? "" : value).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c])); }
    function render(state) {
      current = state;
      const provisioningRequired = Boolean(state.requiredProvisioning?.required);
      document.getElementById("subtitle").textContent = (state.account?.email || "Compte Bridge non connecté") + " · " + state.services.length + " service(s)";
      const versionPill = document.getElementById("version-pill");
      versionPill.textContent = "v" + (state.version || "dev");
      const codexPill = document.getElementById("codex-pill");
      const codexState = state.codex?.state || "unknown";
      codexPill.textContent = "ChatGPT Codex " + (codexLabels[codexState] || codexState);
      codexPill.className = "status-pill " + (state.codex?.ready ? "ready" : "warning");
      document.getElementById("error").textContent = state.bridgeError || state.lastError || "";
      document.getElementById("dashboard-overview").innerHTML = state.authenticated ? dashboardOverview(state) : "";
      const services = document.getElementById("services");
      services.classList.toggle("provisioning", provisioningRequired);
      if (!state.authenticated) {
        ensureLoginHero(state);
      } else if (provisioningRequired) {
        setUiError(state.requiredProvisioning?.label || "Installation requise par votre organisation.");
        services.innerHTML = '<div class="provisioning-panel">' +
          '<h2>Installation automatique en cours</h2>' +
          '<p>' + esc(state.requiredProvisioning?.items?.map(item => item.label).join(", ") || "Préparation locale") + '</p>' +
          '<p class="muted">Bridge installe et configure le nécessaire sans action utilisateur. La fenêtre de préparation peut rester ouverte pendant le téléchargement.</p>' +
        '</div>';
        if (!window.__bridgeProvisioningPrompted) {
          window.__bridgeProvisioningPrompted = true;
          window.bridge.ensureAdminProvisioning().finally(() => {
            window.__bridgeProvisioningPrompted = false;
          });
        }
      } else {
        setUiError(state.bridgeError || state.lastError || "");
        services.innerHTML = state.services.length ? state.services.map(service => {
        const status = service.status || "disconnected";
        const actionLabel = status === "active" || status === "reconnecting"
          ? "Ouverture..."
          : status === "connected"
            ? "Ouvrir"
            : status === "codex_unready"
              ? "Ouvrir"
            : status === "cloud_stale"
              ? "Reconnecter"
            : service.lastSeenAt
              ? "Reconnecter"
              : "Connecter";
        const actionAttr = 'data-open="' + esc(service.serviceId) + '"';
        return '<button class="app-card ' + esc(status) + '" ' + actionAttr + ' title="' + esc(actionLabel + " " + service.name) + '" aria-label="' + esc(actionLabel + " " + service.name) + '">' +
          '<span class="app-badge" aria-hidden="true"></span>' +
          '<span class="app-icon" aria-hidden="true">' + appIcon(service) + '</span>' +
          '<span class="app-label"><strong>' + esc(service.name) + '</strong></span>' +
        '</button>';
      }).join("") + placeholderApps() : '<p class="empty">Aucune app autorisée.</p>';
        services.querySelectorAll("[data-open]").forEach(btn => {
          if (btn.dataset.bound === "1") return;
          btn.dataset.bound = "1";
          btn.addEventListener("click", async () => {
            btn.disabled = true;
            setUiError("");
            const result = await window.bridge.openService(btn.dataset.open);
            if (!result?.ok) {
              setUiError(result?.error || "Ouverture impossible.");
            }
            btn.disabled = false;
          });
        });
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
        localAiPanel(state.localAi) +
        voicePanel(state.voice);
      attachCodexActions(document);
      attachLocalAiActions(document);
      attachVoiceActions(document);
      renderMenu(state);
    }
    function dashboardOverview(state) {
      const codexState = state.codex?.state || "unknown";
      const codexOk = Boolean(state.codex?.ready);
      const tone = codexOk ? "" : (codexState === "error" || codexState === "missing" || codexState === "login_required" ? "error" : "warning");
      const label = "ChatGPT Codex " + (codexLabels[codexState] || codexState);
      if (codexOk) return '<div class="dashboard-intro"><span class="codex-mini" title="' + esc(state.codex?.detail || "ChatGPT Codex prêt.") + '"><span class="dot" aria-hidden="true"></span><span>' + esc(label) + '</span></span></div>';
      return '<div class="dashboard-intro"><button class="codex-mini ' + tone + '" data-codex-setup="1" title="' + esc((state.codex?.detail || "ChatGPT Codex à reconnecter.") + " Cliquer pour reconnecter.") + '"><span class="dot" aria-hidden="true"></span><span>' + esc(label) + '</span></button></div>';
    }
    function healthStat(label, value) {
      return '<div class="health-stat"><span>' + esc(label) + '</span><strong>' + esc(value) + '</strong></div>';
    }
    function renderMenu(state) {
      const activity = state.activity || [];
      const activityHtml = activity.length ? activity.slice(0, 8).map(item =>
        '<div class="menu-activity-row"><span>' + new Date(item.ts).toLocaleTimeString("fr-FR") + '</span><strong>' + esc(item.message) + '</strong></div>'
      ).join("") : '<div class="menu-activity-row"><strong>Aucune activité récente.</strong></div>';
      document.getElementById("menu-popover").innerHTML =
        '<div class="menu-title">Bridge</div>' +
        '<div class="menu-version"><span>Version installée</span><strong>v' + esc(state.version || "dev") + '</strong></div>' +
        (state.update?.latestVersion && state.update.latestVersion !== state.version ? '<div class="menu-version"><span>Dernière version</span><strong>v' + esc(state.update.latestVersion) + '</strong></div>' : '') +
        '<button class="menu-item" id="menu-sync">Synchroniser<span>R</span></button>' +
        '<button class="menu-item" id="menu-folder">Dossier<span>↗</span></button>' +
        (state.authenticated ? '<button class="menu-item" id="menu-signout">Déconnexion<span>⌫</span></button>' : '') +
        '<div class="menu-activity"><div class="menu-title">Activité</div>' + activityHtml + '</div>';
      document.getElementById("menu-sync")?.addEventListener("click", () => window.bridge.sync());
      document.getElementById("menu-folder")?.addEventListener("click", () => window.bridge.revealDataDir());
      document.getElementById("menu-signout")?.addEventListener("click", () => window.bridge.signOut());
    }
    function setUiError(message) {
      const el = document.getElementById("error");
      if (!el) return;
      el.textContent = message || "";
      el.style.display = message ? "block" : "none";
    }
    function appIcon(service = {}) {
      const id = String(service.serviceId || service.slug || service.name || "").toLowerCase();
      const name = String(service.name || "App").toLowerCase();
      const key = id + " " + name;
      if (key.includes("achat") || key.includes("purchase") || key.includes("supplier")) return achatsLogoSvg();
      return iconGeneric(service.name || service.serviceId || "App");
    }
    function placeholderApps() {
      const apps = [
        { name: "Stock", key: "stock" },
        { name: "Recrutement", key: "recruiting" },
        { name: "CRM", key: "crm" },
        { name: "Connaissance", key: "knowledge" },
        { name: "Flotte", key: "fleet" },
      ];
      return apps.map(app =>
        '<button class="app-card placeholder" disabled aria-label="' + esc(app.name + " indisponible") + '" title="' + esc(app.name + " indisponible") + '">' +
          '<span class="app-icon" aria-hidden="true">' + placeholderIcon(app.key) + '</span>' +
          '<span class="app-label"><strong>' + esc(app.name) + '</strong></span>' +
        '</button>'
      ).join("");
    }
    function placeholderIcon(key) {
      if (key === "stock") return iconSvg('<path d="M48 16 76 32v32L48 80 20 64V32L48 16Z" fill="var(--icon-bg)"/><path d="M48 16 76 32 48 48 20 32 48 16Z" fill="var(--icon-accent)"/><path d="M48 48v32L20 64V32l28 16Z" fill="var(--icon-fg)"/><path d="M48 48v32l28-16V32L48 48Z" fill="var(--icon-fg)" opacity=".72"/>');
      if (key === "recruiting") return iconSvg('<circle cx="48" cy="31" r="14" fill="var(--icon-fg)"/><path d="M23 76c4-17 14-26 25-26s21 9 25 26" fill="var(--icon-accent)"/><circle cx="25" cy="44" r="9" fill="var(--icon-fg)" opacity=".72"/><circle cx="72" cy="44" r="9" fill="var(--icon-accent)" opacity=".72"/>');
      if (key === "crm") return iconSvg('<path d="M22 36h40c9 0 16 7 16 16v4H38c-9 0-16-7-16-16v-4Z" fill="var(--icon-accent)"/><path d="M54 36h20v18c0 8-6 14-14 14H40V50c0-8 6-14 14-14Z" fill="var(--icon-fg)"/><path d="M29 58 55 32" stroke="var(--icon-bg)" stroke-width="9" stroke-linecap="round" opacity=".9"/>');
      if (key === "knowledge") return iconSvg('<path d="M26 22h28c9 0 16 7 16 16v36H34c-7 0-12-5-12-12V26c0-2 2-4 4-4Z" fill="var(--icon-fg)"/><path d="M34 30h26c6 0 10 4 10 10v34H40c-6 0-10-4-10-10V34c0-2 2-4 4-4Z" fill="var(--icon-accent)"/><path d="M40 43h18M40 55h22" stroke="var(--icon-bg)" stroke-width="5" stroke-linecap="round"/>');
      if (key === "fleet") return iconSvg('<path d="M18 56 35 36h29l14 20v12H18V56Z" fill="var(--icon-accent)"/><path d="M36 36h18l8 20H26l10-20Z" fill="var(--icon-fg)"/><circle cx="34" cy="70" r="8" fill="var(--icon-fg)"/><circle cx="66" cy="70" r="8" fill="var(--icon-fg)"/><path d="M22 56h54" stroke="var(--icon-bg)" stroke-width="5" stroke-linecap="round" opacity=".72"/>');
      return iconGeneric("A");
    }
    function iconSvg(body) {
      return '<svg viewBox="0 0 96 96" xmlns="http://www.w3.org/2000/svg">' + body + '</svg>';
    }
    function achatsLogoSvg() {
      return '<svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Purchasing module">' +
        '<rect width="1024" height="1024" rx="224" fill="var(--icon-bg)"/>' +
        '<path d="M306 626V398c0-34 27-61 61-61h36c34 0 61 27 61 61v228c0 34-27 61-61 61h-36c-34 0-61-27-61-61Z" fill="var(--icon-fg)"/>' +
        '<path d="M560 626V506c0-34 27-61 61-61h36c34 0 61 27 61 61v120c0 34-27 61-61 61h-36c-34 0-61-27-61-61Z" fill="var(--icon-accent)"/>' +
        '<path d="M300 754h424" stroke="var(--icon-fg)" stroke-width="52" stroke-linecap="round"/>' +
        '<path d="m688 718 52 36-52 36" fill="none" stroke="var(--icon-fg)" stroke-width="42" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg>';
    }
    function iconGeneric(label) {
      const initial = esc(String(label || "A").trim().slice(0, 1).toUpperCase() || "A");
      return iconSvg('<rect x="20" y="20" width="56" height="56" rx="16" fill="var(--icon-bg)" stroke="var(--icon-border)" stroke-width="2"/><circle cx="34" cy="36" r="12" fill="var(--icon-accent)"/><path d="M29 64 64 29" stroke="var(--icon-fg)" stroke-width="13" stroke-linecap="round"/><circle cx="62" cy="60" r="12" fill="var(--icon-accent)"/><text x="48" y="57" text-anchor="middle" font-family="var(--font-sans)" font-size="24" font-weight="800" fill="var(--icon-bg)" opacity=".92">' + initial + '</text>');
    }
    function codexCard(codex = {}) {
      const state = codex.state || "unknown";
      const version = codex.version ? " · " + codex.version : "";
      const action = codex.ready
        ? '<button data-codex-refresh="1">Tester ChatGPT Codex</button>'
        : '<button data-codex-setup="1" class="primary">' + (state === "missing" ? "Configurer Bridge" : "Connecter Bridge") + '</button><button data-codex-refresh="1">Tester</button>';
      return '<article class="codex-card ' + esc(state) + '">' +
        '<span class="dot" aria-hidden="true"></span>' +
        '<div class="service-main"><div class="service-title"><strong>ChatGPT Codex</strong><span class="state">' + esc(codexLabels[state] || state) + esc(version) + '</span></div>' +
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
    function localAiPanel(localAi = {}) {
      if (!localAi.enabled) return "";
      const locked = !localAi.allowUserModelOverride;
      return '<form class="panel local-ai-form"><h2>Moteur local</h2>' +
        '<div class="kv">' +
          '<span>État</span><strong>' + esc(localAi.label || "-") + '</strong>' +
          '<span>Modèle actif</span><strong>' + esc(localAi.model || "-") + '</strong>' +
          '<span>Modèle admin</span><strong>' + esc(localAi.adminModel || localAi.model || "-") + '</strong>' +
          '<span>LM Studio</span><strong>' + esc(localAi.serverReady ? "actif" : localAi.installed ? "à démarrer" : "à installer") + '</strong>' +
          '<span>Modèle chargé</span><strong>' + esc(localAi.modelReady ? "oui" : "non") + '</strong>' +
        '</div>' +
        '<details><summary>Options locales</summary>' +
          '<label>Modèle local<input name="localModel" value="' + esc(localAi.userModel || localAi.model || "") + '" ' + (locked ? "disabled" : "") + ' /></label>' +
          '<div class="codex-actions"><button type="submit" ' + (locked ? "disabled" : "") + '>Enregistrer</button></div>' +
        '</details>' +
        '<p class="form-message">' + esc(locked ? "Modèle verrouillé par l'organisation." : "") + '</p>' +
      '</form>';
    }
    function voicePanel(voice = {}) {
      if (!voice.enabled) return "";
      const locked = !voice.allowUserShortcutOverride;
      return '<form class="panel voice-form"><h2>Push-to-talk</h2>' +
        '<div class="kv">' +
          '<span>État</span><strong>' + esc(voice.label || "-") + '</strong>' +
          '<span>Modèle</span><strong>' + esc(voice.model || "-") + '</strong>' +
          '<span>Fichier modèle</span><strong>' + esc(voice.modelInstalled ? "installé" : "à installer") + '</strong>' +
          '<span>Micro</span><strong>' + esc(voice.audioReady ? "prêt" : (voice.error || "aucun micro utilisable")) + '</strong>' +
          '<span>Transcription</span><strong>' + esc(voice.transcriptionReady ? "active" : "moteur à finaliser") + '</strong>' +
          '<span>Raccourci natif</span><strong>' + esc(voice.shortcutNative || "-") + '</strong>' +
          '<span>Commande</span><strong>' + esc(voice.shortcutReady ? "active" : (voice.shortcutError || "préparation")) + '</strong>' +
          '<span>Écoute</span><strong>' + esc(voice.recording ? "en cours" : voice.busy ? "traitement" : "arrêtée") + '</strong>' +
        '</div>' +
        '<label>Raccourci<input name="shortcut" value="' + esc(voice.shortcut || "") + '" ' + (locked ? "disabled" : "") + ' /></label>' +
        '<div class="codex-actions"><button type="button" data-voice-shortcut="1" ' + (locked ? "disabled" : "") + '>Changer</button><button type="submit" ' + (locked ? "disabled" : "") + '>Enregistrer</button><button type="button" data-voice-toggle="1" ' + (!voice.audioReady || !voice.modelInstalled ? "disabled" : "") + '>' + esc(voice.recording ? "Arrêter" : "Démarrer") + '</button><button type="button" data-voice-test="1">Tester micro</button></div>' +
        '<p class="form-message"></p>' +
      '</form>';
    }
    function attachLocalAiActions(root) {
      root.querySelectorAll(".local-ai-form").forEach((form) => {
        if (form.dataset.bound === "1") return;
        form.dataset.bound = "1";
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          const message = form.querySelector(".form-message");
          const input = form.querySelector('[name="localModel"]');
          if (message) message.textContent = "Enregistrement...";
          const res = await window.bridge.setLocalAiModel(input?.value || "");
          if (message) {
            message.textContent = res?.ok
              ? res.provisioning?.ok === false
                ? "Modèle enregistré, préparation locale à terminer: " + (res.provisioning.error || "erreur inconnue")
                : "Modèle local enregistré."
              : (res?.error || "Enregistrement impossible.");
          }
        });
      });
    }
    function attachVoiceActions(root) {
      root.querySelectorAll(".voice-form").forEach((form) => {
        if (form.dataset.bound === "1") return;
        form.dataset.bound = "1";
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          const message = form.querySelector(".form-message");
          const input = form.querySelector('[name="shortcut"]');
          if (message) message.textContent = "Enregistrement...";
          const res = await window.bridge.setVoiceShortcut(input?.value || "");
          if (message) message.textContent = res?.ok
            ? res.warning
              ? "Raccourci enregistré, activation à terminer: " + res.warning
              : "Raccourci enregistré et actif."
            : (res?.error || "Enregistrement impossible.");
        });
      });
      root.querySelectorAll("[data-voice-test]").forEach((btn) => {
        if (btn.dataset.bound === "1") return;
        btn.dataset.bound = "1";
        btn.addEventListener("click", async () => {
          const form = btn.closest(".voice-form");
          const message = form?.querySelector(".form-message");
          btn.disabled = true;
          if (message) message.textContent = "Test du micro...";
          const res = await window.bridge.testVoiceMicrophone();
          if (message) message.textContent = res?.ok ? "Micro détecté." : (res?.error || "Micro indisponible.");
          btn.disabled = false;
        });
      });
      root.querySelectorAll("[data-voice-shortcut]").forEach((btn) => {
        if (btn.dataset.bound === "1") return;
        btn.dataset.bound = "1";
        btn.addEventListener("click", async () => {
          const form = btn.closest(".voice-form");
          const message = form?.querySelector(".form-message");
          const input = form?.querySelector('[name="shortcut"]');
          btn.disabled = true;
          if (message) message.textContent = "Choix du raccourci...";
          const res = await window.bridge.changeVoiceShortcut();
          if (input && res?.shortcut) input.value = res.shortcut;
          if (message) message.textContent = res?.ok
            ? res.warning
              ? "Raccourci enregistré, activation à terminer: " + res.warning
              : "Raccourci enregistré et actif."
            : res?.cancelled
              ? ""
              : (res?.error || "Changement impossible.");
          btn.disabled = false;
        });
      });
      root.querySelectorAll("[data-voice-toggle]").forEach((btn) => {
        if (btn.dataset.bound === "1") return;
        btn.dataset.bound = "1";
        btn.addEventListener("click", async () => {
          const form = btn.closest(".voice-form");
          const message = form?.querySelector(".form-message");
          btn.disabled = true;
          if (message) message.textContent = btn.textContent === "Arrêter" ? "Transcription..." : "Écoute...";
          const res = await window.bridge.toggleVoice();
          if (message) message.textContent = res?.ok ? (res.text ? "Texte inséré." : "Action effectuée.") : (res?.error || "Dictée indisponible.");
          btn.disabled = false;
        });
      });
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
      root.querySelectorAll("[data-codex-setup]").forEach((btn) => {
        if (btn.dataset.bound === "1") return;
        btn.dataset.bound = "1";
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          const old = btn.textContent;
          btn.textContent = "Configuration...";
          await window.bridge.setupBridge();
          btn.textContent = old || "Configurer Bridge";
          btn.disabled = false;
        });
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
        '<h2>Connexion Bridge</h2>' +
        '<label>Site<input name="controlPlaneBaseUrl" type="text" inputmode="url" value="' + esc(url.replace(/^https?:\\/\\//, "")) + '" placeholder="erp.customer.example" required /></label>' +
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
    document.getElementById("menu-button").addEventListener("click", (event) => {
      event.stopPropagation();
      const popover = document.getElementById("menu-popover");
      const open = !popover.classList.contains("open");
      popover.classList.toggle("open", open);
      document.getElementById("menu-button").setAttribute("aria-expanded", String(open));
    });
    document.addEventListener("click", (event) => {
      const wrap = document.querySelector(".menu-wrap");
      if (wrap?.contains(event.target)) return;
      document.getElementById("menu-popover").classList.remove("open");
      document.getElementById("menu-button").setAttribute("aria-expanded", "false");
    });
    window.bridge.onStatus(render);
    window.bridge.getStatus().then(render);
  </script>
</body>
</html>`;
}

function cleanExternalUrl(value) {
  let raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
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
    <rect width="1024" height="1024" rx="224" fill="var(--icon-bg)"/>
    <path d="M322 516h380" fill="none" stroke="var(--icon-fg)" stroke-width="54" stroke-linecap="round"/>
    <path d="M500 360v312" fill="none" stroke="var(--icon-fg)" stroke-width="42" stroke-linecap="round"/>
    <rect x="238" y="376" width="172" height="172" rx="54" fill="var(--icon-fg)"/>
    <rect x="614" y="476" width="172" height="172" rx="54" fill="var(--icon-accent)"/>
    <circle cx="500" cy="516" r="58" fill="var(--icon-bg)" stroke="var(--icon-fg)" stroke-width="42"/>
  </svg>`;
}

function escapeHtml(value) {
  return escapeHtmlAttr(value);
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
