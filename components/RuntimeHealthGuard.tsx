"use client";

import { useEffect } from "react";
import { captureReplayError } from "@/lib/openreplay";
import { errorMessage, reportClientObservation } from "@/lib/observability";

export function RuntimeHealthGuard() {
  useEffect(() => {
    document.documentElement.setAttribute("data-bridge-react-ready", "1");

    const onError = (event: ErrorEvent) => {
      captureReplayError(event.error ?? event.message, { source: "runtime_error" });
      reportClientObservation({
        severity: "critical",
        source: "web",
        category: "runtime_error",
        message: event.message || "Erreur d'affichage",
        route: window.location.pathname,
        fingerprint: `runtime_error:${event.filename}:${event.lineno}:${event.message}`.slice(0, 240),
        context: {
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno,
          stack: event.error instanceof Error ? event.error.stack : undefined,
        },
      });
    };

    const onRejection = (event: PromiseRejectionEvent) => {
      const message = errorMessage(event.reason);
      captureReplayError(event.reason, { source: "unhandled_rejection" });
      reportClientObservation({
        severity: "error",
        source: "web",
        category: "unhandled_rejection",
        message,
        route: window.location.pathname,
        fingerprint: `unhandled_rejection:${message}`.slice(0, 240),
      });
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  return null;
}
