"use client";
import type { CSSProperties } from "react";

/**
 * Barre de progression simple, transition CSS sur la largeur.
 * Affiche "X / Y" et l'ETA formaté en français lisible.
 */
export function ProgressBar({
  done,
  total,
  label,
  etaSeconds,
  style,
}: {
  done: number;
  total: number;
  label?: string;
  etaSeconds?: number | null;
  style?: CSSProperties;
}) {
  const safeTotal = Math.max(1, total);
  const pct = Math.min(100, Math.max(0, (done / safeTotal) * 100));

  return (
    <div style={{ width: "100%", ...style }}>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        style={{
          width: "100%",
          height: 10,
          background: "var(--bg-subtle)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-pill)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            background: "var(--accent)",
            transition: "width 360ms ease",
          }}
        />
      </div>
      <div
        style={{
          marginTop: 8,
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
          alignItems: "baseline",
          fontSize: 12.5,
          color: "var(--text-muted)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        <span style={{ color: "var(--text-strong)", fontWeight: 600 }}>
          {done} / {total}
        </span>
        {label && (
          <span
            style={{
              flex: "1 1 auto",
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {label}
          </span>
        )}
        {typeof etaSeconds === "number" && etaSeconds > 0 && (
          <span style={{ color: "var(--text-muted)", whiteSpace: "nowrap" }}>
            Reste {formatEta(etaSeconds)}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Formate un nombre de secondes en "X min Y s" ou "X h Y min".
 * Pas d'em dash, pas d'anglicisme.
 */
function formatEta(s: number): string {
  if (s < 60) return `${Math.round(s)} s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.round(s % 60);
  if (h > 0) {
    return m > 0 ? `${h} h ${m} min` : `${h} h`;
  }
  if (m > 0 && sec > 0 && m < 5) return `${m} min ${sec} s`;
  return `${m} min`;
}
