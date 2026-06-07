const { BrowserWindow, shell } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const CODEX = {
  title: "Codex",
  accent: "#111111",
  installTitle: "Installation de Codex",
  authTitle: "Connexion OpenAI",
  doneTitle: "Bridge est prêt avec Codex",
};

async function runCodexSetup() {
  return showCodexSetupWindow();
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
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 560,
      height: 600,
      resizable: false,
      minimizable: false,
      maximizable: false,
      center: true,
      title: "Configuration Codex",
      backgroundColor: "#faf9f7",
      show: true,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      },
    });
    win.setMenuBarVisibility(false);
    const channel = `codex-setup-action-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const { ipcMain } = require("electron");
    win.loadURL(`data:text/html;charset=utf-8;base64,${Buffer.from(setupHtml(needsInstall, alreadyAuthenticated, channel), "utf8").toString("base64")}`);

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

function setupHtml(needsInstall, alreadyAuthenticated, channel) {
  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <title>Configuration Codex</title>
  <style>
    * { box-sizing: border-box; }
    :root { --bg: #faf9f7; --panel: #fff; --border: #ebe8e1; --text: #1a1916; --muted: #746f66; --soft: #9b958c; --accent: ${CODEX.accent}; --accent-tint: #f0efeb; --green: #2e7d32; --green-bg: #eef8ef; --red: #b23b2d; --red-bg: #fff0ee; }
    body { margin: 0; height: 100vh; overflow: hidden; background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
    header { height: 76px; padding: 18px 28px; display: flex; align-items: center; gap: 12px; background: var(--panel); border-bottom: 1px solid var(--border); }
    .logo { width: 38px; height: 38px; border-radius: 10px; display: grid; place-items: center; background: var(--accent); color: #fff; font-weight: 800; }
    .eyebrow { font-size: 10px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: var(--soft); }
    h1 { margin: 2px 0 0; font-size: 17px; line-height: 1.2; }
    main { height: calc(100vh - 144px); overflow-y: auto; padding: 24px 28px 18px; }
    footer { height: 68px; padding: 16px 28px; background: var(--panel); border-top: 1px solid var(--border); display: flex; justify-content: flex-end; gap: 10px; }
    .steps { display: grid; gap: 16px; }
    .step { display: flex; gap: 14px; align-items: flex-start; }
    .step-icon { width: 34px; height: 34px; border-radius: 50%; flex: 0 0 auto; display: grid; place-items: center; font-size: 14px; font-weight: 800; background: #f0ede8; color: var(--soft); }
    .step-icon.running { background: var(--accent-tint); color: var(--accent); animation: pulse 1.3s ease-in-out infinite; }
    .step-icon.done { background: var(--green-bg); color: var(--green); animation: none; }
    .step-icon.error { background: var(--red-bg); color: var(--red); animation: none; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .55; } }
    .step-body { min-width: 0; flex: 1; }
    .step-title { font-size: 14px; font-weight: 700; margin-bottom: 4px; }
    .step-title.muted { color: var(--soft); }
    .step-desc { color: var(--muted); font-size: 12.5px; line-height: 1.55; }
    .progress-wrap { display: none; margin-top: 10px; }
    .progress-track { height: 10px; overflow: hidden; border-radius: 999px; background: #ebe8e1; }
    .progress-fill { height: 100%; width: 0%; border-radius: 999px; background: var(--accent); transition: width .25s ease; }
    .progress-fill.indeterminate { width: 35%; animation: slide 1.5s ease-in-out infinite; }
    @keyframes slide { 0% { transform: translateX(-180%); } 100% { transform: translateX(340%); } }
    .progress-status { margin-top: 5px; display: flex; justify-content: space-between; color: var(--muted); font-size: 11.5px; }
    .log { display: none; max-height: 82px; overflow: auto; margin-top: 8px; padding: 7px 8px; border-radius: 7px; background: #f4f2ed; color: var(--soft); font: 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; }
    .code { display: inline-block; margin: 10px 0; padding: 10px 18px; border-radius: 8px; background: var(--accent-tint); color: var(--accent); font: 700 26px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; letter-spacing: 3px; user-select: all; }
    button { border: 0; border-radius: 7px; padding: 8px 17px; font: inherit; font-size: 13px; font-weight: 650; cursor: pointer; }
    .primary { background: var(--accent); color: #fff; }
    .secondary { background: #ebe8e1; color: var(--text); }
  </style>
</head>
<body>
  <header><div class="logo">C</div><div><div class="eyebrow">Bridge</div><h1>Configuration Codex</h1></div></header>
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

module.exports = { runCodexSetup, ensureCodexFileStore, findCodexBin };
