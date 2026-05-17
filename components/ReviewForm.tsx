"use client";
import { useState } from "react";
import type { Evaluation } from "@/lib/types";
import { QUESTIONS_HORS_IA as DEFAULT_HORS_IA } from "@/lib/types";

export function ReviewForm({
  evaluation,
  user,
  onValidated,
  horsIa,
}: {
  evaluation: Evaluation;
  user: string;
  onValidated: (updated: Evaluation) => void;
  horsIa?: number[];
}) {
  const QUESTIONS_HORS_IA = horsIa ?? DEFAULT_HORS_IA;
  const not = evaluation.phase_notation;
  const initialMap = new Map<number, { score: number; commentaire: string }>();
  evaluation.review?.questions_hors_ia?.forEach((q) =>
    initialMap.set(q.question_id, { score: q.score, commentaire: q.commentaire })
  );

  const [answers, setAnswers] = useState<Map<number, { score: number; commentaire: string }>>(
    initialMap
  );
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!not) {
    return (
      <div
        style={{
          padding: 24,
          fontSize: 13,
          color: "var(--text-muted)",
        }}
      >
        Pas de phase de notation : éligibilité bloquante. Pas de review humaine nécessaire.
      </div>
    );
  }

  const horsIaQuestions = not.questions.filter((q) => QUESTIONS_HORS_IA.includes(q.id));
  const allAnswered = horsIaQuestions.every((q) => answers.has(q.id));

  function setAnswer(qid: number, score: number, commentaire?: string) {
    const next = new Map(answers);
    const cur = next.get(qid) ?? { score: 0, commentaire: "" };
    next.set(qid, { score, commentaire: commentaire ?? cur.commentaire });
    setAnswers(next);
  }
  function setComment(qid: number, c: string) {
    const next = new Map(answers);
    const cur = next.get(qid) ?? { score: 0, commentaire: "" };
    next.set(qid, { ...cur, commentaire: c });
    setAnswers(next);
  }

  async function handleValidate() {
    setSaving(true);
    setErr(null);
    try {
      const items = Array.from(answers.entries()).map(([id, v]) => ({
        question_id: id,
        score: v.score,
        commentaire: v.commentaire,
      }));
      const horsIaTotal = items.reduce((s, x) => s + x.score, 0);
      const scoreFinalTotal = (not?.score_total_ia ?? 0) + horsIaTotal;
      const r = await fetch(`/api/evaluations/${encodeURIComponent(evaluation.dossier_id)}/review`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          validee_par: user,
          validee_le: new Date().toISOString(),
          questions_hors_ia: items,
          score_final_total: scoreFinalTotal,
        }),
      });
      if (!r.ok) throw new Error(`PUT review ${r.status}`);
      const j = (await r.json()) as { evaluation: Evaluation };
      onValidated(j.evaluation);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      style={{
        padding: 18,
        background: "var(--bg)",
        height: "100%",
        overflowY: "auto",
      }}
    >
      <div
        style={{
          padding: "12px 14px",
          borderRadius: "var(--radius)",
          background: "var(--amber-bg)",
          border: "1px solid var(--amber-border)",
          borderLeft: "3px solid var(--amber)",
          marginBottom: 14,
        }}
      >
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: "var(--amber)",
          }}
        >
          ⚠ {horsIaQuestions.length} questions à compléter par vous
        </div>
        <div
          style={{
            fontSize: 12,
            color: "var(--text-muted)",
            marginTop: 4,
            lineHeight: 1.5,
          }}
        >
          Ces questions sont volontairement hors-IA : jugement subjectif ou recoupements complexes
          que la machine ne doit pas trancher seule.
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {horsIaQuestions.map((q) => {
          const cur = answers.get(q.id);
          return (
            <div
              key={q.id}
              id={`review-q-${q.id}`}
              style={{
                padding: 14,
                borderRadius: "var(--radius)",
                border: "1px solid var(--amber-border)",
                background: "var(--bg-panel)",
                boxShadow: "var(--shadow-xs)",
                scrollMarginTop: 16,
              }}
            >
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span
                  style={{
                    fontFamily: "var(--mono)",
                    fontSize: 11,
                    fontWeight: 600,
                    padding: "2px 7px",
                    borderRadius: "var(--radius-sm)",
                    background: "var(--amber-bg)",
                    color: "var(--amber)",
                    border: "1px solid var(--amber-border)",
                  }}
                >
                  Q{q.id}
                </span>
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: 500,
                    color: "var(--text-strong)",
                  }}
                >
                  {q.intitule}
                </span>
              </div>
              <div
                style={{
                  marginTop: 10,
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  flexWrap: "wrap",
                }}
              >
                {Array.from({ length: q.bareme_max + 1 }, (_, i) => {
                  const selected = cur?.score === i;
                  return (
                    <button
                      key={i}
                      onClick={() => setAnswer(q.id, i)}
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: "var(--radius-sm)",
                        fontSize: 13,
                        fontWeight: 600,
                        background: selected ? "var(--accent)" : "var(--bg-subtle)",
                        color: selected ? "white" : "var(--text-muted)",
                        border: selected
                          ? "1px solid var(--accent)"
                          : "1px solid var(--border-soft)",
                        cursor: "pointer",
                        transition: "all 120ms ease",
                        fontFamily: "var(--mono)",
                      }}
                    >
                      {i}
                    </button>
                  );
                })}
                <span
                  style={{
                    marginLeft: 8,
                    fontSize: 11,
                    color: "var(--text-muted)",
                    fontFamily: "var(--mono)",
                  }}
                >
                  / {q.bareme_max}
                </span>
              </div>
              <input
                value={cur?.commentaire ?? ""}
                onChange={(e) => setComment(q.id, e.target.value)}
                placeholder="Commentaire (style télégraphique)..."
                style={{
                  marginTop: 10,
                  width: "100%",
                  fontSize: 12.5,
                  padding: "6px 10px",
                }}
              />
            </div>
          );
        })}
      </div>

      <div
        style={{
          position: "sticky",
          bottom: 0,
          marginTop: 14,
          padding: "12px 0 4px 0",
          background: "var(--bg)",
          borderTop: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
          {answers.size} / {horsIaQuestions.length} complétées
        </span>
        {err && (
          <span style={{ fontSize: 12, color: "var(--red)" }}>{err}</span>
        )}
        <button
          onClick={handleValidate}
          disabled={!allAnswered || saving}
          className="primary"
          style={{
            marginLeft: "auto",
            padding: "8px 16px",
            fontSize: 13,
            cursor: allAnswered && !saving ? "pointer" : "not-allowed",
            opacity: allAnswered && !saving ? 1 : 0.4,
          }}
        >
          {saving ? "Enregistrement..." : "Valider la review"}
        </button>
      </div>
    </div>
  );
}
