"use client";

/**
 * Mark de l'app : drapeau de la Francophonie (5 bandes courbes oranges
 * sur fond blanc), redimensionnable. Utilisé dans le header global et
 * dans les écrans d'accueil. SVG servi depuis /public/francophonie-flag.svg.
 */
export function Mark({ size = 22, className }: { size?: number; className?: string }) {
  return (
    <span
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        background: "var(--bg-panel)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-sm)",
        boxShadow: "var(--shadow-xs)",
        flexShrink: 0,
        overflow: "hidden",
      }}
      aria-label="Organisation Internationale de la Francophonie"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/francophonie-flag.svg"
        alt="Drapeau de la Francophonie"
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
        }}
      />
    </span>
  );
}
