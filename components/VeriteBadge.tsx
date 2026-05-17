"use client";
import { useEffect, useState } from "react";
import { loadVerite } from "@/lib/client";
import type { VeriteSummary } from "@/lib/types";

function deltaPillStyle(absDelta: number): React.CSSProperties {
  if (absDelta < 5) {
    return {
      background: "var(--green-bg)",
      color: "var(--green)",
      border: "1px solid var(--green-border)",
    };
  }
  if (absDelta <= 15) {
    return {
      background: "var(--amber-bg)",
      color: "var(--amber)",
      border: "1px solid color-mix(in srgb, var(--amber) 35%, var(--border))",
    };
  }
  return {
    background: "var(--red-bg)",
    color: "var(--red)",
    border: "1px solid var(--red-border)",
  };
}

export function VeriteBadge({
  dossierId,
  scoreIA,
}: {
  dossierId: string;
  scoreIA?: number;
}) {
  const [v, setV] = useState<VeriteSummary | null>(null);

  useEffect(() => {
    loadVerite(dossierId).then(setV);
  }, [dossierId]);

  if (!v?.verdict_humain && typeof v?.score_humain !== "number") return null;

  const delta =
    typeof scoreIA === "number" && typeof v.score_humain === "number"
      ? scoreIA - v.score_humain
      : null;

  return (
    <div
      style={{
        borderRadius: "var(--radius)",
        background: "var(--blue-bg)",
        border: "1px solid var(--blue-border)",
        borderLeft: "3px solid var(--blue)",
        padding: "10px 14px",
        marginTop: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 8,
          marginBottom: 6,
        }}
      >
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "var(--blue)",
          }}
        >
          Vérité-terrain humaine 6e
        </span>
        {v.reference && (
          <span
            style={{
              fontFamily: "var(--mono)",
              fontSize: 10,
              color: "var(--text-muted)",
            }}
          >
            référence {v.reference}
          </span>
        )}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          flexWrap: "wrap",
          fontSize: 13,
        }}
      >
        {v.verdict_humain && (
          <div>
            <span style={{ color: "var(--text-muted)" }}>Verdict humain : </span>
            <span
              style={{
                fontWeight: 600,
                color:
                  v.verdict_humain === "ELIGIBLE"
                    ? "var(--green)"
                    : "var(--red)",
              }}
            >
              {v.verdict_humain}
            </span>
          </div>
        )}

        {typeof v.score_humain === "number" && (
          <div>
            <span style={{ color: "var(--text-muted)" }}>Score humain : </span>
            <span
              style={{
                fontFamily: "var(--mono)",
                fontWeight: 600,
                color: "var(--text-strong)",
              }}
            >
              {v.score_humain.toFixed(1)}
            </span>
            {typeof v.score_min === "number" &&
              typeof v.score_max === "number" && (
                <span
                  style={{
                    fontSize: 11,
                    color: "var(--text-muted)",
                    marginLeft: 6,
                  }}
                >
                  (min {v.score_min} · max {v.score_max} ·{" "}
                  {v.nb_evaluateurs} éval.)
                </span>
              )}
          </div>
        )}

        {delta !== null && (
          <div
            style={{
              marginLeft: "auto",
              padding: "2px 8px",
              borderRadius: "var(--radius-sm)",
              fontFamily: "var(--mono)",
              fontSize: 11,
              fontWeight: 600,
              ...deltaPillStyle(Math.abs(delta)),
            }}
          >
            Δ IA-humain : {delta >= 0 ? "+" : ""}
            {delta.toFixed(1)}
          </div>
        )}
      </div>
    </div>
  );
}
