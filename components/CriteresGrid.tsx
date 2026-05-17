"use client";
import { useState, useCallback } from "react";
import type { Evaluation } from "@/lib/types";
import { QUESTIONS_HORS_IA as DEFAULT_HORS_IA } from "@/lib/types";
import { VeriteBadge } from "./VeriteBadge";
import {
  overrideQuestion,
  removeOverrideQuestion,
  overrideEligibilite,
  removeOverrideEligibilite,
} from "@/lib/client";
import { Icon } from "@/components/Icon";
import { SourceLink } from "@/components/SourceLink";

const STATUT_COLORS: Record<string, { color: string; bg: string; border: string }> = {
  OUI: { color: "var(--green)", bg: "var(--green-bg)", border: "var(--green-border)" },
  NON: { color: "var(--red)", bg: "var(--red-bg)", border: "var(--red-border)" },
  NON_TROUVE: { color: "var(--text-muted)", bg: "var(--bg-subtle)", border: "var(--border)" },
  AMBIGU: { color: "var(--amber)", bg: "var(--amber-bg)", border: "var(--amber-border)" },
  SANS_OBJET: { color: "var(--text-soft)", bg: "var(--bg-subtle)", border: "var(--border-soft)" },
  EVALUE: { color: "var(--green)", bg: "var(--green-bg)", border: "var(--green-border)" },
  VERIFICATION_EXTERNE: { color: "var(--blue)", bg: "var(--blue-bg)", border: "var(--blue-border)" },
  HORS_IA: { color: "var(--amber)", bg: "var(--amber-bg)", border: "var(--amber-border)" },
};

const STATUT_EMOJI: Record<string, string> = {
  OUI: "✓",
  NON: "✗",
  NON_TROUVE: "?",
  AMBIGU: "⚠",
  SANS_OBJET: "—",
  EVALUE: "✓",
  VERIFICATION_EXTERNE: "🔎",
  HORS_IA: "👤",
};

function normMotif(m: unknown): string {
  if (typeof m === "string") return m;
  if (m && typeof m === "object") {
    const obj = m as Record<string, unknown>;
    return String(obj.id ?? obj.motif ?? obj.code ?? JSON.stringify(m));
  }
  return String(m);
}

/**
 * Libellés officiels des motifs de rejet REJ-1 à REJ-15 (cf. cadre FAE 7e §4
 * + skill evaluer-eligibilite). Permet d'afficher "REJ-7 : Durée hors 24-36 mois"
 * au lieu du code seul, et de proposer un tooltip.
 */
const MOTIFS_LABELS: Record<string, string> = {
  "REJ-1": "Porteur non-OSC (personne physique, entreprise, université, religieux, partisan)",
  "REJ-2": "OSC enregistrée < 2 ans au 26/02/2026",
  "REJ-3": "Organisation hors 53 États OIF",
  "REJ-4": "Projet de micro-crédit / dotation / fonds remboursables",
  "REJ-5": "Projet de prosélytisme / propagande politique",
  "REJ-6": "Projet déjà commencé ou continuité d'un projet en cours",
  "REJ-7": "Durée totale hors 24-36 mois",
  "REJ-8": "Montant hors 15k-100k € OU subvention > 80 % du budget total",
  "REJ-9": "Mise en œuvre hors espace OIF",
  "REJ-10": "Candidature transmise par courriel (vérification humaine)",
  "REJ-11": "Candidature soumise dans une langue autre que le français",
  "REJ-12": "Plus de 2 projets soumis par la même organisation",
  "REJ-13": "Récépissé manquant ou simple attestation de demande",
  "REJ-14": "Soumission après le 26/04/2026 23h59 Paris",
  "REJ-15": "Usage déraisonné/substitutif d'IA (vérification humaine)",
};

function motifLabel(code: string): string {
  return MOTIFS_LABELS[code] ?? "";
}

type EligibiliteStatut = "OUI" | "NON" | "NON_TROUVE" | "AMBIGU" | "SANS_OBJET";
const STATUTS_ELIGIBILITE: EligibiliteStatut[] = ["OUI", "NON", "NON_TROUVE", "AMBIGU", "SANS_OBJET"];

function computeEffectiveVerdict(
  criteres: { id: string; statut: string }[],
  overrides: { critere_id: string; statut_human: string }[]
): "ELIGIBLE" | "INELIGIBLE" | "ELIGIBILITE_INCERTAINE" {
  const effectiveStatuts = criteres.map((c) => {
    const ov = overrides.find((o) => o.critere_id === c.id);
    return ov ? ov.statut_human : c.statut;
  });
  if (effectiveStatuts.some((s) => s === "NON")) return "INELIGIBLE";
  if (effectiveStatuts.some((s) => s === "NON_TROUVE" || s === "AMBIGU")) return "ELIGIBILITE_INCERTAINE";
  return "ELIGIBLE";
}

