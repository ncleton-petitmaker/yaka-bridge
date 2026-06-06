"use client";

import Tracker, { SanitizeLevel } from "@openreplay/tracker";
import { getCloudApiBaseUrl } from "./api-client";
import { getSupabaseSession } from "./supabase-client";

type ReplayStartResult = {
  success?: boolean;
  sessionID?: string;
  reason?: string;
};

type SupportSessionSnapshot = {
  supportSessionId?: string;
  replaySessionId?: string;
  replaySessionUrl?: string;
};

type SupportSessionUpdate = {
  currentRoute?: string;
  currentServiceId?: string;
  currentJobId?: string;
  context?: Record<string, unknown>;
};

let tracker: Tracker | null = null;
let startPromise: Promise<SupportSessionSnapshot> | null = null;
let supportSessionId: string | null = null;
let replaySessionId: string | null = null;
let replaySessionUrl: string | null = null;
let openReplayStarted = false;

const SUPPORT_SESSION_KEY = "bridge:support-session-id";

export function getSupportSessionSnapshot(): SupportSessionSnapshot {
  return {
    supportSessionId: supportSessionId ?? undefined,
    replaySessionId: replaySessionId ?? undefined,
    replaySessionUrl: replaySessionUrl ?? undefined,
  };
}

export function openReplayConfigured(): boolean {
  return openReplayEnabled() && Boolean(openReplayProjectKey());
}

export async function startSupportAndReplay(route: string): Promise<SupportSessionSnapshot> {
  if (startPromise) return startPromise;
  startPromise = startSupportAndReplayOnce(route);
  return startPromise;
}

export async function heartbeatSupportSession(update: SupportSessionUpdate = {}): Promise<void> {
  if (typeof window === "undefined" || !supportSessionId) return;
  const base = getCloudApiBaseUrl();
  const session = await getSupabaseSession();
  if (base == null || !session?.access_token) return;
  const snapshot = getSupportSessionSnapshot();
  await fetch(`${base}/api/support-sessions/${encodeURIComponent(supportSessionId)}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({
      ...snapshot,
      ...update,
      appVersion: appVersion(),
      userAgent: navigator.userAgent,
      viewport: viewport(),
      openReplayEnabled: openReplayConfigured(),
      openReplayStarted,
      context: {
        route: update.currentRoute ?? window.location.pathname,
        href: window.location.href,
        viewport: viewport(),
        appVersion: appVersion(),
        ...(update.context ?? {}),
      },
    }),
  }).catch(() => {
    // Le suivi support ne doit jamais casser l'interface.
  });
}

export function captureReplayError(err: unknown, metadata: Record<string, unknown> = {}): void {
  const current = tracker;
  if (!current || !openReplayStarted) return;
  const error = err instanceof Error ? err : new Error(typeof err === "string" ? err : "Erreur");
  current.handleError(error, metadata);
}

async function startSupportAndReplayOnce(route: string): Promise<SupportSessionSnapshot> {
  if (typeof window === "undefined") return {};
  supportSessionId = supportSessionIdFromStorage();
  const session = await getSupabaseSession();
  if (!session?.access_token) return getSupportSessionSnapshot();
  if (openReplayConfigured()) {
    await startOpenReplay(session.user.email ?? session.user.id, route);
  }
  await registerSupportSession(route);
  return getSupportSessionSnapshot();
}

async function startOpenReplay(userId: string, route: string): Promise<void> {
  if (tracker || openReplayStarted) return;
  const projectKey = openReplayProjectKey();
  if (!projectKey) return;

  tracker = new Tracker({
    projectKey,
    ingestPoint: openReplayIngestPoint(),
    privateMode: openReplayPrivateMode(),
    obscureTextEmails: true,
    obscureTextNumbers: true,
    captureIFrames: openReplayCaptureIframes(),
    network: {
      disabled: true,
      capturePayload: false,
      captureInIframes: false,
      failuresOnly: false,
      ignoreHeaders: true,
      sessionTokenHeader: false,
    },
    domSanitizer: (node: Element) => {
      if (
        node.closest?.("[data-openreplay-hidden], iframe, embed, object") ||
        node.matches?.("input, textarea, [contenteditable='true']")
      ) {
        return SanitizeLevel.Hidden;
      }
      return openReplayPrivateMode() ? SanitizeLevel.Obscured : SanitizeLevel.Plain;
    },
  });

  const started = await tracker.start({
    userID: userId,
    metadata: {
      app: process.env.NEXT_PUBLIC_APP_NAME?.trim() || "Bridge App",
      version: appVersion(),
      route,
    },
  }) as ReplayStartResult;
  if (started.success) {
    openReplayStarted = true;
    replaySessionId = started.sessionID ?? tracker.getSessionID() ?? null;
    replaySessionUrl = tracker.getSessionURL() ?? null;
    tracker.setMetadata("supportSessionId", supportSessionId ?? "");
  }
}

async function registerSupportSession(route: string): Promise<void> {
  const base = getCloudApiBaseUrl();
  const session = await getSupabaseSession();
  if (base == null || !session?.access_token || !supportSessionId) return;
  const snapshot = getSupportSessionSnapshot();
  await fetch(`${base}/api/support-sessions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({
      id: supportSessionId,
      ...snapshot,
      currentRoute: route,
      appVersion: appVersion(),
      userAgent: navigator.userAgent,
      viewport: viewport(),
      openReplayEnabled: openReplayConfigured(),
      openReplayStarted,
      context: {
        route,
        href: window.location.href,
        viewport: viewport(),
        appVersion: appVersion(),
      },
    }),
  }).catch(() => {
    // Le suivi support ne doit jamais casser l'interface.
  });
}

function supportSessionIdFromStorage(): string {
  try {
    const existing = window.sessionStorage.getItem(SUPPORT_SESSION_KEY);
    if (existing) return existing;
    const next = crypto.randomUUID();
    window.sessionStorage.setItem(SUPPORT_SESSION_KEY, next);
    return next;
  } catch {
    return crypto.randomUUID();
  }
}

function openReplayEnabled(): boolean {
  return process.env.NEXT_PUBLIC_OPENREPLAY_ENABLED === "true";
}

function openReplayProjectKey(): string | null {
  return process.env.NEXT_PUBLIC_OPENREPLAY_PROJECT_KEY?.trim() || null;
}

function openReplayIngestPoint(): string | undefined {
  return process.env.NEXT_PUBLIC_OPENREPLAY_INGEST_POINT?.trim() || undefined;
}

function openReplayPrivateMode(): boolean {
  return process.env.NEXT_PUBLIC_OPENREPLAY_PRIVATE_MODE !== "false";
}

function openReplayCaptureIframes(): boolean {
  return process.env.NEXT_PUBLIC_OPENREPLAY_CAPTURE_IFRAMES === "true";
}

function appVersion(): string {
  return process.env.NEXT_PUBLIC_APP_VERSION?.trim() || process.env.NEXT_PUBLIC_BRIDGE_APP_VERSION?.trim() || "dev";
}

function viewport(): string {
  return `${window.innerWidth}x${window.innerHeight}`;
}
