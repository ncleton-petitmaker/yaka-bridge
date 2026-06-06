"use client";

import { useEffect, useMemo, useState } from "react";
import { AppChromeHeader } from "@/components/AppChromeHeader";
import { apiFetch } from "@/lib/api-client";

type Severity = "info" | "warning" | "error" | "critical";

type ObservationEvent = {
  id: string;
  severity: Severity;
  source: string;
  category: string;
  message: string;
  route?: string | null;
  service_id?: string | null;
  job_id?: string | null;
  support_session_id?: string | null;
  replay_session_id?: string | null;
  replay_session_url?: string | null;
  app_version?: string | null;
  count: number;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at?: string | null;
  payload?: Record<string, unknown>;
};

type ObservabilityResponse = {
  events: ObservationEvent[];
  generatedAt: string;
  stats: {
    open: number;
    bySeverity: Record<string, number>;
    bySource: Record<string, number>;
  };
};

type SupportSession = {
  id: string;
  user_id?: string | null;
  replay_session_id?: string | null;
  replay_session_url?: string | null;
  current_route?: string | null;
  service_id?: string | null;
  job_id?: string | null;
  app_version?: string | null;
  viewport?: string | null;
  started_at: string;
  last_seen_at: string;
  ended_at?: string | null;
  metadata?: Record<string, unknown>;
};

type SessionsResponse = {
  sessions: SupportSession[];
  generatedAt: string;
};

type SessionDetail = {
  session: SupportSession;
  observations: ObservationEvent[];
  generatedAt: string;
};

const severityColors: Record<Severity, string> = {
  info: "var(--text-muted)",
  warning: "var(--amber-fg)",
  error: "var(--red-fg)",
  critical: "var(--red-fg)",
};

