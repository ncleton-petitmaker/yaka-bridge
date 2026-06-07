import { mkdir, copyFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const root = process.cwd();
const outdir = resolve(root, "dist", "bridge");

await mkdir(outdir, { recursive: true });

for (const [entry, outfile] of [
  ["index.ts", "index.cjs"],
  ["runtime.ts", "runtime.cjs"],
]) {
  await build({
    entryPoints: [resolve(root, "bridge", entry)],
    outfile: resolve(outdir, outfile),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    packages: "external",
    sourcemap: false,
    logLevel: "info",
  });
}

for (const file of ["electron-main.cjs", "bridge-preload.cjs", "provider-setup.cjs"]) {
  await copyFile(resolve(root, "bridge", file), resolve(outdir, file));
}

console.log(`[bridge] bundle écrit dans ${outdir}`);
