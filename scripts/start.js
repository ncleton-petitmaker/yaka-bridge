#!/usr/bin/env node
/**
 * Lance daemon + Next.js puis ouvre le navigateur.
 * Mode bundle prod sans Electron (script de fallback).
 */
import { spawn } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import { platform } from "node:os";

const NEXT_PORT = process.env["{{APP_NAME_KEBAB_UPPER}}_NEXT_PORT"] ?? "{{NEXT_PORT}}";
const DAEMON_PORT = process.env["{{APP_NAME_KEBAB_UPPER}}_DAEMON_PORT"] ?? "{{DAEMON_PORT}}";

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
      ["{{APP_NAME_KEBAB_UPPER}}_DAEMON_PORT"]: DAEMON_PORT,
    },
  });
  logChild("daemon", daemon);

  const next = spawn("npm", ["run", "start:next"], {
    env: {
      ...process.env,
      ["{{APP_NAME_KEBAB_UPPER}}_NEXT_PORT"]: NEXT_PORT,
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
