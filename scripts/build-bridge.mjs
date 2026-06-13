import { mkdir, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const root = process.cwd();
const outdir = resolve(root, "dist", "bridge");
const argv = process.argv.slice(2);
const targetPlatform = valueAfter("--target") || process.env.BRIDGE_TARGET_PLATFORM || process.platform;
const requireVoiceSidecar = argv.includes("--require-voice-sidecar") || process.env.BRIDGE_REQUIRE_VOICE_SIDECAR === "1";

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

for (const file of ["electron-main.cjs", "bridge-preload.cjs", "provider-setup.cjs", "theme.cjs", "design-system.json"]) {
  await copyFile(resolve(root, "bridge", file), resolve(outdir, file));
}
if (existsSync(resolve(root, "THIRD_PARTY_NOTICES.md"))) {
  await copyFile(resolve(root, "THIRD_PARTY_NOTICES.md"), resolve(outdir, "THIRD_PARTY_NOTICES.md"));
}

await buildVoiceSidecar();

console.log(`[bridge] bundle écrit dans ${outdir}`);

async function buildVoiceSidecar() {
  const manifest = resolve(root, "bridge-voice", "Cargo.toml");
  if (!existsSync(manifest)) return;
  const exe = targetPlatform === "win32" ? "bridge-voice.exe" : "bridge-voice";
  if (targetPlatform !== process.platform) {
    const provided = process.env.BRIDGE_VOICE_SIDECAR_PATH;
    const prebuilt = provided || resolve(root, "bridge-voice", "prebuilt", targetPlatform, exe);
    if (!existsSync(prebuilt)) {
      const message = `[bridge] sidecar vocal ${targetPlatform} introuvable. Construis Bridge sur ${targetPlatform} ou fournis BRIDGE_VOICE_SIDECAR_PATH.`;
      if (requireVoiceSidecar) throw new Error(message);
      console.warn(message);
      return;
    }
    const targetDir = resolve(outdir, "bridge-voice", targetPlatform);
    await mkdir(targetDir, { recursive: true });
    await copyFile(prebuilt, resolve(targetDir, exe));
    return;
  }

  const cargo = spawnSync("cargo", ["--version"], { encoding: "utf8", timeout: 5000 });
  if (cargo.status !== 0) {
    const message = "[bridge] cargo indisponible: sidecar push-to-talk non construit.";
    if (requireVoiceSidecar) throw new Error(message);
    console.warn(message);
    return;
  }
  const build = spawnSync("cargo", ["build", "--release", "--manifest-path", manifest], {
    cwd: root,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (build.status !== 0) {
    const message = "[bridge] build bridge-voice échoué: packaging sans sidecar vocal.";
    if (requireVoiceSidecar) throw new Error(message);
    console.warn(message);
    return;
  }
  const source = resolve(root, "bridge-voice", "target", "release", exe);
  if (!existsSync(source)) {
    const message = "[bridge] binaire bridge-voice introuvable après build.";
    if (requireVoiceSidecar) throw new Error(message);
    console.warn(message);
    return;
  }
  const targetDir = resolve(outdir, "bridge-voice", targetPlatform);
  await mkdir(targetDir, { recursive: true });
  await copyFile(source, resolve(targetDir, exe));
}

function valueAfter(flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}
