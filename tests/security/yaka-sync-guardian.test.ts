import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const CLI = join(ROOT, "scripts", "yaka-sync-guardian.mjs");

function runGuardian(args: string[], cwd = ROOT): { status: number | null; json: any; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [CLI, ...args, "--json"], {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
  });
  return {
    status: res.status,
    json: JSON.parse(res.stdout || "{}"),
    stdout: res.stdout,
    stderr: res.stderr,
  };
}

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function clientFixture(overrides: {
  packageVersion?: string;
  projectVersion?: string;
  vendoredBridge?: boolean;
  releaseDmg?: boolean;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "yaka-client-"));
  writeJson(join(dir, "package.json"), {
    name: "fixture-erp",
    version: "0.1.0",
    private: true,
    dependencies: {
      "@ncleton-petitmaker/yaka-bridge-desktop": overrides.packageVersion ?? "0.0.46",
      "@ncleton-petitmaker/yaka-erp-shell": overrides.packageVersion ?? "0.0.46",
      "@ncleton-petitmaker/yaka-module-sdk": overrides.packageVersion ?? "0.0.46",
    },
    devDependencies: {
      "@ncleton-petitmaker/yaka-sync-guardian": overrides.packageVersion ?? "0.0.46",
    },
  });
  writeJson(join(dir, "yaka.project.json"), {
    schema: "yaka/project.v1",
    kind: "client-erp",
    clientSlug: "fixture",
    platform: {
      repository: "github.com/ncleton-petitmaker/yaka-bridge",
      channel: "stable",
      packages: {
        "@ncleton-petitmaker/yaka-bridge-desktop": overrides.projectVersion ?? "0.0.46",
        "@ncleton-petitmaker/yaka-erp-shell": overrides.projectVersion ?? "0.0.46",
        "@ncleton-petitmaker/yaka-module-sdk": overrides.projectVersion ?? "0.0.46",
      },
    },
  });
  writeJson(join(dir, "modules.lock.json"), {
    schema: "yaka-bridge/modules-lock.v1",
    modules: [],
  });
  if (overrides.vendoredBridge) {
    mkdirSync(join(dir, "bridge"), { recursive: true });
    writeFileSync(join(dir, "bridge", "electron-main.cjs"), "// stale bridge\n", "utf8");
  }
  if (overrides.releaseDmg) {
    mkdirSync(join(dir, "release-bridge"), { recursive: true });
    writeFileSync(join(dir, "release-bridge", "Bridge-0.0.2-arm64.dmg"), "stale", "utf8");
  }
  return dir;
}

test("yaka sync guardian accepts the platform repository", () => {
  const res = runGuardian(["doctor", "--strict"]);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.kind, "platform");
});

test("yaka sync guardian accepts a modern client fixture", () => {
  const dir = clientFixture();
  try {
    const res = runGuardian(["doctor", "--strict", "--cwd", dir]);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.kind, "client-erp");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("yaka sync guardian rejects clients that vendor Bridge core", () => {
  const dir = clientFixture({ vendoredBridge: true });
  try {
    const res = runGuardian(["doctor", "--strict", "--cwd", dir]);
    assert.equal(res.status, 1);
    assert.equal(res.json.ok, false);
    assert.match(res.json.errors.join("\n"), /Core Yaka copié/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("yaka sync guardian rejects stale client package pins and local DMGs", () => {
  const dir = clientFixture({ packageVersion: "0.0.2", projectVersion: "0.0.46", releaseDmg: true });
  try {
    const res = runGuardian(["doctor", "--strict", "--cwd", dir]);
    assert.equal(res.status, 1);
    assert.equal(res.json.ok, false);
    assert.match(res.json.errors.join("\n"), /désynchronisé/);
    assert.match(res.json.errors.join("\n"), /release-bridge contient un DMG local/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
