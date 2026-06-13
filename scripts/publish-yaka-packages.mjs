#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const dryRun = process.argv.includes("--dry-run");
const project = readJson(join(root, "yaka.project.json"));
const rootPackage = readJson(join(root, "package.json"));

if (!project || project.kind !== "platform") {
  fail("yaka.project.json plateforme introuvable.");
}

const packages = Array.isArray(project.packages) ? project.packages : [];
if (!packages.length) fail("Aucun package Yaka declare dans yaka.project.json.");

for (const packageName of packages) {
  const folder = platformPackageFolder(packageName);
  const packagePath = join(root, "packages", folder, "package.json");
  if (!existsSync(packagePath)) fail(`Package manquant: ${packagePath}`);
  const workspacePackage = readJson(packagePath);
  if (workspacePackage?.name !== packageName) fail(`${packagePath} ne declare pas ${packageName}.`);
  if (workspacePackage?.version !== rootPackage?.version) {
    fail(`${packageName} est en ${workspacePackage?.version}, attendu ${rootPackage?.version}.`);
  }

  const args = ["publish", "--workspace", packageName, "--registry", "https://npm.pkg.github.com"];
  if (dryRun) args.push("--dry-run");
  console.log(`[yaka-packages] ${dryRun ? "dry-run" : "publish"} ${packageName}@${workspacePackage.version}`);
  const result = spawnSync("npm", args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function platformPackageFolder(packageName) {
  return packageName.replace("@ncleton-petitmaker/yaka-", "");
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function fail(message) {
  console.error(`[yaka-packages] ${message}`);
  process.exit(1);
}
