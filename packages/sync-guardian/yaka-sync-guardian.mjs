#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url));
const CURRENT_PLATFORM_VERSION = readJson(join(PACKAGE_ROOT, "package.json"))?.version ?? "0.0.0";
const REQUIRED_PACKAGES = [
  "@ncleton-petitmaker/yaka-bridge-desktop",
  "@ncleton-petitmaker/yaka-bridge-runtime",
  "@ncleton-petitmaker/yaka-bridge-voice",
  "@ncleton-petitmaker/yaka-erp-shell",
  "@ncleton-petitmaker/yaka-module-sdk",
  "@ncleton-petitmaker/yaka-design-system",
  "@ncleton-petitmaker/yaka-factory",
  "@ncleton-petitmaker/yaka-sync-guardian",
];
const FORBIDDEN_CLIENT_CORE_PATHS = [
  "bridge/electron-main.cjs",
  "bridge/provider-setup.cjs",
  "bridge/runtime.ts",
  "bridge/runtime.cjs",
  "bridge-voice/src/main.rs",
  "electron-builder.bridge.cjs",
  "scripts/build-bridge.mjs",
  "scripts/verify-bridge-package-assets.mjs",
];

const argv = process.argv.slice(2);
const command = argv.find((arg) => !arg.startsWith("-")) ?? "doctor";
const cwd = resolve(valueAfter("--cwd") ?? process.cwd());
const json = argv.includes("--json");
const strict = argv.includes("--strict");

try {
  if (command === "doctor") {
    const result = doctor(cwd, { strict });
    printResult(result);
    process.exit(result.ok ? 0 : 1);
  }
  if (command === "status") {
    const result = status(cwd);
    printResult(result);
    process.exit(result.ok ? 0 : 1);
  }
  if (command === "clients") {
    const result = clients(cwd);
    printResult(result);
    process.exit(result.ok ? 0 : 1);
  }
  usage();
  process.exit(2);
} catch (err) {
  const result = { ok: false, errors: [err instanceof Error ? err.message : String(err)], warnings: [] };
  printResult(result);
  process.exit(1);
}

function doctor(inputCwd, options = {}) {
  const root = findRepoRoot(inputCwd) ?? inputCwd;
  const pkg = readJson(join(root, "package.json"));
  const project = readJson(join(root, "yaka.project.json"));
  const kind = project?.kind ?? inferKind(pkg, root);
  const result = baseResult(root, kind);

  if (!pkg) {
    result.errors.push("package.json introuvable.");
    return finish(result);
  }

  if (kind === "platform") {
    validatePlatform(root, pkg, project, result);
  } else if (kind === "client-erp") {
    validateClient(root, pkg, project, result);
  } else {
    result.errors.push("Projet Yaka non identifié. Ajoute yaka.project.json.");
  }

  if (options.strict && result.warnings.some((warning) => warning.startsWith("STRICT:"))) {
    result.errors.push(...result.warnings.filter((warning) => warning.startsWith("STRICT:")));
  }

  return finish(result);
}

function status(inputCwd) {
  const root = findRepoRoot(inputCwd) ?? inputCwd;
  const pkg = readJson(join(root, "package.json"));
  const project = readJson(join(root, "yaka.project.json"));
  const kind = project?.kind ?? inferKind(pkg, root);
  return finish({
    ...baseResult(root, kind),
    packageName: pkg?.name,
    packageVersion: pkg?.version,
    project,
  });
}

function clients(inputCwd) {
  const root = findRepoRoot(inputCwd) ?? inputCwd;
  const platform = readJson(join(root, "yaka.project.json"));
  const projectsDir = resolve(root, platform?.clientRegistry?.path ?? "Projets");
  const entries = [];
  if (existsSync(projectsDir)) {
    for (const company of readdirSync(projectsDir, { withFileTypes: true })) {
      if (!company.isDirectory() || company.name.startsWith(".") || company.name === "_template") continue;
      const companyDir = join(projectsDir, company.name);
      for (const project of readdirSync(companyDir, { withFileTypes: true })) {
        if (!project.isDirectory() || project.name.startsWith(".")) continue;
        const projectDir = join(companyDir, project.name);
        const projectManifest = readJson(join(projectDir, "yaka.project.json"));
        const packageJson = readJson(join(projectDir, "package.json"));
        entries.push({
          company: company.name,
          name: project.name,
          path: relative(root, projectDir),
          kind: projectManifest?.kind ?? inferKind(packageJson, projectDir),
          packageName: packageJson?.name,
          packageVersion: packageJson?.version,
          hasGit: existsSync(join(projectDir, ".git")),
          hasYakaProject: Boolean(projectManifest),
        });
      }
    }
  }
  return finish({ ...baseResult(root, "platform"), clients: entries });
}

