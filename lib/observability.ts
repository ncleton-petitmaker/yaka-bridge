"use client";

import { getCloudApiBaseUrl } from "./api-client";
import { getSupportSessionSnapshot } from "./openreplay";
import { getSupabaseSession } from "./supabase-client";

type Severity = "info" | "warning" | "error" | "critical";
type Source = "web" | "api" | "bridge" | "run" | "auth";

type ClientObservation = {
  severity: Severity;
  source?: Source;
  category: string;
  message: string;
  route?: string;
  fingerprint?: string;
  serviceId?: string;
  jobId?: string;
  context?: Record<string, unknown>;
};

const recentFingerprints = new Map<string, number>();
const THROTTLE_MS = 30_000;

export function reportClientObservation(input: ClientObservation): void {
  if (typeof window === "undefined") return;
  const fingerprint = input.fingerprint ?? `${input.source ?? "web"}:${input.category}:${input.message}`.slice(0, 240);
  const last = recentFingerprints.get(fingerprint) ?? 0;
  if (Date.now() - last < THROTTLE_MS) return;
  recentFingerprints.set(fingerprint, Date.now());
  void sendClientObservation({ ...input, fingerprint }).catch(() => {
    // L'observation ne doit jamais casser l'interface utilisateur.
  });
}

export function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function sendClientObservation(input: ClientObservation & { fingerprint: string }): Promise<void> {
  const base = getCloudApiBaseUrl();
  if (base == null) return;
  const session = await getSupabaseSession();
  if (!session?.access_token) return;
  const route = input.route ?? window.location.pathname;
  const support = getSupportSessionSnapshot();
  await fetch(`${base}/api/observability/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({
      severity: input.severity,
      source: input.source ?? "web",
      category: input.category,
      message: input.message.slice(0, 1200),
      route,
      fingerprint: input.fingerprint,
      serviceId: input.serviceId,
      jobId: input.jobId,
      supportSessionId: support.supportSessionId,
      replaySessionId: support.replaySessionId,
      replaySessionUrl: support.replaySessionUrl,
      userAgent: navigator.userAgent,
      appVersion: appVersion(),
      context: {
        ...(input.context ?? {}),
        route,
        href: window.location.href,
        viewport: `${window.innerWidth}x${window.innerHeight}`,
      },
    }),
  });
}

function appVersion(): string {
  return process.env.NEXT_PUBLIC_APP_VERSION?.trim() || process.env.NEXT_PUBLIC_BRIDGE_APP_VERSION?.trim() || "dev";
}
