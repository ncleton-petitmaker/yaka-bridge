import { mkdir, copyFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const root = process.cwd();
const outdir = resolve(root, "dist", "bridge");

await mkdir(outdir, { recursive: true });

for (const [entry, outfile, externalPackages] of [
  ["index.ts", "index.cjs", true],
  ["runtime.ts", "runtime.cjs", true],
  ["../server/mcp.ts", "mcp.cjs", false],
]) {
  await build({
    entryPoints: [resolve(root, "bridge", entry)],
    outfile: resolve(outdir, outfile),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    ...(externalPackages ? { packages: "external" } : {}),
    sourcemap: false,
    logLevel: "info",
  });
}

for (const file of ["electron-main.cjs", "bridge-preload.cjs", "provider-setup.cjs", "design-system.json"]) {
  await copyFile(resolve(root, "bridge", file), resolve(outdir, file));
}

console.log(`[bridge] bundle écrit dans ${outdir}`);
