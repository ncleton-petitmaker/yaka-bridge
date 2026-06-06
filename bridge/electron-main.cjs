const { app, BrowserWindow, Menu, nativeImage, shell, Tray, ipcMain } = require("electron");
const { createServer } = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

process.env.APP_BRIDGE_ELECTRON = "1";
process.env.APP_BRIDGE_VERSION = process.env.APP_BRIDGE_VERSION || app.getVersion();

const PRODUCT_NAME = "Bridge";
const PROTOCOL_VERSION = 2;
const HEALTH_PORT = Number(process.env.BRIDGE_HEALTH_PORT || process.env.APP_BRIDGE_HEALTH_PORT || "7707") || 7707;
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

app.on("before-quit", () => {
  isQuitting = true;
  try {
    runtimeHandle?.stop?.();
    localHealthServer?.close();
  } catch {
    // no-op
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && isQuitting) app.quit();
});

app.whenReady().then(() => {
  ensureDirs();
  createTray();
  startRuntimeIfAvailable();
  startLocalHealthServer();
  showStatusWindow();
  refreshExternalStatuses();
  setInterval(refreshExternalStatuses, 15_000);
});

app.on("activate", () => showStatusWindow());

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
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Afficher Bridge", click: () => showStatusWindow() },
    {
      label: `${state.services.filter((service) => service.status === "connected" || service.status === "active").length}/${state.services.length} services connectés`,
      enabled: false,
    },
    { label: localHealthReady ? "Bridge détectable localement" : "Démarrage local...", enabled: false },
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
    updateTrayMenu();
    refreshStatusWindow();
  });
  localHealthServer.listen(HEALTH_PORT, "127.0.0.1", () => {
    localHealthReady = true;
    updateTrayMenu();
    refreshStatusWindow();
  });
}

