#!/usr/bin/env node
/**
 * Bundle electron/mcp-xlsx.cjs en dist/mcp-xlsx.cjs auto-suffisant.
 *
 * Pourquoi ? En mode packagé Windows (electron.exe + ELECTRON_RUN_AS_NODE=1),
 * les require() dynamiques et imports ESM sur @modelcontextprotocol/sdk,
 * exceljs et mammoth depuis app.asar.unpacked sont fragiles : le résolveur
 * de modules de Node ne trouve pas toujours node_modules/ correctement, et
 * les imports ESM dynamiques échouent silencieusement sous Electron-as-Node.
 *
 * En bundlant tout dans un seul .cjs CommonJS, aucun require runtime hors
 * Node built-ins. Le binaire devient self-contained et portable.
 */
import * as esbuild from "esbuild";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, "dist", "mcp-xlsx.cjs");

mkdirSync(resolve(ROOT, "dist"), { recursive: true });

await esbuild.build({
  entryPoints: [resolve(ROOT, "electron", "mcp-xlsx.cjs")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: OUT,
  external: [],
  sourcemap: false,
  minify: false,
  logLevel: "info",
});

console.log(`OK ${OUT}`);
