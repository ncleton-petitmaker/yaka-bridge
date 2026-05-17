"use client";
import { useEffect, useState, useCallback } from "react";
import type { CSSProperties } from "react";
import { AppChromeHeader } from "@/components/AppChromeHeader";
import { DiffViewer } from "@/components/DiffViewer";
import {
  listPropositions,
  previewProposition,
  decidePropositions,
  revertPromotion,
  type PropositionPreviewData,
} from "@/lib/client";
import type { PropositionEntry } from "@/lib/types";
import { Icon } from "@/components/Icon";

const STATUT_STYLE: Record<string, { label: string; style: CSSProperties; emoji: string }> = {
  en_attente: {
    label: "En attente",
    style: {
      background: "var(--amber-bg)",
      color: "var(--amber)",
      border: "1px solid color-mix(in srgb, var(--amber) 30%, transparent)",
    },
    emoji: "🟡",
  },
  promu: {
    label: "Promu",
    style: {
      background: "var(--green-bg)",
      color: "var(--green)",
      border: "1px solid var(--green-border)",
    },
    emoji: "🟢",
  },
  rejete: {
    label: "Rejeté",
    style: {
      background: "var(--red-bg)",
      color: "var(--red)",
      border: "1px solid var(--red-border)",
    },
    emoji: "🔴",
  },
};

const badgeBase: CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  padding: "2px 8px",
  borderRadius: "var(--radius-sm)",
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
};

interface AppConfig {
  isAdmin?: boolean;
  currentUser?: string;
  autoApprove?: boolean;
}

