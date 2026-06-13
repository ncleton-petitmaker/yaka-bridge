import test from "node:test";
import assert from "node:assert/strict";
import { recommendLocalModel, type LocalHardwareProfile } from "../../server/local-ai-recommendation";

function profile(partial: Partial<LocalHardwareProfile>): LocalHardwareProfile {
  return {
    platform: "darwin",
    arch: "arm64",
    totalMemoryGb: 32,
    cpuCount: 10,
    ...partial,
  };
}

test("local model recommendation keeps low-memory machines cloud-first", () => {
  const recommendation = recommendLocalModel(profile({ totalMemoryGb: 8, cpuCount: 4 }));
  assert.equal(recommendation.tier, "cloud-first");
  assert.equal(recommendation.recommendedModel, "ibm/granite-4-micro");
  assert.equal(recommendation.minimumMemoryGb, 8);
});

test("local model recommendation starts standard users on Granite 4 Micro", () => {
  const recommendation = recommendLocalModel(profile({ totalMemoryGb: 24 }));
  assert.equal(recommendation.tier, "small-local");
  assert.equal(recommendation.recommendedModel, "ibm/granite-4-micro");
  assert.equal(recommendation.accelerator, "apple-silicon");
});

test("local model recommendation can propose gpt-oss-120b on premium unified memory", () => {
  const recommendation = recommendLocalModel(profile({ totalMemoryGb: 128 }));
  assert.equal(recommendation.tier, "large-local");
  assert.equal(recommendation.recommendedModel, "openai/gpt-oss-120b");
  assert.equal(recommendation.downloadSizeGb, 65);
});

test("local model recommendation requires a large accelerator before 120b on Windows", () => {
  const cpuOnly = recommendLocalModel(profile({ platform: "win32", arch: "x64", totalMemoryGb: 128, gpuMemoryGb: undefined }));
  assert.equal(cpuOnly.tier, "standard-local");
  assert.equal(cpuOnly.recommendedModel, "ibm/granite-4-micro");

  const nvidia = recommendLocalModel(profile({ platform: "win32", arch: "x64", totalMemoryGb: 128, gpuMemoryGb: 96 }));
  assert.equal(nvidia.tier, "large-local");
  assert.equal(nvidia.accelerator, "nvidia");
  assert.equal(nvidia.recommendedModel, "openai/gpt-oss-120b");
});
