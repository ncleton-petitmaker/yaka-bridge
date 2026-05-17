"use client";
import { useState } from "react";
import { startRun, streamRun } from "@/lib/client";
import type { AgentEvent } from "@/lib/types";
import { Mark } from "@/components/Mark";
import { Icon } from "@/components/Icon";

type Phase = "eligibilite" | "notation" | "general";

const ELG_LIST = Array.from({ length: 14 }, (_, i) => `ELG-${i + 1}`);
const Q_LIST = Array.from({ length: 49 }, (_, i) => `Q${i + 1}`);

export function RuleProposalForm({
  user,
  dossierId,
  onClose,
}: {
  user: string;
  dossierId: string;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("eligibilite");
  const [critere, setCritere] = useState<string>("ELG-1");
  const [constat, setConstat] = useState("");
  const [regle, setRegle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [response, setResponse] = useState<string>("");
  const [done, setDone] = useState(false);

  const choices = phase === "eligibilite" ? ELG_LIST : phase === "notation" ? Q_LIST : [];

  async function submit() {
    if (!constat.trim() || !regle.trim()) return;
    setSubmitting(true);
    setResponse("");
    setDone(false);
    const message = `Je veux signaler un problème d'évaluation et proposer une nouvelle règle.

Dossier déclencheur : ${dossierId}
Critère/question concerné : ${phase === "general" ? "(règle générale)" : critere}

Ce que tu as raté sur ce dossier :
${constat.trim()}

Règle que tu devrais appliquer à TOUS les dossiers à l'avenir :
${regle.trim()}

Active le skill 'ameliorer-mes-regles' : intègre cette règle dans mes règles persos (_perso/${user}/) ET crée une proposition partagée dans _propositions/ pour que l'admin puisse la promouvoir en règle officielle si elle est pertinente.`;

    try {
      const runId = await startRun({ message, slashCommand: "/ameliorer-regle", user });
      let buf = "";
      await streamRun(runId, {
        onEvent: (ev: AgentEvent) => {
          if (ev.kind === "text_delta") {
            buf += ev.text ?? "";
            setResponse(buf);
          }
          if (ev.kind === "result") {
            setDone(true);
          }
        },
        onEnd: () => setSubmitting(false),
        onError: (err) => {
          setResponse((b) => b + "\n\n[Erreur] " + err.message);
          setSubmitting(false);
        },
      });
    } catch (e) {
      setResponse("[Erreur] " + (e as Error).message);
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        bottom: 0,
        width: 460,
        background: "var(--bg-panel)",
        borderLeft: "1px solid var(--border)",
        boxShadow: "var(--shadow-lg)",
        zIndex: 50,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <header
        style={{
          padding: "12px 14px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        <Mark size={18} />
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-strong)" }}>
          Signaler un problème
        </div>
        <span
          style={{
            fontSize: 11,
            color: "var(--text-muted)",
            fontFamily: "var(--mono)",
            maxWidth: 180,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={dossierId}
        >
          {dossierId}
        </span>
        <button
          onClick={onClose}
          className="ghost"
          aria-label="Fermer"
          style={{
            marginLeft: "auto",
            padding: "4px 8px",
            display: "inline-flex",
            alignItems: "center",
          }}
        >
          <Icon name="close" size={14} />
        </button>
      </header>

      <div style={{ flex: 1, overflowY: "auto", padding: "14px 14px 8px 14px" }}>
        <div
          style={{
            fontSize: 12,
            color: "var(--text-muted)",
            marginBottom: 14,
            lineHeight: 1.55,
            padding: "10px 12px",
            background: "var(--accent-tint)",
            borderRadius: "var(--radius-sm)",
            border: "1px solid color-mix(in srgb, var(--accent) 25%, transparent)",
          }}
        >
          La règle que vous proposez s&apos;applique à <strong>toute la campagne</strong>{" "}
          (tous les dossiers, pas seulement celui-ci). Le dossier en cours sert juste
          de déclencheur pour expliquer le problème.
        </div>

        <Field label="Type de critère concerné">
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {(
              [
                ["eligibilite", "Éligibilité (ELG)"],
                ["notation", "Notation (Q)"],
                ["general", "Général"],
              ] as [Phase, string][]
            ).map(([k, label]) => {
              const active = phase === k;
              return (
                <button
                  key={k}
                  onClick={() => {
                    setPhase(k);
                    setCritere(k === "eligibilite" ? "ELG-1" : k === "notation" ? "Q1" : "");
                  }}
                  style={{
                    fontSize: 11.5,
                    padding: "4px 10px",
                    borderRadius: "var(--radius-pill)",
                    background: active ? "var(--accent)" : "var(--bg-subtle)",
                    color: active ? "white" : "var(--text-muted)",
                    border: active ? "1px solid var(--accent)" : "1px solid var(--border-soft)",
                    cursor: "pointer",
                    fontWeight: 500,
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </Field>

        {phase !== "general" && (
          <Field label={phase === "eligibilite" ? "Critère ELG concerné" : "Question Q concernée"}>
            <select
              value={critere}
              onChange={(e) => setCritere(e.target.value)}
              style={{ width: "100%", fontSize: 13, padding: "6px 10px" }}
            >
              {choices.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
        )}

        <Field
          label="Ce que Claude a raté sur ce dossier"
          hint="Décrivez le constat factuel. Ex : « le récépissé fourni n'était qu'un avis de réception, mais Claude l'a accepté comme un récépissé valide ELG-2 OUI »."
        >
          <textarea
            value={constat}
            onChange={(e) => setConstat(e.target.value)}
            placeholder="Sur ce dossier, Claude a..."
            rows={3}
            style={{ width: "100%", fontSize: 13, padding: "8px 10px", resize: "vertical" }}
          />
        </Field>

        <Field
          label="Règle à appliquer pour TOUS les dossiers à l'avenir"
          hint="Ex : « refuser les récépissés qui sont en réalité des attestations ou avis de réception. Seul le document final officiel est accepté. »"
        >
          <textarea
            value={regle}
            onChange={(e) => setRegle(e.target.value)}
            placeholder="À l'avenir, sur tous les dossiers, tu devrais..."
            rows={4}
            style={{ width: "100%", fontSize: 13, padding: "8px 10px", resize: "vertical" }}
          />
        </Field>

        {response && (
          <div
            style={{
              marginTop: 10,
              padding: "10px 12px",
              background: done ? "var(--green-bg)" : "var(--bg-subtle)",
              border: done
                ? "1px solid var(--green-border)"
                : "1px solid var(--border-soft)",
              borderRadius: "var(--radius-sm)",
              fontSize: 12,
              lineHeight: 1.55,
              color: "var(--text)",
              whiteSpace: "pre-wrap",
            }}
          >
            {done && (
              <div
                style={{
                  fontSize: 10,
                  color: "var(--green)",
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  marginBottom: 4,
                }}
              >
                ✓ Réponse de Claude
              </div>
            )}
            {response}
          </div>
        )}
      </div>

      <div
        style={{
          padding: "10px 14px",
          borderTop: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <button
          onClick={onClose}
          className="ghost"
          style={{ fontSize: 12, padding: "6px 12px", cursor: "pointer" }}
        >
          {done ? "Fermer" : "Annuler"}
        </button>
        <button
          onClick={submit}
          disabled={!constat.trim() || !regle.trim() || submitting}
          className="primary"
          style={{
            marginLeft: "auto",
            fontSize: 12,
            padding: "6px 14px",
            cursor:
              !constat.trim() || !regle.trim() || submitting ? "not-allowed" : "pointer",
            opacity: !constat.trim() || !regle.trim() || submitting ? 0.5 : 1,
          }}
        >
          {submitting ? "Envoi…" : "Soumettre la règle"}
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div
        style={{
          fontSize: 12,
          fontWeight: 500,
          color: "var(--text-strong)",
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      {hint && (
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 6, lineHeight: 1.5 }}>
          {hint}
        </div>
      )}
      {children}
    </div>
  );
}
