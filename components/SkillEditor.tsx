"use client";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import {
  getCampaignDetail,
  getCampaignSkill,
  updateCampaignSkill,
} from "@/lib/client";

interface Props {
  open: boolean;
  campaignId: string;
  campaignLabel: string;
  onClose: () => void;
  onSaved: () => void;
}

interface SkillItem {
  filename: string;
  size: number;
  hash: string;
}

export function SkillEditor({
  open,
  campaignId,
  campaignLabel,
  onClose,
  onSaved,
}: Props) {
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [original, setOriginal] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [campaignStatus, setCampaignStatus] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    if (open) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setInfo(null);
    getCampaignDetail(campaignId)
      .then((d) => {
        setSkills(d.skills);
        setCampaignStatus(d.campaign?.status ?? null);
        if (d.skills.length > 0) setSelected(d.skills[0].filename);
      })
      .catch((e) => setError((e as Error).message));
  }, [open, campaignId]);

  useEffect(() => {
    if (!open || !selected) return;
    setLoading(true);
    setError(null);
    getCampaignSkill(campaignId, selected)
      .then((d) => {
        setContent(d.content);
        setOriginal(d.content);
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [open, campaignId, selected]);

  async function save() {
    if (!selected) return;
    setSaving(true);
    setError(null);
    setInfo(null);
    try {
      await updateCampaignSkill(campaignId, selected, content);
      setOriginal(content);
      setInfo("Sauvegardé");
      setTimeout(() => setInfo(null), 2000);
      onSaved();
      // Refresh hashes affichés
      const d = await getCampaignDetail(campaignId);
      setSkills(d.skills);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function selectSkill(name: string) {
    if (content !== original) {
      if (!confirm("Modifications non sauvegardées seront perdues. Continuer ?")) return;
    }
    setSelected(name);
  }

  if (!open) return null;

  const dirty = content !== original;
  const lineCount = content.split("\n").length;

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
      }}
    >
      <div
        style={{
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          boxShadow: "var(--shadow-lg)",
          width: "min(1200px, 100%)",
          height: "min(800px, 90vh)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
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
          <div style={{ fontWeight: 600, fontSize: 14, color: "var(--text-strong)" }}>
            Éditer les règles
          </div>
          <span
            style={{
              fontSize: 11,
              color: "var(--text-muted)",
              fontFamily: "var(--mono)",
            }}
          >
            {campaignLabel} · {campaignId}
          </span>
          <span
            style={{
              fontSize: 9.5,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              color:
                campaignStatus === "active"
                  ? "var(--green)"
                  : campaignStatus === "archived"
                  ? "var(--text-muted)"
                  : "var(--amber)",
              background:
                campaignStatus === "active"
                  ? "var(--green-bg)"
                  : campaignStatus === "archived"
                  ? "var(--bg-subtle)"
                  : "var(--amber-bg)",
              padding: "1px 6px",
              borderRadius: "var(--radius-sm)",
            }}
          >
            {campaignStatus ?? "…"}
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
        {campaignStatus === "active" && (
          <div
            style={{
              padding: "10px 14px",
              background: "var(--amber-bg)",
              borderBottom: "1px solid var(--border)",
              fontSize: 12,
              color: "var(--text-strong)",
              borderLeft: "3px solid var(--amber)",
            }}
          >
            <strong>Campagne active.</strong> Toute modification s&apos;applique
            immédiatement à l&apos;équipe entière. Les évaluations en cours sur
            d&apos;autres postes peuvent finir avec l&apos;ancienne version chargée
            en mémoire. Prévenir l&apos;équipe avant de sauvegarder.
          </div>
        )}

        <div style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0 }}>
          {/* Sidebar skills */}
          <div
            style={{
              width: 260,
              borderRight: "1px solid var(--border)",
              background: "var(--bg-subtle)",
              overflowY: "auto",
              flexShrink: 0,
            }}
          >
            <div
              style={{
                padding: "10px 14px",
                fontSize: 11,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                color: "var(--text-muted)",
                borderBottom: "1px solid var(--border-soft)",
              }}
            >
              Skills ({skills.length})
            </div>
            {skills.map((s) => {
              const active = s.filename === selected;
              return (
                <button
                  key={s.filename}
                  onClick={() => selectSkill(s.filename)}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    padding: "10px 14px",
                    background: active ? "var(--bg-panel)" : "transparent",
                    border: "none",
                    borderLeft: active
                      ? "3px solid var(--accent)"
                      : "3px solid transparent",
                    cursor: "pointer",
                    fontFamily: "var(--mono)",
                    fontSize: 12,
                    color: active ? "var(--text-strong)" : "var(--text)",
                    display: "block",
                  }}
                >
                  <div
                    style={{
                      fontWeight: active ? 600 : 400,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {s.filename}
                  </div>
                  <div
                    style={{
                      fontSize: 10,
                      color: "var(--text-faint)",
                      marginTop: 2,
                    }}
                  >
                    {(s.size / 1024).toFixed(1)} ko · {s.hash.slice(0, 8)}…
                  </div>
                </button>
              );
            })}
          </div>

          {/* Editor */}
          <div
            style={{
              flex: 1,
              minWidth: 0,
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div
              style={{
                padding: "8px 14px",
                background: "var(--bg-subtle)",
                borderBottom: "1px solid var(--border-soft)",
                display: "flex",
                alignItems: "center",
                gap: 12,
                fontSize: 11,
                color: "var(--text-muted)",
              }}
            >
              <span style={{ fontFamily: "var(--mono)" }}>{selected ?? "(aucun)"}</span>
              {selected && (
                <span style={{ marginLeft: "auto" }}>
                  {lineCount} lignes · {content.length} car.
                  {dirty && (
                    <span
                      style={{
                        marginLeft: 8,
                        color: "var(--amber)",
                        fontWeight: 600,
                      }}
                    >
                      ● modifications non sauvegardées
                    </span>
                  )}
                </span>
              )}
            </div>
            {loading && (
              <div style={{ padding: 16, color: "var(--text-muted)", fontSize: 13 }}>
                Chargement…
              </div>
            )}
            {!loading && selected && (
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                spellCheck={false}
                style={{
                  flex: 1,
                  border: "none",
                  outline: "none",
                  resize: "none",
                  padding: "14px 16px",
                  fontFamily: "var(--mono)",
                  fontSize: 12.5,
                  lineHeight: 1.6,
                  background: "var(--bg-panel)",
                  color: "var(--text)",
                  width: "100%",
                  minHeight: 0,
                }}
                placeholder="Le skill markdown..."
              />
            )}
            {!loading && !selected && (
              <div style={{ padding: 16, color: "var(--text-muted)", fontSize: 13 }}>
                Sélectionnez un skill à gauche.
              </div>
            )}
          </div>
        </div>

        <footer
          style={{
            padding: "10px 14px",
            borderTop: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            gap: 8,
            background: "var(--bg-subtle)",
            flexShrink: 0,
          }}
        >
          {error && (
            <span style={{ fontSize: 12, color: "var(--red)" }}>{error}</span>
          )}
          {info && (
            <span style={{ fontSize: 12, color: "var(--green)" }}>✓ {info}</span>
          )}
          <button
            onClick={onClose}
            className="ghost"
            disabled={saving}
            style={{ marginLeft: "auto", fontSize: 12, padding: "6px 12px" }}
          >
            Fermer
          </button>
          <button
            onClick={() => {
              if (
                content !== original &&
                !confirm("Annuler les modifications de ce skill ?")
              )
                return;
              setContent(original);
            }}
            className="ghost"
            disabled={saving || !dirty}
            style={{ fontSize: 12, padding: "6px 12px" }}
          >
            Annuler les modifs
          </button>
          <button
            onClick={save}
            disabled={saving || !dirty}
            className="primary"
            style={{ fontSize: 12, padding: "6px 16px" }}
          >
            {saving ? "Sauvegarde..." : "Enregistrer"}
          </button>
        </footer>
      </div>
    </div>
  );
}
