import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const CARGO_ENV = { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH ?? ""}` };

function cargoAvailable(): boolean {
  return spawnSync("cargo", ["--version"], { env: CARGO_ENV, encoding: "utf8", timeout: 5000 }).status === 0;
}

function runVoice(args: string[]): Record<string, unknown> {
  const bin = join(ROOT, "bridge-voice", "target", "debug", process.platform === "win32" ? "bridge-voice.exe" : "bridge-voice");
  assert.equal(existsSync(bin), true, "bridge-voice binary should exist after cargo build");
  const res = spawnSync(bin, args, { encoding: "utf8", timeout: 6000 });
  const line = res.stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
  assert.ok(line, `bridge-voice ${args.join(" ")} should print JSON`);
  return JSON.parse(line) as Record<string, unknown>;
}

test("bridge-voice builds and exposes bounded JSON diagnostics", (t) => {
  if (!cargoAvailable()) {
    if (process.env.CI === "true") {
      assert.fail("cargo unavailable in CI");
    }
    t.skip("cargo unavailable");
    return;
  }
  const build = spawnSync("cargo", ["build", "--manifest-path", "bridge-voice/Cargo.toml"], {
    cwd: ROOT,
    env: CARGO_ENV,
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(build.status, 0, build.stderr || build.stdout);

  const status = runVoice(["status"]);
  assert.equal(status.ok, true);
  assert.equal(status.engine, "bridge-voice");
  assert.equal(typeof status.audioReady, "boolean");
  assert.ok(Array.isArray(status.features));
  assert.ok((status.features as unknown[]).includes("parakeet-transcription"));
  assert.ok((status.features as unknown[]).includes("handy-keys"));

  const shortcut = runVoice(["validate-shortcut", "--shortcut", "ctrl+space"]);
  assert.equal(shortcut.ok, true);
  assert.equal(shortcut.event, "shortcut-valid");

  const devices = runVoice(["devices"]);
  assert.equal(typeof devices.ok, "boolean");

  const mic = runVoice(["test-microphone", "--duration-ms", "150"]);
  assert.equal(typeof mic.ok, "boolean");
  assert.ok("event" in mic || "error" in mic);
});
