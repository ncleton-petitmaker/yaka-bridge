import type { ErpModuleManifest } from "./types";
import { purchasingModule } from "./purchasing";

export const erpModules = [purchasingModule] satisfies ErpModuleManifest[];

export function getErpModule(moduleId: string): ErpModuleManifest | undefined {
  return erpModules.find((module) => module.id === moduleId);
}

export function assertKnownModules(moduleIds: string[]): void {
  const known = new Set(erpModules.map((module) => module.id));
  const unknown = moduleIds.filter((moduleId) => !known.has(moduleId));
  if (unknown.length) {
    throw new Error(`Unknown ERP module(s): ${unknown.join(", ")}`);
  }
}

