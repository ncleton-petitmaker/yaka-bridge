"use client";

/**
 * Mark de l'app : pastille avec l'icône de l'app (servie depuis /icon-64.png),
 * utilisée dans le header global et les écrans d'accueil.
 *
 * La factory remplace l'icône via la procédure de branding (cf. docs). Hérité
 * du shell UX d'oif-eval, génericisé : pas d'asset SVG métier en dur.
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
      aria-label="{{APP_NAME}}"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/icon-64.png"
        alt="{{APP_NAME}}"
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
        }}
      />
    </span>
  );
}
