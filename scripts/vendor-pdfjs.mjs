#!/usr/bin/env node
/**
 * Télécharge le viewer prebuilt officiel pdf.js depuis les releases Mozilla
 * et le dépose dans `vendor/pdfjs/`. Match la version installée de pdfjs-dist.
 *
 * Pourquoi : depuis pdfjs-dist v5 (août 2024), le package npm ne contient
 * plus `web/viewer.html` (uniquement les briques `pdf_viewer.mjs`). Mozilla
 * publie le viewer complet en zip sur GitHub releases.
 *
 * Idempotent : si vendor/pdfjs/web/viewer.html existe déjà à la bonne
 * version, ne re-télécharge pas. Sinon nettoie et re-download.
 */
import { readFileSync, existsSync, mkdirSync, rmSync, writeFileSync, createWriteStream } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import { pipeline } from "node:stream/promises";

const ROOT = resolve(import.meta.dirname, "..");
const VENDOR_DIR = resolve(ROOT, "vendor", "pdfjs");
const STAMP = resolve(VENDOR_DIR, ".version");

const pkgPath = resolve(ROOT, "node_modules", "pdfjs-dist", "package.json");
if (!existsSync(pkgPath)) {
  console.error("pdfjs-dist n'est pas installé. Lance `npm install` d'abord.");
  process.exit(1);
}
const version = JSON.parse(readFileSync(pkgPath, "utf8")).version;

// Cache hit ?
if (existsSync(STAMP) && readFileSync(STAMP, "utf8").trim() === version) {
  console.log(`vendor-pdfjs : déjà à jour (v${version})`);
  process.exit(0);
}

console.log(`vendor-pdfjs : téléchargement v${version}…`);
rmSync(VENDOR_DIR, { recursive: true, force: true });
mkdirSync(VENDOR_DIR, { recursive: true });

const url = `https://github.com/mozilla/pdf.js/releases/download/v${version}/pdfjs-${version}-dist.zip`;
const zipPath = resolve(VENDOR_DIR, "pdfjs.zip");

const res = await fetch(url, { redirect: "follow" });
if (!res.ok || !res.body) {
  console.error(`vendor-pdfjs : téléchargement échoué (${res.status} ${res.statusText}) sur ${url}`);
  process.exit(1);
}
await pipeline(res.body, createWriteStream(zipPath));

// unzip via la commande système (présente sur macOS, Linux, Windows 10+)
try {
  execSync(`unzip -q -o "${zipPath}" -d "${VENDOR_DIR}"`, { stdio: "inherit" });
} catch (e) {
  console.error("vendor-pdfjs : unzip a échoué. Sur Windows ancien, installer unzip ou utiliser tar.");
  process.exit(1);
}
rmSync(zipPath);

if (!existsSync(resolve(VENDOR_DIR, "web", "viewer.html"))) {
  console.error("vendor-pdfjs : le zip ne contient pas web/viewer.html, structure inattendue.");
  process.exit(1);
}
writeFileSync(STAMP, version, "utf8");
console.log(`vendor-pdfjs : OK, vendor/pdfjs/web/viewer.html prêt (v${version})`);
