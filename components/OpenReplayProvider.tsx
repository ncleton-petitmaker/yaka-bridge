"use client";

import { useEffect, useState } from "react";
import {
  captureReplayError,
  heartbeatSupportSession,
  startSupportAndReplay,
} from "@/lib/openreplay";
import { reportClientObservation } from "@/lib/observability";

export function OpenReplayProvider() {
  const [route, setRoute] = useState("/");

  useEffect(() => installRouteCapture(() => setRoute(currentBrowserRoute())), []);

  useEffect(() => {
    void startSupportAndReplay(route);
    reportClientObservation({
      severity: "info",
      source: "web",
      category: "page_view",
      message: "Page affichée",
      route,
      fingerprint: `page_view:${route}`,
      context: { route },
    });
  }, [route]);

  useEffect(() => {
    void heartbeatSupportSession({ currentRoute: route });
    const interval = window.setInterval(() => {
      void heartbeatSupportSession({ currentRoute: route });
    }, 10_000);
    return () => window.clearInterval(interval);
  }, [route]);

  useEffect(() => {
    const restore = installConsoleCapture();
    const onError = (event: ErrorEvent) => {
      captureReplayError(event.error ?? event.message, { source: "window.error" });
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      captureReplayError(event.reason, { source: "unhandledrejection" });
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      restore();
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  return null;
}

function currentBrowserRoute(): string {
  if (typeof window === "undefined") return "/";
  return `${window.location.pathname}${window.location.search}`;
}

function installRouteCapture(onRoute: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const originalPushState = window.history.pushState;
  const originalReplaceState = window.history.replaceState;
  const notify = () => window.setTimeout(onRoute, 0);
  window.history.pushState = function patchedPushState(...args) {
    const result = originalPushState.apply(this, args);
    notify();
    return result;
  };
  window.history.replaceState = function patchedReplaceState(...args) {
    const result = originalReplaceState.apply(this, args);
    notify();
    return result;
  };
  window.addEventListener("popstate", notify);
  window.addEventListener("hashchange", notify);
  onRoute();
  return () => {
    window.history.pushState = originalPushState;
    window.history.replaceState = originalReplaceState;
    window.removeEventListener("popstate", notify);
    window.removeEventListener("hashchange", notify);
  };
}

function installConsoleCapture(): () => void {
  const originalWarn = console.warn;
  const originalError = console.error;

  console.warn = (...args: unknown[]) => {
    originalWarn.apply(console, args);
    reportConsole("warning", "console_warn", args);
  };
  console.error = (...args: unknown[]) => {
    originalError.apply(console, args);
    reportConsole("error", "console_error", args);
  };

  return () => {
    console.warn = originalWarn;
    console.error = originalError;
  };
}

function reportConsole(severity: "warning" | "error", category: string, args: unknown[]): void {
  const message = args.map(consoleArgSummary).filter(Boolean).join(" ").slice(0, 600) || category;
  reportClientObservation({
    severity,
    source: "web",
    category,
    message,
    route: window.location.pathname,
    fingerprint: `${category}:${message}`.slice(0, 240),
  });
}

function consoleArgSummary(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return redactConsoleText(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value == null) return "";
  return Object.prototype.toString.call(value);
}

function redactConsoleText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/(token|password|secret|authorization|api[_-]?key)=([^&\s]+)/gi, "$1=[redacted]");
}
