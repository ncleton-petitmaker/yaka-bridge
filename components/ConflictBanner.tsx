"use client";

import { useEffect, useState } from "react";
import { listConflictCopies, type ConflictFile } from "@/lib/client";

/**
 * Bandeau global qui s'affiche si des "conflict copies" sont détectées dans le
 * dossier partagé synchronisé. Les sync engines (OneDrive, Dropbox) créent ces
 * fichiers quand deux utilisateurs modifient la même ressource en même temps.
 *
 * Polling léger toutes les 60 secondes. Cliquer ouvre une modale avec la liste.
 * Hérité d'oif-eval. Si l'app n'a pas de dossier partagé, l'API renvoie [] et
 * le banner ne s'affiche jamais.
 */
export function ConflictBanner() {
  const [conflicts, setConflicts] = useState<ConflictFile[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    function load() {
      listConflictCopies()
        .then((list) => {
          if (!cancelled) setConflicts(list);
        })
        .catch(() => {
          /* silent : si pas de partage configuré, l'API renvoie [] */
        });
    }
    load();
    timer = setInterval(load, 60_000);
    // Reload aussi quand la config app change (changement de dossier partagé)
    function onConfigChange() {
      load();
    }
    window.addEventListener("app-config-changed", onConfigChange);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      window.removeEventListener("app-config-changed", onConfigChange);
    };
  }, []);

  if (conflicts.length === 0) return null;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 14px",
          background: "var(--amber-bg)",
          color: "var(--amber)",
          border: "1px solid var(--amber-border)",
          borderRadius: 0,
          cursor: "pointer",
          fontSize: 12,
          fontWeight: 500,
          width: "100%",
          justifyContent: "center",
        }}
        title="Cliquer pour voir le détail"
      >
        <span style={{ fontWeight: 700 }}>⚠</span>
        {conflicts.length} fichier{conflicts.length > 1 ? "s" : ""} en conflit dans le
        dossier partagé. Cliquer pour résoudre.
      </button>

      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            zIndex: 1000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              padding: 20,
              maxWidth: 720,
              width: "100%",
              maxHeight: "80vh",
              overflowY: "auto",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 12,
              }}
            >
              <h2
                style={{
                  fontSize: 16,
                  fontWeight: 600,
                  color: "var(--text-strong)",
                  margin: 0,
                }}
              >
                Conflits de synchronisation détectés
              </h2>
              <button
                onClick={() => setOpen(false)}
                className="ghost"
                style={{ fontSize: 12, padding: "4px 10px", cursor: "pointer" }}
              >
                Fermer
              </button>
            </div>
            <p style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.55 }}>
              Le sync engine (OneDrive, Dropbox, etc.) a créé ces fichiers parce que
              deux personnes ont modifié la même ressource en même temps. Comparez les
              versions, gardez la bonne, supprimez le doublon. <strong>Ne supprimez
              pas le fichier original</strong> (sans le suffixe « conflicted copy »).
            </p>
            <ul
              style={{
                listStyle: "none",
                padding: 0,
                margin: "12px 0 0 0",
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
              {conflicts.map((c) => (
                <li
                  key={c.path}
                  style={{
                    padding: "8px 12px",
                    background: "var(--bg-subtle)",
                    border: "1px solid var(--border-soft)",
                    borderRadius: "var(--radius-sm)",
                    fontSize: 12,
                  }}
                >
                  <div
                    style={{
                      fontFamily: "var(--mono)",
                      fontSize: 11,
                      color: "var(--text-strong)",
                      wordBreak: "break-all",
                    }}
                  >
                    {c.path}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: "var(--text-muted)",
                      marginTop: 2,
                    }}
                  >
                    {(c.size / 1024).toFixed(1)} Ko · modifié{" "}
                    {new Date(c.mtime).toLocaleString("fr-FR")}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}
