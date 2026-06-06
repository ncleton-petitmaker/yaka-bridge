import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { loadAppConfig, type AppConfig } from "./app-config.js";

export interface SupabaseRuntimeConfig {
  url?: string;
  anonKey?: string;
  serviceRoleKey?: string;
}

export interface SupabasePublicConfig {
  provider: "supabase";
  configured: boolean;
  url?: string;
  hasAnonKey: boolean;
  hasServiceRoleKey: boolean;
}

export function loadSupabaseRuntimeConfig(dataDir: string): SupabaseRuntimeConfig {
  const cfg = loadAppConfig(dataDir);
  return {
    url: process.env.SUPABASE_URL ?? cfg.supabaseUrl,
    anonKey: process.env.SUPABASE_ANON_KEY ?? cfg.supabaseAnonKey,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
}

export function getSupabasePublicConfig(dataDir: string): SupabasePublicConfig {
  const cfg = loadSupabaseRuntimeConfig(dataDir);
  return {
    provider: "supabase",
    configured: Boolean(cfg.url && (cfg.serviceRoleKey || cfg.anonKey)),
    url: cfg.url,
    hasAnonKey: Boolean(cfg.anonKey),
    hasServiceRoleKey: Boolean(cfg.serviceRoleKey),
  };
}

export function getSupabaseServerClient(dataDir: string): SupabaseClient {
  const cfg = loadSupabaseRuntimeConfig(dataDir);
  if (!cfg.url) {
    throw new Error("Supabase URL manquante. Configure SUPABASE_URL ou app-config.supabaseUrl.");
  }
  const key = cfg.serviceRoleKey ?? cfg.anonKey;
  if (!key) {
    throw new Error(
      "Clé Supabase manquante. Configure SUPABASE_SERVICE_ROLE_KEY côté daemon, ou SUPABASE_ANON_KEY/app-config.supabaseAnonKey."
    );
  }
  return createClient(cfg.url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

export function sanitizeAppConfigForClient(config: AppConfig): AppConfig {
  return {
    ...config,
    supabaseAnonKey: config.supabaseAnonKey,
  };
}
