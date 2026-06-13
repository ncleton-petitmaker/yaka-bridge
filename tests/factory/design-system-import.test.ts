import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "../..");

test("design importer normalizes a raw DESIGN.md and applies it", () => {
  const targetDir = mkdtempSync(join(tmpdir(), "yaka-design-import-"));
  const sourceDir = join(targetDir, "source");
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(
    join(sourceDir, "DESIGN.md"),
    [
      "# Ocean Ops",
      "",
      "Operational ERP interface for maritime teams.",
      "",
      "- Background: #f7fbfc",
      "- Surface: #ffffff",
      "- Body text: #0b1f2a",
      "- Muted text: #5e7180",
      "- Border: #d8e4ea",
      "- Brand accent: #0f6d8f",
      "- Font body: `Inter`",
    ].join("\n"),
    "utf8",
  );

  const result = spawnSync(process.execPath, [
    join(root, "scripts", "import-design-system.mjs"),
    "--id",
    "ocean-ops",
    "--source",
    sourceDir,
    "--target-dir",
    targetDir,
    "--apply",
  ], { cwd: root, encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const systemDir = join(targetDir, "design-systems", "ocean-ops");
  const manifest = JSON.parse(readFileSync(join(systemDir, "design-system.config.json"), "utf8"));
  const appCss = readFileSync(join(targetDir, "app", "design-system.css"), "utf8");
  const bridgeTokens = JSON.parse(readFileSync(join(targetDir, "bridge", "design-system.json"), "utf8"));

  assert.equal(manifest.id, "ocean-ops");
  assert.equal(manifest.sourceKind, "custom");
  assert.equal(manifest.bridge.tokens.accent, "#0f6d8f");
  assert.match(appCss, /--on-accent:/);
  assert.match(appCss, /--surface: #ffffff;/);
  assert.equal(bridgeTokens.accent, "#0f6d8f");
  assert.ok(existsSync(join(targetDir, "public", "app-mark.svg")));
});
