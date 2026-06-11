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
  const purchasingManifest = meta.manifests?.find((manifest) => manifest.id === "purchasing");
  if (purchasingManifest?.version !== "0.1.0") {
    throw new Error(`Invalid generated purchasing module version: ${JSON.stringify(purchasingManifest?.version)}`);
  }
  const design = JSON.parse(readFileSync(join(outputDir, "design-system.config.json"), "utf8"));
  if (design.active !== "claude") {
    throw new Error(`Invalid generated design system: ${JSON.stringify(design.active)}`);
  }
  readFileSync(join(outputDir, "app", "design-system.css"), "utf8");
  readFileSync(join(outputDir, "bridge", "design-system.json"), "utf8");
  for (const skill of [
    "yaka-bridge-onboard",
    "yaka-bridge-create-module",
    "yaka-bridge-new-client-vps",
    "yaka-bridge-refactor-design-system",
    "yaka-bridge-version-modules",
  ]) {
    readFileSync(join(outputDir, ".codex", "skills", skill, "SKILL.md"), "utf8");
  }

  run("npm", ["ci"], outputDir);
  run("npm", ["run", "skills:check"], outputDir);
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
