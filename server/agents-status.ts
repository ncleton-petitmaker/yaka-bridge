/**
 * Probe le statut de Claude Code CLI : présence, version, login.
 * Utilisé par /api/agents pour la page Paramètres.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { findClaudeBin } from "./agents.js";

interface AgentStatus {
  id: "claude";
  name: "Claude Code";
  available: boolean;
  path: string | null;
  version: string | null;
  loggedIn: boolean | null;
  error?: string;
}

function execProbe(bin: string, args: string[], timeoutMs = 5000): Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null }> {
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

export async function getAgentStatus(): Promise<AgentStatus> {
  const bin = findClaudeBin();
  if (!bin) {
    return {
      id: "claude",
      name: "Claude Code",
      available: false,
      path: null,
      version: null,
      loggedIn: null,
      error: "Binaire 'claude' introuvable sur le PATH. Installez Claude Code et faites 'claude login'.",
    };
  }

  // Version
  const v = await execProbe(bin, ["--version"], 5000);
  const versionMatch = v.stdout.match(/(\d+\.\d+\.\d+)/);
  const version = versionMatch ? versionMatch[1] : null;

  // Login : vérifie CLAUDE_CODE_OAUTH_TOKEN (injecté par Electron) ou .credentials.json
  let loggedIn: boolean | null = null;
  if (v.ok) {
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      loggedIn = true;
    } else {
      const home = process.env.HOME || process.env.USERPROFILE;
      const credPaths = home ? [
        path.join(home, ".claude", ".credentials.json"),
        path.join(home, ".claude", "credentials.json"),
      ] : [];
      loggedIn = false;
      for (const p of credPaths) {
        try {
          const c = JSON.parse(fs.readFileSync(p, "utf8"));
          if (c?.claudeAiOauth?.accessToken || c?.accessToken) { loggedIn = true; break; }
        } catch {}
      }
    }
  }

  return {
    id: "claude",
    name: "Claude Code",
    available: v.ok && version !== null,
    path: bin,
    version,
    loggedIn,
    error: v.ok ? undefined : v.stderr.slice(0, 500) || "claude --version a échoué",
  };
}
