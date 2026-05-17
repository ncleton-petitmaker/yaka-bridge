#!/usr/bin/env node
/**
 * Patche le bundle Electron embarqué dans node_modules pour que macOS
 * affiche "OIF-Eval" partout (menu bar, Dock, About) au lieu de "Electron"
 * en mode dev (npm run electron).
 *
 * En mode pack final (electron-builder), ce script n'est plus nécessaire,
 * le bundle .app est généré avec le bon Info.plist via productName.
 *
 * Idempotent : peut être relancé sans danger.
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (process.platform !== "darwin") {
  console.log("[rebrand-electron] non-macOS, rien à faire");
  process.exit(0);
}

const plistPath = resolve(
  ROOT,
  "node_modules/electron/dist/Electron.app/Contents/Info.plist"
);

if (!existsSync(plistPath)) {
  console.warn(
    `[rebrand-electron] Info.plist introuvable : ${plistPath}. Skip.`
  );
  process.exit(0);
}

function patch(key, value) {
  const r = spawnSync(
    "plutil",
    ["-replace", key, "-string", value, plistPath],
    { encoding: "utf8" }
  );
  if (r.status !== 0) {
    console.warn(`[rebrand-electron] échec patch ${key}: ${r.stderr}`);
  } else {
    console.log(`[rebrand-electron] ${key} = "${value}"`);
  }
}

patch("CFBundleName", "OIF-Eval");
patch("CFBundleDisplayName", "OIF-Eval");
patch("CFBundleExecutable", "Electron"); // garde le binaire d'origine
