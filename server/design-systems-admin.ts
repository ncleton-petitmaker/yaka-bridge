import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export interface DesignSystemOption {
  id: string;
  name: string;
  version: string;
  description?: string;
  sourceKind?: string;
  targets: string[];
}

export interface ServiceDesignSystem {
  id: string;
  name?: string;
  version?: string;
  sourceKind?: string;
  appliedAt?: string;
}

export interface DesignSystemService {
  serviceId: string;
  serviceInstanceId?: string | null;
  name: string;
  description?: string | null;
  baseUrl?: string | null;
  adminUrl?: string | null;
  enabled: boolean;
  designSystem: ServiceDesignSystem;
  designSystemSource: "service" | "active";
}

export interface DesignSystemServicePatch {
  designSystemId: string;
  serviceIds?: string[];
}

export function listDesignSystemOptions(repoRoot = process.cwd()): DesignSystemOption[] {
  const systemsDir = resolve(repoRoot, "design-systems");
  if (!existsSync(systemsDir)) return [];
  const options: DesignSystemOption[] = [];
  for (const entry of readdirSync(systemsDir)) {
    const dir = join(systemsDir, entry);
    const manifestPath = join(dir, "design-system.config.json");
    if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) continue;
    const manifest = readJson(manifestPath);
    const id = cleanString(manifest.id, 80) ?? basename(dir);
    options.push({
      id,
      name: cleanString(manifest.name, 120) ?? id,
      version: cleanString(manifest.version, 40) ?? "1.0.0",
      description: cleanString(manifest.description, 300),
      sourceKind: cleanString(manifest.sourceKind, 80),
      targets: Array.isArray(manifest.targets) ? manifest.targets.map(String) : [],
    });
  }
  return options.sort((a, b) => a.name.localeCompare(b.name));
}

export function activeDesignSystemOption(repoRoot = process.cwd(), options = listDesignSystemOptions(repoRoot)): DesignSystemOption | null {
  const activePath = resolve(repoRoot, "design-system.config.json");
  const activeId = existsSync(activePath) ? cleanString(readJson(activePath).active, 80) : undefined;
  return options.find((option) => option.id === activeId) ?? options.find((option) => option.id === "claude") ?? options[0] ?? null;
}

export function normalizeDesignSystemPatch(
  patch: DesignSystemServicePatch,
  options: DesignSystemOption[]
): { option: DesignSystemOption; serviceIds: string[] | null } {
  const id = cleanString(patch.designSystemId, 80);
  if (!id) throw new Error("design-system-required");
  const option = options.find((candidate) => candidate.id === id);
  if (!option) throw new Error("design-system-unknown");
  const serviceIds = Array.isArray(patch.serviceIds)
    ? Array.from(new Set(patch.serviceIds.map((value) => cleanString(value, 160)).filter((value): value is string => Boolean(value))))
    : null;
  return { option, serviceIds };
}

export function applyServiceDesignSystemManifestPatch(
  manifest: Record<string, unknown>,
  option: DesignSystemOption,
  appliedAt = new Date().toISOString()
): Record<string, unknown> {
  return {
    ...manifest,
    designSystem: {
      id: option.id,
      name: option.name,
      version: option.version,
      sourceKind: option.sourceKind,
      appliedAt,
    },
  };
}

export function mapDesignSystemService(
  row: Record<string, unknown>,
  active: DesignSystemOption | null,
  options: DesignSystemOption[]
): DesignSystemService {
  const manifest = objectOrEmpty(row.manifest);
  const explicit = normalizeServiceDesignSystem(manifest.designSystem, options);
  const defaultDesignSystem = active
    ? {
        id: active.id,
        name: active.name,
        version: active.version,
        sourceKind: active.sourceKind,
      }
    : { id: "unknown", name: "Inconnu" };
  return {
    serviceId: String(row.service_id ?? row.serviceId ?? ""),
    serviceInstanceId: stringOrNull(row.service_instance_id ?? row.serviceInstanceId),
    name: String(row.name ?? row.service_id ?? ""),
    description: stringOrNull(row.description),
    baseUrl: stringOrNull(row.base_url ?? row.baseUrl),
    adminUrl: stringOrNull(row.admin_url ?? row.adminUrl),
    enabled: row.enabled !== false,
    designSystem: explicit ?? defaultDesignSystem,
    designSystemSource: explicit ? "service" : "active",
  };
}

function normalizeServiceDesignSystem(value: unknown, options: DesignSystemOption[]): ServiceDesignSystem | null {
  if (typeof value === "string") {
    const option = options.find((candidate) => candidate.id === value);
    return option ? { id: option.id, name: option.name, version: option.version, sourceKind: option.sourceKind } : { id: value };
  }
  const object = objectOrEmpty(value);
  const id = cleanString(object.id, 80);
  if (!id) return null;
  const option = options.find((candidate) => candidate.id === id);
  return {
    id,
    name: cleanString(object.name, 120) ?? option?.name,
    version: cleanString(object.version, 40) ?? option?.version,
    sourceKind: cleanString(object.sourceKind, 80) ?? option?.sourceKind,
    appliedAt: cleanString(object.appliedAt, 80),
  };
}

function readJson(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function cleanString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
