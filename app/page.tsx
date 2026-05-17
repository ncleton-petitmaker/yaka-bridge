import Link from "next/link";
import { Mark } from "@/components/Mark";
import { Icon } from "@/components/Icon";

/**
 * Page d'accueil 2-colonnes, héritée du pattern oif-eval :
 * - aside : brand + liste des sections (génériques par défaut)
 * - main : hero serif + CTA principal + cards de stats
 *
 * L'agent ui-page-generator de la factory enrichit `navItems` et `stats` selon
 * le brief métier. Les valeurs ici sont des placeholders neutres.
 */
const navItems: {
  href: string;
  label: string;
  description: string;
  icon: Parameters<typeof Icon>[0]["name"];
}[] = [
  // AGENT-SLOT: home-nav-items — l'agent ui-page-generator remplit ces entrées.
  {
    href: "/runs",
    label: "Runs",
    description: "Lancer et suivre les runs Claude Code",
    icon: "play",
  },
  {
    href: "/dashboard",
    label: "Dashboard",
    description: "Statistiques d'usage et coûts",
    icon: "grid",
  },
  {
    href: "/settings",
    label: "Paramètres",
    description: "Modèle, paths, utilisateur",
    icon: "settings",
  },
];

const stats: { label: string; value: string }[] = [
  // AGENT-SLOT: home-stats — l'agent ui-page-generator remplit selon le métier.
  { label: "{{STAT_1_LABEL}}", value: "—" },
  { label: "{{STAT_2_LABEL}}", value: "—" },
  { label: "{{STAT_3_LABEL}}", value: "—" },
];

export default function HomePage() {
  return (
    <div className="app">
      <div className="entry">
        <aside className="entry-side">
          <div className="entry-brand" style={{ marginBottom: 8 }}>
            <Mark size={36} />
            <div className="entry-brand-text">
              <h1 className="entry-brand-title">{"{{APP_NAME}}"}</h1>
              <span className="entry-brand-subtitle">
                {"{{DOMAIN_BRIEF}}"}
              </span>
            </div>
          </div>

          <div
            style={{
              fontSize: 11,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--text-muted)",
              fontWeight: 500,
              marginTop: 8,
              marginBottom: 4,
            }}
          >
            Sections
          </div>
          <nav style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="settings-nav-item"
                style={{ textDecoration: "none" }}
              >
                <Icon name={item.icon} size={16} />
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.description}</small>
                </span>
              </Link>
            ))}
          </nav>
        </aside>

        <main
          style={{
            padding: 48,
            overflowY: "auto",
            background: "var(--bg)",
          }}
        >
          <div style={{ maxWidth: 720 }}>
            <h2
              style={{
                fontFamily: "var(--serif)",
                fontWeight: 600,
                fontSize: 36,
                letterSpacing: "-0.02em",
                color: "var(--text-strong)",
                marginBottom: 12,
              }}
            >
              {"{{APP_NAME}}"}
            </h2>
            <p
              style={{
                fontSize: 15,
                color: "var(--text-muted)",
                lineHeight: 1.6,
                marginBottom: 32,
              }}
            >
              {"{{DOMAIN_BRIEF}}"}
            </p>

            <div
              className="pane"
              style={{
                padding: 24,
                marginBottom: 24,
                display: "flex",
                alignItems: "center",
                gap: 20,
                flexWrap: "wrap",
              }}
            >
              <div style={{ flex: "1 1 280px", minWidth: 0 }}>
                <div
                  style={{
                    fontFamily: "var(--serif)",
                    fontWeight: 600,
                    fontSize: 18,
                    color: "var(--text-strong)",
                    marginBottom: 4,
                  }}
                >
                  Démarrer
                </div>
                <div style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.5 }}>
                  {/* AGENT-SLOT: home-cta-description */}
                  Lancez un nouveau run pour explorer ce que cette app peut faire.
                </div>
              </div>
              <Link href="/runs" style={{ textDecoration: "none" }}>
                <button
                  className="primary"
                  style={{ padding: "8px 16px", fontSize: 14, cursor: "pointer" }}
                >
                  Nouveau run
                </button>
              </Link>
            </div>

            {stats.length > 0 && (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                  gap: 12,
                }}
              >
                {stats.map((s) => (
                  <Stat key={s.label} label={s.label} value={s.value} />
                ))}
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="pane"
      style={{
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <div
        style={{
          fontSize: 11,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--text-muted)",
          fontWeight: 500,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: "var(--serif)",
          fontWeight: 600,
          fontSize: 22,
          color: "var(--text-strong)",
        }}
      >
        {value}
      </div>
    </div>
  );
}
