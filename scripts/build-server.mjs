#!/usr/bin/env node
/**
 * Bundle server/index.ts en dist/server.cjs auto-suffisant pour la prod.
 *
 * Pourquoi ? En mode packagé Electron, spawner tsx pour exécuter du
 * TypeScript en runtime est fragile (tsx re-fork Node, ce qui pose des
 * soucis sous ELECTRON_RUN_AS_NODE). Mieux vaut compiler en JS une fois
 * pour toutes au build.
 *
 * Externalise les modules natifs (better-sqlite3, sharp, etc.) qui doivent
 * être chargés depuis node_modules au runtime.
 */
import * as esbuild from "esbuild";
import { resolve } from "node:path";
import { mkdirSync, copyFileSync } from "node:fs";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, "dist", "server.cjs");

mkdirSync(resolve(ROOT, "dist"), { recursive: true });

// Copie le worker pdfjs-dist à côté du bundle. pdfjs cherche
// `pdf.worker.mjs` dans le même répertoire que son module au runtime
// (fake-worker setup en mode Node). Sans ce fichier, getDocument plante.
copyFileSync(
  resolve(ROOT, "node_modules", "pdfjs-dist", "legacy", "build", "pdf.worker.mjs"),
  resolve(ROOT, "dist", "pdf.worker.mjs")
);
console.log("✓ pdf.worker.mjs copié dans dist/");

await esbuild.build({
  entryPoints: [resolve(ROOT, "server", "index.ts")],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  outfile: OUT,
  // Bundle TOUT en interne pour qu'on n'ait pas besoin d'embarquer
  // node_modules/ dans le pack Electron (gain de 200+ Mo).
  // External : seulement les modules natifs (.node) qui ne peuvent pas
  // être bundlés.
  external: ["better-sqlite3"],
  // electron est jamais require au runtime du serveur
  sourcemap: false,
  minify: false,
  logLevel: "info",
});

console.log(`✓ ${OUT}`);
