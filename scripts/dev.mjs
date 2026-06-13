#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

const NEXT_ENV_VAR = "{{APP_NAME_KEBAB_UPPER}}_NEXT_PORT";
const DAEMON_ENV_VAR = "{{APP_NAME_KEBAB_UPPER}}_DAEMON_PORT";
const NEXT_PORT_PLACEHOLDER = "{{NEXT_PORT}}";
const DAEMON_PORT_PLACEHOLDER = "{{DAEMON_PORT}}";

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const cliNextPort = valueAfter("--port") ?? valueAfter("-p");
const cliDaemonPort = valueAfter("--daemon-port");
const NEXT_PORT =
  cliNextPort ??
  process.env[NEXT_ENV_VAR] ??
  process.env.NEXT_PORT ??
  (/^\d+$/.test(NEXT_PORT_PLACEHOLDER) ? NEXT_PORT_PLACEHOLDER : "3100");
const DAEMON_PORT =
  cliDaemonPort ??
  process.env[DAEMON_ENV_VAR] ??
  process.env.DAEMON_PORT ??
  (/^\d+$/.test(DAEMON_PORT_PLACEHOLDER) ? DAEMON_PORT_PLACEHOLDER : "7456");
const daemonToken = process.env.APP_DAEMON_TOKEN || randomBytes(32).toString("base64url");

const children = [
  spawn("tsx", ["watch", "server/index.ts"], {
    stdio: "inherit",
    env: {
      ...process.env,
      APP_DAEMON_TOKEN: daemonToken,
      [DAEMON_ENV_VAR]: DAEMON_PORT,
    },
  }),
  spawn("next", ["dev", "-p", String(NEXT_PORT)], {
    stdio: "inherit",
    env: {
      ...process.env,
      NEXT_PUBLIC_DAEMON_PORT: String(DAEMON_PORT),
      NEXT_PUBLIC_DAEMON_TOKEN: daemonToken,
      WATCHPACK_POLLING: process.env.WATCHPACK_POLLING ?? "true",
      WATCHPACK_POLLING_INTERVAL: process.env.WATCHPACK_POLLING_INTERVAL ?? "1000",
      CHOKIDAR_USEPOLLING: process.env.CHOKIDAR_USEPOLLING ?? "true",
      CHOKIDAR_INTERVAL: process.env.CHOKIDAR_INTERVAL ?? "1000",
      [NEXT_ENV_VAR]: NEXT_PORT,
    },
  }),
];

function stop(signal) {
  for (const child of children) child.kill(signal);
}

process.on("SIGINT", () => {
  stop("SIGINT");
  process.exit(130);
});
process.on("SIGTERM", () => {
  stop("SIGTERM");
  process.exit(143);
});

for (const child of children) {
  child.on("exit", (code, signal) => {
    if (signal) return;
    if (code && code !== 0) {
      stop("SIGTERM");
      process.exit(code);
    }
  });
}