export default function ObservabilityPage() {
  const [data, setData] = useState<ObservabilityResponse | null>(null);
  const [sessionsData, setSessionsData] = useState<SessionsResponse | null>(null);
  const [selectedSession, setSelectedSession] = useState<SessionDetail | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<ObservationEvent | null>(null);
  const [severity, setSeverity] = useState("all");
  const [resolved, setResolved] = useState("open");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      const params = new URLSearchParams();
      if (severity !== "all") params.set("severity", severity);
      if (resolved !== "open") params.set("resolved", resolved);
      const [eventsResponse, sessionsResponse] = await Promise.all([
        apiFetch(`/api/admin/observability?${params.toString()}`),
        apiFetch("/api/admin/support-sessions?minutes=360&limit=80"),
      ]);
      const eventsJson = (await eventsResponse.json().catch(() => ({}))) as ObservabilityResponse & { error?: string };
      if (!eventsResponse.ok) throw new Error(eventsJson.error ?? `Observability HTTP ${eventsResponse.status}`);
      setData(eventsJson);
      const sessionsJson = (await sessionsResponse.json().catch(() => ({}))) as SessionsResponse & { error?: string };
      if (sessionsResponse.ok) setSessionsData(sessionsJson);
      if (selectedEvent) {
        const fresh = eventsJson.events.find((event) => event.id === selectedEvent.id);
        if (fresh) setSelectedEvent(fresh);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => void load(), 10_000);
    return () => window.clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [severity, resolved]);

  async function resolveEvent(event: ObservationEvent) {
    const response = await apiFetch(`/api/admin/observability/${encodeURIComponent(event.id)}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!response.ok) {
      const json = await response.json().catch(() => ({ error: response.statusText }));
      setError(json.error ?? "Résolution impossible");
      return;
    }
    await load();
  }

  async function loadSession(session: SupportSession) {
    setSelectedSession(null);
    const response = await apiFetch(`/api/admin/support-sessions/${encodeURIComponent(session.id)}`);
    const json = (await response.json().catch(() => ({}))) as SessionDetail & { error?: string };
    if (!response.ok) {
      setError(json.error ?? `Session HTTP ${response.status}`);
      return;
    }
    setSelectedSession(json);
  }

  const events = data?.events ?? [];
  const sessions = sessionsData?.sessions ?? [];
  const selectedPayload = useMemo(() => {
    if (!selectedEvent?.payload) return "";
    try {
      return JSON.stringify(selectedEvent.payload, null, 2);
    } catch {
      return "";
    }
  }, [selectedEvent]);

  return (
    <div className="app">
      <AppChromeHeader />
      <main style={{ flex: 1, overflowY: "auto", padding: 32, maxWidth: 1280, width: "100%", margin: "0 auto" }}>
        <header style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-end", marginBottom: 18 }}>
          <div>
            <h1 style={{ fontFamily: "var(--serif)", fontWeight: 600, fontSize: 28, margin: 0 }}>Observation</h1>
            <p style={{ color: "var(--text-muted)", fontSize: 13, margin: "6px 0 0" }}>
              Sessions support, erreurs client et liens OpenReplay.
            </p>
          </div>
          <button className="primary" type="button" onClick={() => void load()} disabled={loading}>
            {loading ? "Actualisation..." : "Actualiser"}
          </button>
        </header>

        <section style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10, marginBottom: 14 }}>
          <Stat label="Ouverts" value={data?.stats.open ?? 0} />
          <Stat label="Critiques" value={data?.stats.bySeverity.critical ?? 0} color="var(--red-fg)" />
          <Stat label="Erreurs" value={data?.stats.bySeverity.error ?? 0} color="var(--red-fg)" />
          <Stat label="Sessions" value={sessions.length} />
        </section>

        <section className="pane" style={{ padding: 14, display: "flex", gap: 10, alignItems: "center", marginBottom: 14 }}>
          <select value={severity} onChange={(event) => setSeverity(event.target.value)}>
            <option value="all">Toutes gravités</option>
            <option value="critical">Critique</option>
            <option value="error">Erreur</option>
            <option value="warning">Attention</option>
            <option value="info">Info</option>
          </select>
          <select value={resolved} onChange={(event) => setResolved(event.target.value)}>
            <option value="open">Ouverts</option>
            <option value="true">Résolus</option>
            <option value="all">Tous</option>
          </select>
        </section>

        {error && (
          <div className="pane" style={{ padding: 12, color: "var(--red-fg)", borderColor: "var(--red-fg)", marginBottom: 14 }}>
            {error}
          </div>
        )}

        <section className="pane" style={{ overflow: "hidden", marginBottom: 14 }}>
          <div style={sectionHeadStyle}>
            <strong>Sessions récentes</strong>
            <span style={mutedStyle}>6 dernières heures</span>
          </div>
          {sessions.length === 0 ? (
            <p style={{ padding: 14, color: "var(--text-muted)", margin: 0 }}>Aucune session récente.</p>
          ) : (
            sessions.slice(0, 12).map((session) => (
              <button
                key={session.id}
                type="button"
                onClick={() => void loadSession(session)}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1.4fr auto auto",
                  gap: 10,
                  width: "100%",
                  alignItems: "center",
                  textAlign: "left",
                  border: 0,
                  borderTop: "1px solid var(--border-soft)",
                  background: selectedSession?.session.id === session.id ? "var(--bg-muted)" : "transparent",
                  color: "var(--fg)",
                  padding: "10px 14px",
                  cursor: "pointer",
                }}
              >
                <span>{session.user_id?.slice(0, 8) ?? "-"}</span>
                <span style={{ ...mutedStyle, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {session.current_route ?? "-"}
                </span>
                <span style={{ color: isLive(session.last_seen_at) ? "var(--green-fg)" : "var(--text-muted)", whiteSpace: "nowrap" }}>
                  {formatDate(session.last_seen_at)}
                </span>
                {session.replay_session_url ? (
                  <a href={session.replay_session_url} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>
                    Replay
                  </a>
                ) : (
                  <span style={mutedStyle}>Trace</span>
                )}
              </button>
            ))
          )}
        </section>

        <div style={{ display: "grid", gridTemplateColumns: "1.2fr 0.8fr", gap: 14, alignItems: "start" }}>
          <section className="pane" style={{ overflow: "hidden" }}>
            <div style={sectionHeadStyle}>
              <strong>Événements</strong>
              <span style={mutedStyle}>{events.length}</span>
            </div>
            {events.length === 0 ? (
              <p style={{ padding: 14, color: "var(--text-muted)", margin: 0 }}>Aucun événement.</p>
            ) : (
              events.map((event) => (
                <button
                  key={event.id}
                  type="button"
                  onClick={() => setSelectedEvent(event)}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "92px 120px 1fr auto",
                    gap: 10,
                    width: "100%",
                    alignItems: "center",
                    textAlign: "left",
                    border: 0,
                    borderTop: "1px solid var(--border-soft)",
                    background: selectedEvent?.id === event.id ? "var(--bg-muted)" : "transparent",
                    color: "var(--fg)",
                    padding: "10px 14px",
                    cursor: "pointer",
                  }}
                >
                  <span style={{ color: severityColors[event.severity], fontWeight: 700 }}>{event.severity}</span>
                  <span style={mutedStyle}>{event.source}/{event.category}</span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{event.message}</span>
                  <span style={mutedStyle}>x{event.count}</span>
                </button>
              ))
            )}
          </section>

          <aside className="pane" style={{ padding: 14 }}>
            {selectedEvent ? (
              <>
                <h2 style={{ margin: "0 0 8px", fontSize: 16 }}>{selectedEvent.category}</h2>
                <p style={{ margin: "0 0 10px" }}>{selectedEvent.message}</p>
                <Meta label="Route" value={selectedEvent.route ?? "-"} />
                <Meta label="Dernière vue" value={formatDate(selectedEvent.last_seen_at)} />
                <Meta label="Version" value={selectedEvent.app_version ?? "-"} />
                {selectedEvent.replay_session_url && (
                  <p><a href={selectedEvent.replay_session_url} target="_blank" rel="noreferrer">Ouvrir le replay</a></p>
                )}
                {!selectedEvent.resolved_at && (
                  <button className="primary" type="button" onClick={() => void resolveEvent(selectedEvent)}>
                    Marquer résolu
                  </button>
                )}
                {selectedPayload && <pre style={preStyle}>{selectedPayload}</pre>}
              </>
            ) : selectedSession ? (
              <>
                <h2 style={{ margin: "0 0 8px", fontSize: 16 }}>Session support</h2>
                <Meta label="Route" value={selectedSession.session.current_route ?? "-"} />
                <Meta label="Dernier signal" value={formatDate(selectedSession.session.last_seen_at)} />
                {selectedSession.session.replay_session_url && (
                  <p><a href={selectedSession.session.replay_session_url} target="_blank" rel="noreferrer">Ouvrir le replay</a></p>
                )}
                <h3 style={{ fontSize: 13 }}>Observations liées</h3>
                {selectedSession.observations.map((event) => (
                  <button key={event.id} type="button" onClick={() => setSelectedEvent(event)} style={miniEventStyle}>
                    {event.severity} · {event.category} · {event.message}
                  </button>
                ))}
              </>
            ) : (
              <p style={mutedStyle}>Sélectionnez une session ou un événement.</p>
            )}
          </aside>
        </div>
      </main>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <article className="pane" style={{ padding: 14 }}>
      <div style={{ color: "var(--text-muted)", fontSize: 12 }}>{label}</div>
      <strong style={{ color, fontSize: 24 }}>{value}</strong>
    </article>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "92px 1fr", gap: 8, fontSize: 12, marginBottom: 6 }}>
      <span style={mutedStyle}>{label}</span>
      <span style={{ overflowWrap: "anywhere" }}>{value}</span>
    </div>
  );
}

function formatDate(value?: string | null): string {
  if (!value) return "-";
  return new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "medium" }).format(new Date(value));
}

function isLive(value: string): boolean {
  return Date.now() - new Date(value).getTime() < 30_000;
}

const mutedStyle = { color: "var(--text-muted)", fontSize: 12 };
const sectionHeadStyle = {
  padding: "12px 14px",
  borderBottom: "1px solid var(--border-soft)",
  display: "flex",
  justifyContent: "space-between",
  gap: 12,
};
const preStyle = {
  marginTop: 12,
  maxHeight: 260,
  overflow: "auto",
  padding: 10,
  borderRadius: 6,
  background: "var(--bg)",
  border: "1px solid var(--border-soft)",
  fontSize: 11,
};
const miniEventStyle = {
  display: "block",
  width: "100%",
  textAlign: "left" as const,
  border: "1px solid var(--border-soft)",
  background: "transparent",
  color: "var(--fg)",
  borderRadius: 6,
  padding: 8,
  marginBottom: 6,
  cursor: "pointer",
};
