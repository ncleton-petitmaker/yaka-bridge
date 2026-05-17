"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { cancelRun, getRun, streamRun } from "@/lib/client";
import type { AgentEvent, RunRecord } from "@/lib/types";

export default function RunDetailPage({ params }: { params: { id: string } }) {
  const [run, setRun] = useState<RunRecord | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getRun(params.id).then((r) => {
      if (!cancelled) setRun(r);
    });
    const abort = new AbortController();
    streamRun(params.id, {
      onEvent: (ev) => {
        if (cancelled) return;
        setEvents((prev) => [...prev, ev]);
      },
      onError: (err) => setError(err.message),
      signal: abort.signal,
    }).catch(() => {
      /* géré par onError */
    });
    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [params.id]);

  return (
    <main style={{ maxWidth: 960, margin: "0 auto", padding: "32px 24px" }}>
      <header style={{ marginBottom: 16 }}>
        <Link href="/runs" style={{ fontSize: 13, color: "#666" }}>
          ← Runs
        </Link>
        <h1 style={{ fontSize: 22, fontWeight: 600, marginTop: 8 }}>
          Run {params.id.slice(0, 8)}…
        </h1>
        {run && (
          <div style={{ fontSize: 13, color: "#666", marginTop: 4 }}>
            statut : <strong>{run.status}</strong> · tag : {run.tag ?? "—"} ·
            démarré : {new Date(run.startedAt).toLocaleTimeString()}
            {" · "}
            <button
              onClick={() => cancelRun(params.id)}
              style={{ marginLeft: 8, padding: "2px 8px", fontSize: 12 }}
              disabled={run.status !== "running"}
            >
              Annuler
            </button>
          </div>
        )}
      </header>

      {error && (
        <div style={{ color: "crimson", fontSize: 13, marginBottom: 12 }}>{error}</div>
      )}

      <section
        style={{
          border: "1px solid var(--border, #e4e4e4)",
          borderRadius: 8,
          padding: 12,
          fontFamily: "ui-monospace, monospace",
          fontSize: 12,
          maxHeight: 600,
          overflow: "auto",
          background: "#fafafa",
        }}
      >
        {events.length === 0 ? (
          <p style={{ color: "#999" }}>En attente d'events…</p>
        ) : (
          events.map((ev, i) => (
            <div key={i} style={{ marginBottom: 4 }}>
              <span style={{ color: "#888" }}>
                {new Date(ev.ts).toLocaleTimeString()} [{ev.kind}]
              </span>{" "}
              <span>{ev.text ?? ev.status ?? ev.error ?? ""}</span>
            </div>
          ))
        )}
      </section>
    </main>
  );
}
