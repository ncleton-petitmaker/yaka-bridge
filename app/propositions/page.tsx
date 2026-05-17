"use client";

import { useState } from "react";
import { AppChromeHeader } from "@/components/AppChromeHeader";

/**
 * Pattern proposition + DiffViewer + approve/reject workflow hérité d'oif-eval.
 * Une "proposition" est un objet générique : l'app métier le typera (par ex.
 * `RuleProposal` chez OIF). On garde ici un type vide `{}` que l'agent
 * ui-page-generator étendra selon le brief.
 */
type Proposal = Record<string, unknown> & {
  id: string;
  status: "pending" | "approved" | "rejected";
};

export default function PropositionsPage() {
  const [proposals] = useState<Proposal[]>([
    // AGENT-SLOT: proposals-list — l'agent ui-page-generator branche un fetch.
  ]);
  const [selected, setSelected] = useState<Proposal | null>(null);

  return (
    <div className="app">
      <AppChromeHeader />
      <div
        style={{
          flex: 1,
          display: "grid",
          gridTemplateColumns: "320px 1fr",
          overflow: "hidden",
          minHeight: 0,
        }}
      >
        <aside
          style={{
            borderRight: "1px solid var(--border)",
            overflowY: "auto",
            padding: 16,
            background: "var(--bg-panel)",
          }}
        >
          <h2
            style={{
              fontSize: 13,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              color: "var(--text-muted)",
              marginBottom: 12,
            }}
          >
            Propositions
          </h2>
          {proposals.length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--text-faint)", fontStyle: "italic" }}>
              Aucune proposition pour l&apos;instant.
            </p>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {proposals.map((p) => (
                <li key={p.id} style={{ marginBottom: 6 }}>
                  <button
                    onClick={() => setSelected(p)}
                    style={{
                      width: "100%",
                      textAlign: "left",
                      padding: "8px 10px",
                      background:
                        selected?.id === p.id
                          ? "var(--accent-tint)"
                          : "transparent",
                      border: "1px solid var(--border-soft)",
                      borderRadius: "var(--radius-sm)",
                      cursor: "pointer",
                      fontSize: 12,
                    }}
                  >
                    <code style={{ fontFamily: "var(--mono)" }}>{p.id}</code>
                    <span
                      style={{
                        marginLeft: 8,
                        fontSize: 10,
                        color: "var(--text-muted)",
                      }}
                    >
                      {p.status}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <main
          style={{
            overflowY: "auto",
            padding: 28,
            background: "var(--bg)",
          }}
        >
          {selected ? (
            <div>
              <h1
                style={{
                  fontFamily: "var(--serif)",
                  fontWeight: 600,
                  fontSize: 22,
                  color: "var(--text-strong)",
                  marginBottom: 16,
                }}
              >
                Proposition {selected.id}
              </h1>

              {/* AGENT-SLOT: proposition-diff-viewer
                  L'agent ui-page-generator remplace par <DiffViewer />
                  avec le before/after typé selon l'entité métier. */}
              <section
                className="pane"
                style={{
                  padding: 20,
                  marginBottom: 16,
                  minHeight: 200,
                  color: "var(--text-muted)",
                  fontSize: 13,
                  fontStyle: "italic",
                }}
              >
                Diff viewer à brancher par l&apos;agent ui-page-generator.
              </section>

              {selected.status === "pending" && (
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    className="primary"
                    style={{ padding: "8px 16px", fontSize: 13, cursor: "pointer" }}
                  >
                    Approuver
                  </button>
                  <button
                    style={{
                      padding: "8px 16px",
                      fontSize: 13,
                      cursor: "pointer",
                      background: "transparent",
                      border: "1px solid var(--border)",
                      color: "var(--text)",
                      borderRadius: "var(--radius-sm)",
                    }}
                  >
                    Rejeter
                  </button>
                </div>
              )}
            </div>
          ) : (
            <p style={{ color: "var(--text-muted)", fontSize: 14 }}>
              Sélectionnez une proposition à gauche.
            </p>
          )}
        </main>
      </div>
    </div>
  );
}
