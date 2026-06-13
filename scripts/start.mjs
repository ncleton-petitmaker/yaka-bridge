#!/usr/bin/env node
/**
 * Lance daemon + Next.js puis ouvre le navigateur.
 * Mode bundle prod sans Electron.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { platform } from "node:os";

const NEXT_ENV_VAR = "{{APP_NAME_KEBAB_UPPER}}_NEXT_PORT";
const DAEMON_ENV_VAR = "{{APP_NAME_KEBAB_UPPER}}_DAEMON_PORT";
const NEXT_PORT_PLACEHOLDER = "{{NEXT_PORT}}";
const DAEMON_PORT_PLACEHOLDER = "{{DAEMON_PORT}}";
const NEXT_PORT =
  process.env[NEXT_ENV_VAR] ??
  process.env.NEXT_PORT ??
  (/^\d+$/.test(NEXT_PORT_PLACEHOLDER) ? NEXT_PORT_PLACEHOLDER : "3307");
const DAEMON_PORT =
  process.env[DAEMON_ENV_VAR] ??
  process.env.DAEMON_PORT ??
  (/^\d+$/.test(DAEMON_PORT_PLACEHOLDER) ? DAEMON_PORT_PLACEHOLDER : "7456");
const daemonToken = process.env.APP_DAEMON_TOKEN || randomBytes(32).toString("base64url");

function logChild(name, child) {
  child.stdout.on("data", (b) => process.stdout.write(`[${name}] ${b}`));
  child.stderr.on("data", (b) => process.stderr.write(`[${name}] ${b}`));
  child.on("exit", (code) => console.log(`[${name}] exit ${code}`));
}

async function openBrowser(url) {
  const cmd =
    platform() === "darwin" ? "open" :
    platform() === "win32"  ? "cmd" :
    "xdg-open";
  const args =
    platform() === "win32" ? ["/c", "start", "", url] : [url];
  spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
}

async function main() {
  const daemon = spawn("npm", ["run", "start:daemon"], {
    env: {
      ...process.env,
      APP_DAEMON_TOKEN: daemonToken,
      [DAEMON_ENV_VAR]: DAEMON_PORT,
    },
  });
  logChild("daemon", daemon);

  const next = spawn("npm", ["run", "start:next"], {
    env: {
      ...process.env,
      NEXT_PUBLIC_DAEMON_PORT: String(DAEMON_PORT),
      NEXT_PUBLIC_DAEMON_TOKEN: daemonToken,
      [NEXT_ENV_VAR]: NEXT_PORT,
    },
  });
  logChild("next", next);

  // attendre que Next.js boote (timing approximatif, à durcir avec un poll HTTP)
  await wait(3000);
  await openBrowser(`http://localhost:${NEXT_PORT}`);

  process.on("SIGINT", () => {
    daemon.kill();
    next.kill();
    process.exit(0);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
