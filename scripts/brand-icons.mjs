#!/usr/bin/env node
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { copyFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const publicDir = resolve(root, "public");
const svgPath = resolve(publicDir, "app-mark.svg");
const bridgeMarkPath = resolve(publicDir, "bridge-mark.png");
const sizes = [16, 32, 64, 128, 256, 512, 1024];

if (!existsSync(bridgeMarkPath) && !existsSync(svgPath)) {
  throw new Error(`Logo source introuvable: ${bridgeMarkPath} ou ${svgPath}`);
}

mkdirSync(publicDir, { recursive: true });

const canUseSips = spawnSync("sips", ["--version"], { stdio: "ignore" }).status === 0;

if (canUseSips) {
  const tmpPng = resolve(publicDir, ".app-mark-1024.png");
  if (existsSync(bridgeMarkPath)) {
    await copyFile(bridgeMarkPath, tmpPng);
  } else {
    run("sips", ["-s", "format", "png", svgPath, "--out", tmpPng]);
  }
  for (const size of sizes) {
    const out = resolve(publicDir, `icon-${size}.png`);
    await copyFile(tmpPng, out);
    run("sips", ["-z", String(size), String(size), out]);
  }
  rmSync(tmpPng, { force: true });
  await makeIcns();
  console.log(`[brand] icônes générées depuis ${existsSync(bridgeMarkPath) ? "public/bridge-mark.png" : "public/app-mark.svg"}`);
} else {
  console.warn("[brand] sips indisponible: PNG/icns non régénérés.");
}

async function makeIcns() {
  const iconset = resolve(publicDir, "icon.iconset");
  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset, { recursive: true });
  const pairs = [
    ["icon_16x16.png", "icon-16.png"],
    ["icon_16x16@2x.png", "icon-32.png"],
    ["icon_32x32.png", "icon-32.png"],
    ["icon_32x32@2x.png", "icon-64.png"],
    ["icon_128x128.png", "icon-128.png"],
    ["icon_128x128@2x.png", "icon-256.png"],
    ["icon_256x256.png", "icon-256.png"],
    ["icon_256x256@2x.png", "icon-512.png"],
    ["icon_512x512.png", "icon-512.png"],
    ["icon_512x512@2x.png", "icon-1024.png"],
  ];
  for (const [target, source] of pairs) {
    await copyFile(resolve(publicDir, source), resolve(iconset, target));
  }
  const result = spawnSync("iconutil", ["-c", "icns", iconset, "-o", resolve(publicDir, "icon.icns")], {
    encoding: "utf8",
  });
  rmSync(iconset, { recursive: true, force: true });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    await writeFile(resolve(publicDir, "icon.icns.error.log"), result.stderr || "iconutil failed", "utf8");
    throw new Error(result.stderr || result.stdout || "iconutil failed");
  }
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")}\n${result.stderr || result.stdout}`);
  }
}
