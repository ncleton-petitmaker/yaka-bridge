"use client";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import {
  createCampaign,
  type CampaignEntry,
} from "@/lib/client";

type Step = "identite" | "source" | "recap";

interface CreatedEvent {
  id: string;
  label: string;
  activated: boolean;
  openEditor: boolean;
  openChat: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (event: CreatedEvent) => void;
  campaigns: CampaignEntry[];
}

const STEP_LABELS: Record<Step, string> = {
  identite: "1. Identité",
  source: "2. Source",
  recap: "3. Récap",
};
const STEP_ORDER: Step[] = ["identite", "source", "recap"];

function slugify(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function CampaignWizard({ open, onClose, onCreated, campaigns }: Props) {
  const [step, setStep] = useState<Step>("identite");
  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  const [dateOuverture, setDateOuverture] = useState("");
  const [dateCloture, setDateCloture] = useState("");
  const [basedOn, setBasedOn] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setStep("identite");
      setId("");
      setLabel("");
      setDateOuverture("");
      setDateCloture("");
      const defaultBase = campaigns.find((c) => c.status === "active")?.id ?? "";
      setBasedOn(defaultBase);
      setError(null);
    }
  }, [open, campaigns]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    if (open) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const idCollision = campaigns.some((c) => c.id === id.trim());
  const canGoStep2 = id.trim().length > 0 && label.trim().length > 0 && !idCollision;
  const canGoStep3 = canGoStep2;

  async function submit(opts: {
    activate: boolean;
    openEditor: boolean;
    openChat: boolean;
  }) {
    setSubmitting(true);
    setError(null);
    try {
      const out = await createCampaign({
        id: id.trim(),
        label: label.trim(),
        basedOn: basedOn || null,
        dateOuverture: dateOuverture.trim() || undefined,
        dateCloture: dateCloture.trim() || undefined,
        activate: opts.activate,
      });
      onCreated({
        id: out.campaign.id,
        label: out.campaign.label,
        activated: opts.activate,
        openEditor: opts.openEditor,
        openChat: opts.openChat,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

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
          width: "min(640px, 100%)",
          maxHeight: "90vh",
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
            Nouvelle campagne
          </div>
          <button
            onClick={onClose}
            className="ghost"
            aria-label="Fermer"
            style={{ marginLeft: "auto", padding: "4px 8px" }}
          >
            <Icon name="close" size={14} />
          </button>
        </header>

        {/* Progress steps */}
        <div
          style={{
            display: "flex",
            gap: 8,
            padding: "10px 18px",
            background: "var(--bg-subtle)",
            borderBottom: "1px solid var(--border-soft)",
            fontSize: 11,
          }}
        >
          {STEP_ORDER.map((s, i) => {
            const idx = STEP_ORDER.indexOf(step);
            const active = i === idx;
            const past = i < idx;
            return (
              <div
                key={s}
                style={{
                  padding: "3px 10px",
                  borderRadius: "var(--radius-pill)",
                  background: active
                    ? "var(--accent-tint)"
                    : past
                    ? "var(--green-bg)"
                    : "transparent",
                  color: active
                    ? "var(--accent-strong)"
                    : past
                    ? "var(--green)"
                    : "var(--text-muted)",
                  fontWeight: active ? 600 : 500,
                  border: active
                    ? "1px solid color-mix(in srgb, var(--accent) 40%, transparent)"
                    : "1px solid transparent",
                }}
              >
                {past && "✓ "}
                {STEP_LABELS[s]}
              </div>
            );
          })}
        </div>

        <div style={{ flex: 1, padding: "18px 22px", overflowY: "auto" }}>
          {step === "identite" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <p style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.55 }}>
                Donnez un identifiant et un libellé à votre campagne.
                L&apos;identifiant sera utilisé dans les fichiers et URLs ; le
                libellé sera affiché à l&apos;utilisateur.
              </p>
              <Field label="Libellé affiché">
                <input
                  type="text"
                  value={label}
                  onChange={(e) => {
                    setLabel(e.target.value);
                    if (!id || id === slugify(label))
                      setId(slugify(e.target.value));
                  }}
                  placeholder="ex. FAE 8e édition"
                  style={{ width: "100%", fontSize: 13, padding: "6px 10px" }}
                />
              </Field>
              <Field label="Identifiant (slug)">
                <input
                  type="text"
                  value={id}
                  onChange={(e) => setId(slugify(e.target.value))}
                  placeholder="ex. fae-8e"
                  style={{
                    width: "100%",
                    fontSize: 13,
                    padding: "6px 10px",
                    fontFamily: "var(--mono)",
                  }}
                />
                {idCollision && (
                  <span style={{ fontSize: 11, color: "var(--red)" }}>
                    Une campagne avec cet identifiant existe déjà.
                  </span>
                )}
              </Field>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <Field label="Date d'ouverture (optionnel)">
                  <input
                    type="date"
                    value={dateOuverture}
                    onChange={(e) => setDateOuverture(e.target.value)}
                    style={{ width: "100%", fontSize: 13, padding: "6px 10px" }}
                  />
                </Field>
                <Field label="Date de clôture (optionnel)">
                  <input
                    type="date"
                    value={dateCloture}
                    onChange={(e) => setDateCloture(e.target.value)}
                    style={{ width: "100%", fontSize: 13, padding: "6px 10px" }}
                  />
                </Field>
              </div>
            </div>
          )}

          {step === "source" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <p style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.55 }}>
                Cloner une campagne existante reprend ses skills et son schéma de
                sortie. Vous pourrez les éditer ensuite (V2). Pour V1, créer
                vide est déconseillé : tous les skills d&apos;évaluation
                manqueront.
              </p>
              {campaigns.length === 0 && (
                <div
                  style={{
                    padding: "10px 12px",
                    background: "var(--amber-bg)",
                    border: "1px solid var(--amber-border)",
                    borderRadius: "var(--radius-sm)",
                    fontSize: 12,
                    color: "var(--text)",
                  }}
                >
                  Aucune campagne existante. Vous devrez créer une campagne
                  vide. Pas recommandé en V1.
                </div>
              )}
              <Field label="Cloner depuis">
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {campaigns.map((c) => {
                    const active = basedOn === c.id;
                    return (
                      <label
                        key={c.id}
                        style={{
                          display: "grid",
                          gridTemplateColumns: "auto 1fr",
                          gap: 10,
                          padding: "10px 12px",
                          background: active ? "var(--accent-tint)" : "var(--bg-subtle)",
                          border: active
                            ? "1px solid color-mix(in srgb, var(--accent) 40%, var(--border))"
                            : "1px solid var(--border-soft)",
                          borderRadius: "var(--radius-sm)",
                          cursor: "pointer",
                          alignItems: "center",
                        }}
                      >
                        <input
                          type="radio"
                          name="basedOn"
                          checked={active}
                          onChange={() => setBasedOn(c.id)}
                          style={{ accentColor: "var(--accent)" }}
                        />
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-strong)" }}>
                            {c.label}{" "}
                            <span
                              style={{
                                fontSize: 10,
                                color: "var(--text-muted)",
                                fontFamily: "var(--mono)",
                                marginLeft: 6,
                              }}
                            >
                              {c.id}
                            </span>
                            {c.status === "active" && (
                              <span
                                style={{
                                  fontSize: 9.5,
                                  fontWeight: 600,
                                  textTransform: "uppercase",
                                  letterSpacing: "0.06em",
                                  color: "var(--green)",
                                  background: "var(--green-bg)",
                                  padding: "1px 6px",
                                  borderRadius: "var(--radius-sm)",
                                  marginLeft: 8,
                                }}
                              >
                                Active
                              </span>
                            )}
                          </div>
                        </div>
                      </label>
                    );
                  })}
                  <label
                    style={{
                      display: "grid",
                      gridTemplateColumns: "auto 1fr",
                      gap: 10,
                      padding: "10px 12px",
                      background: basedOn === "" ? "var(--accent-tint)" : "var(--bg-subtle)",
                      border:
                        basedOn === ""
                          ? "1px solid color-mix(in srgb, var(--accent) 40%, var(--border))"
                          : "1px solid var(--border-soft)",
                      borderRadius: "var(--radius-sm)",
                      cursor: "pointer",
                      alignItems: "center",
                    }}
                  >
                    <input
                      type="radio"
                      name="basedOn"
                      checked={basedOn === ""}
                      onChange={() => setBasedOn("")}
                      style={{ accentColor: "var(--accent)" }}
                    />
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-strong)" }}>
                        Vide (déconseillé)
                      </div>
                      <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                        Aucun skill, aucun schéma. À utiliser uniquement pour des
                        cas avancés.
                      </div>
                    </div>
                  </label>
                </div>
              </Field>
            </div>
          )}

          {step === "recap" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <p style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.55 }}>
                Récap avant création. La campagne sera créée en statut{" "}
                <strong>brouillon</strong>. Vous pouvez l&apos;activer
                immédiatement (l&apos;ancienne active passera en archivée) ou
                la garder en brouillon pour l&apos;activer plus tard.
              </p>
              <div
                style={{
                  padding: "12px 14px",
                  background: "var(--bg-subtle)",
                  border: "1px solid var(--border-soft)",
                  borderRadius: "var(--radius-sm)",
                  fontSize: 13,
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                }}
              >
                <div>
                  <span style={{ color: "var(--text-muted)" }}>Identifiant : </span>
                  <code style={{ fontFamily: "var(--mono)" }}>{id}</code>
                </div>
                <div>
                  <span style={{ color: "var(--text-muted)" }}>Libellé : </span>
                  <strong>{label}</strong>
                </div>
                {dateOuverture && (
                  <div>
                    <span style={{ color: "var(--text-muted)" }}>Ouverture : </span>
                    {dateOuverture}
                  </div>
                )}
                {dateCloture && (
                  <div>
                    <span style={{ color: "var(--text-muted)" }}>Clôture : </span>
                    {dateCloture}
                  </div>
                )}
                <div>
                  <span style={{ color: "var(--text-muted)" }}>Cloné depuis : </span>
                  {basedOn ? (
                    <strong>{basedOn}</strong>
                  ) : (
                    <em style={{ color: "var(--amber)" }}>vide</em>
                  )}
                </div>
              </div>

              {error && (
                <div
                  style={{
                    padding: "10px 12px",
                    background: "var(--red-bg)",
                    border: "1px solid var(--red-border)",
                    borderRadius: "var(--radius-sm)",
                    fontSize: 12,
                    color: "var(--red)",
                  }}
                >
                  {error}
                </div>
              )}
            </div>
          )}
        </div>

        <footer
          style={{
            padding: "12px 18px",
            borderTop: "1px solid var(--border)",
            display: "flex",
            gap: 8,
            background: "var(--bg-subtle)",
            flexShrink: 0,
          }}
        >
          <button
            onClick={onClose}
            className="ghost"
            disabled={submitting}
            style={{ fontSize: 12, padding: "6px 12px" }}
          >
            Annuler
          </button>

          {step !== "identite" && (
            <button
              onClick={() =>
                setStep(STEP_ORDER[STEP_ORDER.indexOf(step) - 1])
              }
              className="ghost"
              disabled={submitting}
              style={{ fontSize: 12, padding: "6px 12px" }}
            >
              ← Précédent
            </button>
          )}

          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            {step === "identite" && (
              <button
                onClick={() => setStep("source")}
                disabled={!canGoStep2}
                className="primary"
                style={{ fontSize: 12, padding: "6px 16px" }}
              >
                Suivant →
              </button>
            )}
            {step === "source" && (
              <button
                onClick={() => setStep("recap")}
                disabled={!canGoStep3}
                className="primary"
                style={{ fontSize: 12, padding: "6px 16px" }}
              >
                Suivant →
              </button>
            )}
            {step === "recap" && (
              <>
                <button
                  onClick={() =>
                    submit({ activate: false, openEditor: false, openChat: false })
                  }
                  disabled={submitting}
                  className="ghost"
                  style={{ fontSize: 12, padding: "6px 12px" }}
                  title="Crée la campagne en brouillon. Vous pourrez l'éditer et l'activer plus tard depuis la liste."
                >
                  {submitting ? "..." : "Brouillon seul"}
                </button>
                <button
                  onClick={() =>
                    submit({ activate: false, openEditor: false, openChat: true })
                  }
                  disabled={submitting}
                  className="primary"
                  style={{ fontSize: 12, padding: "6px 16px" }}
                  title="Crée la campagne et ouvre le chat où vous pourrez joindre un nouveau référentiel (.docx, .md...) pour régénérer automatiquement les règles."
                >
                  {submitting ? "..." : "Créer et adapter les règles"}
                </button>
                <button
                  onClick={() =>
                    submit({ activate: false, openEditor: true, openChat: false })
                  }
                  disabled={submitting}
                  className="ghost"
                  style={{ fontSize: 12, padding: "6px 12px" }}
                  title="Crée la campagne et ouvre l'éditeur markdown brut pour modifier manuellement chaque skill."
                >
                  {submitting ? "..." : "Édition manuelle"}
                </button>
                <button
                  onClick={() => {
                    if (
                      campaigns.find((c) => c.status === "active") &&
                      !confirm(
                        `Activer ${id} ? La campagne actuellement active sera archivée.`
                      )
                    )
                      return;
                    submit({ activate: true, openEditor: false, openChat: false });
                  }}
                  disabled={submitting}
                  className="ghost"
                  style={{ fontSize: 12, padding: "6px 14px" }}
                  title="Active la campagne immédiatement avec les règles inchangées de la source. À utiliser seulement si vous ne voulez rien modifier."
                >
                  {submitting ? "..." : "Activer telle quelle"}
                </button>
              </>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span
        style={{
          fontSize: 11,
          fontWeight: 500,
          color: "var(--text-strong)",
        }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}