function validatePlatform(root, pkg, project, result) {
  if (!project) result.errors.push("yaka.project.json plateforme obligatoire.");
  if (project && project.schema !== "yaka/project.v1") result.errors.push("schema yaka.project.json invalide.");
  if (pkg.name !== "yaka-bridge") result.errors.push(`package root attendu: yaka-bridge, reçu: ${pkg.name}.`);
  if (!Array.isArray(pkg.workspaces) || !pkg.workspaces.includes("packages/*")) {
    result.errors.push("workspaces doit inclure packages/*.");
  }
  if (!Array.isArray(pkg.workspaces) || !pkg.workspaces.includes("templates/*")) {
    result.errors.push("workspaces doit inclure templates/*.");
  }

  for (const packageName of REQUIRED_PACKAGES) {
    const folder = platformPackageFolder(packageName);
    const packagePath = join(root, "packages", folder, "package.json");
    const workspacePackage = readJson(packagePath);
    if (!workspacePackage) {
      result.errors.push(`Package plateforme manquant: packages/${folder}/package.json.`);
      continue;
    }
    if (workspacePackage.name !== packageName) {
      result.errors.push(`Package ${folder} doit s'appeler ${packageName}.`);
    }
    if (workspacePackage.version !== pkg.version) {
      result.errors.push(`Package ${packageName} en ${workspacePackage.version}, attendu ${pkg.version}.`);
    }
  }

  const templateProject = readJson(join(root, "templates", "client-erp", "yaka.project.json"));
  const templatePackage = readJson(join(root, "templates", "client-erp", "package.json"));
  if (!templateProject || templateProject.kind !== "client-erp") {
    result.errors.push("Template client manquant ou invalide: templates/client-erp/yaka.project.json.");
  }
  if (!templatePackage) result.errors.push("Template client manquant: templates/client-erp/package.json.");

  for (const scriptName of ["yaka:doctor", "yaka:status", "yaka:clients"]) {
    if (!pkg.scripts?.[scriptName]) result.errors.push(`Script obligatoire manquant: ${scriptName}.`);
  }
  for (const scriptName of ["bridge:pack:mac", "bridge:pack:win"]) {
    if (!String(pkg.scripts?.[scriptName] ?? "").includes("yaka-sync-guardian.mjs doctor --strict")) {
      result.errors.push(`${scriptName} doit lancer yaka-sync-guardian avant le packaging.`);
    }
  }

  const ci = existsSync(join(root, ".github", "workflows", "ci.yml"))
    ? readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8")
    : "";
  if (!ci.includes("npm run yaka:doctor")) result.errors.push("CI doit lancer npm run yaka:doctor.");
}

function validateClient(root, pkg, project, result) {
  if (!project) {
    result.errors.push("Client Yaka sans yaka.project.json.");
    return;
  }
  if (project.schema !== "yaka/project.v1") result.errors.push("schema yaka.project.json invalide.");
  if (!project.clientSlug) result.errors.push("clientSlug obligatoire.");
  if (!project.platform?.packages || typeof project.platform.packages !== "object") {
    result.errors.push("platform.packages obligatoire dans yaka.project.json.");
  }

  const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  for (const packageName of ["@ncleton-petitmaker/yaka-bridge-desktop", "@ncleton-petitmaker/yaka-erp-shell", "@ncleton-petitmaker/yaka-module-sdk"]) {
    const expected = project.platform?.packages?.[packageName];
    const actual = allDeps[packageName];
    if (!expected) result.errors.push(`yaka.project.json doit épingler ${packageName}.`);
    if (!actual) result.errors.push(`package.json doit dépendre de ${packageName}.`);
    if (expected && actual && normalizeRange(actual) !== normalizeRange(expected)) {
      result.errors.push(`${packageName} désynchronisé: package.json=${actual}, yaka.project=${expected}.`);
    }
  }

  if (!existsSync(join(root, "modules.lock.json"))) {
    result.errors.push("modules.lock.json obligatoire pour un client ERP.");
  }

  for (const forbidden of FORBIDDEN_CLIENT_CORE_PATHS) {
    if (existsSync(join(root, forbidden))) {
      result.errors.push(`Core Yaka copié dans le client: ${forbidden}. Utilise les packages @ncleton-petitmaker/yaka-*.`);
    }
  }

  const releaseDir = join(root, "release-bridge");
  if (existsSync(releaseDir) && hasDmg(releaseDir)) {
    result.errors.push("release-bridge contient un DMG local. Les artefacts client doivent venir de CI.");
  }
}

function inferKind(pkg, root) {
  if (pkg?.name === "yaka-bridge") return "platform";
  if (existsSync(join(root, "bridge", "electron-main.cjs")) || existsSync(join(root, "electron-builder.bridge.cjs"))) {
    return "legacy-client";
  }
  if (pkg?.dependencies && Object.keys(pkg.dependencies).some((name) => name.startsWith("@ncleton-petitmaker/yaka-"))) {
    return "client-erp";
  }
  return "unknown";
}

function hasDmg(dir) {
  try {
    return readdirSync(dir).some((entry) => entry.endsWith(".dmg"));
  } catch {
    return false;
  }
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

function findRepoRoot(start) {
  const res = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: start,
    encoding: "utf8",
    timeout: 3000,
  });
  if (res.status === 0 && res.stdout.trim()) return resolve(res.stdout.trim());
  return null;
}

function baseResult(root, kind) {
  return {
    ok: true,
    root,
    kind,
    platformVersion: CURRENT_PLATFORM_VERSION,
    errors: [],
    warnings: [],
  };
}

function finish(result) {
  result.ok = result.errors.length === 0;
  return result;
}

function printResult(result) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Yaka sync guardian: ${result.ok ? "OK" : "FAILED"} (${result.kind ?? "unknown"})`);
  if (result.root) console.log(`Root: ${result.root}`);
  for (const warning of result.warnings ?? []) console.warn(`WARN ${warning}`);
  for (const error of result.errors ?? []) console.error(`ERR ${error}`);
  if (result.clients) {
    for (const client of result.clients) {
      console.log(`${client.hasYakaProject ? "OK" : "LEGACY"} ${client.company}/${client.name} ${client.kind}`);
    }
  }
}

function usage() {
  console.error("Usage: node scripts/yaka-sync-guardian.mjs [doctor|status|clients] [--strict] [--json] [--cwd <path>]");
}

function valueAfter(flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function normalizeRange(value) {
  return String(value ?? "").trim().replace(/^[~^]/, "");
}

function relative(root, path) {
  return path.startsWith(root) ? path.slice(root.length + 1) : path;
}
