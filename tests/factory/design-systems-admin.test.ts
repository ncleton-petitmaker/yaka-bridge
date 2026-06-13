import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeDesignSystemOption,
  applyServiceDesignSystemManifestPatch,
  listDesignSystemOptions,
  mapDesignSystemService,
  normalizeDesignSystemPatch,
} from "../../server/design-systems-admin";

test("design-system admin helpers list options and patch service manifests", () => {
  const root = mkdtempSync(join(tmpdir(), "yaka-design-admin-"));
  const systemsDir = join(root, "design-systems");
  mkdirSync(join(systemsDir, "claude"), { recursive: true });
  mkdirSync(join(systemsDir, "ocean"), { recursive: true });
  writeFileSync(join(root, "design-system.config.json"), JSON.stringify({ active: "ocean" }), "utf8");
  writeFileSync(join(systemsDir, "claude", "design-system.config.json"), JSON.stringify({
    id: "claude",
    name: "Claude",
    version: "1.0.0",
    sourceKind: "built-in",
    targets: ["app", "bridge"],
  }), "utf8");
  writeFileSync(join(systemsDir, "ocean", "design-system.config.json"), JSON.stringify({
    id: "ocean",
    name: "Ocean",
    version: "2.1.0",
    sourceKind: "custom",
    targets: ["app", "modules", "bridge"],
  }), "utf8");

  const options = listDesignSystemOptions(root);
  const active = activeDesignSystemOption(root, options);
  assert.equal(options.length, 2);
  assert.equal(active?.id, "ocean");

  const { option, serviceIds } = normalizeDesignSystemPatch({ designSystemId: "claude", serviceIds: ["purchasing", "purchasing", "crm"] }, options);
  assert.equal(option.id, "claude");
  assert.deepEqual(serviceIds, ["purchasing", "crm"]);

  const nextManifest = applyServiceDesignSystemManifestPatch({ actions: [{ id: "run" }] }, option, "2026-06-12T10:00:00.000Z");
  assert.deepEqual(nextManifest.actions, [{ id: "run" }]);
  assert.deepEqual(nextManifest.designSystem, {
    id: "claude",
    name: "Claude",
    version: "1.0.0",
    sourceKind: "built-in",
    appliedAt: "2026-06-12T10:00:00.000Z",
  });

  const mapped = mapDesignSystemService({
    service_id: "purchasing",
    name: "Achats",
    enabled: true,
    manifest: nextManifest,
  }, active, options);
  assert.equal(mapped.designSystem.id, "claude");
  assert.equal(mapped.designSystemSource, "service");
});