interface CritereRowProps {
  evaluationId: string;
  critere: import("@/lib/types").CritereEligibilite;
  override?: { critere_id: string; statut_ia: string | null; statut_human: string; raison: string; par: string; le: string };
  onChange?: (next: Evaluation) => void;
  onPickSource?: (file: string, hint?: { page?: number; sheet?: string; cell?: string; search?: string; quote?: string }) => void;
}

function CritereRow({ evaluationId, critere, override, onChange, onPickSource }: CritereRowProps) {
  const [editing, setEditing] = useState(false);
  const [statutInput, setStatutInput] = useState<EligibiliteStatut>(
    (override?.statut_human as EligibiliteStatut) ?? critere.statut as EligibiliteStatut
  );
  const [raisonInput, setRaisonInput] = useState(override?.raison ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveStatut = override?.statut_human ?? critere.statut;
  const meta = STATUT_COLORS[effectiveStatut] ?? STATUT_COLORS.NON_TROUVE;
  const overridden = Boolean(override);

  async function save() {
    if (raisonInput.trim().length < 3) {
      setError("Raison obligatoire (au moins 3 caractères).");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await overrideEligibilite(evaluationId, critere.id, statutInput, raisonInput.trim());
      onChange?.(next);
      setEditing(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function doRemoveOverride() {
    if (!confirm(`Annuler la modification de ${critere.id} ? Le statut IA d'origine reprendra.`)) return;
    setBusy(true);
    try {
      const next = await removeOverrideEligibilite(evaluationId, critere.id);
      onChange?.(next);
      setEditing(false);
      setRaisonInput("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <div style={{ padding: "10px 12px", borderRadius: "var(--radius)", border: "1px solid var(--accent)", background: "var(--accent-tint)", fontSize: 12.5 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: 11, fontWeight: 600, color: "var(--accent-strong)" }}>{critere.id}</span>
          <span style={{ flex: 1, color: "var(--text-strong)", fontSize: 13 }}>{critere.intitule}</span>
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>IA : {critere.statut}</span>
        </div>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 8 }}>
          {STATUTS_ELIGIBILITE.map((s) => {
            const sm = STATUT_COLORS[s] ?? STATUT_COLORS.NON_TROUVE;
            return (
              <button
                key={s}
                onClick={() => setStatutInput(s)}
                style={{
                  padding: "4px 10px", fontSize: 12, borderRadius: "var(--radius-sm)", cursor: "pointer", fontWeight: statutInput === s ? 600 : 400,
                  background: statutInput === s ? sm.bg : "var(--bg-panel)",
                  color: statutInput === s ? sm.color : "var(--text-muted)",
                  border: statutInput === s ? `1px solid ${sm.border}` : "1px solid var(--border)",
                }}
              >
                {STATUT_EMOJI[s]} {s}
              </button>
            );
          })}
        </div>
        <input
          type="text"
          value={raisonInput}
          onChange={(e) => setRaisonInput(e.target.value)}
          placeholder="Raison du désaccord (ex: le récépissé est bien présent p.2…)"
          style={{ width: "100%", fontSize: 12, padding: "5px 8px", marginBottom: 6, boxSizing: "border-box" }}
        />
        {error && <div style={{ fontSize: 11, color: "var(--red)", marginBottom: 6 }}>{error}</div>}
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={() => setEditing(false)} disabled={busy} className="ghost" style={{ fontSize: 11, padding: "4px 10px", cursor: "pointer" }}>Annuler</button>
          {overridden && (
            <button onClick={doRemoveOverride} disabled={busy} className="ghost" style={{ fontSize: 11, padding: "4px 10px", cursor: "pointer", color: "var(--red)" }}>
              Rétablir IA
            </button>
          )}
          <button onClick={save} disabled={busy} className="primary" style={{ fontSize: 11, padding: "4px 10px", cursor: "pointer", marginLeft: "auto" }}>
            {busy ? "…" : "Confirmer"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{ padding: "10px 12px", borderRadius: "var(--radius)", border: `1px solid ${overridden ? "var(--accent)" : "var(--border-soft)"}`, background: overridden ? "var(--accent-tint)" : "var(--bg-panel)", boxShadow: "var(--shadow-xs)" }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 11, fontWeight: 600, padding: "2px 7px", borderRadius: "var(--radius-sm)", background: meta.bg, color: meta.color, border: `1px solid ${meta.border}` }}>
          {STATUT_EMOJI[effectiveStatut]} {critere.id}
        </span>
        <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text-strong)", flex: 1 }}>{critere.intitule}</span>
        {overridden && (
          <span style={{ fontSize: 10, fontFamily: "var(--mono)", color: "var(--accent)", padding: "1px 5px", border: "1px solid var(--accent)", borderRadius: "var(--radius-sm)" }}>
            modifié
          </span>
        )}
        <button
          onClick={() => { setStatutInput((override?.statut_human as EligibiliteStatut) ?? critere.statut as EligibiliteStatut); setRaisonInput(override?.raison ?? ""); setError(null); setEditing(true); }}
          title="Modifier ce critère"
          style={{ background: "transparent", border: "none", cursor: "pointer", padding: "2px 4px", color: "var(--text-faint)", lineHeight: 1 }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text)")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-faint)")}
        >
          <Icon name="pencil" size={13} />
        </button>
      </div>
      <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4, fontFamily: "var(--mono)" }}>
        <SourceLink source={critere.source} onPick={onPickSource} />
      </div>
      {overridden && (
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 3, fontStyle: "italic" }}>
          IA : {critere.statut} — {override!.raison} <span style={{ color: "var(--text-faint)" }}>({override!.par})</span>
        </div>
      )}
      <div style={{ fontSize: 13, marginTop: 6, color: "var(--text)", lineHeight: 1.5 }}>{critere.justification}</div>
      {critere.verification_externe_requise && (
        <div style={{ fontSize: 11, color: "var(--blue)", marginTop: 6, padding: "3px 8px", background: "var(--blue-bg)", borderRadius: "var(--radius-sm)", display: "inline-block" }}>
          🔎 {critere.verification_externe_requise}
        </div>
      )}
    </div>
  );
}

