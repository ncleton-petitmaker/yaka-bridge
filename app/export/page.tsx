"use client";

import { useState } from "react";
import { AppChromeHeader } from "@/components/AppChromeHeader";

type ExportFormat = "xlsx" | "json" | "csv";

/**
 * Pattern download avec format selector hérité d'oif-eval.
 * L'agent ui-page-generator branche les routes /api/export?format=X côté daemon.
 */
export default function ExportPage() {
  const [format, setFormat] = useState<ExportFormat>("xlsx");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    setBusy(true);
    setError(null);
    try {
      const url = `/api/export?format=${format}`;
      // Forme générique : on laisse le navigateur télécharger en suivant le
      // Content-Disposition retourné par le daemon.
      const a = document.createElement("a");
      a.href = url;
      a.download = "";
      a.click();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <AppChromeHeader />
      <main
        style={{
          flex: 1,
          overflowY: "auto",
          padding: 32,
          maxWidth: 720,
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
            Export
          </h1>
          <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
            {/* AGENT-SLOT: export-intro */}
            Téléchargez un export des données dans le format de votre choix.
          </p>
        </header>

        <section
          className="pane"
          style={{
            padding: 24,
            display: "flex",
            flexDirection: "column",
            gap: 16,
          }}
        >
          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text)" }}>
              Format
            </span>
            <select
              value={format}
              onChange={(e) => setFormat(e.target.value as ExportFormat)}
              style={{ maxWidth: 220 }}
            >
              <option value="xlsx">Excel (.xlsx)</option>
              <option value="json">JSON (.json)</option>
              <option value="csv">CSV (.csv)</option>
            </select>
          </label>

          {/* AGENT-SLOT: export-options
              Options supplémentaires (filtres, période, scope) ajoutées par
              l'agent ui-page-generator. */}

          <div>
            <button
              onClick={download}
              disabled={busy}
              className="primary"
              style={{
                padding: "10px 20px",
                fontSize: 14,
                cursor: busy ? "default" : "pointer",
              }}
            >
              {busy ? "Préparation…" : "Télécharger"}
            </button>
          </div>

          {error && (
            <p style={{ fontSize: 12, color: "var(--red, crimson)" }}>{error}</p>
          )}
        </section>
      </main>
    </div>
  );
}
