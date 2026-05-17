"use client";
import type { EvalSource, StructuredSource } from "@/lib/types";

/**
 * Rend une source d'évaluation cliquable.
 *
 * Format unique attendu : objet structuré `{file, page?, sheet?, cell?, quote?}`.
 * Si une vieille évaluation contient une source en string, on l'affiche en
 * texte brut (non cliquable) - c'est juste de l'historique.
 */
export function SourceLink({
  source,
  onPick,
}: {
  source: EvalSource;
  onPick?: (
    file: string,
    hint?: { page?: number; sheet?: string; cell?: string; search?: string; quote?: string }
  ) => void;
}) {
  if (typeof source === "object" && source !== null) {
    return <StructuredSourceLink source={source} onPick={onPick} />;
  }
  if (!source) return null;
  if (onPick) {
    return (
      <button
        type="button"
        onClick={() => onPick(source)}
        title="Ouvrir cette source"
        style={{
          background: "transparent",
          border: "none",
          padding: 0,
          textAlign: "left",
          fontFamily: "var(--mono)",
          fontSize: 11,
          color: "var(--accent)",
          cursor: "pointer",
          textDecoration: "underline",
          textUnderlineOffset: 2,
          textDecorationStyle: "dotted",
        }}
      >
        {source}
      </button>
    );
  }
  return (
    <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-muted)" }}>
      {source}
    </span>
  );
}

function StructuredSourceLink({
  source,
  onPick,
}: {
  source: StructuredSource;
  onPick?: (
    file: string,
    hint?: { page?: number; sheet?: string; cell?: string; search?: string; quote?: string }
  ) => void;
}) {
  if (!source.file) return null;
  const hint =
    source.page || source.sheet || source.cell || source.section || source.quote
      ? {
          page: source.page,
          sheet: source.sheet,
          cell: source.cell,
          search: source.section,
          quote: source.quote,
        }
      : undefined;
  const label = [
    source.file,
    source.page ? `p.${source.page}` : null,
    source.sheet ? `feuille "${source.sheet}"` : null,
    source.cell ? source.cell : null,
    source.section ? source.section : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: 2 }}>
      <button
        type="button"
        onClick={() => onPick?.(source.file, hint)}
        title="Ouvrir cette source"
        style={{
          background: "transparent",
          border: "none",
          padding: 0,
          textAlign: "left",
          fontFamily: "var(--mono)",
          fontSize: 11,
          color: "var(--accent)",
          cursor: onPick ? "pointer" : "default",
          textDecoration: "underline",
          textUnderlineOffset: 2,
          textDecorationStyle: "dotted",
        }}
      >
        {label}
      </button>
      {source.quote && (
        <span
          style={{
            fontFamily: "var(--mono)",
            fontSize: 11,
            color: "var(--text-muted)",
            fontStyle: "italic",
          }}
        >
          « {source.quote} »
        </span>
      )}
    </span>
  );
}