function buildMarkdown(evaluation: Evaluation): string {
  const elg = evaluation.phase_eligibilite;
  const not = evaluation.phase_notation;
  const lines: string[] = [];

  lines.push(`# Évaluation - ${evaluation.dossier_id}`);
  lines.push("");
  lines.push(`**Verdict** : ${elg.verdict.replace(/_/g, " ")}`);
  if (not) lines.push(`**Score IA** : ${not.score_total_ia}/${not.score_max_ia}`);
  if (elg.motifs_rejet_declenches?.length) {
    const formatted = elg.motifs_rejet_declenches.map(normMotif).map((code) => {
      const label = motifLabel(code);
      return label ? `${code} (${label})` : code;
    });
    lines.push(`**Motifs rejet** : ${formatted.join(", ")}`);
  }
  lines.push("");

  lines.push("## Éligibilité");
  lines.push("");
  for (const c of elg.criteres) {
    const statut = c.statut.replace(/_/g, " ");
    lines.push(`### ${c.id} - ${c.intitule}`);
    lines.push(`**Statut** : ${statut}`);
    if (c.justification) lines.push(`**Justification** : ${c.justification}`);
    lines.push("");
  }

  if (not) {
    lines.push("## Notation");
    lines.push("");
    for (const q of not.questions) {
      const override = evaluation.review?.overrides_ia?.find((o) => o.question_id === q.id);
      const finalScore = override?.score_human ?? q.score;
      const scoreStr = finalScore != null ? `${finalScore}/${q.bareme_max}` : `?/${q.bareme_max}`;
      lines.push(`- **Q${q.id}** ${q.intitule} : **${scoreStr}**${override ? ` *(modifié : ${override.raison})*` : ""}`);
    }
    lines.push("");
  }

  if (evaluation.synthese) {
    const s = evaluation.synthese;
    if (s.points_forts?.length) {
      lines.push("## Points forts");
      s.points_forts.forEach((p) => lines.push(`- ${p}`));
      lines.push("");
    }
    if (s.points_vigilance?.length) {
      lines.push("## Points de vigilance");
      s.points_vigilance.forEach((p) => lines.push(`- ${p}`));
      lines.push("");
    }
    if (s.verifications_externes?.length) {
      lines.push("## Vérifications externes");
      s.verifications_externes.forEach((p) => lines.push(`- ${p}`));
      lines.push("");
    }
  }

  return lines.join("\n");
}

const sectionLabelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: "var(--text-muted)",
  marginBottom: 10,
};

