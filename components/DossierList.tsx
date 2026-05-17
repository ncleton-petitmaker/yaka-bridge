"use client";
import { useMemo, useState } from "react";
import type { DossierEntry, DossierStatus } from "@/lib/types";
import { Icon } from "@/components/Icon";

const STATUS_META: Record<
  DossierStatus,
  { label: string; emoji: string; color: string; bg: string }
> = {
  a_faire: {
    label: "À faire",
    emoji: "◷",
    color: "var(--text-muted)",
    bg: "var(--bg-subtle)",
  },
  en_review: {
    label: "En review",
    emoji: "◔",
    color: "var(--amber)",
    bg: "var(--amber-bg)",
  },
  valide: {
    label: "Validé",
    emoji: "✓",
    color: "var(--green)",
    bg: "var(--green-bg)",
  },
  eligibilite_ok: {
    label: "Eligible - à noter",
    emoji: "◑",
    color: "var(--blue, var(--accent))",
    bg: "var(--blue-bg, var(--accent-tint))",
  },
  ineligible: {
    label: "Inéligible",
    emoji: "⊘",
    color: "var(--red)",
    bg: "var(--red-bg)",
  },
};

export function DossierList({
  dossiers,
  selectedId,
  onSelect,
  onCollapse,
  onBatch,
  batchBusy,
  concurrency,
  inputDir,
}: {
  dossiers: DossierEntry[];
  selectedId?: string;
  onSelect: (d: DossierEntry) => void;
  onCollapse?: () => void;
  /** Callback : lance N évaluations parmi les dossiers filtrés a_faire (limité à 5). */
  onBatch?: (dossierIds: string[]) => void;
  batchBusy?: boolean;
  concurrency?: { running: number; max: number };
  /** Chemin absolu du dossier candidatures (pour ouvrir dans le Finder
   *  quand la liste est vide). */
  inputDir?: string;
}) {
  const [q, setQ] = useState("");
  const [filterStatus, setFilterStatus] = useState<DossierStatus | "all">("all");

  const filtered = useMemo(() => {
    return dossiers.filter((d) => {
      if (filterStatus !== "all" && d.status !== filterStatus) return false;
      if (q && !d.id.toLowerCase().includes(q.toLowerCase())) return false;
      return true;
    });
  }, [dossiers, q, filterStatus]);

  return (
    <aside
      style={{
        width: "100%",
        height: "100%",
        background: "var(--bg-panel)",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "14px 14px 10px 14px",
          borderBottom: "1px solid var(--border-soft)",
          display: "flex",
          flexDirection: "column",
          gap: 8,
          flexShrink: 0,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              color: "var(--text-muted)",
            }}
          >
            Dossiers
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 11, color: "var(--text-faint)" }}>
              {filtered.length}/{dossiers.length}
            </span>
            {onCollapse && (
              <button
                onClick={onCollapse}
                aria-label="Réduire la barre latérale (Cmd+B)"
                title="Réduire la barre latérale (Cmd+B)"
                style={{
                  width: 22,
                  height: 22,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "transparent",
                  border: "1px solid transparent",
                  borderRadius: "var(--radius-sm)",
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  transition: "background 120ms ease, color 120ms ease",
                  padding: 0,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--bg-subtle)";
                  e.currentTarget.style.color = "var(--text-strong)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                  e.currentTarget.style.color = "var(--text-muted)";
                }}
              >
                <Icon name="panel-left-close" size={14} />
              </button>
            )}
          </div>
        </div>
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Rechercher..."
          style={{
            fontSize: 12,
            padding: "5px 9px",
          }}
        />
        <div
          style={{
            display: "flex",
            gap: 4,
            flexWrap: "wrap",
          }}
        >
          {(["all", "a_faire", "en_review", "eligibilite_ok", "valide", "ineligible"] as const).map((s) => {
            const isActive = filterStatus === s;
            const label =
              s === "all" ? "Tous" : STATUS_META[s as DossierStatus].label;
            return (
              <button
                key={s}
                onClick={() => setFilterStatus(s)}
                style={{
                  fontSize: 10.5,
                  padding: "3px 8px",
                  borderRadius: "var(--radius-pill)",
                  background: isActive
                    ? "var(--accent)"
                    : "var(--bg-subtle)",
                  color: isActive ? "white" : "var(--text-muted)",
                  border: isActive
                    ? "1px solid var(--accent)"
                    : "1px solid var(--border-soft)",
                  cursor: "pointer",
                  fontWeight: 500,
                  transition: "all 120ms ease",
                }}
              >
                {label}
              </button>
            );
          })}
        </div>

        {/* Bouton batch : lance jusqu'à 5 évaluations à faire d'un coup */}
        {onBatch && (() => {
          const todoFiltered = filtered.filter((d) => d.status === "a_faire");
          const max = concurrency?.max ?? 5;
          const running = concurrency?.running ?? 0;
          const slots = Math.max(0, max - running);
          const willLaunch = Math.min(slots, todoFiltered.length);
          const targets = todoFiltered.slice(0, willLaunch).map((d) => d.id);
          const disabled = batchBusy || willLaunch === 0;
          const label = batchBusy
            ? "Lancement..."
            : willLaunch === 0
            ? running >= max
              ? `Limite ${max} atteinte (${running} en cours)`
              : "Aucun à faire dans le filtre"
            : `Lancer ${willLaunch} évaluation${willLaunch > 1 ? "s" : ""} (batch)`;
          return (
            <button
              onClick={() => onBatch(targets)}
              disabled={disabled}
              className="primary"
              style={{
                fontSize: 11.5,
                padding: "5px 10px",
                cursor: disabled ? "not-allowed" : "pointer",
                opacity: disabled ? 0.5 : 1,
                width: "100%",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
              }}
              title={
                running >= max
                  ? `${running} évaluations déjà en cours (max ${max}). Attendez qu'une se termine.`
                  : `Lance ${willLaunch} évaluations en parallèle parmi les ${todoFiltered.length} dossiers à faire visibles.`
              }
            >
              ⚡ {label}
              {running > 0 && willLaunch > 0 && (
                <span
                  style={{
                    fontSize: 10,
                    opacity: 0.85,
                    marginLeft: 2,
                  }}
                >
                  ({running} en cours)
                </span>
              )}
            </button>
          );
        })()}
      </div>

      <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden", minHeight: 0, padding: "8px 8px 24px 8px" }}>
        {dossiers.length === 0 && <EmptyDossierState inputDir={inputDir} />}
        {dossiers.length > 0 && filtered.length === 0 && (
          <div
            style={{
              padding: 24,
              textAlign: "center",
              fontSize: 12,
              color: "var(--text-muted)",
            }}
          >
            Aucun dossier ne correspond à votre filtre.
          </div>
        )}
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {filtered.map((d) => {
            const meta = STATUS_META[d.status];
            const active = d.id === selectedId;
            return (
              <li key={d.id}>
                <button
                  onClick={() => onSelect(d)}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    padding: "10px 12px",
                    margin: "2px 0",
                    border: active
                      ? "1px solid color-mix(in srgb, var(--accent) 50%, var(--border))"
                      : "1px solid transparent",
                    borderRadius: 12,
                    background: active ? "var(--bg-subtle)" : "transparent",
                    color: "var(--text)",
                    cursor: "pointer",
                    transition:
                      "background 120ms ease, border-color 120ms ease",
                    display: "flex",
                    flexDirection: "column",
                    gap: 3,
                    boxShadow: active ? "var(--shadow-xs)" : "none",
                  }}
                  onMouseEnter={(e) => {
                    if (!active) e.currentTarget.style.background = "var(--bg-subtle)";
                  }}
                  onMouseLeave={(e) => {
                    if (!active) e.currentTarget.style.background = "transparent";
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: 18,
                        height: 18,
                        borderRadius: "var(--radius-sm)",
                        background: meta.bg,
                        color: meta.color,
                        fontSize: 11,
                        fontWeight: 600,
                        flexShrink: 0,
                      }}
                      aria-hidden
                    >
                      {d.running ? (
                        <span className="dossier-spinner" aria-label="En cours">⟳</span>
                      ) : (
                        meta.emoji
                      )}
                    </span>
                    <span
                      style={{
                        fontSize: 12.5,
                        fontWeight: 500,
                        color: "var(--text-strong)",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        flex: 1,
                      }}
                      title={d.id}
                    >
                      {d.id}
                    </span>
                  </div>
                  <div
                    style={{
                      fontSize: 10.5,
                      color: "var(--text-muted)",
                      marginLeft: 26,
                    }}
                  >
                    {d.running ? "En cours…" : meta.label} · {d.files.length} fichiers
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
}

/**
 * Affiché quand aucun dossier n'est présent dans le dossier candidatures.
 * Inclut un bouton qui ouvre le dossier dans le Finder/Explorateur via
 * l'API Electron `oifEval.revealFile`, pour que l'utilisateur puisse y
 * glisser-déposer ses propres dossiers sans passer par l'admin.
 */
function EmptyDossierState({ inputDir }: { inputDir?: string }) {
  const electron = (
    typeof window !== "undefined"
      ? (window as unknown as {
          oifEval?: {
            revealFile?: (p: string) => Promise<{ ok: boolean; error?: string }>;
            openFile?: (p: string) => Promise<{ ok: boolean; error?: string }>;
          };
        }).oifEval
      : undefined
  ) ?? undefined;

  async function openInFinder() {
    if (!inputDir) return;
    const fn = electron?.revealFile ?? electron?.openFile;
    if (!fn) return;
    try {
      await fn(inputDir);
    } catch {
      // pas bloquant
    }
  }

  const canOpen = Boolean(inputDir && (electron?.revealFile || electron?.openFile));

  return (
    <div
      style={{
        padding: "32px 20px",
        textAlign: "center",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 14,
        color: "var(--text)",
      }}
    >
      <div style={{ fontSize: 36, lineHeight: 1, opacity: 0.4 }}>📂</div>
      <div
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: "var(--text-strong)",
          lineHeight: 1.5,
        }}
      >
        Aucun dossier à traiter
      </div>
      <div
        style={{
          fontSize: 12,
          color: "var(--text-muted)",
          lineHeight: 1.6,
          maxWidth: 280,
        }}
      >
        Une candidature = <strong>un sous-dossier</strong> contenant les
        PDF/xlsx du candidat (présentation, récépissé, budget, etc.).
        <br />
        <br />
        Demandez à votre admin de déposer les sous-dossiers de candidatures
        dans votre dossier, ou ajoutez-les vous-même.
      </div>
      {canOpen ? (
        <button
          type="button"
          onClick={openInFinder}
          className="ghost"
          style={{
            fontSize: 12,
            padding: "7px 14px",
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            marginTop: 4,
          }}
          title={inputDir}
        >
          <Icon name="folder" size={14} />
          Ouvrir le dossier candidatures
        </button>
      ) : inputDir ? (
        <code
          style={{
            fontSize: 11,
            color: "var(--text-muted)",
            wordBreak: "break-all",
            padding: "4px 8px",
            background: "var(--bg-subtle)",
            borderRadius: "var(--radius-sm)",
            maxWidth: 280,
          }}
        >
          {inputDir}
        </code>
      ) : null}
    </div>
  );
}
