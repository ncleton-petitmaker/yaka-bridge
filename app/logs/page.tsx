"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { listAuditLogs, type AuditEvent } from "@/lib/client";

export default function LogsPage() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      const r = await listAuditLogs({ limit: 200 });
      setEvents(r.events);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  return (
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: "32px 24px" }}>
      <header style={{ marginBottom: 16 }}>
        <Link href="/" style={{ fontSize: 13, color: "#666" }}>
          ← Accueil
        </Link>
        <h1 style={{ fontSize: 22, fontWeight: 600, marginTop: 8 }}>Journal d'audit</h1>
      </header>

      {loading ? (
        <p>Chargement…</p>
      ) : error ? (
        <p style={{ color: "crimson" }}>{error}</p>
      ) : events.length === 0 ? (
        <p style={{ color: "#666", fontSize: 14 }}>Aucun événement.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border, #e4e4e4)" }}>
              <th style={{ textAlign: "left", padding: 8 }}>Date</th>
              <th style={{ textAlign: "left", padding: 8 }}>Acteur</th>
              <th style={{ textAlign: "left", padding: 8 }}>Action</th>
              <th style={{ textAlign: "left", padding: 8 }}>Ressource</th>
              <th style={{ textAlign: "left", padding: 8 }}>Résultat</th>
            </tr>
          </thead>
          <tbody>
            {events.map((ev) => (
              <tr key={ev.event_id} style={{ borderBottom: "1px solid #f0f0f0" }}>
                <td style={{ padding: 8, fontFamily: "ui-monospace, monospace" }}>
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
                        ? "green"
                        : ev.result === "denied"
                        ? "orange"
                        : "crimson",
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
  );
}
