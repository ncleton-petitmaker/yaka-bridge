"use client";

import { useEffect, useState } from "react";

interface ConsumedBridgeTicket {
  organizationId?: string;
  serviceId?: string;
  returnTo?: string | null;
  service?: {
    baseUrl?: string;
  } | null;
}

interface ConsumeResponse {
  ok?: boolean;
  ticket?: ConsumedBridgeTicket;
  error?: string;
}

export default function BridgeAuthCallbackPage() {
  const [message, setMessage] = useState("Connexion au service...");

  useEffect(() => {
    let cancelled = false;

    async function consumeTicket() {
      try {
        const currentUrl = new URL(window.location.href);
        const ticket = currentUrl.searchParams.get("ticket") || currentUrl.searchParams.get("bridge_ticket");
        if (!ticket) throw new Error("Ticket Bridge manquant.");

        const controlPlaneBaseUrl = resolveControlPlaneBaseUrl(currentUrl);
        const response = await fetch(`${controlPlaneBaseUrl}/bridge/launch-ticket/consume`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ticket }),
        });
        const payload = (await response.json().catch(() => ({}))) as ConsumeResponse;
        if (!response.ok || !payload.ok || !payload.ticket) {
          throw new Error(payload.error || `Ticket Bridge refuse (${response.status}).`);
        }

        if (payload.ticket.organizationId) {
          window.localStorage.setItem("bridge:organization-id", payload.ticket.organizationId);
        }

        const redirectUrl =
          safeRedirectUrl(payload.ticket.returnTo) ||
          safeRedirectUrl(payload.ticket.service?.baseUrl) ||
          new URL("/dashboard", window.location.origin).toString();
        const nextUrl = new URL(redirectUrl, window.location.origin);
        const browserSessionId = currentUrl.searchParams.get("browserSessionId");
        if (browserSessionId && !nextUrl.searchParams.has("browserSessionId")) {
          nextUrl.searchParams.set("browserSessionId", browserSessionId);
        }
        if (payload.ticket.serviceId && !nextUrl.searchParams.has("service")) {
          nextUrl.searchParams.set("service", payload.ticket.serviceId);
        }

        if (!cancelled) {
          setMessage("Ouverture du service...");
          window.location.replace(nextUrl.toString());
        }
      } catch (err) {
        if (!cancelled) setMessage(err instanceof Error ? err.message : String(err));
      }
    }

    void consumeTicket();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="cloud-auth-shell">
      <section className="cloud-auth-panel">
        <h1>Bridge</h1>
        <p>{message}</p>
      </section>
    </main>
  );
}

function resolveControlPlaneBaseUrl(currentUrl: URL): string {
  const fromQuery = cleanExternalBaseUrl(currentUrl.searchParams.get("bridgeControlPlaneUrl"));
  if (fromQuery) return fromQuery;

  const fromEnv = cleanExternalBaseUrl(process.env.NEXT_PUBLIC_CLOUD_API_URL);
  if (fromEnv) return fromEnv;

  const daemonPort = process.env.NEXT_PUBLIC_DAEMON_PORT;
  if (daemonPort && /^\d+$/.test(daemonPort)) {
    return `http://127.0.0.1:${daemonPort}`;
  }

  return window.location.origin.replace(/\/+$/, "");
}

function cleanExternalBaseUrl(value: string | null | undefined): string | null {
  const raw = value?.trim().replace(/\/+$/, "");
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol === "https:") return url.toString().replace(/\/+$/, "");
    if (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) {
      return url.toString().replace(/\/+$/, "");
    }
  } catch {
    return null;
  }
  return null;
}

function safeRedirectUrl(value: string | null | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw, window.location.origin);
    if (url.protocol === "https:") return url.toString();
    if (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) {
      return url.toString();
    }
  } catch {
    return null;
  }
  return null;
}
