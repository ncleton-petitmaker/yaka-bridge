"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { listRuns, startRun } from "@/lib/client";
import type { RunRecord } from "@/lib/types";

export default function RunsPage() {
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [prompt, setPrompt] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      const list = await listRuns();
      setRuns(list);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    const i = setInterval(refresh, 3000);
    return () => clearInterval(i);
  }, []);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!prompt.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const runId = await startRun({ prompt });
      setPrompt("");
      window.location.href = `/runs/${runId}`;
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  }

  return (
    <main style={{ maxWidth: 880, margin: "0 auto", padding: "32px 24px" }}>
      <header style={{ marginBottom: 24 }}>
        <Link href="/" style={{ fontSize: 13, color: "#666" }}>
          ← Accueil
        </Link>
        <h1 style={{ fontSize: 24, fontWeight: 600, marginTop: 8 }}>Runs</h1>
      </header>

      <form
        onSubmit={onCreate}
        style={{
          border: "1px solid var(--border, #e4e4e4)",
          borderRadius: 8,
          padding: 16,
          marginBottom: 24,
        }}
      >
        <label
          htmlFor="prompt"
          style={{ display: "block", fontSize: 13, fontWeight: 500, marginBottom: 6 }}
        >
          Nouveau run (prompt envoyé à Claude Code)
        </label>
        <textarea
          id="prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          placeholder="Décris ce que Claude doit faire…"
          style={{
            width: "100%",
            padding: 10,
            border: "1px solid var(--border, #e4e4e4)",
            borderRadius: 6,
            fontFamily: "inherit",
            fontSize: 14,
            resize: "vertical",
          }}
        />
        <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center" }}>
          <button
            type="submit"
            disabled={creating || !prompt.trim()}
            style={{
              padding: "8px 14px",
              fontSize: 14,
              cursor: creating ? "default" : "pointer",
              opacity: creating ? 0.6 : 1,
            }}
          >
            {creating ? "Lancement…" : "+ Nouveau"}
          </button>
          {error && <span style={{ color: "crimson", fontSize: 13 }}>{error}</span>}
        </div>
      </form>

      {loading ? (
        <p>Chargement…</p>
      ) : runs.length === 0 ? (
        <p style={{ color: "#666", fontSize: 14 }}>Aucun run pour l'instant.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border, #e4e4e4)" }}>
              <th style={{ textAlign: "left", padding: 8 }}>ID</th>
              <th style={{ textAlign: "left", padding: 8 }}>Statut</th>
              <th style={{ textAlign: "left", padding: 8 }}>Tag</th>
              <th style={{ textAlign: "left", padding: 8 }}>Démarré</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} style={{ borderBottom: "1px solid #f0f0f0" }}>
                <td style={{ padding: 8 }}>
                  <Link href={`/runs/${r.id}`}>{r.id.slice(0, 8)}…</Link>
                </td>
                <td style={{ padding: 8 }}>{r.status}</td>
                <td style={{ padding: 8 }}>{r.tag ?? "—"}</td>
                <td style={{ padding: 8 }}>
                  {new Date(r.startedAt).toLocaleTimeString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
