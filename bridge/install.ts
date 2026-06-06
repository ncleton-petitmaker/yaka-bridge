import { hostname } from "node:os";
import { resolve } from "node:path";
import {
  defaultBridgeDataDir,
  normalizeBridgeConfig,
  resolveConfigPath,
  saveBridgeConfig,
} from "./config.js";
import type { BridgeAllowedRoot, BridgeServiceInstance } from "./types.js";

function main(): void {
  const argv = process.argv.slice(2);
  const configPath = resolveConfigPath(argv);
  const dataDir = resolvePathArg(valueAfter(argv, "--data-dir") ?? process.env.BRIDGE_DATA_DIR ?? defaultBridgeDataDir());
  const organizationId = valueAfter(argv, "--organization-id") ?? process.env.BRIDGE_ORGANIZATION_ID;
  const services = parseServices(argv, organizationId ?? "demo-org", dataDir);

  const cfg = normalizeBridgeConfig({
    controlPlaneBaseUrl: valueAfter(argv, "--control-plane-url") ?? valueAfter(argv, "--cloud-base-url") ?? process.env.BRIDGE_CONTROL_PLANE_URL,
    organizationId,
    bridgeToken: valueAfter(argv, "--bridge-token") ?? process.env.BRIDGE_TOKEN,
    bridgeId: valueAfter(argv, "--bridge-id") ?? process.env.BRIDGE_ID,
    label: valueAfter(argv, "--label") ?? hostname(),
    dataDir,
    defaultModel: valueAfter(argv, "--model"),
    maxConcurrentJobs: numberArg(argv, "--max-concurrent-jobs"),
    pollIntervalSeconds: numberArg(argv, "--poll-interval-seconds"),
    services,
    demoMode: valueAfter(argv, "--demo") === "true" ? true : undefined,
  });

  saveBridgeConfig(cfg, configPath);
  console.log(`[bridge:install] config écrite: ${configPath}`);
  console.log(`[bridge:install] data dir: ${cfg.dataDir}`);
  console.log(`[bridge:install] lancement: npm run bridge -- run --config ${configPath}`);
}

function parseServices(argv: string[], organizationId: string, dataDir: string): BridgeServiceInstance[] | undefined {
  const rawServices = valuesAfter(argv, "--service");
  if (!rawServices.length) return undefined;
  return rawServices.map((raw) => {
    const parts = raw.split("|");
    const serviceId = parts[0]?.trim();
    const name = parts[1]?.trim();
    const baseUrl = parts[2]?.trim();
    const healthUrl = parts[3]?.trim();
    if (!serviceId || !name || !baseUrl) {
      throw new Error("--service attend serviceId|Nom|https://service|https://service/health");
    }
    return {
      serviceId,
      serviceInstanceId: `${organizationId}:${serviceId}`,
      organizationId,
      name,
      baseUrl,
      healthUrl,
      scopes: ["codex:run", "erp:core:read"],
      allowedRoots: parseAllowedRoots(argv, serviceId, dataDir),
    };
  });
}

function parseAllowedRoots(argv: string[], serviceId: string, dataDir: string): BridgeAllowedRoot[] {
  const roots: BridgeAllowedRoot[] = [];
  for (const raw of valuesAfter(argv, "--allowed-root")) {
    const [id, path, label] = raw.split("=");
    if (!id || !path) {
      throw new Error("--allowed-root attend id=/chemin ou id=/chemin=Libellé");
    }
    roots.push({ id, path: resolvePathArg(path), label: label || id, writable: true });
  }
  if (roots.length) return roots;
  return [{ id: "service-data", label: `Données ${serviceId}`, path: resolve(dataDir, "services", serviceId), writable: true }];
}

function resolvePathArg(value: string): string {
  return resolve(value.replace(/^~(?=$|[\\/])/, process.env.HOME ?? ""));
}

function valueAfter(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx < 0) return undefined;
  return argv[idx + 1];
}

function valuesAfter(argv: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === flag && argv[i + 1]) values.push(argv[i + 1]);
  }
  return values;
}

function numberArg(argv: string[], flag: string): number | undefined {
  const value = valueAfter(argv, flag);
  if (!value) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${flag} doit être un nombre`);
  return n;
}

main();
