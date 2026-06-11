import manifest from "./module.config.json";
import type { ErpModuleManifest } from "../types";

export { PurchasingWorkspace } from "./PurchasingWorkspace";

export const purchasingModule = manifest as ErpModuleManifest;

