#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

const NEXT_ENV_VAR = "{{APP_NAME_KEBAB_UPPER}}_NEXT_PORT";
const DAEMON_ENV_VAR = "{{APP_NAME_KEBAB_UPPER}}_DAEMON_PORT";
const NEXT_PORT_PLACEHOLDER = "{{NEXT_PORT}}";
const DAEMON_PORT_PLACEHOLDER = "{{DAEMON_PORT}}";
const NEXT_PORT = process.env[NEXT_ENV_VAR] ?? (/^\d+$/.test(NEXT_PORT_PLACEHOLDER) ? NEXT_PORT_PLACEHOLDER : "3100");
const DAEMON_PORT = process.env[DAEMON_ENV_VAR] ?? (/^\d+$/.test(DAEMON_PORT_PLACEHOLDER) ? DAEMON_PORT_PLACEHOLDER : "7456");
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
