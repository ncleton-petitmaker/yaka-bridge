#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const NEXT_ENV_VAR = "{{APP_NAME_KEBAB_UPPER}}_NEXT_PORT";
const NEXT_PORT_PLACEHOLDER = "{{NEXT_PORT}}";
const NEXT_PORT =
  process.env[NEXT_ENV_VAR] ??
  process.env.NEXT_PORT ??
  (/^\d+$/.test(NEXT_PORT_PLACEHOLDER) ? NEXT_PORT_PLACEHOLDER : "3307");

const standaloneServer = resolve(".next", "standalone", "server.js");
const command = existsSync(standaloneServer) ? process.execPath : "next";
const args = existsSync(standaloneServer) ? [standaloneServer] : ["start", "-p", String(NEXT_PORT)];

const child = spawn(command, args, {
  stdio: "inherit",
  env: {
    ...process.env,
    PORT: String(NEXT_PORT),
  },
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