export default function PropositionsPage() {
  const [profile, setProfile] = useState<AppConfig>({});
  const [props, setProps] = useState<PropositionEntry[]>([]);
  const [filter, setFilter] = useState<"toutes" | "en_attente" | "promu" | "rejete">(
    "en_attente"
  );
  const [openPreview, setOpenPreview] = useState<PropositionEntry | null>(null);

  const refresh = useCallback(async () => {
    try {
      setProps(await listPropositions());
    } catch (e) {
      console.error(e);
    }
  }, []);

  const refreshProfile = useCallback(() => {
    fetch("/api/app-config")
      .then((r) => r.json())
      .then((j: { config?: AppConfig }) => setProfile(j.config ?? {}))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    refreshProfile();
    const tProps = setInterval(refresh, 5000);
    const tProfile = setInterval(refreshProfile, 3000);
    window.addEventListener("fae-config-changed", refreshProfile);
    window.addEventListener("focus", refreshProfile);
    return () => {
      clearInterval(tProps);
      clearInterval(tProfile);
      window.removeEventListener("fae-config-changed", refreshProfile);
      window.removeEventListener("focus", refreshProfile);
    };
  }, [refresh, refreshProfile]);

  const filtered = props.filter((p) => filter === "toutes" || p.statut === filter);

  return (
    <div className="app">
      <AppChromeHeader user={profile.currentUser ?? "Non connecté"} />
      <main
        style={{
          padding: "32px 28px",
          maxWidth: 960,
          margin: "0 auto",
          width: "100%",
          overflowY: "auto",
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", marginBottom: 16, gap: 12 }}>
          <div style={{ flex: 1 }}>
            <h1
              style={{
                fontFamily: "var(--serif)",
                fontWeight: 600,
                fontSize: 24,
                color: "var(--text-strong)",
                letterSpacing: "-0.01em",
              }}
            >
              Propositions de l&apos;équipe
            </h1>
            <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 4 }}>
              Règles proposées par les membres de l&apos;équipe.{" "}
              {profile.isAdmin ? (
                <>
                  Vous êtes <strong>admin</strong>. Cliquez sur une proposition pour voir
                  ce qu&apos;elle change dans la règle officielle.
                </>
              ) : (
                <>L&apos;admin promeut les pertinentes en règles globales.</>
              )}
            </p>
          </div>
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as typeof filter)}
            style={{ width: "auto", flexShrink: 0, minWidth: 180, fontSize: 13 }}
          >
            <option value="toutes">Toutes ({props.length})</option>
            <option value="en_attente">
              En attente ({props.filter((p) => p.statut === "en_attente").length})
            </option>
            <option value="promu">
              Promues ({props.filter((p) => p.statut === "promu").length})
            </option>
            <option value="rejete">
              Rejetées ({props.filter((p) => p.statut === "rejete").length})
            </option>
          </select>
        </div>

        {profile.isAdmin && profile.autoApprove && (
          <div
            style={{
              padding: "10px 14px",
              background: "var(--amber-bg)",
              border: "1px solid var(--amber-border)",
              borderRadius: "var(--radius-sm)",
              fontSize: 12,
              color: "var(--text)",
              marginBottom: 14,
              lineHeight: 1.5,
            }}
          >
            <strong>Mode calibrage actif.</strong> Toutes les nouvelles
            propositions sont automatiquement promues en règle officielle.
            Vous pouvez annuler une promotion en cliquant sur{" "}
            <strong>« Voir le diff »</strong> sur une proposition au statut{" "}
            <strong>Promu</strong>.
          </div>
        )}

        {filtered.length === 0 && (
          <div
            style={{
              border: "1px dashed var(--border-strong)",
              borderRadius: "var(--radius)",
              padding: 32,
              textAlign: "center",
              color: "var(--text-muted)",
              fontSize: 13,
            }}
          >
            Aucune proposition pour ce filtre.
          </div>
        )}

        <div>
          {filtered.map((p) => {
            const style = STATUT_STYLE[p.statut ?? "en_attente"];
            const canDecide = profile.isAdmin && p.statut === "en_attente";
            return (
              <div
                key={p.path}
                className="pane"
                style={{ padding: 16, marginBottom: 12 }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    gap: 8,
                    marginBottom: 6,
                    flexWrap: "wrap",
                  }}
                >
                  <span style={{ ...badgeBase, ...style.style }}>
                    {style.emoji} {style.label}
                  </span>
                  <span style={{ fontSize: 11, color: "var(--text-muted)" }}>·</span>
                  <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                    {p.date ? new Date(p.date).toLocaleString("fr-FR") : "—"}
                  </span>
                  <span style={{ fontSize: 11, color: "var(--text-muted)" }}>·</span>
                  <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text)" }}>
                    {p.auteur ?? "?"}
                  </span>
                  {p.affecte && (
                    <span
                      style={{
                        marginLeft: "auto",
                        fontSize: 11,
                        fontFamily: "var(--mono)",
                        color: "var(--text-muted)",
                        background: "var(--bg-subtle)",
                        padding: "2px 8px",
                        borderRadius: "var(--radius-sm)",
                      }}
                    >
                      {p.affecte}
                    </span>
                  )}
                </div>
                {p.dossier_declencheur && (
                  <div
                    style={{
                      fontSize: 11,
                      color: "var(--text-muted)",
                      marginBottom: 6,
                    }}
                  >
                    Déclencheur :{" "}
                    <span style={{ fontFamily: "var(--mono)" }}>
                      {p.dossier_declencheur}
                    </span>
                  </div>
                )}
                {p.raison && (
                  <p
                    style={{
                      fontSize: 13,
                      fontStyle: "italic",
                      color: "var(--text-muted)",
                      margin: "0 0 10px 0",
                      lineHeight: 1.5,
                    }}
                  >
                    « {p.raison} »
                  </p>
                )}
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={() => setOpenPreview(p)}
                    className="ghost"
                    style={{
                      fontSize: 12,
                      padding: "5px 10px",
                      cursor: "pointer",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    <Icon name="git-merge" size={12} /> Voir le diff
                  </button>
                  {canDecide && (
                    <span
                      style={{
                        fontSize: 11,
                        color: "var(--text-faint)",
                        alignSelf: "center",
                      }}
                    >
                      Promouvoir / Rejeter dans le diff
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </main>

      {openPreview && (
        <PreviewModal
          proposition={openPreview}
          isAdmin={profile.isAdmin === true}
          adminName={profile.currentUser ?? ""}
          onClose={() => setOpenPreview(null)}
          onDecided={() => {
            setOpenPreview(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function PreviewModal({
  proposition,
  isAdmin,
  adminName,
  onClose,
  onDecided,
}: {
  proposition: PropositionEntry;
  isAdmin: boolean;
  adminName: string;
  onClose: () => void;
  onDecided: () => void;
}) {
  const [data, setData] = useState<PropositionPreviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState<"promouvoir" | "rejeter" | "revert" | null>(null);

  useEffect(() => {
    setLoading(true);
    previewProposition(proposition.filename)
      .then((d) => setData(d))
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [proposition.filename]);

  async function decide(decision: "promouvoir" | "rejeter") {
    if (!isAdmin) return;
    if (decision === "rejeter" && !comment.trim()) {
      setError("Un commentaire est obligatoire pour rejeter (au moins la raison).");
      return;
    }
    setBusy(decision);
    setError(null);
    try {
      await decidePropositions(
        proposition.filename,
        decision,
        adminName || "admin",
        comment.trim() || undefined
      );
      onDecided();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function revert() {
    if (!isAdmin) return;
    if (!confirm("Annuler la promotion de cette règle ? Le skill global sera restauré tel qu'il était avant la promotion.")) return;
    setBusy("revert");
    setError(null);
    try {
      await revertPromotion(
        proposition.filename,
        adminName || "admin",
        comment.trim() || undefined
      );
      onDecided();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const canDecide = isAdmin && proposition.statut === "en_attente";
  const canRevert = isAdmin && proposition.statut === "promu";

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "color-mix(in srgb, var(--text-strong) 40%, transparent)",
        backdropFilter: "blur(2px)",
        zIndex: 60,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        pointerEvents: "auto",
      }}
    >
      <div
        style={{
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          boxShadow: "var(--shadow-lg)",
          width: "min(1100px, 100%)",
          maxHeight: "90vh",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          position: "relative",
          zIndex: 1,
        }}
      >
        <header
          style={{
            padding: "12px 18px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <Icon name="git-merge" size={16} />
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: "var(--text-strong)",
            }}
          >
            Diff de la proposition
          </div>
          <span
            style={{
              fontSize: 11,
              color: "var(--text-muted)",
              fontFamily: "var(--mono)",
            }}
          >
            {proposition.filename}
          </span>
          <button
            onClick={onClose}
            className="ghost"
            aria-label="Fermer"
            style={{ marginLeft: "auto", padding: "4px 8px" }}
          >
            <Icon name="close" size={14} />
          </button>
        </header>

        <div style={{ padding: "12px 18px", overflowY: "auto", flex: 1 }}>
          {loading && (
            <div style={{ color: "var(--text-muted)", fontSize: 13, padding: 16 }}>
              Calcul du diff…
            </div>
          )}

          {error && !loading && (
            <div
              style={{
                background: "var(--red-bg)",
                border: "1px solid var(--red-border)",
                color: "var(--red)",
                padding: "10px 12px",
                borderRadius: "var(--radius-sm)",
                fontSize: 12,
                marginBottom: 12,
              }}
            >
              {error}
            </div>
          )}

          {data && (
            <>
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 14,
                  marginBottom: 10,
                  fontSize: 12,
                  color: "var(--text-muted)",
                  flexWrap: "wrap",
                }}
              >
                <span>
                  Auteur : <strong>{data.proposition.auteur ?? "?"}</strong>
                </span>
                {data.proposition.dossier_declencheur && (
                  <span>
                    Dossier déclencheur :{" "}
                    <span style={{ fontFamily: "var(--mono)" }}>
                      {data.proposition.dossier_declencheur}
                    </span>
                  </span>
                )}
                {data.proposition.affecte && (
                  <span>
                    Critère :{" "}
                    <span style={{ fontFamily: "var(--mono)" }}>
                      {data.proposition.affecte}
                    </span>
                  </span>
                )}
                <span style={{ marginLeft: "auto" }}>
                  Cible :{" "}
                  <span
                    style={{
                      fontFamily: "var(--mono)",
                      color: "var(--text)",
                    }}
                  >
                    _global/{data.targetFile}
                  </span>
                </span>
              </div>

              {data.insertedAt.section && (
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--text-muted)",
                    marginBottom: 8,
                    padding: "6px 10px",
                    background: "var(--bg-subtle)",
                    borderRadius: "var(--radius-sm)",
                  }}
                >
                  Insertion dans la section :{" "}
                  <strong style={{ color: "var(--text-strong)" }}>
                    {data.insertedAt.section}
                  </strong>
                </div>
              )}

              {data.proposition.raison && (
                <div
                  style={{
                    fontSize: 13,
                    fontStyle: "italic",
                    color: "var(--text-muted)",
                    padding: "8px 12px",
                    background: "var(--accent-tint)",
                    border: "1px solid color-mix(in srgb, var(--accent) 25%, transparent)",
                    borderRadius: "var(--radius-sm)",
                    marginBottom: 12,
                    lineHeight: 1.5,
                  }}
                >
                  « {data.proposition.raison} »
                </div>
              )}

              <DiffViewer before={data.before} after={data.after} />
            </>
          )}
        </div>

        {canDecide && (
          <footer
            style={{
              padding: "14px 18px",
              borderTop: "1px solid var(--border)",
              display: "flex",
              flexDirection: "column",
              gap: 10,
              background: "var(--bg-subtle)",
              flexShrink: 0,
              position: "relative",
              zIndex: 2,
            }}
          >
            <label
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                Commentaire admin (optionnel pour promouvoir, requis pour rejeter)
              </span>
              <input
                type="text"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="Ex. « Cohérent avec ELG-2, j'accepte »"
                style={{ fontSize: 13, padding: "6px 10px" }}
              />
            </label>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={onClose}
                className="ghost"
                style={{ fontSize: 12, padding: "6px 12px", cursor: "pointer" }}
              >
                Annuler
              </button>
              <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                <button
                  onClick={() => decide("rejeter")}
                  disabled={busy !== null}
                  style={{
                    fontSize: 12,
                    padding: "6px 14px",
                    cursor: busy ? "not-allowed" : "pointer",
                    background: "var(--red-bg)",
                    color: "var(--red)",
                    border: "1px solid var(--red-border)",
                    borderRadius: "var(--radius-sm)",
                    fontWeight: 500,
                  }}
                >
                  {busy === "rejeter" ? "..." : "Rejeter"}
                </button>
                <button
                  onClick={() => decide("promouvoir")}
                  disabled={busy !== null}
                  className="primary"
                  style={{
                    fontSize: 12,
                    padding: "6px 16px",
                    cursor: busy ? "not-allowed" : "pointer",
                    fontWeight: 500,
                  }}
                >
                  {busy === "promouvoir" ? "..." : "✓ Promouvoir"}
                </button>
              </div>
            </div>
          </footer>
        )}

        {canRevert && (
          <footer
            style={{
              padding: "14px 18px",
              borderTop: "1px solid var(--border)",
              display: "flex",
              flexDirection: "column",
              gap: 10,
              background: "var(--amber-bg)",
              flexShrink: 0,
              position: "relative",
              zIndex: 2,
            }}
          >
            <div style={{ fontSize: 12, color: "var(--text)", lineHeight: 1.5 }}>
              Cette règle a été promue. Si elle s&apos;avère non pertinente,
              vous pouvez <strong>annuler la promotion</strong> : le skill
              global sera restauré tel qu&apos;il était avant, et la
              proposition repassera en statut « rejetée ».
            </div>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                Raison de l&apos;annulation (optionnel)
              </span>
              <input
                type="text"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="Ex. « règle trop stricte, a fait basculer 12 dossiers »"
                style={{ fontSize: 13, padding: "6px 10px" }}
              />
            </label>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={onClose}
                className="ghost"
                style={{ fontSize: 12, padding: "6px 12px", cursor: "pointer" }}
              >
                Fermer
              </button>
              <button
                onClick={revert}
                disabled={busy !== null}
                style={{
                  marginLeft: "auto",
                  fontSize: 12,
                  padding: "6px 14px",
                  cursor: busy ? "not-allowed" : "pointer",
                  background: "var(--red-bg)",
                  color: "var(--red)",
                  border: "1px solid var(--red-border)",
                  borderRadius: "var(--radius-sm)",
                  fontWeight: 500,
                }}
              >
                {busy === "revert" ? "Annulation..." : "↶ Annuler la promotion"}
              </button>
            </div>
          </footer>
        )}

        {!canDecide && !canRevert && proposition.statut !== "en_attente" && (
          <footer
            style={{
              padding: "12px 18px",
              borderTop: "1px solid var(--border)",
              fontSize: 12,
              color: "var(--text-muted)",
              background: "var(--bg-subtle)",
            }}
          >
            Cette proposition a déjà été{" "}
            <strong>{proposition.statut === "promu" ? "promue" : "rejetée"}</strong>.
            Lecture seule.
          </footer>
        )}

        {!canDecide && proposition.statut === "en_attente" && !isAdmin && (
          <footer
            style={{
              padding: "12px 18px",
              borderTop: "1px solid var(--border)",
              fontSize: 12,
              color: "var(--text-muted)",
              background: "var(--bg-subtle)",
            }}
          >
            Seul l&apos;admin peut promouvoir ou rejeter une proposition.
          </footer>
        )}
      </div>
    </div>
  );
}
