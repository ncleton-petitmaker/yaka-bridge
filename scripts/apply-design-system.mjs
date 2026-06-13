#!/usr/bin/env node
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), "..");

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  ensureDir(path);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function ensureDir(path) {
  mkdirSync(dirname(path), { recursive: true });
}

function copyRequired(src, dst) {
  if (!existsSync(src) || !statSync(src).isFile()) {
    throw new Error(`Required design-system file missing: ${src}`);
  }
  ensureDir(dst);
  copyFileSync(src, dst);
}

function copyOptional(src, dst) {
  if (!src || !existsSync(src) || !statSync(src).isFile()) return false;
  ensureDir(dst);
  copyFileSync(src, dst);
  return true;
}

function resolveDesignSystem(args) {
  const id = String(args["design-system"] || args.design || "claude");
  const explicitSource = args.source ? resolvePath(String(args.source)) : null;
  const sourceDir = explicitSource ?? resolve(ROOT, "design-systems", id);
  if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
    throw new Error(
      `Design system not found: ${sourceDir}\n` +
        `Use --design-system <id> for design-systems/<id> or --source <dir> for an imported system.`
    );
  }
  const manifestPath = resolve(sourceDir, "design-system.config.json");
  if (!existsSync(manifestPath)) {
    throw new Error(
      `Missing design-system.config.json in ${sourceDir}.\n` +
        `Run npm run design:import -- --id <id> --source <DESIGN.md|dir> first.`
    );
  }
  const manifest = readJson(manifestPath);
  const systemId = String(args["design-system"] || manifest.id || basename(sourceDir));
  return { id: systemId, sourceDir, manifest };
}

function resolvePath(path) {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

function fileFromManifest(sourceDir, manifest, key) {
  const rel = manifest.files?.[key];
  return rel ? resolve(sourceDir, rel) : null;
}

function validateTokens(tokensPath, manifest) {
  const css = readFileSync(tokensPath, "utf8");
  const missing = [];
  for (const token of manifest.requiredCssVariables ?? []) {
    if (!css.includes(`${token}:`)) missing.push(token);
  }
  if (missing.length) {
    throw new Error(
      `Design system tokens.css is missing required variables:\n` +
        missing.map((token) => `  - ${token}`).join("\n")
    );
  }
}

function main() {
  const args = parseArgs(process.argv);
  const { id, sourceDir, manifest } = resolveDesignSystem(args);
  const targetDir = args["target-dir"] ? resolvePath(String(args["target-dir"])) : ROOT;

  const tokensPath = fileFromManifest(sourceDir, manifest, "tokens");
  const designDocPath = fileFromManifest(sourceDir, manifest, "designDoc");
  const appMarkPath = fileFromManifest(sourceDir, manifest, "appMark");
  const bridgeMarkPath = fileFromManifest(sourceDir, manifest, "bridgeMark");
  const bridgeMarkExt = bridgeMarkPath ? extname(bridgeMarkPath) || ".svg" : ".svg";

  if (!tokensPath) throw new Error(`Design system ${id} has no files.tokens entry.`);
  if (!designDocPath) throw new Error(`Design system ${id} has no files.designDoc entry.`);
  validateTokens(tokensPath, manifest);

  const appliedFiles = {
    appCss: "app/design-system.css",
    designDoc: "DESIGN.md",
    bridgeTokens: "bridge/design-system.json",
    appMark: "public/app-mark.svg",
    bridgeMark: `public/bridge-mark${bridgeMarkExt}`,
  };

  const appCssTarget = resolve(targetDir, appliedFiles.appCss);
  const cssHeader =
    `/* Active design system. Managed by scripts/apply-design-system.mjs. */\n` +
    `/* Source: ${relative(targetDir, tokensPath)} */\n`;
  ensureDir(appCssTarget);
  writeFileSync(appCssTarget, cssHeader + readFileSync(tokensPath, "utf8"), "utf8");

  copyRequired(designDocPath, resolve(targetDir, appliedFiles.designDoc));
  copyOptional(appMarkPath, resolve(targetDir, appliedFiles.appMark));
  copyOptional(bridgeMarkPath, resolve(targetDir, appliedFiles.bridgeMark));

  const bridgeTokens = manifest.bridge?.tokens;
  if (!bridgeTokens || typeof bridgeTokens !== "object") {
    throw new Error(`Design system ${id} must provide bridge.tokens for Bridge setup UI.`);
  }
  writeJson(resolve(targetDir, appliedFiles.bridgeTokens), bridgeTokens);

  writeJson(resolve(targetDir, "design-system.config.json"), {
    contractVersion: manifest.contractVersion ?? "1.0.0",
    active: id,
    name: manifest.name ?? id,
    sourceKind: manifest.sourceKind ?? "yaka-bridge",
    sourceMeta: manifest.source ?? null,
    source: relative(targetDir, sourceDir),
    targets: manifest.targets ?? ["app", "modules", "bridge"],
    appliedFiles,
  });

  console.log(`Applied design system "${id}" to ${targetDir}`);
  console.log(`  app CSS      ${appliedFiles.appCss}`);
  console.log(`  design doc   ${appliedFiles.designDoc}`);
  console.log(`  Bridge       ${appliedFiles.bridgeTokens}`);
  if (appMarkPath) console.log(`  app mark     ${appliedFiles.appMark}`);
  if (bridgeMarkPath) console.log(`  Bridge mark  ${appliedFiles.bridgeMark}`);
}

try {
  main();
} catch (err) {
  console.error(`[design:apply] ${err?.message || err}`);
  process.exit(1);
}
