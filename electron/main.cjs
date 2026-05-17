/**
 * Electron main process pour {{APP_NAME}}.
 *
 * Lance le daemon Hono et Next.js en sidecar, charge l'UI dans une BrowserWindow.
 *
 * Mode dev (npm run electron) : utilise next dev + tsx pour le daemon.
 * Mode pack : utilise next start + daemon compilé.
 *
 * Note : on est en CommonJS (.cjs) parce qu'Electron + ESM est encore capricieux
 * sur certaines versions selon le setup. Les sidecars (Hono + Next) tournent en
 * ESM normalement, c'est juste le main process qui est en CJS.
 *
 * Variables d'environnement (toutes optionnelles, défauts ci-dessous) :
 *   {{APP_NAME_KEBAB_UPPER}}_NEXT_PORT     port du sidecar Next.js
 *   {{APP_NAME_KEBAB_UPPER}}_DAEMON_PORT   port du sidecar Hono daemon
 *   {{DATA_DIR_ENV_VAR}}                   dossier de données (userData/)
 *   {{APP_NAME_KEBAB_UPPER}}_DEVTOOLS=1    ouvre les DevTools en dev
 */
const { app, BrowserWindow, Menu, shell, ipcMain, dialog, clipboard } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const IS_DEV = !app.isPackaged;

// Nom affiché dans le Dock macOS, la menu bar et les notifications.
// À faire AVANT app.whenReady() pour que le menu "appMenu" prenne ce nom,
// et AVANT le premier app.getPath("userData") pour que le dossier userData
// soit calculé sous le bon nom ("{{APP_NAME}}/" plutôt que "Electron/").
app.setName("{{APP_NAME}}");

// File logging : userData/logs/. Capture les sorties des sidecars + console main +
// uncaughtException, pour qu'ils soient récupérables dans le bundle de diagnostic
// même quand l'app est packagée (où stdout est perdu).
const LOG_DIR = path.join(app.getPath("userData"), "logs");
const LOG_MAX_BYTES = 5_000_000;
const logStreams = {};

function openLogStream(name) {
  if (logStreams[name]) return logStreams[name];
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const file = path.join(LOG_DIR, `${name}.log`);
  try {
    const st = fs.statSync(file);
    if (st.size > LOG_MAX_BYTES) {
      const old = path.join(LOG_DIR, `${name}.log.old`);
      try { fs.rmSync(old); } catch {}
      fs.renameSync(file, old);
    }
  } catch {}
  const stream = fs.createWriteStream(file, { flags: "a" });
  logStreams[name] = stream;
  return stream;
}

function safeStringify(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

function setupMainLogging() {
  const stream = openLogStream("electron-main");
  const stamp = () => new Date().toISOString();
  for (const level of ["log", "warn", "error"]) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      orig(...args);
      try {
        const line = args.map((a) => (typeof a === "string" ? a : safeStringify(a))).join(" ");
        stream.write(`[${stamp()}] [${level}] ${line}\n`);
      } catch {}
    };
  }
  process.on("uncaughtException", (err) => {
    try { stream.write(`[${stamp()}] [uncaught] ${err?.stack || err}\n`); } catch {}
  });
  process.on("unhandledRejection", (reason) => {
    try { stream.write(`[${stamp()}] [unhandledRejection] ${reason?.stack || reason}\n`); } catch {}
  });
  console.log(`[main] log dir: ${LOG_DIR}`);
}

setupMainLogging();
if (process.platform === "darwin") {
  app.commandLine.appendSwitch("disable-features", "AppName");
  // Force l'icône du Dock en mode dev (en mode pack, electron-builder s'en occupe)
  if (!app.isPackaged) {
    try {
      const iconPath = path.join(ROOT, "public", "icon-512.png");
      app.dock?.setIcon(iconPath);
    } catch (e) {
      console.warn("[main] dock icon failed:", e?.message);
    }
  }
}

const NEXT_PORT = Number(process.env["{{APP_NAME_KEBAB_UPPER}}_NEXT_PORT"] || {{NEXT_PORT}});
const DAEMON_PORT = Number(process.env["{{APP_NAME_KEBAB_UPPER}}_DAEMON_PORT"] || {{DAEMON_PORT}});
const TARGET_URL = `http://localhost:${NEXT_PORT}/`;

let mainWindow = null;
let daemonProc = null;
let nextProc = null;

function logChild(name, child) {
  const stream = openLogStream(name);
  child.stdout.on("data", (b) => {
    process.stdout.write(`[${name}] ${b}`);
    try { stream.write(b); } catch {}
  });
  child.stderr.on("data", (b) => {
    process.stderr.write(`[${name}] ${b}`);
    try { stream.write(b); } catch {}
  });
  child.on("exit", (code) => console.log(`[${name}] exit ${code}`));
}

// ---------- Auth persistante ----------

function authFilePath() {
  return path.join(app.getPath("userData"), "claude-auth.json");
}
function readClaudeAuth() {
  try { return JSON.parse(fs.readFileSync(authFilePath(), "utf8")); } catch { return {}; }
}
function saveOifAuth(partial) {
  const cur = readClaudeAuth();
  fs.mkdirSync(path.dirname(authFilePath()), { recursive: true });
  fs.writeFileSync(authFilePath(), JSON.stringify({ ...cur, ...partial }, null, 2));
}
// Tente d'extraire un access token OAuth depuis un contenu JSON parsé.
function extractTokenFromJson(content) {
  if (!content || typeof content !== "object") return null;
  if (content?.claudeAiOauth?.accessToken) return content.claudeAiOauth.accessToken;
  if (content?.accessToken) return content.accessToken;
  // Cherche récursivement accessToken dans les valeurs imbriquées (max 2 niveaux)
  for (const val of Object.values(content)) {
    if (val && typeof val === "object") {
      if (val.accessToken) return val.accessToken;
    }
  }
  return null;
}

// Cherche récursivement un fichier JSON contenant un accessToken dans dir (max depth=3).
function findTokenInDir(dir, depth = 0) {
  if (depth > 3) return null;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const t = findTokenInDir(full, depth + 1);
      if (t) return t;
    } else if (e.isFile() && e.name.endsWith(".json")) {
      try {
        const tok = extractTokenFromJson(JSON.parse(fs.readFileSync(full, "utf8")));
        if (tok) { console.log("[credentials] token trouvé dans:", full); return tok; }
      } catch {}
    }
  }
  return null;
}

/**
 * Cherche le token OAuth dans tous les emplacements connus de Claude Code.
 * Ordre : chemins connus → recherche récursive ~/.claude → APPDATA/.claude
 */
function readClaudeOAuthToken() {
  const home = process.env.HOME || process.env.USERPROFILE;
  const appdata = process.env.APPDATA;

  // Chemins connus (vérifiés en premier, rapides)
  const knownPaths = [
    home && path.join(home, ".claude", ".credentials.json"),
    home && path.join(home, ".claude", "credentials.json"),
    appdata && path.join(appdata, "Claude", ".credentials.json"),
    appdata && path.join(appdata, "Claude", "credentials.json"),
    appdata && path.join(appdata, ".claude", ".credentials.json"),
    appdata && path.join(appdata, ".claude", "credentials.json"),
  ].filter(Boolean);

  for (const p of knownPaths) {
    try {
      if (!fs.existsSync(p)) continue;
      const tok = extractTokenFromJson(JSON.parse(fs.readFileSync(p, "utf8")));
      if (tok) { console.log("[credentials] trouvé:", p); return tok; }
    } catch {}
  }

  // Recherche récursive dans ~/.claude/ (attrape tout sous-dossier ou nom de fichier non standard)
  if (home) {
    const t = findTokenInDir(path.join(home, ".claude"));
    if (t) return t;
  }
  if (appdata) {
    const t = findTokenInDir(path.join(appdata, "Claude"));
    if (t) return t;
  }

  return null;
}

function checkClaudeCredentialsExist() {
  return readClaudeOAuthToken() !== null;
}

function checkClaudeAuth() {
  const a = readClaudeAuth();
  if (a.claudeOAuthToken) return true;
  return checkClaudeCredentialsExist();
}

// ---------- Localise le binaire claude depuis le main process ----------

