import type { AgentRoutingPolicy } from "../bridge/types";

export interface ErpModuleRoute {
  path: string;
  label: {
    fr: string;
    en: string;
  };
  kind: "dashboard" | "workspace" | "admin";
}

export interface ErpModuleTable {
  name: string;
  description: string;
  rls: "organization";
}

export interface ErpModuleManifest {
  id: string;
  version: string;
  labels: {
    fr: string;
    en: string;
  };
  description: {
    fr: string;
    en: string;
  };
  category: "core" | "business";
  dataStrategy: "erp-core" | "service-supabase" | "external-api";
  routes: ErpModuleRoute[];
  scopes: string[];
  actions: Array<{
    id: string;
    label: string;
    requiredScopes: string[];
    agentRouting?: AgentRoutingPolicy;
  }>;
  events: Array<{
    type: string;
    label: string;
    requiredScopes: string[];
  }>;
  tables: ErpModuleTable[];
  migrations: string[];
  seeds: string[];
  bridgeService: {
    serviceId: string;
    basePath: string;
    requiredScopes: string[];
  };
}
