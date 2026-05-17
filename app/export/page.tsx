"use client";
import { useEffect, useState, useCallback } from "react";
import { AppChromeHeader } from "@/components/AppChromeHeader";
import { listDossiers } from "@/lib/client";
import type { DossierEntry } from "@/lib/types";

export default function ExportPage() {
  const user = "Nicolas (test)";
  const [dossiers, setDossiers] = useState<DossierEntry[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    setDossiers(await listDossiers());
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // On expose TOUS les dossiers, même non évalués. L'utilisateur peut vouloir
  // exporter la liste exhaustive (avec lignes "non évalué" pour les manquants)
  // pour suivre l'avancement ou produire un rapport global.
  const eligibles = dossiers;

  function toggleAll() {
    if (selected.size === eligibles.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(eligibles.map((d) => d.id)));
    }
  }

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  async function exporter() {
    if (selected.size === 0) return;
    const ids = Array.from(selected);
    const r = await fetch("/api/export-xlsx", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dossier_ids: ids }),
    });
    if (!r.ok) {
      alert("Échec export : " + r.statusText);
      return;
    }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `oif-eval-export-${new Date().toISOString().slice(0, 10)}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="app">
      <AppChromeHeader user={user} />
      <main
        style={{
          padding: "32px 28px",
          maxWidth: 960,
          margin: "0 auto",
          width: "100%",
          overflowY: "auto",
        }}
      >
        <div className="mb-6">
          <h1
            style={{
              fontFamily: "var(--serif)",
              fontWeight: 600,
              fontSize: 24,
              color: "var(--text-strong)",
              letterSpacing: "-0.01em",
            }}
          >
            Export xlsx (format 6e)
          </h1>
          <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 4 }}>
            Sélectionnez les dossiers à inclure dans le fichier xlsx final. Format compatible avec
            la 6e édition (utilisé par l&apos;OIF pour la consolidation). Les dossiers non encore
            évalués sont inclus avec une ligne vide marquée &laquo; non évalué &raquo;.
          </p>
        </div>

        <div className="flex items-center gap-3 mb-3">
          <button
            onClick={toggleAll}
            className="ghost"
            style={{ padding: "6px 12px", fontSize: 13, cursor: "pointer" }}
          >
            {selected.size === eligibles.length ? "Tout désélectionner" : "Tout sélectionner"}
          </button>
          <span style={{ fontSize: 13, color: "var(--text-muted)" }}>
            {selected.size} / {eligibles.length} sélectionnés
          </span>
          <button
            onClick={exporter}
            disabled={selected.size === 0}
            className="primary"
            style={{ marginLeft: "auto", padding: "8px 14px", fontSize: 13, cursor: "pointer" }}
          >
            Générer xlsx ({selected.size})
          </button>
        </div>

        <div
          style={{
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            overflow: "hidden",
            background: "var(--bg-panel)",
          }}
        >
          <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
            <thead style={{ background: "var(--bg-subtle)" }}>
              <tr>
                <th style={{ textAlign: "left", padding: 8, width: 40 }}></th>
                <th
                  style={{
                    textAlign: "left",
                    padding: 8,
                    fontSize: 11,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    color: "var(--text-muted)",
                    fontWeight: 500,
                  }}
                >
                  Dossier
                </th>
                <th
                  style={{
                    textAlign: "left",
                    padding: 8,
                    fontSize: 11,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    color: "var(--text-muted)",
                    fontWeight: 500,
                  }}
                >
                  Statut
                </th>
                <th
                  style={{
                    textAlign: "left",
                    padding: 8,
                    width: 80,
                    fontSize: 11,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    color: "var(--text-muted)",
                    fontWeight: 500,
                  }}
                >
                  Fichiers
                </th>
              </tr>
            </thead>
            <tbody>
              {eligibles.map((d) => (
                <tr key={d.id} style={{ borderTop: "1px solid var(--border-soft)" }}>
                  <td style={{ padding: 8 }}>
                    <input
                      type="checkbox"
                      checked={selected.has(d.id)}
                      onChange={() => toggle(d.id)}
                    />
                  </td>
                  <td
                    style={{
                      padding: 8,
                      fontFamily: "var(--mono)",
                      fontSize: 11,
                      color: "var(--text)",
                    }}
                  >
                    {d.id}
                  </td>
                  <td style={{ padding: 8 }}>
                    {d.status === "valide" && (
                      <span style={{ color: "var(--green)", fontSize: 11 }}>Validé</span>
                    )}
                    {d.status === "en_review" && (
                      <span style={{ color: "var(--amber)", fontSize: 11 }}>En review</span>
                    )}
                    {d.status === "ineligible" && (
                      <span style={{ color: "var(--text-muted)", fontSize: 11 }}>Inéligible</span>
                    )}
                    {d.status === "a_faire" && (
                      <span style={{ color: "var(--text-muted)", fontSize: 11 }}>À faire</span>
                    )}
                  </td>
                  <td style={{ padding: 8, fontSize: 11, color: "var(--text-muted)" }}>
                    {d.files.length}
                  </td>
                </tr>
              ))}
              {eligibles.length === 0 && (
                <tr>
                  <td
                    colSpan={4}
                    style={{
                      padding: 32,
                      textAlign: "center",
                      fontSize: 13,
                      color: "var(--text-muted)",
                    }}
                  >
                    Aucun dossier trouvé.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  );
}
