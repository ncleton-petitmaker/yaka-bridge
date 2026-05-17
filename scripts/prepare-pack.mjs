#!/usr/bin/env node
/**
 * Prépare l'arborescence pour electron-builder.
 *
 * Étapes :
 *   1. Bundle server.cjs (esbuild)
 *   2. next build (output standalone)
 *   3. Copie .next/static/ et public/ dans .next/standalone/ pour que
 *      le server.js standalone trouve les assets attendus
 *
 * À appeler avant electron-builder : `node scripts/prepare-pack.mjs && electron-builder --win --x64`
 */
import { execSync } from "node:child_process";
import { rmSync, cpSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

function step(label, fn) {
  console.log(`\n→ ${label}`);
  fn();
}

step("Clean .next et dist", () => {
  rmSync(resolve(ROOT, ".next"), { recursive: true, force: true });
  rmSync(resolve(ROOT, "dist"), { recursive: true, force: true });
});

step("Bundle server (esbuild)", () => {
  execSync("node scripts/build-server.mjs", { cwd: ROOT, stdio: "inherit" });
});

step("Bundle MCP xlsx server (esbuild)", () => {
  execSync("node scripts/build-mcp.mjs", { cwd: ROOT, stdio: "inherit" });
});

step("Vendor pdf.js viewer (Mozilla prebuilt zip)", () => {
  execSync("node scripts/vendor-pdfjs.mjs", { cwd: ROOT, stdio: "inherit" });
});

step("Build Next.js (output standalone)", () => {
  execSync("npx next build", { cwd: ROOT, stdio: "inherit" });
});

step("Copie .next/static et public dans .next/standalone", () => {
  const standalone = resolve(ROOT, ".next", "standalone");
  if (!existsSync(standalone)) {
    throw new Error(
      `${standalone} introuvable. Vérifier que next.config.ts a output: 'standalone'.`
    );
  }
  cpSync(
    resolve(ROOT, ".next", "static"),
    resolve(standalone, ".next", "static"),
    { recursive: true }
  );
  cpSync(resolve(ROOT, "public"), resolve(standalone, "public"), {
    recursive: true,
  });
});

console.log("\n✓ Prêt pour electron-builder.");