function findClaudeBinFromElectron() {
  const home = process.env.HOME || process.env.USERPROFILE;
  const isWin = process.platform === "win32";
  if (isWin) {
    const r = spawnSync("where.exe", ["claude"], { timeout: 3000, encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().split(/\r?\n/)[0].trim();
    for (const dir of [
      home && path.join(home, ".local", "bin"),
      home && path.join(home, ".claude", "bin"),
    ].filter(Boolean)) {
      const p = path.join(dir, "claude.exe");
      if (fs.existsSync(p)) return p;
    }
    return null;
  }
  const extra = ["/usr/local/bin", "/opt/homebrew/bin",
    home && path.join(home, ".local", "bin"),
    home && path.join(home, ".claude", "bin"),
  ].filter(Boolean);
  const enriched = [process.env.PATH, ...extra].filter(Boolean).join(path.delimiter);
  const r = spawnSync("which", ["claude"], { env: { ...process.env, PATH: enriched }, timeout: 3000, encoding: "utf8" });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  return null;
}

// Si ~/.claude.json est absent mais qu'un backup existe, le restaure.
// Évite l'erreur "Claude configuration file not found" qui fait planter setup-token.
function restoreClaudeJsonIfNeeded() {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return;
  const p = path.join(home, ".claude.json");
  if (fs.existsSync(p)) return; // déjà là, rien à faire
  // Cherche le backup le plus récent dans ~/.claude/backups/
  const backupDir = path.join(home, ".claude", "backups");
  try {
    if (!fs.existsSync(backupDir)) return;
    const files = fs.readdirSync(backupDir)
      .filter((f) => f.startsWith(".claude.json.backup"))
      .sort()
      .reverse(); // les plus récents en premier
    if (files.length > 0) {
      fs.copyFileSync(path.join(backupDir, files[0]), p);
      console.log(`[claude-json] restauré depuis backup : ${files[0]}`);
    }
  } catch (e) {
    console.warn("[claude-json] restauration backup échouée :", e?.message);
  }
}

// Ecrit ~/.claude.json pour sauter le wizard d'onboarding Claude au premier lancement.
function writeClaudeOnboardingSkip() {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return;
  const p = path.join(home, ".claude.json");
  try {
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
    if (!existing.hasCompletedOnboarding) {
      fs.writeFileSync(p, JSON.stringify({
        ...existing,
        hasCompletedOnboarding: true,
        lastOnboardingVersion: "2.1.29",
      }, null, 2));
    }
  } catch {}
}

// ----------

function sidecarEnv() {
  const auth = readClaudeAuth();
  // CLAUDE_CODE_OAUTH_TOKEN attend le token brut (sk-ant-oat01-...), pas un JSON.
  // On extrait accessToken si claudeOAuthToken est un JSON, sinon on l'utilise tel quel.
  let rawToken = null;
  if (auth.claudeOAuthToken) {
    try {
      const parsed = JSON.parse(auth.claudeOAuthToken);
      rawToken = parsed.accessToken || auth.claudeOAuthToken;
    } catch {
      rawToken = auth.claudeOAuthToken;
    }
  }
  return {
    ...process.env,
    "{{APP_NAME_KEBAB_UPPER}}_DAEMON_PORT": String(DAEMON_PORT),
    "{{APP_NAME_KEBAB_UPPER}}_LOG_DIR": LOG_DIR,
    "{{APP_NAME_KEBAB_UPPER}}_APP_VERSION": app.getVersion(),
    ...(rawToken ? { CLAUDE_CODE_OAUTH_TOKEN: rawToken } : {}),
  };
}

function spawnSidecars() {
  if (IS_DEV) {
    daemonProc = spawn("npm", ["run", "start:daemon"], {
      cwd: ROOT,
      env: sidecarEnv(),
      shell: false,
    });
    logChild("daemon", daemonProc);
    nextProc = spawn("npx", ["next", "dev", "-p", String(NEXT_PORT)], {
      cwd: ROOT,
      env: sidecarEnv(),
      shell: false,
    });
    logChild("next", nextProc);
    return;
  }

  // ---------- MODE PACKAGÉ ----------
  // process.execPath est le binaire Electron. Avec ELECTRON_RUN_AS_NODE=1, il
  // se comporte comme Node. On exécute directement des fichiers JS pré-compilés.
  //
  // CRITIQUE : avec asar:true, app.getAppPath() retourne le chemin de
  // app.asar/. Mais child_process.spawn() ne sait PAS lire dans un asar
  // (contrairement à fs). Les fichiers que je veux spawner sont en
  // asarUnpack, donc à app.asar.unpacked/. Il FAUT remplacer le chemin.
  const appRoot = app.getAppPath();
  const unpackedRoot = appRoot.endsWith(".asar")
    ? appRoot + ".unpacked"
    : appRoot.includes(`${path.sep}app.asar${path.sep}`)
    ? appRoot.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
    : appRoot;
  const nodeBin = process.execPath;
  const userDataDir = path.join(app.getPath("userData"), "data");
  const nodeEnv = {
    ...sidecarEnv(),
    ELECTRON_RUN_AS_NODE: "1",
    NODE_ENV: "production",
    "{{DATA_DIR_ENV_VAR}}": userDataDir,
    PORT: String(NEXT_PORT),
    HOSTNAME: "127.0.0.1",
  };

  console.log(`[main] appRoot: ${appRoot}`);
  console.log(`[main] unpackedRoot: ${unpackedRoot}`);
  console.log(`[main] userDataDir: ${userDataDir}`);

  // Synchronise userData/data/.claude depuis data-template/.claude à chaque
  // lancement. Stratégie :
  //  - Les fichiers de .claude/ (CLAUDE.md, schemas, hooks, skills, settings,
  //    commands) sont VERSIONNÉS par l'app et doivent toujours refléter ce
  //    qui est packagé. On les écrase systématiquement (sinon les nouveaux
  //    skills d'une mise à jour ne se propagent pas).
  //  - Les autres dossiers de userData/data/ (candidatures, evaluations,
  //    calibrage, audit-log) sont des DONNÉES utilisateur : on ne touche
  //    JAMAIS leur contenu existant ; on les crée juste s'ils manquent
  //    (par copie depuis data-template, ce qui couvre le 1er lancement).
  try {
    const templateDir = path.join(unpackedRoot, "data-template");
    if (fs.existsSync(templateDir)) {
      fs.mkdirSync(userDataDir, { recursive: true });
      // 1. Sync .claude/ (force overwrite)
      const srcClaude = path.join(templateDir, ".claude");
      const dstClaude = path.join(userDataDir, ".claude");
      if (fs.existsSync(srcClaude)) {
        const forceCopy = (src, dst) => {
          const stat = fs.statSync(src);
          if (stat.isDirectory()) {
            if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
            for (const entry of fs.readdirSync(src)) {
              forceCopy(path.join(src, entry), path.join(dst, entry));
            }
          } else if (stat.isFile()) {
            fs.copyFileSync(src, dst);
          }
        };
        forceCopy(srcClaude, dstClaude);
      }
      // 2. Crée les autres dossiers s'ils manquent (sans écraser)
      const softCopy = (src, dst) => {
        const stat = fs.statSync(src);
        if (stat.isDirectory()) {
          if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
          for (const entry of fs.readdirSync(src)) {
            softCopy(path.join(src, entry), path.join(dst, entry));
          }
        } else if (stat.isFile()) {
          if (!fs.existsSync(dst)) fs.copyFileSync(src, dst);
        }
      };
      for (const entry of fs.readdirSync(templateDir)) {
        if (entry === ".claude") continue;
        softCopy(path.join(templateDir, entry), path.join(userDataDir, entry));
      }
      console.log(`[main] data synchronisé depuis ${templateDir}`);
    } else {
      console.warn(`[main] data-template absent: ${templateDir}`);
    }
  } catch (err) {
    console.error(`[main] init data: ${err?.message || err}`);
  }

  // Daemon : bundle CommonJS produit par scripts/build-server.mjs (esbuild).
  const daemonScript = path.join(unpackedRoot, "dist", "server.cjs");
  if (!fs.existsSync(daemonScript)) {
    console.error(`[main] daemon script introuvable : ${daemonScript}`);
  }
  daemonProc = spawn(nodeBin, [daemonScript], {
    cwd: unpackedRoot,
    env: nodeEnv,
    shell: false,
  });
  logChild("daemon", daemonProc);
  daemonProc.on("error", (e) => console.error(`[daemon] spawn error: ${e.message}`));

  // Next : output 'standalone' produit .next/standalone/server.js auto-suffisant.
  const nextScript = path.join(unpackedRoot, ".next", "standalone", "server.js");
  if (!fs.existsSync(nextScript)) {
    console.error(`[main] next script introuvable : ${nextScript}`);
  }
  nextProc = spawn(nodeBin, [nextScript], {
    cwd: path.join(unpackedRoot, ".next", "standalone"),
    env: nodeEnv,
    shell: false,
  });
  logChild("next", nextProc);
  nextProc.on("error", (e) => console.error(`[next] spawn error: ${e.message}`));
}

async function waitForUrl(url, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 404) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timeout en attendant ${url}`);
}

// Charge un logo optionnel embedded en data URI. Si public/app-icon.svg
// existe, on l'utilise pour les écrans de boot / wizard. Sinon, fallback vide.
const FLAG_PATH = path.join(__dirname, "..", "public", "app-icon.svg");
const FLAG_DATA_URI = (() => {
  try {
    const svg = fs.readFileSync(FLAG_PATH, "utf8");
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  } catch {
    return "";
  }
})();

// Charge les captures d'install Windows en data URI (embed dans le dialog).
function loadScreenshotDataUri(filename) {
  try {
    const p = path.join(__dirname, "..", "public", "screenshots", filename);
    const buf = fs.readFileSync(p);
    return `data:image/png;base64,${buf.toString("base64")}`;
  } catch {
    return "";
  }
}
const WIN_INSTALL_SCREENSHOTS = {
  powershell: loadScreenshotDataUri("win-install-01-powershell.png"),
  pasteWarning: loadScreenshotDataUri("win-install-02a-paste-warning.png"),
  irm: loadScreenshotDataUri("win-install-02b-irm.png"),
  irmSuccess: loadScreenshotDataUri("win-install-02c-installation-success.png"),
  claude: loadScreenshotDataUri("win-install-03-claude.png"),
  theme: loadScreenshotDataUri("win-install-04-theme.png"),
  loginMethod: loadScreenshotDataUri("win-install-05-login-method.png"),
  seConnecter: loadScreenshotDataUri("win-install-06-se-connecter.png"),
  autoriser: loadScreenshotDataUri("win-install-07-autoriser.png"),
  confirmation: loadScreenshotDataUri("win-install-08-confirmation.png"),
  loggedIn: loadScreenshotDataUri("win-install-09-logged-in.png"),
  securityNotes: loadScreenshotDataUri("win-install-10-security-notes.png"),
  trustFolder: loadScreenshotDataUri("win-install-11-trust-folder.png"),
};

// Splash inline minimaliste : affiché immédiatement à la création de la fenêtre,
// remplacé par la vraie page une fois que Next.js a fini de démarrer.
const SPLASH_HTML = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"><title>{{APP_NAME}}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    background: #ffffff; color: #1a1a1a;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    display: flex; align-items: center; justify-content: center;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { text-align: center; }
  .logo {
    width: 140px; height: auto; display: block; margin: 0 auto 24px;
  }
  .brand {
    font-size: 24px; font-weight: 600; letter-spacing: -0.01em;
    color: #1a1a1a; margin-bottom: 6px;
  }
  .sub {
    font-size: 12px; font-weight: 500; letter-spacing: 0.08em;
    text-transform: uppercase; color: #777;
    margin-bottom: 48px;
  }
  .status {
    font-size: 13px; color: #555;
    margin-bottom: 16px; min-height: 18px;
  }
  .bar {
    width: 240px; height: 3px; background: #e5e5e5;
    border-radius: 999px; overflow: hidden; margin: 0 auto;
  }
  .bar::after {
    content: ''; display: block; height: 100%;
    background: linear-gradient(90deg, transparent, #1a1a1a, transparent);
    width: 40%; animation: slide 1.4s ease-in-out infinite;
  }
  @keyframes slide {
    0% { transform: translateX(-150%); }
    100% { transform: translateX(350%); }
  }
</style></head>
<body>
  <div class="wrap">
    ${FLAG_DATA_URI ? `<img class="logo" src="${FLAG_DATA_URI}" alt="App"/>` : ""}
    <div class="brand">{{APP_NAME}}</div>
    <div class="sub">Organisation Internationale de la Francophonie</div>
    <div class="status">Démarrage en cours…</div>
    <div class="bar"></div>
  </div>
</body></html>`;

const SPLASH_URL = `data:text/html;charset=utf-8;base64,${Buffer.from(SPLASH_HTML).toString("base64")}`;

let splashWindow = null;

// Splash window séparée minimaliste, créée le PLUS TÔT POSSIBLE pour
// donner un feedback visuel à l'utilisateur en moins d'une seconde,
// même quand Defender scanne tout au premier lancement post-install.
function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 480,
    height: 320,
    frame: false,
    transparent: false,
    alwaysOnTop: false, // pas alwaysOnTop : sinon il passe devant les dialogs
    resizable: false,
    skipTaskbar: false,
    title: "{{APP_NAME}}",
    backgroundColor: "#ffffff",
    show: true, // critique : show:true direct pour que la fenêtre apparaisse
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  splashWindow.loadURL(SPLASH_URL);
  splashWindow.on("closed", () => (splashWindow = null));
  return splashWindow;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: "{{APP_NAME}}",
    backgroundColor: "#ffffff",
    show: false, // affiché manuellement quand Next a chargé, pour swap propre avec splash
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (IS_DEV && process.env["{{APP_NAME_KEBAB_UPPER}}_DEVTOOLS"] === "1") {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => (mainWindow = null));
}

function setupMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac
      ? [
          {
            // Force le label "{{APP_NAME}}" même en dev où role:'appMenu' afficherait "Electron"
            label: "{{APP_NAME}}",
            submenu: [
              { label: "À propos de {{APP_NAME}}", role: "about" },
              { type: "separator" },
              { label: "Préférences…", accelerator: "Cmd+,", enabled: false },
              { type: "separator" },
              { role: "services", submenu: [] },
              { type: "separator" },
              { label: "Masquer {{APP_NAME}}", accelerator: "Cmd+H", role: "hide" },
              { label: "Masquer les autres", accelerator: "Cmd+Alt+H", role: "hideOthers" },
              { label: "Afficher tout", role: "unhide" },
              { type: "separator" },
              { label: "Quitter {{APP_NAME}}", accelerator: "Cmd+Q", role: "quit" },
            ],
          },
        ]
      : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    {
      label: "Vue",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// IPC : ouvre un dialog OS pour choisir un dossier. Renvoie le chemin absolu ou null.
ipcMain.handle("select-directory", async (_event, opts) => {
  const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, {
    title: opts?.title || "Choisir un dossier",
    defaultPath: opts?.defaultPath,
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// IPC : ouvre un fichier avec l'application native du système (Word, Excel, etc).
ipcMain.handle("open-file", async (_event, absPath) => {
  if (!absPath || typeof absPath !== "string") {
    return { ok: false, error: "chemin invalide" };
  }
  try {
    const err = await shell.openPath(absPath);
    if (err) return { ok: false, error: err };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
});

// IPC : révèle le fichier dans le Finder / Explorer (sélectionne sans ouvrir).
ipcMain.handle("reveal-file", async (_event, absPath) => {
  if (!absPath || typeof absPath !== "string") {
    return { ok: false, error: "chemin invalide" };
  }
  try {
    shell.showItemInFolder(absPath);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
});

// IPC : sauvegarde un buffer ZIP sur disque via dialog Save (défaut Bureau)
// puis révèle le fichier dans le Finder / Explorer. Utilisé pour le bundle
// de diagnostic envoyé au support.
ipcMain.handle("save-debug-bundle", async (_event, payload) => {
  const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
  if (!win) return { ok: false, error: "pas de fenêtre active" };
  const { buffer, filename } = payload || {};
  if (!buffer || !filename) return { ok: false, error: "payload invalide" };
  const desktop = app.getPath("desktop");
  try {
    const result = await dialog.showSaveDialog(win, {
      title: "Enregistrer le diagnostic",
      defaultPath: path.join(desktop, filename),
      filters: [{ name: "Archive ZIP", extensions: ["zip"] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, cancelled: true };
    fs.writeFileSync(result.filePath, Buffer.from(buffer));
    shell.showItemInFolder(result.filePath);
    return { ok: true, path: result.filePath };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
});

/**
 * Vérifie que Claude Code CLI est installé et accessible. C'est une dépendance
 * runtime obligatoire (l'app spawn `claude -p ...`). Si absent, on bloque le
 * lancement des sidecars et on affiche un dialog avec les instructions
 * d'installation natives 2026 (curl/irm, plus besoin de Node ni WSL).
 *
 * Renvoie true si claude est installé, false sinon.
 */
function checkClaudeCli() {
  const home = process.env.HOME || process.env.USERPROFILE;
  const isWin = process.platform === "win32";

  if (isWin) {
    // Sur Windows on aligne avec ce que voit PowerShell (where.exe).
    // shell:true utilise cmd.exe qui trouve claude.cmd même si claude.exe
    // a été supprimé -> faux positif. On évite donc shell:true.
    const whereResult = spawnSync("where.exe", ["claude"], {
      timeout: 5000,
      encoding: "utf8",
    });
    if (whereResult.status === 0 && whereResult.stdout.trim()) {
      // Trouvé dans le PATH courant - on vérifie qu'il tourne
      const ver = spawnSync("claude", ["--version"], {
        timeout: 5000,
        encoding: "utf8",
        shell: true,
      });
      if (ver.status === 0) {
        console.log(`[claude-check] OK (PATH) : ${(ver.stdout || "").trim()}`);
        return true;
      }
    }
    // Cas post-install immédiat : Electron a un PATH figé au démarrage,
    // le registre Windows a déjà la nouvelle entrée mais notre process ne
    // l'a pas encore. On cherche claude.exe directement (pas .cmd/.bat pour
    // éviter les faux positifs sur fichiers résiduels après désinstall).
    const localAppData = process.env.LOCALAPPDATA;
    const extraPaths = [
      home ? path.join(home, ".local", "bin") : null,
      home ? path.join(home, ".claude", "bin") : null,
      // winget peut installer dans %LOCALAPPDATA%\Programs\...
      localAppData ? path.join(localAppData, "Programs", "claude") : null,
      localAppData ? path.join(localAppData, "Programs", "Claude Code") : null,
      localAppData ? path.join(localAppData, "claude", "bin") : null,
    ].filter(Boolean);
    for (const dir of extraPaths) {
      const exePath = path.join(dir, "claude.exe");
      if (fs.existsSync(exePath)) {
        const result = spawnSync(exePath, ["--version"], {
          timeout: 5000,
          encoding: "utf8",
        });
        if (result.status === 0) {
          console.log(`[claude-check] OK (extra) : ${(result.stdout || "").trim()}`);
          return true;
        }
      }
    }
    console.warn("[claude-check] non trouvé (Windows)");
    return false;
  }

  // macOS / Linux : enrichit le PATH car Electron peut avoir un env réduit
  const extraPaths = [
    "/usr/local/bin",
    "/opt/homebrew/bin",
    home ? path.join(home, ".local", "bin") : null,
    home ? path.join(home, ".claude", "bin") : null,
  ].filter(Boolean);
  const enrichedPath = [process.env.PATH, ...extraPaths]
    .filter(Boolean)
    .join(path.delimiter);
  try {
    const result = spawnSync("claude", ["--version"], {
      env: { ...process.env, PATH: enrichedPath },
      timeout: 5000,
      encoding: "utf8",
    });
    if (result.status === 0) {
      console.log(`[claude-check] OK : ${(result.stdout || "").trim()}`);
      return true;
    }
    console.warn(`[claude-check] échec status=${result.status}`);
  } catch (e) {
    console.warn(`[claude-check] non trouvé : ${e?.message || e}`);
  }
  return false;
}

/**
 * Affiche un dialog d'erreur avec les instructions d'install Claude Code.
 * Boutons : copier la commande, ouvrir la doc, quitter.
 * Renvoie l'index du bouton cliqué.
 */
async function showClaudeMissingDialog() {
  const isWin = process.platform === "win32";
  const installCmd = isWin
    ? `irm https://claude.ai/install.ps1 | iex; $b="$env:USERPROFILE\\.local\\bin"; $p=[Environment]::GetEnvironmentVariable("Path","User"); if($p -notlike "*$b*"){[Environment]::SetEnvironmentVariable("Path","$p;$b","User")}; $env:Path=[Environment]::GetEnvironmentVariable("Path","Machine")+";"+[Environment]::GetEnvironmentVariable("Path","User"); claude`
    : "curl -fsSL https://claude.ai/install.sh | bash";
  const terminalName = isWin ? "PowerShell" : "Terminal";
  const terminalHowto = isWin
    ? "Dans la barre de recherche Windows, tapez <code>powershell</code> et lancez Windows PowerShell."
    : "Cmd+Espace puis tapez <code>Terminal</code>.";

  const html = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"><title>Installer Claude Code</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  :root {
    --bg: #faf9f7;
    --bg-panel: #ffffff;
    --bg-subtle: #f4f2ed;
    --border: #ebe8e1;
    --border-soft: #f1eee7;
    --text: #1a1916;
    --text-strong: #0d0c0a;
    --text-muted: #74716b;
    --text-soft: #989590;
    --accent: #c96442;
    --accent-strong: #b45a3b;
    --accent-soft: #f5d8cb;
    --accent-tint: #fbeee5;
  }
  body {
    background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
    overflow: hidden;
  }
  .wrap { height: 100vh; display: grid; grid-template-rows: auto 1fr auto; }
  header {
    padding: 22px 32px 18px;
    display: flex; align-items: center; gap: 14px;
    background: var(--bg-panel);
    border-bottom: 1px solid var(--border);
  }
  header img.logo { width: 40px; height: 40px; object-fit: contain; flex-shrink: 0; }
  header .eyebrow {
    font-size: 10.5px; font-weight: 600; letter-spacing: 0.12em;
    text-transform: uppercase; color: var(--text-muted);
  }
  header h1 {
    font-size: 19px; font-weight: 600; color: var(--text-strong);
    margin-top: 2px; letter-spacing: -0.01em;
  }
  main {
    overflow-y: auto;
    padding: 22px 32px 18px;
    background: var(--bg);
  }
  .lead {
    font-size: 13px; color: var(--text-muted); line-height: 1.6;
    margin-bottom: 22px;
  }
  .step {
    margin-bottom: 22px;
    padding-left: 36px;
    position: relative;
  }
  .step .num {
    position: absolute; left: 0; top: 1px;
    width: 26px; height: 26px; border-radius: 50%;
    background: var(--accent); color: #fff;
    display: inline-flex; align-items: center; justify-content: center;
    font-size: 12px; font-weight: 600;
    box-shadow: 0 0 0 4px var(--accent-tint);
  }
  .step h3 {
    font-size: 14px; font-weight: 600; color: var(--text-strong); margin-bottom: 6px;
    line-height: 1.3;
  }
  .step p {
    font-size: 13px; color: var(--text-muted); line-height: 1.55;
  }
  .step code {
    font-family: 'Consolas', 'JetBrains Mono', 'SF Mono', ui-monospace, Menlo, monospace;
    background: var(--accent-tint);
    color: var(--accent-strong);
    padding: 1px 7px; border-radius: 4px; font-size: 11.5px; font-weight: 500;
  }
  .cmdbox {
    background: #1a1916; color: #f4f2ed;
    border-radius: 8px;
    padding: 14px 16px;
    font-family: 'Consolas', 'JetBrains Mono', 'SF Mono', ui-monospace, Menlo, monospace;
    font-size: 11.5px; line-height: 1.55;
    white-space: pre; overflow-x: auto;
    margin-top: 10px;
    user-select: text;
    border: 1px solid var(--border);
  }
  .shot {
    margin-top: 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
    background: var(--bg-subtle);
    max-width: 380px;
  }
  .shot img {
    display: block;
    width: 100%;
    height: auto;
    max-height: 260px;
    object-fit: contain;
    object-position: center;
  }
  .shot-cap {
    font-size: 11.5px; color: var(--text-soft);
    padding: 8px 12px;
    background: var(--bg-subtle);
    border-top: 1px solid var(--border-soft);
  }
  .divider {
    margin: 22px 0 14px;
    border: none; border-top: 1px solid var(--border);
  }
  .ready {
    background: var(--accent-tint);
    border: 1px solid var(--accent-soft);
    border-radius: 8px;
    padding: 14px 16px;
    font-size: 13px; color: var(--text);
    line-height: 1.55;
  }
  footer {
    padding: 14px 32px;
    background: var(--bg-panel);
    border-top: 1px solid var(--border);
    display: flex; align-items: center; justify-content: flex-end; gap: 8px;
  }
  button {
    padding: 8px 16px;
    font-size: 13px; font-weight: 500;
    border-radius: 6px; cursor: pointer;
    border: 1px solid var(--border);
    background: var(--bg-panel); color: var(--text);
    transition: all 120ms;
    font-family: inherit;
  }
  button:hover { background: var(--bg-subtle); }
  button.primary {
    background: var(--accent); color: #fff; border-color: var(--accent);
  }
  button.primary:hover { background: var(--accent-strong); border-color: var(--accent-strong); }
  button.copied {
    background: #16a34a !important; color: #fff !important; border-color: #16a34a !important;
    transform: scale(1.05);
    box-shadow: 0 0 0 4px rgba(22, 163, 74, 0.2);
  }
  @keyframes flash {
    0% { transform: scale(1); }
    50% { transform: scale(1.08); }
    100% { transform: scale(1.05); }
  }
  button.copied { animation: flash 250ms ease; }
  .toast {
    position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
    background: var(--accent); color: #fff; padding: 8px 16px; border-radius: 8px;
    font-size: 12.5px; font-weight: 500;
    opacity: 0; transition: opacity 200ms;
    pointer-events: none;
    box-shadow: 0 4px 16px rgba(0,0,0,0.1);
  }
  .toast.show { opacity: 1; }
  ::-webkit-scrollbar { width: 8px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border-soft); border-radius: 4px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--border); }

  /* Mode pas-à-pas : une seule étape visible à la fois */
  .step { display: none; }
  .step.active { display: block; animation: fadeIn 180ms ease; }
  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .step-progress {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 16px;
    padding: 12px 14px;
    background: var(--bg-subtle);
    border: 1px solid var(--border-soft);
    border-radius: 8px;
  }
  .step-progress-label {
    font-size: 12px; font-weight: 600;
    color: var(--text);
    letter-spacing: 0.02em;
  }
  .step-dots {
    display: flex; gap: 5px; flex-wrap: wrap;
  }
  .step-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--border);
    border: none; padding: 0;
    cursor: pointer;
    transition: background 120ms;
  }
  .step-dot.active { background: var(--accent); }
  .step-dot:hover { background: var(--accent-soft); }
  .nav-spacer { flex: 1; }
  button:disabled { opacity: 0.4; cursor: not-allowed; }
</style></head>
<body>
<div class="wrap">
  <header>
    <img class="logo" src="${FLAG_DATA_URI}" alt="App"/>
    <div>
      <div class="eyebrow">{{APP_NAME}} · Première étape</div>
      <h1>Installer Claude Code</h1>
    </div>
  </header>

  <main>
    <p class="lead">
      {{APP_NAME}} s'appuie sur Claude Code (Anthropic) pour analyser les dossiers candidats.
      Suivez les étapes ci-dessous pour le mettre en place. Comptez moins d'une minute.
    </p>

    <div class="step-progress">
      <span class="step-progress-label" id="step-counter">Étape 1 / 11</span>
      <div class="step-dots" id="step-dots"></div>
    </div>

    ${
      isWin
        ? `
    <div class="step">
      <span class="num">1</span>
      <h3>Ouvrir Windows PowerShell</h3>
      <p>Dans la barre de recherche Windows, tapez <code>powershell</code> puis cliquez sur Windows PowerShell.</p>
      <figure class="shot">
        <img src="${WIN_INSTALL_SCREENSHOTS.powershell}" alt="Ouvrir PowerShell">
      </figure>
    </div>

    <div class="step" data-needs-copy="1">
      <span class="num">2</span>
      <h3>Copier puis coller la commande dans PowerShell</h3>
      <p>Cliquez sur <strong>Copier la commande</strong> en bas, puis collez dans PowerShell avec <code>Ctrl+V</code>. Windows peut afficher un avertissement (commande sur plusieurs lignes) : cliquez sur <strong>Coller tout de même</strong>, puis validez avec Entrée.</p>
      <figure class="shot">
        <img src="${WIN_INSTALL_SCREENSHOTS.pasteWarning}" alt="Avertissement de collage Windows : Coller tout de même">
      </figure>
      <p style="margin-top:12px; padding:10px 12px; background:var(--accent-tint); border:1px solid var(--accent-soft); border-radius:6px; font-size:13px;">
        ⏳ <strong>Après avoir validé, il ne se passe rien pendant 10 à 30 secondes</strong> : c'est normal, le téléchargement démarre en arrière-plan. Patientez avant de cliquer sur "Suivant".
      </p>
    </div>

    <div class="step">
      <span class="num">3</span>
      <h3>Installation réussie</h3>
      <p>Au bout de 10-30 secondes, le message vert <strong>Claude Code successfully installed!</strong> s'affiche, puis Claude Code se lance automatiquement dans la même fenêtre.</p>
      <figure class="shot">
        <img src="${WIN_INSTALL_SCREENSHOTS.irmSuccess}" alt="Installation Claude Code réussie">
      </figure>
      <p style="margin-top:10px; font-size:12.5px; color:var(--text-muted);">
        Si vous ne voyez pas le message vert, l'installation a échoué (connexion internet, sécurité Windows). Recommencez depuis l'étape 2.
      </p>
    </div>

    <div class="step">
      <span class="num">4</span>
      <h3>Claude Code se lance automatiquement</h3>
      <p>La dernière ligne de la commande lance Claude Code directement, sans que vous ayez à taper quoi que ce soit. Vous devez voir l'interface Claude Code s'afficher dans cette même fenêtre PowerShell.</p>
      <figure class="shot">
        <img src="${WIN_INSTALL_SCREENSHOTS.claude}" alt="Claude Code lancé">
      </figure>
      <p style="margin-top:10px; font-size:12.5px; color:var(--text-muted);">
        Si vous voyez une erreur sur la dernière ligne, l'installation a échoué. Recommencez depuis l'étape 2.
      </p>
    </div>

    <div class="step">
      <span class="num">5</span>
      <h3>Choisir le thème</h3>
      <p>Au premier lancement, Claude Code propose un thème. Le mode sombre est sélectionné par défaut, valider avec Entrée.</p>
      <figure class="shot">
        <img src="${WIN_INSTALL_SCREENSHOTS.theme}" alt="Choisir le thème">
      </figure>
    </div>

    <div class="step">
      <span class="num">6</span>
      <h3>Choisir la méthode de connexion</h3>
      <p>Sélectionnez la première option <strong>Claude account with subscription</strong> (compte Pro, Max, Team ou Enterprise) puis Entrée.</p>
      <figure class="shot">
        <img src="${WIN_INSTALL_SCREENSHOTS.loginMethod}" alt="Choix de la méthode de connexion">
      </figure>
    </div>

    <div class="step">
      <span class="num">7</span>
      <h3>Se connecter dans le navigateur</h3>
      <p>Une page Claude.ai s'ouvre dans votre navigateur. Connectez-vous avec votre compte Claude.ai (Google ou e-mail).</p>
      <figure class="shot">
        <img src="${WIN_INSTALL_SCREENSHOTS.seConnecter}" alt="Se connecter">
      </figure>
    </div>

    <div class="step">
      <span class="num">8</span>
      <h3>Autoriser Claude Code</h3>
      <p>Cliquez sur <strong>Autoriser</strong> pour permettre à Claude Code d'utiliser votre compte.</p>
      <figure class="shot">
        <img src="${WIN_INSTALL_SCREENSHOTS.autoriser}" alt="Autoriser Claude Code">
      </figure>
    </div>

    <div class="step">
      <span class="num">9</span>
      <h3>Confirmation</h3>
      <p>Le navigateur affiche <em>Tout est prêt pour Claude Code</em>. Vous pouvez fermer cet onglet.</p>
      <figure class="shot">
        <img src="${WIN_INSTALL_SCREENSHOTS.confirmation}" alt="Confirmation web">
      </figure>
    </div>

    <div class="step">
      <span class="num">10</span>
      <h3>Retour dans PowerShell</h3>
      <p>Le message <em>Logged in as ...</em> confirme la connexion. Appuyez sur Entrée pour continuer.</p>
      <figure class="shot">
        <img src="${WIN_INSTALL_SCREENSHOTS.loggedIn}" alt="Login confirmé">
      </figure>
    </div>

    <div class="step">
      <span class="num">11</span>
      <h3>Notes de sécurité</h3>
      <p>Claude Code affiche des notes de sécurité. Lire puis appuyer sur Entrée.</p>
      <figure class="shot">
        <img src="${WIN_INSTALL_SCREENSHOTS.securityNotes}" alt="Notes de sécurité">
      </figure>
    </div>

    <div class="step">
      <span class="num">12</span>
      <h3>Autoriser le dossier de travail</h3>
      <p>Sélectionnez <strong>Yes, I trust this folder</strong> et validez avec Entrée. Claude Code est prêt.</p>
      <figure class="shot">
        <img src="${WIN_INSTALL_SCREENSHOTS.trustFolder}" alt="Trust folder">
      </figure>
    </div>

    <div class="step">
      <span class="num">✓</span>
      <h3>Claude Code est installé</h3>
      <p>Une fois Claude Code installé et connecté, cliquez sur <strong>Installer {{APP_NAME}}</strong> ci-dessous pour finaliser le démarrage.</p>
    </div>
        `
        : `
    <div class="step">
      <span class="num">1</span>
      <h3>Ouvrir le Terminal</h3>
      <p>Cmd+Espace puis tapez <code>Terminal</code>.</p>
    </div>

    <div class="step">
      <span class="num">2</span>
      <h3>Coller la commande puis Entrée</h3>
      <p>Cliquez sur <strong>Copier la commande</strong> en bas de cette fenêtre, collez dans le Terminal avec <code>Cmd+V</code>, validez avec Entrée.</p>
      <div class="cmdbox" id="cmd"></div>
    </div>

    <div class="step">
      <span class="num">3</span>
      <h3>Se connecter à Claude</h3>
      <p>Tapez <code>claude</code> puis Entrée. Une page web s'ouvre, connectez-vous avec votre compte Claude.ai (Pro/Max/Team).</p>
    </div>
        `
    }

  </main>

  <footer>
    <button id="quit">Quitter</button>
    <div class="nav-spacer"></div>
    <button id="prev">← Précédent</button>
    <button id="copy" class="primary">Copier la commande</button>
    <button id="next" class="primary">Suivant →</button>
    <button id="retry" class="primary" style="display:none;">Installer {{APP_NAME}}</button>
  </footer>
</div>

<div class="toast" id="toast">✓ Commande copiée</div>

<script>
  const cmd = ${JSON.stringify(installCmd)};
  const cmdEls = document.querySelectorAll('#cmd, .cmdbox');
  cmdEls.forEach((el) => { if (el) el.textContent = cmd; });

  function send(action) {
    if (window.oifClaudeDialog && window.oifClaudeDialog.respond) {
      window.oifClaudeDialog.respond(action);
    }
  }

  // Navigation pas-à-pas : on cache toutes les .step sauf la courante
  const steps = Array.from(document.querySelectorAll('.step'));
  const total = steps.length;
  let current = 0;

  const counterEl = document.getElementById('step-counter');
  const dotsEl = document.getElementById('step-dots');
  const prevBtn = document.getElementById('prev');
  const nextBtn = document.getElementById('next');
  const retryBtn = document.getElementById('retry');
  const copyBtn = document.getElementById('copy');

  // Crée les dots cliquables
  for (let i = 0; i < total; i++) {
    const d = document.createElement('button');
    d.className = 'step-dot';
    d.setAttribute('aria-label', 'Étape ' + (i + 1));
    d.onclick = () => goTo(i);
    dotsEl.appendChild(d);
  }
  const dots = Array.from(dotsEl.children);

  function render() {
    steps.forEach((s, i) => s.classList.toggle('active', i === current));
    dots.forEach((d, i) => d.classList.toggle('active', i === current));
    counterEl.textContent = 'Étape ' + (current + 1) + ' / ' + total;
    prevBtn.disabled = current === 0;
    const isLast = current === total - 1;
    nextBtn.style.display = isLast ? 'none' : '';
    retryBtn.style.display = isLast ? '' : 'none';
    // Le bouton "Copier la commande" n'a de sens QUE sur l'étape qui contient
    // l'attribut data-needs-copy="1" (celle où l'utilisateur doit coller).
    const needsCopy = steps[current].getAttribute('data-needs-copy') === '1';
    copyBtn.style.display = needsCopy ? '' : 'none';
  }
  function goTo(i) {
    current = Math.max(0, Math.min(total - 1, i));
    render();
    // Scroll en haut de la fenêtre à chaque changement
    document.querySelector('main').scrollTop = 0;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  prevBtn.onclick = () => goTo(current - 1);
  nextBtn.onclick = () => goTo(current + 1);
  render();

  copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(cmd);
      copyBtn.classList.add('copied');
      copyBtn.textContent = '✓ Copié';
      const toast = document.getElementById('toast');
      toast.classList.add('show');
      setTimeout(() => {
        toast.classList.remove('show');
        copyBtn.classList.remove('copied');
        copyBtn.textContent = 'Copier la commande';
      }, 2200);
    } catch (e) {
      send('copy-fallback');
    }
  };
  retryBtn.onclick = () => send('retry');
  document.getElementById('quit').onclick = () => send('quit');
</script>
</body></html>`;

  return new Promise((resolve) => {
    const dialogWindow = new BrowserWindow({
      width: 860,
      height: 880,
      frame: true,
      title: "{{APP_NAME}} - Installer Claude Code",
      backgroundColor: "#faf9f7",
      modal: false,
      resizable: true,
      minimizable: false,
      maximizable: true,
      show: true,
      webPreferences: {
        preload: path.join(__dirname, "claude-dialog-preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    dialogWindow.setMenuBarVisibility(false);
    // Écrit le HTML en fichier temp + loadFile : data:URL se cassait au-delà
    // de ~2 Mo (les 11 captures embedded font dépasser la limite Chromium).
    const tmpDir = path.join(app.getPath("temp"), "{{APP_NAME_KEBAB}}");
    try {
      fs.mkdirSync(tmpDir, { recursive: true });
    } catch {}
    const tmpHtml = path.join(tmpDir, "claude-install-dialog.html");
    try {
      fs.writeFileSync(tmpHtml, html, "utf8");
      dialogWindow.loadFile(tmpHtml);
    } catch (e) {
      console.error("[claude-dialog] échec écriture HTML temp :", e?.message);
      dialogWindow.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(html.slice(0, 500000))}`
      );
    }

    let resolved = false;
    const finish = (action) => {
      if (resolved) return;
      resolved = true;
      ipcMain.removeAllListeners("claude-dialog-respond");
      if (!dialogWindow.isDestroyed()) dialogWindow.close();
      resolve(action);
    };

    ipcMain.on("claude-dialog-respond", (_e, action) => {
      if (action === "doc") {
        shell.openExternal("https://docs.claude.com/en/docs/claude-code/quickstart");
        return; // garde la fenêtre ouverte
      }
      if (action === "copy-fallback") {
        clipboard.writeText(installCmd);
        return;
      }
      finish(action); // retry ou quit
    });

    dialogWindow.on("closed", () => finish("quit"));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// WIZARD DE SETUP : installation silencieuse + auth OAuth
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Installe Claude Code via winget (Windows seulement) sans aucune fenêtre.
 * Appelle onProgress(line) pour chaque ligne de sortie.
 */
function installClaudeWinget(onProgress) {
  return new Promise((resolve, reject) => {
    // winget.exe peut être dans WindowsApps (non dans PATH standard pour certains process)
    const wingetCandidates = [
      "winget",
      process.env.LOCALAPPDATA
        ? path.join(process.env.LOCALAPPDATA, "Microsoft", "WindowsApps", "winget.exe")
        : null,
    ].filter(Boolean);

    let bin = null;
    for (const candidate of wingetCandidates) {
      const r = spawnSync(candidate, ["--version"], { timeout: 3000, encoding: "utf8", windowsHide: true });
      if (r.status === 0) { bin = candidate; break; }
    }
    if (!bin) {
      reject(new Error("winget introuvable. Installez 'App Installer' depuis le Microsoft Store puis réessayez."));
      return;
    }

    onProgress({ log: `[setup] winget trouvé : ${bin}`, stage: "Démarrage de winget..." });
    const child = spawn(
      bin,
      [
        "install", "-e", "--id", "Anthropic.ClaudeCode",
        "--silent",
        "--accept-package-agreements",
        "--accept-source-agreements",
        "--source", "winget",
      ],
      { windowsHide: true, stdio: "pipe" }
    );
    const parseWinget = (raw) => {
      const line = raw.toString().replace(/[ --]/g, " ").trim();
      if (!line) return;
      console.log("[winget]", line);
      // Détecter les étapes et le pourcentage
      let stage = null;
      let percent = null;
      const pctMatch = line.match(/(\d+)\s*%/);
      if (pctMatch) percent = Math.min(99, parseInt(pctMatch[1]));
      if (/download/i.test(line)) stage = "Téléchargement...";
      else if (/hash|verify/i.test(line)) stage = "Vérification...";
      else if (/install|extract/i.test(line)) stage = "Installation...";
      else if (/success|terminé|complete/i.test(line)) stage = "Finalisation...";
      onProgress({ log: line, stage, percent });
    };
    child.stdout.on("data", parseWinget);
    child.stderr.on("data", parseWinget);
    child.on("error", reject);
    child.on("close", (code) => {
      console.log("[winget] exit code:", code);
      // 0 = ok, -1978335189 = déjà installé (APPINSTALLER_ERROR_PACKAGE_ALREADY_INSTALLED)
      if (code === 0 || code === -1978335189) resolve();
      else reject(new Error(`winget a échoué (code ${code}). Connectez-vous à Internet et réessayez.`));
    });
  });
}

/**
 * Met à jour Claude Code via winget upgrade (Windows seulement, best-effort).
 * Appelé avant l'auth pour s'assurer que la version installée est à jour.
 */
function upgradeClaudeWinget(onProgress) {
  return new Promise((resolve) => {
    const wingetCandidates = [
      "winget",
      process.env.LOCALAPPDATA
        ? path.join(process.env.LOCALAPPDATA, "Microsoft", "WindowsApps", "winget.exe")
        : null,
    ].filter(Boolean);
    let bin = null;
    for (const candidate of wingetCandidates) {
      const r = spawnSync(candidate, ["--version"], { timeout: 3000, encoding: "utf8", windowsHide: true });
      if (r.status === 0) { bin = candidate; break; }
    }
    if (!bin) { resolve(); return; }

    const child = spawn(
      bin,
      ["upgrade", "--id", "Anthropic.ClaudeCode", "--silent",
       "--accept-package-agreements", "--accept-source-agreements", "--source", "winget"],
      { windowsHide: true, stdio: "pipe" }
    );
    const parse = (d) => {
      const line = d.toString().replace(/[ —\-]{2,}/g, " ").trim();
      if (!line) return;
      let stage = null;
      const pctMatch = line.match(/(\d+)\s*%/);
      const percent = pctMatch ? Math.min(99, parseInt(pctMatch[1])) : null;
      if (/download/i.test(line)) stage = "Téléchargement mise à jour...";
      else if (/install/i.test(line)) stage = "Installation mise à jour...";
      else if (/success|complete|terminé/i.test(line)) stage = "Mise à jour terminée";
      else if (/no.*update|no.*upgrade|already.*update|aucune/i.test(line)) stage = "Déjà à jour";
      onProgress({ log: line, stage, percent });
    };
    child.stdout.on("data", parse);
    child.stderr.on("data", parse);
    child.on("close", () => { reloadWindowsPath(); resolve(); }); // always resolve
    child.on("error", () => resolve());
  });
}

/**
 * Recharge le PATH Windows depuis le registre dans le process Electron courant.
 * Nécessaire après winget install pour que findClaudeBinFromElectron() trouve le binaire
 * sans redémarrer l'app.
 */
function reloadWindowsPath() {
  if (process.platform !== "win32") return;
  try {
    const r = spawnSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')",
    ], { encoding: "utf8", timeout: 5000 });
    if (r.status === 0 && r.stdout.trim()) {
      process.env.PATH = r.stdout.trim();
      process.env.Path = process.env.PATH;
    }
  } catch {}
}

/**
 * Lance `claude setup-token`, capture le token OAuth ou détecte l'auth réussie.
 * onProgress(line) : lignes brutes pour affichage.
 * onBrowserOpened() : callback quand le navigateur s'ouvre (pour afficher le bouton manuel).
 * Résout avec { token?: string, authDone: true } quand l'auth est confirmée.
 */
function captureSetupToken(onProgress, onBrowserOpened) {
  return new Promise((resolve, reject) => {
    const bin = findClaudeBinFromElectron();
    if (!bin) { reject(new Error("claude introuvable après installation")); return; }

    // Fichier de debug : toute la sortie brute de setup-token, pour diagnostic
    const debugFile = path.join(app.getPath("userData"), "logs", "setup-token-debug.txt");
    fs.mkdirSync(path.dirname(debugFile), { recursive: true });
    const debugStream = fs.createWriteStream(debugFile, { flags: "w" });
    debugStream.write(`[${new Date().toISOString()}] claude setup-token start\n`);

    // CI=1 + NO_COLOR force Claude Code (Ink) en mode plain-text :
    // sans ça, Ink ne rend rien quand stdout n'est pas un vrai TTY.
    const child = spawn(bin, ["setup-token"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        CI: "1",
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        TERM: "dumb",
      },
    });

    let allOut = "";
    let resolved = false;
    let browserOpenedNotified = false;

    const tryResolveToken = () => {
      if (resolved) return false;
      // Patterns : CLAUDE_CODE_OAUTH_TOKEN=<val>, sk-ant-..., JWT eyJ...
      const m = allOut.match(/CLAUDE_CODE_OAUTH_TOKEN[=:\s]+([^\s\r\n'"]{20,})/i)
              || allOut.match(/(sk-ant-[A-Za-z0-9_\-./+]{20,})/)
              || allOut.match(/(eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+(?:\.[A-Za-z0-9_\-]*)?)/);
      if (m) {
        console.log("[setup-token] token capturé, longueur:", m[1].length);
        debugStream.write(`[token-captured] length=${m[1].length}\n`);
        resolved = true;
        resolve({ token: m[1], authDone: true });
        try { child.kill(); } catch {}
        debugStream.end();
        return true;
      }
      return false;
    };

    const onData = (d) => {
      const s = d.toString();
      allOut += s;
      debugStream.write(s); // log brut complet
      s.split(/\r?\n/).filter(Boolean).forEach((line) => {
        console.log("[setup-token]", line);
        onProgress(line);
        if (!browserOpenedNotified && /browser|navigateur|opening|http|oauth|login/i.test(line)) {
          browserOpenedNotified = true;
          onBrowserOpened && onBrowserOpened();
        }
      });
      tryResolveToken();
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (err) => { debugStream.end(); reject(err); });
    child.on("close", (code) => {
      debugStream.write(`\n[exit] code=${code} allOut_length=${allOut.length}\n`);
      debugStream.end();
      console.log("[setup-token] exit code:", code, "| sortie complète dans:", debugFile);
      if (resolved) return;
      if (tryResolveToken()) return;
      if (code === 0) {
        // Petit délai pour laisser le OS finir d'écrire credentials.json si setup-token
        // venait juste de le créer au moment de l'exit
        setTimeout(() => {
          if (!resolved) { resolved = true; resolve({ token: null, authDone: true }); }
        }, 800);
      } else {
        reject(new Error(`claude setup-token a échoué (code ${code}). Vérifiez votre connexion et réessayez.`));
      }
    });

    // Notifier après 3s si le navigateur n'a pas encore émis de ligne reconnaissable
    setTimeout(() => {
      if (!browserOpenedNotified) {
        browserOpenedNotified = true;
        onBrowserOpened && onBrowserOpened();
      }
    }, 3000);

    captureSetupToken._activeChild = child;
    captureSetupToken._resolve = (r) => {
      if (!resolved) { resolved = true; resolve(r); try { child.kill(); } catch {} debugStream.end(); }
    };
  });
}

/**
 * Fenêtre de setup : installation silencieuse + auth OAuth.
 * needsInstall : claude binaire absent.
 * needsAuth    : pas de token stocké.
 * Retourne "done" ou "quit".
 */
async function showSetupWindow({ needsInstall, needsAuth }) {
  const isWin = process.platform === "win32";

  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 540,
      height: 560,
      resizable: false,
      minimizable: false,
      maximizable: false,
      center: true,
      title: "Configuration {{APP_NAME}}",
      backgroundColor: "#faf9f7",
      show: true,
      webPreferences: {
        preload: path.join(__dirname, "setup-preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    win.setMenuBarVisibility(false);

    // ── HTML de la fenêtre ──
    const html = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"><title>Configuration {{APP_NAME}}</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg: #faf9f7; --panel: #fff; --border: #ebe8e1;
  --text: #1a1916; --muted: #74716b; --soft: #989590;
  --accent: #c96442; --accent-soft: #f5d8cb; --accent-tint: #fbeee5;
  --green: #2e7d32; --green-bg: #f0f9f0; --red: #c62828; --red-bg: #fff0f0;
}
body { background: var(--bg); color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  -webkit-font-smoothing: antialiased; height: 100vh;
  display: flex; flex-direction: column; overflow: hidden; }
header {
  padding: 20px 28px 16px;
  background: var(--panel); border-bottom: 1px solid var(--border);
  display: flex; align-items: center; gap: 12px; flex-shrink: 0;
}
header img { width: 36px; height: 36px; object-fit: contain; }
header .titles { display: flex; flex-direction: column; gap: 2px; }
header .eyebrow { font-size: 10px; font-weight: 600; letter-spacing: .12em;
  text-transform: uppercase; color: var(--soft); }
header h1 { font-size: 17px; font-weight: 600; color: var(--text); letter-spacing: -.01em; }
main { flex: 1; overflow-y: auto; padding: 24px 28px 16px; }
.steps { display: flex; flex-direction: column; gap: 16px; }
.step { display: flex; gap: 14px; align-items: flex-start; }
.step-icon {
  width: 34px; height: 34px; border-radius: 50%; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  font-size: 14px; font-weight: 700; margin-top: 1px;
  transition: background .3s, color .3s;
}
.step-icon.pending { background: #f0ede8; color: var(--soft); }
.step-icon.running { background: var(--accent-tint); color: var(--accent);
  animation: pulse 1.4s ease-in-out infinite; }
.step-icon.done { background: var(--green-bg); color: var(--green); }
.step-icon.error { background: var(--red-bg); color: var(--red); }
.step-icon.skipped { background: #f0ede8; color: var(--soft); }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.55} }
.step-body { flex: 1; min-width: 0; }
.step-title { font-size: 14px; font-weight: 600; color: var(--text);
  line-height: 1.3; margin-bottom: 4px; }
.step-title.muted { color: var(--soft); }
.step-desc { font-size: 12.5px; color: var(--muted); line-height: 1.55; }
.step-log { font-size: 11px; color: var(--soft); margin-top: 8px;
  font-family: 'Menlo', 'Consolas', monospace; white-space: pre-wrap;
  max-height: 70px; overflow-y: auto; background: #f4f2ed;
  border-radius: 6px; padding: 6px 8px; }
.progress-wrap { margin-top: 10px; display: none; }
.progress-track { background: #ebe8e1; border-radius: 6px; height: 10px; overflow: hidden; }
.progress-fill {
  height: 100%; border-radius: 6px;
  background: linear-gradient(90deg, var(--accent) 0%, #e07a55 100%);
  transition: width .4s ease;
  width: 0%;
}
.progress-fill.indeterminate {
  width: 35%;
  animation: slide 1.6s ease-in-out infinite;
}
@keyframes slide {
  0%   { transform: translateX(-200%); }
  100% { transform: translateX(350%); }
}
.progress-status { font-size: 11.5px; color: var(--muted); margin-top: 5px;
  display: flex; justify-content: space-between; }
.badge { display: inline-flex; align-items: center; gap: 5px;
  background: var(--green-bg); color: var(--green);
  font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 20px;
  margin-top: 6px; }
.badge-err { background: var(--red-bg); color: var(--red); }
footer {
  padding: 16px 28px 20px; background: var(--panel); border-top: 1px solid var(--border);
  display: flex; gap: 10px; justify-content: flex-end; flex-shrink: 0;
}
button {
  border: none; cursor: pointer; font-size: 13px; font-weight: 500;
  padding: 8px 18px; border-radius: 7px; transition: opacity .15s;
}
button:hover { opacity: .88; }
.btn-primary { background: var(--accent); color: #fff; }
.btn-secondary { background: #ebe8e1; color: var(--text); }
.divider { width: 1px; background: var(--border); align-self: stretch; }
#mac-step { display: none; }
</style>
</head>
<body>
<header>
  <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'%3E%3Crect width='40' height='40' rx='10' fill='%23c96442'/%3E%3Ctext x='20' y='27' font-family='system-ui' font-size='20' font-weight='700' fill='white' text-anchor='middle'%3EO%3C/text%3E%3C/svg%3E" alt="">
  <div class="titles">
    <span class="eyebrow">{{APP_NAME}}</span>
    <h1>Configuration initiale</h1>
  </div>
</header>
<main>
  <div class="steps">

    <div class="step" id="step-install">
      <div class="step-icon pending" id="icon-install">1</div>
      <div class="step-body">
        <div class="step-title" id="title-install">Installation de Claude Code</div>
        <div class="step-desc" id="desc-install">L'installation va démarrer automatiquement...</div>
        <div class="progress-wrap" id="progress-wrap">
          <div class="progress-track">
            <div class="progress-fill indeterminate" id="progress-fill"></div>
          </div>
          <div class="progress-status">
            <span id="progress-stage">Démarrage...</span>
            <span id="progress-pct"></span>
          </div>
        </div>
        <div class="step-log" id="log-install"></div>
      </div>
    </div>

    <div class="step" id="mac-step">
      <div class="step-icon pending" id="icon-mac">1</div>
      <div class="step-body">
        <div class="step-title" id="title-mac">Installer Claude Code</div>
        <div class="step-desc">
          Dans le Terminal, collez cette commande :<br>
          <code style="display:block;background:#f4f2ed;padding:7px 10px;border-radius:5px;margin-top:7px;font-size:12px;user-select:all">curl -fsSL https://claude.ai/install.sh | bash</code>
        </div>
        <div style="margin-top:10px">
          <button class="btn-primary" onclick="window.oifSetup.action('mac-installed')">J'ai installé Claude Code</button>
        </div>
      </div>
    </div>

    <div class="step" id="step-auth">
      <div class="step-icon pending" id="icon-auth">2</div>
      <div class="step-body">
        <div class="step-title muted" id="title-auth">Connexion à Claude</div>
        <div class="step-desc" id="desc-auth">Préparation...</div>
        <div class="progress-wrap" id="auth-progress-wrap" style="display:none">
          <div class="progress-track">
            <div class="progress-fill indeterminate" id="auth-progress-fill"></div>
          </div>
          <div class="progress-status">
            <span id="auth-progress-stage">Vérification...</span>
            <span id="auth-progress-pct"></span>
          </div>
        </div>
        <div class="step-log" id="log-auth" style="display:none"></div>
        <div id="auth-win-box" style="display:none;margin-top:10px">
          <div style="font-size:12px;color:var(--muted);line-height:1.6;margin-bottom:8px">
            Une fen&#234;tre noire (PowerShell) vient de s'ouvrir.<br>
            &#10004; Connectez-vous dans votre navigateur quand il s'ouvre.<br>
            &#10004; Une fois connect&#233;, copiez le token affich&#233; dans la fen&#234;tre noire<br>
            <span style="font-size:11px;opacity:.75">(il commence par <code>sk-ant-oat01-</code>)</span>
          </div>
          <input id="token-input" type="text"
            placeholder="Collez le token ici (sk-ant-oat01-...)"
            style="width:100%;padding:7px 9px;border:1px solid var(--border);border-radius:6px;font-size:12px;font-family:var(--mono,monospace);background:var(--panel);color:var(--text);outline:none;box-sizing:border-box"
            oninput="document.getElementById('btn-token-submit').disabled=this.value.length<20"
          />
          <div style="display:flex;gap:8px;margin-top:8px;align-items:center">
            <button class="btn-primary" id="btn-token-submit" disabled
              onclick="var t=document.getElementById('token-input').value.trim();if(t.length>20)window.oifSetup.action('auth-token-submit',t)"
              style="font-size:12.5px;padding:7px 14px">
              Valider le token
            </button>
            <span style="font-size:11px;color:var(--soft)" id="auth-auto-msg">ou d&#233;tection automatique en cours...</span>
          </div>
        </div>
        <div id="auth-manual-btn" style="display:none;margin-top:10px">
          <button class="btn-primary" onclick="window.oifSetup.action('auth-manual-confirm')" style="font-size:12.5px;padding:7px 14px">
            J'ai confirm&#233; la connexion dans mon navigateur
          </button>
        </div>
      </div>
    </div>

    <div class="step" id="step-done">
      <div class="step-icon pending" id="icon-done">3</div>
      <div class="step-body">
        <div class="step-title muted" id="title-done">{{APP_NAME}} prêt</div>
        <div class="step-desc" id="desc-done">L'application va démarrer automatiquement.</div>
      </div>
    </div>

  </div>
</main>
<footer>
  <button class="btn-secondary" id="btn-cancel" onclick="window.oifSetup.action('quit')">Quitter</button>
  <button class="btn-primary" id="btn-retry" style="display:none" onclick="window.oifSetup.action('retry')">Réessayer</button>
</footer>

<script>
const isWin = ${JSON.stringify(isWin)};
const needsInstall = ${JSON.stringify(needsInstall)};
const needsAuth = ${JSON.stringify(needsAuth)};

// Affiche le bon step install
if (!isWin && needsInstall) {
  document.getElementById('step-install').style.display = 'none';
  document.getElementById('mac-step').style.display = 'flex';
  document.getElementById('icon-mac').className = 'step-icon running';
} else if (!needsInstall) {
  document.getElementById('step-install').style.display = 'none';
  document.getElementById('mac-step').style.display = 'none';
  // Auth prend le step 1
  document.getElementById('icon-auth').textContent = '1';
  document.getElementById('icon-done').textContent = '2';
}

function setIcon(id, state, text) {
  const el = document.getElementById(id);
  el.className = 'step-icon ' + state;
  if (text !== undefined) el.textContent = text;
}
function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
function showLog(id, line) {
  const el = document.getElementById(id);
  el.style.display = 'block';
  el.textContent = (el.textContent + '\\n' + line).slice(-400).trim();
  el.scrollTop = el.scrollHeight;
}

// executeJavaScript injecte les états depuis le main process directement
// (plus fiable que IPC renderer qui dépend du timing du preload).
window.__oifState = function(s) {
  if (s.phase === 'installing') {
    setIcon('icon-install', 'running');
    setText('title-install', 'Installation en cours...');
    setText('desc-install', '');
    // Barre de progression
    var wrap = document.getElementById('progress-wrap');
    wrap.style.display = 'block';
    var fill = document.getElementById('progress-fill');
    var pctEl = document.getElementById('progress-pct');
    var stageEl = document.getElementById('progress-stage');
    if (s.percent != null) {
      fill.classList.remove('indeterminate');
      fill.style.width = s.percent + '%';
      pctEl.textContent = s.percent + '%';
    }
    if (s.stage) { stageEl.textContent = s.stage; }
    if (s.log) showLog('log-install', s.log);
  }
  if (s.phase === 'install-done') {
    setIcon('icon-install', 'done', String.fromCodePoint(0x2713));
    setText('title-install', 'Claude Code installé');
    var fill2 = document.getElementById('progress-fill');
    fill2.classList.remove('indeterminate');
    fill2.style.width = '100%';
    fill2.style.background = 'var(--green)';
    document.getElementById('progress-pct').textContent = '100%';
    document.getElementById('progress-stage').textContent = 'Terminé';
    document.getElementById('desc-install').innerHTML = '';
  }
  if (s.phase === 'install-error') {
    setIcon('icon-install', 'error', '!');
    setText('title-install', "Echec d'installation");
    var fill3 = document.getElementById('progress-fill');
    fill3.classList.remove('indeterminate');
    fill3.style.background = 'var(--red)';
    fill3.style.width = '100%';
    document.getElementById('progress-stage').textContent = 'Echec';
    setText('desc-install', s.error || 'Erreur inconnue.');
    document.getElementById('btn-retry').style.display = 'inline-block';
  }
  if (s.phase === 'mac-check') {
    setIcon('icon-mac', 'running');
    setText('title-mac', 'Verification...');
  }
  if (s.phase === 'mac-ok') {
    setIcon('icon-mac', 'done', String.fromCodePoint(0x2713));
    setText('title-mac', 'Claude Code detecte');
  }
  if (s.phase === 'mac-not-found') {
    setIcon('icon-mac', 'error', '!');
    setText('title-mac', 'Claude Code introuvable');
    document.getElementById('btn-retry').style.display = 'inline-block';
  }
  if (s.phase === 'auth-upgrading') {
    setIcon('icon-auth', 'running');
    document.getElementById('title-auth').className = 'step-title';
    setText('title-auth', 'Mise à jour Claude Code...');
    setText('desc-auth', 'Mise à jour automatique en cours...');
    var authWrap = document.getElementById('auth-progress-wrap');
    if (authWrap) authWrap.style.display = 'block';
    var authFill = document.getElementById('auth-progress-fill');
    var authPct = document.getElementById('auth-progress-pct');
    var authStage = document.getElementById('auth-progress-stage');
    if (s.percent != null && authFill) {
      authFill.classList.remove('indeterminate');
      authFill.style.width = s.percent + '%';
      if (authPct) authPct.textContent = s.percent + '%';
    }
    if (s.stage && authStage) authStage.textContent = s.stage;
    if (s.log) showLog('log-auth', s.log);
  }
  if (s.phase === 'auth-waiting') {
    setIcon('icon-auth', 'running');
    document.getElementById('title-auth').className = 'step-title';
    setText('title-auth', 'Connexion en cours...');
    setText('desc-auth', "Preparation de la connexion - votre navigateur va s'ouvrir dans quelques secondes.");
    var authWrap2 = document.getElementById('auth-progress-wrap');
    if (authWrap2) authWrap2.style.display = 'none';
    if (s.log) showLog('log-auth', s.log);
  }
  if (s.phase === 'auth-browser-open') {
    setText('title-auth', 'Connexion en cours...');
    setText('desc-auth', "Une fenetre de connexion s'est ouverte dans l'application. Connectez-vous avec votre compte Claude (Pro, Max ou Team) - la configuration se termine automatiquement.");
    if (s.log) showLog('log-auth', s.log);
  }
  if (s.phase === 'auth-browser-open-win') {
    setText('desc-auth', 'Detection automatique en cours... Si vous avez deja autorise dans le navigateur :');
    document.getElementById('auth-win-box').style.display = 'block';
    document.getElementById('token-input').focus();
  }
  if (s.phase === 'auth-token-accepted') {
    document.getElementById('auth-win-box').style.display = 'none';
    setText('desc-auth', 'Token valide. Verification...');
    setText('auth-auto-msg', '');
  }
  if (s.phase === 'auth-waiting-confirm') {
    setText('desc-auth', "Verification de la connexion... Veuillez patienter.");
    document.getElementById('auth-manual-btn').style.display = 'none';
  }
  if (s.phase === 'auth-done') {
    setIcon('icon-auth', 'done', String.fromCodePoint(0x2713));
    setText('title-auth', 'Connexion reussie');
    document.getElementById('desc-auth').innerHTML = '<span style="color:var(--green);font-weight:600">Connexion reussie.</span>';
    setIcon('icon-done', 'running');
    document.getElementById('title-done').className = 'step-title';
    setText('title-done', 'Demarrage...');
  }
  if (s.phase === 'auth-error') {
    setIcon('icon-auth', 'error', '!');
    setText('title-auth', 'Echec de connexion');
    setText('desc-auth', s.error || 'La connexion a echoue ou a expire.');
    document.getElementById('btn-retry').style.display = 'inline-block';
  }
  if (s.phase === 'done') {
    setIcon('icon-done', 'done', String.fromCodePoint(0x2713));
    setText('title-done', '{{APP_NAME}} demarre...');
    document.getElementById('btn-cancel').style.display = 'none';
  }
};
</script>
</body></html>`;

    // HTML embarqué en base64 : pas de fichier temp, pas d'interférence Windows
    win.loadURL(`data:text/html;charset=utf-8;base64,${Buffer.from(html, "utf8").toString("base64")}`);

    // executeJavaScript est plus fiable qu'IPC pour main→renderer :
    // pas de dépendance au timing du preload.
    const send = (state) => {
      if (win.isDestroyed()) return;
      const payload = JSON.stringify(state);
      win.webContents.executeJavaScript(
        `window.__oifState && window.__oifState(${payload})`
      ).catch((e) => console.warn("[setup] send failed:", e?.message));
    };

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      ipcMain.removeAllListeners("setup-action");
      try { if (!win.isDestroyed()) win.close(); } catch {}
      resolve(result);
    };

    let retryFn = null;

    ipcMain.on("setup-action", async (_e, action) => {
      if (action === "quit") { finish("quit"); return; }
      if (action === "retry" && retryFn) { retryFn(); return; }
      if (action === "mac-installed") {
        setTimeout(async () => {
          send({ phase: "mac-check" });
          await sleep(300);
          if (checkClaudeCli()) {
            send({ phase: "mac-ok" });
            setTimeout(() => runAuth(), 600);
          } else {
            send({ phase: "mac-not-found" });
            retryFn = () => ipcMain.emit("setup-action", null, "mac-installed");
          }
        }, 0);
      }
    });

    win.on("closed", () => finish("quit"));

    // ── Logic principale ──

    async function runInstall() {
      send({ phase: "installing", stage: "Démarrage..." });
      try {
        await installClaudeWinget(({ log, stage, percent }) =>
          send({ phase: "installing", log, stage, percent }));
        reloadWindowsPath();
        send({ phase: "install-done" });
        await sleep(700);
        runAuth();
      } catch (err) {
        send({ phase: "install-error", error: err.message });
        retryFn = () => { retryFn = null; runInstall(); };
      }
    }

    async function runAuth() {
      restoreClaudeJsonIfNeeded();
      writeClaudeOnboardingSkip();
      await runElectronOAuth();
    }

    // OAuth PKCE dans une BrowserWindow Electron : pas de subprocess, pas de TTY.
    // Electron intercepte la redirection vers platform.claude.com avant qu'elle
    // charge, extrait le code, échange contre un token via fetch POST.
    async function runElectronOAuth() {
      const crypto = require("node:crypto");

      const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
      const REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
      const SCOPES = "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
      const AUTH_URL = "https://claude.com/cai/oauth/authorize";
      const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";

      send({ phase: "auth-waiting" });

      const codeVerifier = crypto.randomBytes(32).toString("base64url");
      const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
      const state = crypto.randomBytes(16).toString("hex");

      const authUrl = AUTH_URL + "?" + new URLSearchParams({
        code: "true",
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        scope: SCOPES,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        state,
      }).toString();

      try {
        const tokenData = await new Promise((resolve, reject) => {
          const authWin = new BrowserWindow({
            width: 520,
            height: 700,
            title: "Connexion Claude Code - {{APP_NAME}}",
            backgroundColor: "#ffffff",
            webPreferences: {
              nodeIntegration: false,
              contextIsolation: true,
              sandbox: true,
            },
          });
          authWin.setMenuBarVisibility(false);

          let resolved = false;

          const handleRedirect = async (url) => {
            if (!url || !url.startsWith(REDIRECT_URI) || resolved) return;
            resolved = true;
            console.log("[oauth] redirect intercepté:", url.slice(0, 120));

            const urlObj = new URL(url);
            const code = urlObj.searchParams.get("code");
            const returnedState = urlObj.searchParams.get("state");

            if (!code) {
              try { authWin.close(); } catch {}
              reject(new Error("Pas de code OAuth dans la redirection"));
              return;
            }
            if (returnedState !== state) {
              try { authWin.close(); } catch {}
              reject(new Error("State OAuth invalide"));
              return;
            }

            try { authWin.loadURL("about:blank"); } catch {}

            try {
              console.log("[oauth] échange du code contre token...");
              const resp = await fetch(TOKEN_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  grant_type: "authorization_code",
                  code,
                  code_verifier: codeVerifier,
                  client_id: CLIENT_ID,
                  redirect_uri: REDIRECT_URI,
                  state,
                }),
              });
              const rawBody = await resp.text();
              console.log("[oauth] token response status:", resp.status, "body:", rawBody.slice(0, 400));
              let data;
              try { data = JSON.parse(rawBody); } catch { data = { raw: rawBody }; }
              try { authWin.close(); } catch {}
              if (data.access_token) {
                console.log("[oauth] token obtenu, expires_in:", data.expires_in);
                resolve({
                  accessToken: data.access_token,
                  refreshToken: data.refresh_token || null,
                  expiresAt: Date.now() + (data.expires_in || 28800) * 1000,
                });
              } else {
                console.error("[oauth] réponse complète:", rawBody.slice(0, 400));
                reject(new Error("Token exchange échoué (HTTP " + resp.status + "): " + rawBody.slice(0, 200)));
              }
            } catch (e) {
              try { authWin.close(); } catch {}
              reject(e);
            }
          };

          // will-redirect : HTTP 302 depuis le serveur OAuth
          authWin.webContents.on("will-redirect", (e, url) => {
            if (url && url.startsWith(REDIRECT_URI)) {
              e.preventDefault();
              handleRedirect(url);
            }
          });
          // will-navigate : navigation JS (fallback)
          authWin.webContents.on("will-navigate", (e, url) => {
            if (url && url.startsWith(REDIRECT_URI)) {
              e.preventDefault();
              handleRedirect(url);
            }
          });
          // did-navigate : page déjà chargée (dernier recours si redirect non bloqué)
          authWin.webContents.on("did-navigate", (_e, url) => {
            if (url && url.startsWith(REDIRECT_URI)) handleRedirect(url);
          });

          authWin.on("closed", () => {
            if (!resolved) { resolved = true; reject(new Error("Fenetre de connexion fermee avant la fin")); }
          });

          authWin.loadURL(authUrl);
          send({ phase: "auth-browser-open" });
        });

        const tokenJson = JSON.stringify(tokenData);
        saveOifAuth({ claudeOAuthToken: tokenJson, authDone: true });
        console.log("[oauth] token sauvegardé, expiresAt:", new Date(tokenData.expiresAt).toISOString());

        // Écrire aussi dans ~/.claude/.credentials.json (format natif de claude auth login).
        // C'est ce que lit claude -p pour l'authentification.
        const home = process.env.USERPROFILE || process.env.HOME;
        if (home) {
          const credDir = path.join(home, ".claude");
          const credFile = path.join(credDir, ".credentials.json");
          try {
            fs.mkdirSync(credDir, { recursive: true });
            let existing = {};
            try { existing = JSON.parse(fs.readFileSync(credFile, "utf8")); } catch {}
            existing.claudeAiOauth = {
              accessToken: tokenData.accessToken,
              refreshToken: tokenData.refreshToken || null,
              expiresAt: tokenData.expiresAt,
            };
            fs.writeFileSync(credFile, JSON.stringify(existing, null, 2));
            console.log("[oauth] ~/.claude/.credentials.json mis à jour");
          } catch (e) {
            console.warn("[oauth] écriture credentials.json échouée:", e?.message);
          }
        }
        send({ phase: "auth-done" });
        await sleep(1200);
        send({ phase: "done" });
        await sleep(800);
        finish("done");
      } catch (err) {
        console.error("[oauth] erreur:", err.message);
        send({ phase: "auth-error", error: err.message });
        retryFn = () => { retryFn = null; runElectronOAuth(); };
      }
    }

    // Démarre selon les besoins détectés
    win.webContents.once("did-finish-load", () => {
      if (needsInstall) {
        if (isWin) {
          setTimeout(() => runInstall(), 400);
        }
        // macOS : on attend que l'utilisateur clique "J'ai installé"
      } else {
        // Pas d'install nécessaire, auth seulement
        setTimeout(() => runAuth(), 400);
      }
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─────────────────────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  // ÉTAPE 1 : splash IMMÉDIATEMENT, avant tout le reste. C'est ce que voit
  // l'utilisateur dans la première seconde.
  createSplashWindow();

  // ÉTAPE 2 : check Claude Code + auth token.
  const claudeInstalled = checkClaudeCli();
  const claudeAuthed = checkClaudeAuth();

  if (!claudeInstalled || !claudeAuthed) {
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.hide();
    const result = await showSetupWindow({
      needsInstall: !claudeInstalled,
      needsAuth: !claudeAuthed,
    });
    if (result === "quit") {
      app.quit();
      return;
    }
    // Si le wizard a géré l'install (needsInstall=true), on lui fait confiance :
    // winget a signalé succès, le binaire est présent mais le PATH Electron
    // (figé au démarrage) ne le voit pas encore. On recharge le PATH pour les
    // spawn suivants mais on ne bloque plus sur un check fatal ici.
    // Si l'install était en fait ratée, le sidecar échouera avec son propre message.
    reloadWindowsPath();
  }

  writeClaudeOnboardingSkip();
  // Claude OK, re-show le splash pendant le démarrage des sidecars
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.show();

  // ÉTAPE 3 : crée la main window (cachée) et lance les sidecars en parallèle.
  createWindow();
  setupMenu();

  spawnSidecars();
  console.log("[main] attente que Next.js soit prêt...");
  try {
    await waitForUrl(TARGET_URL, 120000);
    console.log("[main] Next.js OK, swap splash → main");
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(TARGET_URL);
      // Attend que la page soit rendue avant de swap pour éviter le flash blanc
      mainWindow.webContents.once("did-finish-load", () => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
        if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
      });
    }
  } catch (e) {
    console.error(`[main] ${e.message}`);
    // Si Next ne démarre pas dans les 60s, affiche un message d'erreur dans le splash
    if (mainWindow && !mainWindow.isDestroyed()) {
      const errHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #fff; color: #1a1a1a; font-family: -apple-system, system-ui, sans-serif;
          display: flex; align-items: center; justify-content: center; height: 100vh;
          flex-direction: column; gap: 14px; padding: 40px; text-align: center; }
        h1 { font-size: 20px; font-weight: 600; }
        p { color: #555; font-size: 13px; max-width: 520px; line-height: 1.6; }
        code { background: #f0f0f0; padding: 2px 8px; border-radius: 4px; font-size: 12px; }
        button { background: #1a1a1a; color: #fff; border: none; padding: 10px 20px;
          border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500;
          margin-top: 8px; }
        button:hover { opacity: 0.9; }
      </style></head><body>
        <h1>{{APP_NAME}} prend plus de temps que prévu</h1>
        <p>Le démarrage interne n'a pas répondu en 60 secondes. Cela arrive si l'antivirus de votre poste scanne l'app à fond au premier lancement. Réessayez, c'est souvent plus rapide la deuxième fois.</p>
        <p>Si le problème persiste, consultez les logs dans <code>%APPDATA%\\{{APP_NAME}}\\logs</code> (Win) ou <code>~/Library/Logs/{{APP_NAME}}/</code> (Mac).</p>
        <button onclick="location.reload()">Réessayer</button>
      </body></html>`;
      mainWindow.loadURL(`data:text/html;charset=utf-8;base64,${Buffer.from(errHtml).toString("base64")}`);
      mainWindow.webContents.once("did-finish-load", () => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
        if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
      });
    }
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  console.log("[main] arrêt des sidecars...");
  daemonProc?.kill();
  nextProc?.kill();
});
