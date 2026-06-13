#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const target = valueAfter("--target") || process.env.BRIDGE_TARGET_PLATFORM || process.platform;
const root = process.cwd();
const exe = target === "win32" ? "bridge-voice.exe" : "bridge-voice";
const required = [
  "electron-main.cjs",
  "bridge-preload.cjs",
  "provider-setup.cjs",
  "runtime.cjs",
  "index.cjs",
  "mcp.cjs",
  "theme.cjs",
  "design-system.json",
  "bridge-mark.png",
  "yaka-build.json",
  "THIRD_PARTY_NOTICES.md",
  `bridge-voice/${target}/${exe}`,
];

const missing = [];
for (const relative of required) {
  const full = resolve(root, "dist", "bridge", relative);
  if (!existsSync(full)) {
    missing.push(relative);
    continue;
  }
  const stat = statSync(full);
  if (!stat.isFile() || stat.size <= 0) missing.push(`${relative} (empty)`);
}

if (missing.length) {
  console.error(`[bridge-assets] missing for ${target}:`);
  for (const item of missing) console.error(`- ${item}`);
  process.exitCode = 1;
} else {
  validateBuildMetadata();
  console.log(`[bridge-assets] OK for ${target}`);
}

function valueAfter(flag) {
  const args = process.argv.slice(2);
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function validateBuildMetadata() {
  const full = resolve(root, "dist", "bridge", "yaka-build.json");
  const metadata = JSON.parse(readFileSync(full, "utf8"));
  const errors = [];
  if (metadata.schema !== "yaka/bridge-build.v1") errors.push("schema");
  if (!metadata.platform?.version) errors.push("platform.version");
  if (!metadata.platform?.commit) errors.push("platform.commit");
  if (metadata.target?.platform !== target) errors.push("target.platform");
  if (!metadata.packages?.["@ncleton-petitmaker/yaka-bridge-desktop"]) {
    errors.push("packages.@ncleton-petitmaker/yaka-bridge-desktop");
  }
  if (errors.length) {
    console.error(`[bridge-assets] invalid yaka-build.json: ${errors.join(", ")}`);
    process.exitCode = 1;
  }
}
