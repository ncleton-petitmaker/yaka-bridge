#!/usr/bin/env node
/**
 * Bundle server/index.ts en dist/server.cjs auto-suffisant pour la prod.
 *
 * Pourquoi ? En mode packagé Electron, spawner tsx pour exécuter du
 * TypeScript en runtime est fragile (tsx re-fork Node, ce qui pose des
 * soucis sous ELECTRON_RUN_AS_NODE). Mieux vaut compiler en JS une fois
 * pour toutes au build.
 *
 * Externalise les modules natifs (.node) qui doivent être chargés depuis
 * node_modules au runtime. Les apps qui ajoutent des deps natives doivent
 * les lister dans `EXTERNAL` ci-dessous.
 */
import * as esbuild from "esbuild";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";

const ROOT = resolve(import.meta.dirname, "..");
const DIST = resolve(ROOT, "dist");
const OUT = resolve(DIST, "server.cjs");
const MCP_OUT = resolve(DIST, "mcp.cjs");

mkdirSync(DIST, { recursive: true });

// Liste des modules à externaliser (modules natifs ou volumineux qu'on ne veut
// pas bundler). À étendre par les apps métier.
const EXTERNAL = [
  // exemple: "better-sqlite3", "sharp", etc.
];

for (const [entry, outfile] of [
  [resolve(ROOT, "server", "index.ts"), OUT],
  [resolve(ROOT, "server", "mcp.ts"), MCP_OUT],
]) {
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    target: "node24",
    format: "cjs",
    outfile,
    external: EXTERNAL,
    sourcemap: false,
    minify: false,
    logLevel: "info",
  });
  console.log(`✓ ${outfile}`);
}