export function CriteresGrid({
  evaluation,
  horsIa,
  onChange,
  onPickSource,
  onLancerNotation,
}: {
  evaluation: Evaluation | null;
  horsIa?: number[];
  /** Appelé après un override réussi pour mettre à jour l'évaluation côté parent. */
  onChange?: (next: Evaluation) => void;
  /** Appelé quand l'utilisateur clique sur une source (file PDF/xlsx, optionnel page) */
  onPickSource?: (
    file: string,
    hint?: { page?: number; sheet?: string; cell?: string; search?: string; quote?: string }
  ) => void;
  /** Si fourni, affiche le bouton "Lancer les notations" à côté du header Éligibilité */
  onLancerNotation?: () => void;
}) {
  const QUESTIONS_HORS_IA = horsIa ?? DEFAULT_HORS_IA;
  const [copied, setCopied] = useState(false);
  const [notationFilter, setNotationFilter] = useState<"all" | "ia" | "human">("all");
  const copyMarkdown = useCallback(async () => {
    if (!evaluation) return;
    try {
      await navigator.clipboard.writeText(buildMarkdown(evaluation));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* pas bloquant */ }
  }, [evaluation]);

  if (!evaluation) {
    return (
      <div
        style={{
          padding: 24,
          fontSize: 13,
          color: "var(--text-muted)",
        }}
      >
        Aucune évaluation chargée. Lancez l&apos;évaluation depuis la liste à gauche.
      </div>
    );
  }
  const elg = evaluation.phase_eligibilite;
  const not = evaluation.phase_notation;
  const overridesElg = evaluation.review?.overrides_eligibilite ?? [];
  const effectiveVerdict = computeEffectiveVerdict(elg.criteres, overridesElg);
  const verdictChanged = effectiveVerdict !== elg.verdict;
  const showNotationBtn = onLancerNotation && !not &&
    effectiveVerdict === "ELIGIBLE";

  return (
    <div
      style={{
        padding: 18,
        overflowY: "auto",
        height: "100%",
        background: "var(--bg)",
      }}
    >
      <header style={{ marginBottom: 18, position: "relative" }}>
        <button
          onClick={copyMarkdown}
          title="Copier la grille en Markdown"
          aria-label="Copier la grille en Markdown"
          style={{
            position: "absolute",
            top: 0,
            right: 0,
            background: "transparent",
            border: "1px solid var(--border-soft)",
            borderRadius: "var(--radius-sm)",
            padding: "3px 8px",
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            fontSize: 11,
            color: copied ? "var(--green)" : "var(--text-muted)",
            transition: "color 150ms ease, border-color 150ms ease",
          }}
          onMouseEnter={(e) => {
            if (!copied) {
              e.currentTarget.style.color = "var(--text)";
              e.currentTarget.style.borderColor = "var(--border)";
            }
          }}
          onMouseLeave={(e) => {
            if (!copied) {
              e.currentTarget.style.color = "var(--text-muted)";
              e.currentTarget.style.borderColor = "var(--border-soft)";
            }
          }}
        >
          <Icon name={copied ? "check" : "copy"} size={11} />
          {copied ? "Copié" : "Copier"}
        </button>
        <h2
          style={{
            fontFamily: "var(--serif)",
            fontWeight: 600,
            fontSize: 22,
            letterSpacing: "-0.01em",
            color: "var(--text-strong)",
            marginBottom: 6,
          }}
        >
          {evaluation.dossier_id}
        </h2>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontSize: 12.5,
            color: "var(--text-muted)",
            flexWrap: "wrap",
          }}
        >
          <Badge verdict={effectiveVerdict} />
          {verdictChanged && (
            <span style={{ fontSize: 11, color: "var(--text-faint)", fontFamily: "var(--mono)" }}>
              (IA : {elg.verdict})
            </span>
          )}
          {not && (
            <span style={{ fontFamily: "var(--mono)" }}>
              Score IA · {not.score_total_ia}/{not.score_max_ia}
            </span>
          )}
        </div>
        {elg.motifs_rejet_declenches && elg.motifs_rejet_declenches.length > 0 && overridesElg.length === 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
            <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--red)", fontWeight: 600 }}>
              Motifs de rejet déclenchés
            </span>
            {elg.motifs_rejet_declenches.map(normMotif).map((code) => {
              const label = motifLabel(code);
              return (
                <div
                  key={code}
                  style={{
                    fontSize: 12,
                    padding: "5px 9px",
                    background: "var(--red-bg)",
                    border: "1px solid var(--red-border)",
                    borderRadius: "var(--radius-sm)",
                    color: "var(--text)",
                    display: "flex",
                    gap: 8,
                    alignItems: "baseline",
                  }}
                  title={label || code}
                >
                  <strong style={{ fontFamily: "var(--mono)", color: "var(--red)", flexShrink: 0 }}>{code}</strong>
                  <span style={{ color: "var(--text)" }}>{label || "(libellé inconnu)"}</span>
                </div>
              );
            })}
          </div>
        )}
        <VeriteBadge dossierId={evaluation.dossier_id} scoreIA={not?.score_total_ia} />
      </header>

      {not && (
        <NoteFinaleBandeau evaluation={evaluation} horsIaIds={QUESTIONS_HORS_IA} />
      )}

      <section style={{ marginBottom: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          <h3 style={{ ...sectionLabelStyle, marginBottom: 0 }}>Éligibilité — 14 critères</h3>
          {showNotationBtn && (
            <button
              onClick={onLancerNotation}
              className="primary"
              style={{ fontSize: 12, padding: "4px 10px", cursor: "pointer", whiteSpace: "nowrap" }}
              title="Lancer la notation (phase 2) pour ce dossier éligible"
            >
              Lancer les notations
            </button>
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {elg.criteres.map((c) => {
            const override = overridesElg.find((o) => o.critere_id === c.id);
            return (
              <CritereRow
                key={c.id}
                evaluationId={evaluation.dossier_id}
                critere={c}
                override={override}
                onChange={onChange}
                onPickSource={onPickSource}
              />
            );
          })}
        </div>
      </section>

      {not && (
        <section style={{ marginBottom: 24 }}>
          <h3 style={sectionLabelStyle}>
            Notation — {not.questions.length} questions
          </h3>
          <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
            {(["all", "ia", "human"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setNotationFilter(f)}
                style={{
                  padding: "3px 10px",
                  fontSize: 11,
                  borderRadius: "var(--radius-sm)",
                  border: `1px solid ${notationFilter === f ? "var(--accent)" : "var(--border-soft)"}`,
                  background: notationFilter === f ? "var(--accent-tint)" : "var(--bg-panel)",
                  color: notationFilter === f ? "var(--accent-strong)" : "var(--text-muted)",
                  cursor: "pointer",
                  fontWeight: notationFilter === f ? 600 : 400,
                }}
              >
                {f === "all" ? "Tout" : f === "ia" ? "🤖 IA" : "👤 Humain"}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {not.questions
              .filter((q) => {
                const isHorsIa = QUESTIONS_HORS_IA.includes(q.id);
                if (notationFilter === "ia") return !isHorsIa;
                if (notationFilter === "human") return isHorsIa;
                return true;
              })
              .map((q) => {
                const isHorsIa = QUESTIONS_HORS_IA.includes(q.id);
                const override = evaluation.review?.overrides_ia?.find(
                  (o) => o.question_id === q.id
                );
                return (
                  <QuestionRow
                    key={q.id}
                    evaluationId={evaluation.dossier_id}
                    questionId={q.id}
                    intitule={q.intitule}
                    statut={q.statut}
                    scoreIa={q.score}
                    baremeMax={q.bareme_max}
                    isHorsIa={isHorsIa}
                    source={q.source}
                    justification={q.justification}
                    override={override}
                    onChange={onChange}
                    onPickSource={onPickSource}
                    alreadyReviewed={
                      evaluation.review?.questions_hors_ia?.some(
                        (x) => x.question_id === q.id
                      ) ?? false
                    }
                  />
                );
              })}
          </div>
        </section>
      )}

    </div>
  );
}

function Badge({ verdict }: { verdict: string }) {
  const styles: Record<string, React.CSSProperties> = {
    ELIGIBLE: {
      background: "var(--green-bg)",
      color: "var(--green)",
      border: "1px solid var(--green-border)",
    },
    INELIGIBLE: {
      background: "var(--red-bg)",
      color: "var(--red)",
      border: "1px solid var(--red-border)",
    },
    ELIGIBILITE_INCERTAINE: {
      background: "var(--amber-bg)",
      color: "var(--amber)",
      border: "1px solid var(--amber-border)",
    },
  };
  const label = verdict.replace(/_/g, " ");
  return (
    <span
      style={{
        ...(styles[verdict] || {}),
        display: "inline-block",
        padding: "3px 10px",
        borderRadius: "var(--radius-pill)",
        fontSize: 11,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
      }}
    >
      {label}
    </span>
  );
}

/**
 * Calcule l'état global de la notation : score total actuel, score max
 * possible, et complétion (toutes les Q ont un score).
 */
function computeScoreFinal(evaluation: Evaluation, horsIaIds: number[]): {
  scoreTotal: number;
  scoreMaxTotal: number;
  questionsCount: number;
  completedCount: number;
  iaOverrideCount: number;
  horsIaCompletedCount: number;
  horsIaTotal: number;
  isComplete: boolean;
} {
  const not = evaluation.phase_notation;
  const overrides = evaluation.review?.overrides_ia ?? [];
  const overrideById = new Map(overrides.map((o) => [o.question_id, o]));
  let scoreTotal = 0;
  let scoreMaxTotal = 0;
  let completedCount = 0;
  let horsIaCompletedCount = 0;
  let iaOverrideCount = 0;
  let horsIaTotal = 0;
  if (!not) return { scoreTotal: 0, scoreMaxTotal: 0, questionsCount: 0, completedCount: 0, iaOverrideCount: 0, horsIaCompletedCount: 0, horsIaTotal: 0, isComplete: false };
  for (const q of not.questions) {
    scoreMaxTotal += q.bareme_max;
    const ov = overrideById.get(q.id);
    const isHorsIa = horsIaIds.includes(q.id);
    if (isHorsIa) horsIaTotal++;
    if (ov) {
      scoreTotal += ov.score_human;
      completedCount++;
      if (isHorsIa) horsIaCompletedCount++;
      else iaOverrideCount++;
    } else if (q.score !== null) {
      scoreTotal += q.score;
      completedCount++;
    }
  }
  return {
    scoreTotal,
    scoreMaxTotal,
    questionsCount: not.questions.length,
    completedCount,
    iaOverrideCount,
    horsIaCompletedCount,
    horsIaTotal,
    isComplete: completedCount === not.questions.length,
  };
}

function NoteFinaleBandeau({
  evaluation,
  horsIaIds,
}: {
  evaluation: Evaluation;
  horsIaIds: number[];
}) {
  const s = computeScoreFinal(evaluation, horsIaIds);
  if (s.questionsCount === 0) return null;
  const pct = s.scoreMaxTotal > 0 ? (s.scoreTotal / s.scoreMaxTotal) * 100 : 0;
  const ringColor = s.isComplete ? "var(--green)" : "var(--amber)";
  const ringBg = s.isComplete ? "var(--green-bg)" : "var(--amber-bg)";
  const ringBorder = s.isComplete ? "var(--green-border)" : "var(--amber-border)";
  return (
    <div
      style={{
        marginBottom: 16,
        padding: "12px 16px",
        background: ringBg,
        border: `1.5px solid ${ringBorder}`,
        borderRadius: "var(--radius)",
        display: "flex",
        alignItems: "center",
        gap: 16,
        boxShadow: "var(--shadow-xs)",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-muted)", fontWeight: 600 }}>
          {s.isComplete ? "✓ Évaluation terminée" : "Évaluation en cours"}
        </span>
        <span style={{ fontSize: 22, fontWeight: 700, color: ringColor, fontFamily: "var(--mono)", lineHeight: 1.1 }}>
          {s.scoreTotal.toFixed(s.scoreTotal % 1 === 0 ? 0 : 1)}<span style={{ fontSize: 14, fontWeight: 500, color: "var(--text-muted)" }}>/{s.scoreMaxTotal}</span>
          <span style={{ fontSize: 12, marginLeft: 8, color: "var(--text-muted)", fontWeight: 500 }}>
            ({pct.toFixed(1)} %)
          </span>
        </span>
      </div>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", fontSize: 11 }}>
          <Pill icon="🤖" color="var(--blue)" bg="var(--blue-bg)" label={`${s.questionsCount - s.horsIaTotal - s.iaOverrideCount} IA`} />
          {s.iaOverrideCount > 0 && (
            <Pill icon="✏️" color="var(--amber)" bg="var(--amber-bg)" label={`${s.iaOverrideCount} modifié${s.iaOverrideCount > 1 ? "es" : "e"}`} />
          )}
          <Pill
            icon="👤"
            color={s.horsIaCompletedCount === s.horsIaTotal ? "var(--green)" : "var(--amber)"}
            bg={s.horsIaCompletedCount === s.horsIaTotal ? "var(--green-bg)" : "var(--amber-bg)"}
            label={`${s.horsIaCompletedCount}/${s.horsIaTotal} humain`}
          />
        </div>
      </div>
    </div>
  );
}

function NotationSummary({
  evaluation,
  horsIaIds,
}: {
  evaluation: Evaluation;
  horsIaIds: number[];
}) {
  // Conservé pour compat éventuelle, mais le bandeau NoteFinaleBandeau remplace
  // désormais cette synthèse à l'usage. Si appelé, on rend le bandeau enrichi.
  return <NoteFinaleBandeau evaluation={evaluation} horsIaIds={horsIaIds} />;
}

function Pill({
  icon,
  color,
  bg,
  label,
}: {
  icon: string;
  color: string;
  bg: string;
  label: string;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "3px 9px",
        borderRadius: "var(--radius-pill)",
        background: bg,
        color,
        fontSize: 11,
        fontWeight: 500,
        border: `1px solid color-mix(in srgb, ${color} 30%, transparent)`,
      }}
    >
      <span aria-hidden>{icon}</span>
      {label}
    </span>
  );
}

interface QuestionRowProps {
  evaluationId: string;
  questionId: number;
  intitule: string;
  statut: string;
  scoreIa: number | null;
  baremeMax: number;
  isHorsIa: boolean;
  source?: import("@/lib/types").EvalSource;
  justification?: string;
  alreadyReviewed?: boolean;
  override?: {
    question_id: number;
    score_ia: number | null;
    score_human: number;
    raison: string;
    par: string;
    le: string;
  };
  onChange?: (next: Evaluation) => void;
  onPickSource?: (
    file: string,
    hint?: { page?: number; sheet?: string; cell?: string; search?: string; quote?: string }
  ) => void;
}

function QuestionRow({
  evaluationId,
  questionId,
  intitule,
  statut,
  scoreIa,
  baremeMax,
  isHorsIa,
  source,
  justification,
  alreadyReviewed,
  override,
  onChange,
  onPickSource,
}: QuestionRowProps) {
  const [editing, setEditing] = useState(false);
  const [scoreInput, setScoreInput] = useState<number>(
    override?.score_human ?? scoreIa ?? 0
  );
  const [raisonInput, setRaisonInput] = useState(override?.raison ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const meta = STATUT_COLORS[statut] ?? STATUT_COLORS.NON_TROUVE;
  const overridden = Boolean(override);
  const finalScore = override?.score_human ?? scoreIa;

  async function save() {
    // Pour les questions IA, exiger une raison (c'est un désaccord).
    // Pour les HORS_IA, la raison est facultative (c'est juste une saisie).
    if (!isHorsIa && raisonInput.trim().length < 3) {
      setError("Raison obligatoire (au moins 3 caractères).");
      return;
    }
    if (scoreInput < 0 || scoreInput > baremeMax) {
      setError(`Score doit être entre 0 et ${baremeMax}.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await overrideQuestion(
        evaluationId,
        questionId,
        scoreInput,
        raisonInput.trim() || (isHorsIa ? "Note humaine saisie" : "")
      );
      onChange?.(next);
      setEditing(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function removeOverride() {
    if (!confirm(`Annuler l'override de Q${questionId} ? La note IA d'origine reprendra.`)) return;
    setBusy(true);
    try {
      const next = await removeOverrideQuestion(evaluationId, questionId);
      onChange?.(next);
      setEditing(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <div
        style={{
          padding: "10px 12px",
          borderRadius: "var(--radius-sm)",
          border: "1px solid var(--accent)",
          background: "var(--accent-tint)",
          fontSize: 12.5,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginBottom: 8,
          }}
        >
          <span
            style={{
              fontFamily: "var(--mono)",
              fontSize: 11,
              fontWeight: 600,
              color: "var(--accent-strong)",
            }}
          >
            Q{questionId}
          </span>
          <span style={{ flex: 1, color: "var(--text-strong)" }}>{intitule}</span>
          {!isHorsIa && (
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
              IA : {scoreIa ?? "—"}/{baremeMax}
            </span>
          )}
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "auto 1fr",
            gap: 8,
            alignItems: "center",
            marginBottom: 6,
          }}
        >
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Note humaine :</span>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {Array.from({ length: baremeMax + 1 }, (_, i) => i).map((n) => (
              <button
                key={n}
                onClick={() => setScoreInput(n)}
                style={{
                  padding: "3px 10px",
                  fontSize: 12,
                  fontFamily: "var(--mono)",
                  borderRadius: "var(--radius-sm)",
                  background: scoreInput === n ? "var(--accent)" : "var(--bg-panel)",
                  color: scoreInput === n ? "white" : "var(--text)",
                  border: scoreInput === n
                    ? "1px solid var(--accent)"
                    : "1px solid var(--border)",
                  cursor: "pointer",
                  fontWeight: scoreInput === n ? 600 : 400,
                }}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
        <input
          type="text"
          value={raisonInput}
          onChange={(e) => setRaisonInput(e.target.value)}
          placeholder={
            isHorsIa
              ? "Commentaire (facultatif) - ex: justification de la note"
              : "Raison du désaccord (ex: la note IA était trop généreuse, le récépissé...)"
          }
          style={{
            width: "100%",
            fontSize: 12,
            padding: "5px 8px",
            marginBottom: 6,
          }}
        />
        {error && (
          <div style={{ fontSize: 11, color: "var(--red)", marginBottom: 6 }}>
            {error}
          </div>
        )}
        <div style={{ display: "flex", gap: 6 }}>
          <button
            onClick={() => setEditing(false)}
            disabled={busy}
            className="ghost"
            style={{ fontSize: 11, padding: "4px 10px", cursor: "pointer" }}
          >
            Annuler
          </button>
          {overridden && (
            <button
              onClick={removeOverride}
              disabled={busy}
              className="ghost"
              style={{
                fontSize: 11,
                padding: "4px 10px",
                cursor: "pointer",
                color: "var(--red)",
              }}
            >
              Supprimer l&apos;override
            </button>
          )}
          <button
            onClick={save}
            disabled={busy}
            className="primary"
            style={{
              marginLeft: "auto",
              fontSize: 11,
              padding: "4px 12px",
              cursor: busy ? "not-allowed" : "pointer",
            }}
          >
            {busy ? "..." : "Enregistrer"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        padding: "8px 12px",
        borderRadius: "var(--radius-sm)",
        border: `1px solid ${overridden ? "var(--accent)" : isHorsIa ? "var(--amber-border)" : "var(--border-soft)"}`,
        background: overridden
          ? "color-mix(in srgb, var(--accent) 8%, var(--bg-panel))"
          : isHorsIa
          ? "var(--amber-bg)"
          : "var(--bg-panel)",
        fontSize: 12.5,
      }}
    >
      {/* Ligne principale */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          aria-hidden
          title={overridden ? "Modifié par humain" : alreadyReviewed ? "Note humaine saisie via review" : isHorsIa ? "À compléter par humain" : "Évalué par IA"}
          style={{ fontSize: 14, width: 18, textAlign: "center", flexShrink: 0 }}
        >
          {overridden ? "✏️" : isHorsIa ? (alreadyReviewed ? "✓" : "👤") : "🤖"}
        </span>
        <span
          style={{ fontFamily: "var(--mono)", fontSize: 11, fontWeight: 600, width: 48, flexShrink: 0, color: overridden ? "var(--accent-strong)" : meta.color }}
        >
          {STATUT_EMOJI[statut]} Q{questionId}
        </span>
        <span
          style={{ flex: 1, color: "var(--text)", fontWeight: 500 }}
          title={overridden ? `${intitule} - Override : ${override?.raison}` : intitule}
        >
          {intitule}
        </span>
        <span
          style={{
            fontSize: 11,
            fontFamily: "var(--mono)",
            color: overridden ? "var(--accent-strong)" : isHorsIa ? (alreadyReviewed ? "var(--green)" : "var(--amber)") : "var(--text-muted)",
            flexShrink: 0,
          }}
        >
          {`${finalScore ?? "—"}/${baremeMax}`}
          {override && scoreIa !== null && scoreIa !== override.score_human && (
            <span style={{ fontSize: 10, color: "var(--text-faint)", marginLeft: 6, textDecoration: "line-through" }} title={`Note IA d'origine : ${scoreIa}/${baremeMax}`}>
              IA: {scoreIa}
            </span>
          )}
        </span>
        <button
          onClick={() => {
            setScoreInput(override?.score_human ?? scoreIa ?? 0);
            setRaisonInput(override?.raison ?? "");
            setError(null);
            setEditing(true);
          }}
          aria-label={overridden ? "Modifier l'override" : isHorsIa ? "Saisir la note" : "Modifier la note IA"}
          title={overridden ? "Modifier l'override" : isHorsIa ? "Saisir la note humaine" : "Modifier la note IA"}
          style={{ background: "transparent", border: "none", cursor: "pointer", padding: "2px 4px", color: "var(--text-faint)", lineHeight: 1, flexShrink: 0 }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text)")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-faint)")}
        >
          <Icon name="pencil" size={13} />
        </button>
      </div>
      {/* Source */}
      {source && (
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 3, fontFamily: "var(--mono)" }}>
          <SourceLink source={source} onPick={onPickSource} />
        </div>
      )}
      {/* Override info */}
      {overridden && (
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 3, fontStyle: "italic" }}>
          {isHorsIa
            ? <>Saisi par <span style={{ color: "var(--text-faint)" }}>{override!.par}</span>{override!.raison && override!.raison !== "Note humaine saisie" ? ` — ${override!.raison}` : ""}</>
            : <>IA : {scoreIa ?? "—"} — {override!.raison} <span style={{ color: "var(--text-faint)" }}>({override!.par})</span></>
          }
        </div>
      )}
      {/* Justification */}
      {justification && (
        <div style={{ fontSize: 12.5, marginTop: 6, color: "var(--text)", lineHeight: 1.5 }}>{justification}</div>
      )}
    </div>
  );
}
