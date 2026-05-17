"use client";

import { useEffect, useState } from "react";
import { AppChromeHeader } from "@/components/AppChromeHeader";
import { listAuditLogs, type AuditEvent } from "@/lib/client";

/**
 * Audit log viewer générique hérité d'oif-eval : table chronologique des
 * événements + filtres user / date / action.
 */
export default function LogsPage() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterUser, setFilterUser] = useState("");
  const [filterAction, setFilterAction] = useState("");
  const [filterSince, setFilterSince] = useState("");

  async function refresh() {
    setLoading(true);
    try {
      const r = await listAuditLogs({
        limit: 200,
        user: filterUser || undefined,
        action: filterAction || undefined,
        since: filterSince || undefined,
      });
      setEvents(r.events);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="app">
      <AppChromeHeader />
      <main
        style={{
          flex: 1,
          overflowY: "auto",
          padding: 32,
          maxWidth: 1200,
          width: "100%",
          margin: "0 auto",
        }}
      >
        <header style={{ marginBottom: 20 }}>
          <h1
            style={{
              fontFamily: "var(--serif)",
              fontWeight: 600,
              fontSize: 28,
              letterSpacing: "-0.01em",
              color: "var(--text-strong)",
              marginBottom: 6,
            }}
          >
            Journal d&apos;audit
          </h1>
          <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
            Événements chaînés (insertion only) de l&apos;app. Filtres par utilisateur,
            date et action.
          </p>
        </header>

        <section
          className="pane"
          style={{
            padding: 16,
            display: "flex",
            gap: 12,
            alignItems: "flex-end",
            flexWrap: "wrap",
            marginBottom: 16,
          }}
        >
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Utilisateur</span>
            <input
              type="text"
              value={filterUser}
              onChange={(e) => setFilterUser(e.target.value)}
              placeholder="prenom"
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Action</span>
            <input
              type="text"
              value={filterAction}
              onChange={(e) => setFilterAction(e.target.value)}
              placeholder="run.start, skill.update…"
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Depuis</span>
            <input
              type="datetime-local"
              value={filterSince}
              onChange={(e) => setFilterSince(e.target.value)}
            />
          </label>
          <button
            onClick={refresh}
            className="primary"
            style={{ padding: "8px 14px", fontSize: 13, cursor: "pointer" }}
          >
            Filtrer
          </button>
        </section>

        {loading ? (
          <p>Chargement…</p>
        ) : error ? (
          <p style={{ color: "var(--red, crimson)" }}>{error}</p>
        ) : events.length === 0 ? (
          <p style={{ color: "var(--text-muted)", fontSize: 14 }}>Aucun événement.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                <th style={{ textAlign: "left", padding: 8 }}>Date</th>
                <th style={{ textAlign: "left", padding: 8 }}>Acteur</th>
                <th style={{ textAlign: "left", padding: 8 }}>Action</th>
                <th style={{ textAlign: "left", padding: 8 }}>Ressource</th>
                <th style={{ textAlign: "left", padding: 8 }}>Résultat</th>
              </tr>
            </thead>
            <tbody>
              {events.map((ev) => (
                <tr
                  key={ev.event_id}
                  style={{ borderBottom: "1px solid var(--border-soft)" }}
                >
                  <td style={{ padding: 8, fontFamily: "var(--mono)" }}>
                    {ev.timestamp.replace("T", " ").slice(0, 19)}
                  </td>
                  <td style={{ padding: 8 }}>{ev.actor_id}</td>
                  <td style={{ padding: 8 }}>{ev.action}</td>
                  <td style={{ padding: 8 }}>
                    {ev.resource_type}
                    {ev.resource_id ? `:${ev.resource_id.slice(0, 8)}` : ""}
                  </td>
                  <td
                    style={{
                      padding: 8,
                      color:
                        ev.result === "success"
                          ? "var(--green, green)"
                          : ev.result === "denied"
                          ? "var(--amber, orange)"
                          : "var(--red, crimson)",
                    }}
                  >
                    {ev.result}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </main>
    </div>
  );
}
