"use client";

import { getSupabaseBrowserClient, getSupabaseSession } from "./supabase-client";
import { getDaemonToken } from "./electron";

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
  return "";
}

export function getBridgeOrganizationId(): string | null {
  const configured = cleanBaseUrl(process.env.NEXT_PUBLIC_BRIDGE_ORGANIZATION_ID);
  if (configured) return configured;
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem("bridge:organization-id")?.trim() || null;
}

export function localDaemonOrigin(): string {
  const port = process.env.NEXT_PUBLIC_DAEMON_PORT ?? "{{DAEMON_PORT}}";
  // Toujours 127.0.0.1 : le daemon ne bind que la loopback, on ne route jamais
  // le SSE vers une interface réseau même si l'app est ouverte via un hostname
  // LAN.
  return `http://127.0.0.1:${port}`;
}

/**
 * Ajoute le token de session du daemon en query param sur une URL locale.
 * Utilisé pour le SSE (`EventSource` ne permet pas d'en-têtes). No-op hors
 * Electron (mode cloud).
 */
export function withDaemonToken(url: string): string {
  const token = getDaemonToken();
  if (!token) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}daemon_token=${encodeURIComponent(token)}`;
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
    const token = getDaemonToken();
    const localInit: RequestInit = init;
    if (token) {
      const headers = new Headers(init.headers);
      if (!headers.has("authorization")) {
        headers.set("authorization", `Bearer ${token}`);
      }
      localInit.headers = headers;
    }
    if (typeof input === "string") return fetch(apiUrl(input), localInit);
    if (input instanceof URL) return fetch(apiUrl(input.toString()), localInit);
    return fetch(input, localInit);
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
  const organizationId = getBridgeOrganizationId();
  if (organizationId && !headers.has("x-bridge-organization-id")) {
    headers.set("x-bridge-organization-id", organizationId);
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