function localStatusPayload() {
  const cfg = loadConfig();
  const base = runtimeState || stateFromConfig(cfg);
  return {
    ...base,
    services: base.services.map((service) => ({
      ...service,
      status: localStatuses[service.serviceId] || service.status,
    })),
    localHealthReady,
    bridgeError,
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
    controlPlaneConfigured: Boolean(cfg.controlPlaneBaseUrl && cfg.bridgeToken),
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

function loadConfig() {
  const fallback = defaultConfig();
  try {
    if (!fs.existsSync(CONFIG_PATH)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return normalizeConfig({ ...fallback, ...parsed });
  } catch {
    return fallback;
  }
}

function saveConfig(next) {
  const cfg = normalizeConfig(next);
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
  return cfg;
}

function defaultConfig() {
  return normalizeConfig({
    dataDir: DATA_DIR,
    installId: stableInstallId(),
    deviceId: stableInstallId(),
    label: os.hostname(),
    demoMode: true,
    services: [
      {
        serviceId: "crm",
        serviceInstanceId: "demo-org:crm",
        organizationId: "demo-org",
        name: "CRM",
        baseUrl: "http://localhost:3307/dashboard?service=crm",
        healthUrl: "http://localhost:3307/api/health",
        scopes: ["erp:core:read", "erp:events:publish", "codex:run"],
        actions: [{ id: "customer.lookup", label: "Rechercher client" }],
        events: [{ type: "core.customer.updated", label: "Client mis à jour" }],
      },
      {
        serviceId: "purchasing",
        serviceInstanceId: "demo-org:purchasing",
        organizationId: "demo-org",
        name: "Achats",
        baseUrl: "http://localhost:3307/runs?service=purchasing",
        healthUrl: "http://localhost:3307/api/health",
        scopes: ["erp:core:read", "erp:events:consume", "codex:run"],
        actions: [{ id: "supplier.quote.import", label: "Importer offre" }],
        events: [{ type: "purchasing.quote.imported", label: "Offre importée" }],
      },
    ],
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
  const organizationId = cfg.organizationId || cfg.account?.organizationId || "demo-org";
  const services = Array.isArray(cfg.services) ? cfg.services : [];
  return {
    ...cfg,
    dataDir,
    cloudBaseUrl: cfg.controlPlaneBaseUrl || cfg.cloudBaseUrl,
    controlPlaneBaseUrl: cfg.controlPlaneBaseUrl || cfg.cloudBaseUrl,
    installId: cfg.installId || stableInstallId(),
    deviceId: cfg.deviceId || cfg.installId || stableInstallId(),
    label: cfg.label || os.hostname(),
    services: services.map((service) => ({
      ...service,
      organizationId: service.organizationId || organizationId,
      serviceInstanceId: service.serviceInstanceId || `${organizationId}:${service.serviceId}`,
      scopes: Array.isArray(service.scopes) ? service.scopes : [],
      actions: Array.isArray(service.actions) ? service.actions : [],
      events: Array.isArray(service.events) ? service.events : [],
      status: service.paused ? "paused" : service.status || "disconnected",
    })),
    erpBus: cfg.erpBus || { enabled: true, mode: "typed-actions-events", sharedCore: "organization", rules: [] },
    demoMode: cfg.demoMode !== false && !(cfg.controlPlaneBaseUrl && cfg.bridgeToken),
  };
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

async function refreshExternalStatuses() {
  const cfg = loadConfig();
  for (const service of cfg.services) {
    if (service.paused) {
      localStatuses[service.serviceId] = "paused";
      continue;
    }
    if (!service.healthUrl) {
      localStatuses[service.serviceId] = service.status || "connected";
      continue;
    }
    const current = localStatuses[service.serviceId];
    if (current === "active" || current === "reconnecting") continue;
    try {
      const ok = await probe(service.healthUrl);
      localStatuses[service.serviceId] = ok ? "connected" : "disconnected";
    } catch {
      localStatuses[service.serviceId] = "disconnected";
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
    const res = await postControlPlane(cfg, "bridge/sync", localStatusPayload());
    if (Array.isArray(res.services)) cfg.services = res.services;
    if (res.account) cfg.account = res.account;
    if (res.erpBus) cfg.erpBus = res.erpBus;
    saveConfig(cfg);
    pushActivity("Services synchronisés.");
    bridgeError = null;
  } catch (err) {
    bridgeError = err instanceof Error ? err.message : String(err);
    pushActivity(`Synchronisation échouée: ${bridgeError}`);
  }
  refreshStatusWindow();
}

async function openService(serviceId) {
  const cfg = loadConfig();
  const service = cfg.services.find((candidate) => candidate.serviceId === serviceId);
  if (!service) return { ok: false, error: "service-not-found" };
  localStatuses[serviceId] = "reconnecting";
  refreshStatusWindow();

  let target = service.baseUrl;
  try {
    if (cfg.controlPlaneBaseUrl && cfg.bridgeToken) {
      const ticket = await postControlPlane(cfg, "bridge/launch-ticket", {
        serviceId: service.serviceId,
        serviceInstanceId: service.serviceInstanceId,
      });
      if (ticket.launchUrl) target = ticket.launchUrl;
    }
    await shell.openExternal(target);
    localStatuses[serviceId] = "connected";
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

async function postControlPlane(cfg, route, payload) {
  const url = `${String(cfg.controlPlaneBaseUrl).replace(/\/+$/, "")}/${route.replace(/^\/+/, "")}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-bridge-protocol-version": String(PROTOCOL_VERSION),
      "x-bridge-organization-id": cfg.organizationId || cfg.account?.organizationId || "",
      "x-bridge-id": cfg.bridgeId || "",
      "x-bridge-install-id": cfg.installId || "",
      "x-bridge-device-id": cfg.deviceId || "",
      "x-bridge-user-id": cfg.userId || cfg.account?.userId || "",
      "x-bridge-token": cfg.bridgeToken || "",
    },
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
  if (!res.ok) throw new Error(`${route} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

function signOut() {
  const cfg = loadConfig();
  delete cfg.account;
  delete cfg.session;
  delete cfg.userId;
  saveConfig(cfg);
  pushActivity("Compte Bridge déconnecté.");
  refreshStatusWindow();
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
    ipcMain.handle("bridge:open-service", (_event, serviceId) => openService(serviceId));
    ipcMain.handle("bridge:reconnect-service", (_event, serviceId) => openService(serviceId));
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
    .mark { width: 34px; height: 34px; border: 1px solid #cfcfc6; border-radius: 8px; display: grid; place-items: center; background: #fff; color: #111; font-weight: 800; }
    h1 { font-size: 18px; line-height: 1.1; margin: 0; letter-spacing: 0; }
    .subtitle { color: var(--muted); font-size: 12px; margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .top-actions { display: flex; gap: 8px; align-items: center; }
    button { border: 1px solid var(--line); border-radius: 7px; background: #fff; color: var(--fg); padding: 8px 10px; font-size: 13px; font-weight: 650; cursor: pointer; min-height: 34px; }
    button:hover { border-color: #b9bbb3; }
    button.primary { background: #171716; color: #fff; border-color: #171716; }
    button.icon { width: 34px; padding: 0; display: grid; place-items: center; }
    nav { display: flex; gap: 4px; padding: 10px 22px 0; background: #fbfbf8; }
    nav button { border-color: transparent; background: transparent; color: var(--muted); min-height: 32px; }
    nav button.active { color: var(--fg); background: #e8e8e1; border-color: #d0d0c8; }
    section { display: none; padding: 18px 22px 22px; overflow: auto; }
    section.active { display: block; }
    .services { display: grid; gap: 8px; }
    .service-row { display: grid; grid-template-columns: 18px 1fr auto; gap: 12px; align-items: center; border: 1px solid var(--line); background: var(--panel); border-radius: 8px; padding: 12px; min-height: 72px; position: relative; overflow: hidden; }
    .service-row.active::before, .service-row.reconnecting::before { content:""; position:absolute; left:-30%; right:-30%; bottom:0; height:2px; background: linear-gradient(90deg, transparent, var(--blue), transparent); animation: move 1.15s linear infinite; }
    @keyframes move { from { transform: translateX(-30%); } to { transform: translateX(30%); } }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--grey); box-shadow: 0 0 0 4px #ecece8; }
    .connected .dot { background: var(--green); box-shadow: 0 0 0 4px #e2f2e8; }
    .active .dot, .reconnecting .dot { background: var(--blue); box-shadow: 0 0 0 4px #e3edf9; }
    .paused .dot { background: var(--grey); }
    .disconnected .dot { background: var(--red); box-shadow: 0 0 0 4px #f5e6e3; }
    .service-main { min-width: 0; }
    .service-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .service-title strong { font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .state { color: var(--muted); font-size: 12px; text-transform: lowercase; }
    .meta { color: var(--muted); font-size: 12px; margin-top: 5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .service-actions { display: flex; gap: 8px; align-items: center; }
    .grid { display: grid; gap: 12px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .panel { border: 1px solid var(--line); background: var(--panel); border-radius: 8px; padding: 14px; }
    .panel h2 { font-size: 13px; margin: 0 0 10px; }
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
      <div class="brand"><div class="mark">B</div><div><h1>Bridge</h1><div class="subtitle" id="subtitle"></div></div></div>
      <div class="top-actions"><button class="icon" id="sync" title="Synchroniser" aria-label="Synchroniser">R</button><button id="folder">Dossier</button></div>
    </header>
    <nav>
      <button data-tab="bridges" class="active">Bridges</button>
      <button data-tab="identity">Identifiants</button>
      <button data-tab="activity">Activité</button>
    </nav>
    <section id="bridges" class="active"><div class="services" id="services"></div><p class="error" id="error"></p></section>
    <section id="identity"><div class="grid" id="identity-grid"></div></section>
    <section id="activity"><div class="activity" id="activity-list"></div></section>
  </main>
  <script>
    let current = null;
    const labels = { connected: "connecté", paused: "pause", reconnecting: "reconnexion", active: "actif", disconnected: "déconnecté" };
    function esc(value) { return String(value == null ? "" : value).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c])); }
    function render(state) {
      current = state;
      document.getElementById("subtitle").textContent = (state.account?.email || "Compte Bridge non connecté") + " · " + state.services.length + " service(s)";
      document.getElementById("error").textContent = state.bridgeError || state.lastError || "";
      const services = document.getElementById("services");
      services.innerHTML = state.services.length ? state.services.map(service => {
        const status = service.status || "disconnected";
        const scopes = (service.scopes || []).slice(0, 3).join(" · ");
        return '<article class="service-row ' + esc(status) + '">' +
          '<span class="dot" aria-hidden="true"></span>' +
          '<div class="service-main"><div class="service-title"><strong>' + esc(service.name) + '</strong><span class="state">' + esc(labels[status] || status) + '</span></div>' +
          '<div class="meta">' + esc(scopes || service.baseUrl) + '</div></div>' +
          '<div class="service-actions"><button data-open="' + esc(service.serviceId) + '" class="primary">' + (status === "disconnected" ? "Reconnecter" : "Ouvrir") + '</button></div>' +
        '</article>';
      }).join("") : '<p class="empty">Aucun service autorisé.</p>';
      services.querySelectorAll("[data-open]").forEach(btn => btn.addEventListener("click", () => window.bridge.openService(btn.dataset.open)));

      const account = state.account || {};
      document.getElementById("identity-grid").innerHTML =
        panel("Compte", [
          ["Email", account.email || "Non connecté"],
          ["Organisation", account.organizationName || state.organizationId || "Démo"],
          ["Rôle", account.role || "local"],
          ["Session", state.controlPlaneConfigured ? "persistante" : "mode démo"]
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
        '<div class="panel"><h2>Session</h2><button id="signout">Déconnecter</button></div>';
      document.getElementById("signout")?.addEventListener("click", () => window.bridge.signOut());

      const activity = state.activity || [];
      document.getElementById("activity-list").innerHTML = activity.length ? activity.map(item =>
        '<div class="activity-row"><span>' + new Date(item.ts).toLocaleTimeString("fr-FR") + '</span><strong>' + esc(item.message) + '</strong></div>'
      ).join("") : '<p class="empty">Aucune activité récente.</p>';
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
