#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outputDir = mkdtempSync(join(tmpdir(), "yaka-bridge-factory-"));

try {
  run("node", [
    "scripts/new-app-from-brief.mjs",
    "--brief",
    "briefs/demo-erp-purchasing.md",
    "--output-dir",
    outputDir,
    "--yes",
    "--force",
    "--skip-agents",
    "--skip-install",
    "--skip-typecheck",
  ], ROOT);

  const meta = JSON.parse(readFileSync(join(outputDir, ".factory-modules.json"), "utf8"));
  if (!Array.isArray(meta.selectedModules) || meta.selectedModules.length !== 1 || meta.selectedModules[0] !== "purchasing") {
    throw new Error(`Invalid generated module selection: ${JSON.stringify(meta.selectedModules)}`);
  }

  run("npm", ["ci"], outputDir);
  run("npm", ["run", "typecheck"], outputDir);
  run("npm", ["run", "build"], outputDir);
  run("node", ["scripts/security-grep.mjs"], outputDir);
  console.log(`Factory check passed: ${outputDir}`);
} finally {
  rmSync(outputDir, { recursive: true, force: true });
}

function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, {
    cwd,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}
