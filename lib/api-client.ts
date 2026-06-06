"use client";

import { getSupabaseBrowserClient, getSupabaseSession } from "./supabase-client";

type ApiMode = "local" | "cloud";

function cleanBaseUrl(value: string | undefined): string | null {
  const raw = value?.trim().replace(/\/+$/, "");
  return raw ? raw : null;
}

export function getApiMode(): ApiMode {
  return process.env.NEXT_PUBLIC_APP_API_MODE === "cloud" ? "cloud" : "local";
}

export function getCloudApiBaseUrl(): string | null {
  const explicit = cleanBaseUrl(process.env.NEXT_PUBLIC_CLOUD_API_URL);
  if (explicit) return explicit;
  const supabaseUrl = cleanBaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL);
  if (!supabaseUrl) return null;
  try {
    const url = new URL(supabaseUrl);
    url.hostname = url.hostname.replace(".supabase.co", ".functions.supabase.co");
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export function localDaemonOrigin(): string {
  const port = process.env.NEXT_PUBLIC_DAEMON_PORT ?? "{{DAEMON_PORT}}";
  if (typeof window !== "undefined" && window.location.hostname) {
    return `http://${window.location.hostname}:${port}`;
  }
  return `http://localhost:${port}`;
}

function isAbsoluteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function normalizePath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

export function apiUrl(path: string): string {
  if (isAbsoluteUrl(path)) return path;
  const normalized = normalizePath(path);
  if (getApiMode() !== "cloud") return normalized;
  const base = getCloudApiBaseUrl();
  if (!base) {
    throw new Error(
      "NEXT_PUBLIC_CLOUD_API_URL ou NEXT_PUBLIC_SUPABASE_URL requis en mode cloud."
    );
  }
  return `${base}${normalized}`;
}

export function apiDaemonUrl(path: string): string {
  if (isAbsoluteUrl(path)) return path;
  if (getApiMode() === "cloud") return apiUrl(path);
  return `${localDaemonOrigin()}${normalizePath(path)}`;
}

export async function apiFetch(
  input: string | URL | Request,
  init: RequestInit = {}
): Promise<Response> {
  if (getApiMode() !== "cloud") {
    if (typeof input === "string") return fetch(apiUrl(input), init);
    if (input instanceof URL) return fetch(apiUrl(input.toString()), init);
    return fetch(input, init);
  }
  return cloudFetch(input, init);
}

let invalidSessionHandled = false;

function looksLikeInvalidCloudSession(message: string): boolean {
  return /session invalide|authorization requis|JWT|expired/i.test(message);
}

async function cloudFetch(
  input: string | URL | Request,
  init: RequestInit = {}
): Promise<Response> {
  const session = await getSupabaseSession();
  const headers = new Headers(init.headers);
  if (session?.access_token && !headers.has("authorization")) {
    headers.set("authorization", `Bearer ${session.access_token}`);
  }

  const target = typeof input === "string"
    ? apiUrl(input)
    : input instanceof URL
      ? apiUrl(input.toString())
      : input;
  const response = await fetch(target, { ...init, headers });
  if (response.status >= 400 && !invalidSessionHandled) {
    const text = await response.clone().text().catch(() => "");
    if (looksLikeInvalidCloudSession(text)) {
      invalidSessionHandled = true;
      try {
        window.dispatchEvent(new CustomEvent("app-auth-invalid"));
      } catch {
        /* no-op hors navigateur */
      }
      await getSupabaseBrowserClient()?.auth.signOut().catch(() => null);
    }
  }
  return response;
}
