import Link from "next/link";
import { Mark } from "@/components/Mark";
import { Icon } from "@/components/Icon";

const navItems: { href: string; label: string; description: string; icon: Parameters<typeof Icon>[0]["name"] }[] = [
  {
    href: "/evaluation",
    label: "Évaluation",
    description: "Lancer une évaluation IA sur un dossier candidat",
    icon: "sparkles",
  },
  {
    href: "/propositions",
    label: "Propositions",
    description: "Règles proposées par l'équipe, diff visuel et arbitrage admin",
    icon: "comment",
  },
  {
    href: "/export",
    label: "Export",
    description: "Générer le fichier xlsx final au format 6e édition",
    icon: "download",
  },
];

export default function HomePage() {
  return (
    <div className="app">
      <div className="entry">
        <aside className="entry-side">
          <div className="entry-brand" style={{ marginBottom: 8 }}>
            <Mark size={36} />
            <div className="entry-brand-text">
              <h1 className="entry-brand-title">OIF-Eval</h1>
              <span className="entry-brand-subtitle">
                Outil d&apos;évaluation des candidatures FAE 7e édition
              </span>
            </div>
          </div>
          <p
            style={{
              fontSize: 12,
              color: "var(--text-muted)",
              lineHeight: 1.5,
              marginBottom: 8,
            }}
          >
            Organisation Internationale de la Francophonie
          </p>

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
              Évaluer la 7e édition
            </h2>
            <p
              style={{
                fontSize: 15,
                color: "var(--text-muted)",
                lineHeight: 1.6,
                marginBottom: 32,
              }}
            >
              Évaluation assistée par IA des candidatures au Fonds d&apos;Appui aux Entreprises
              (FAE) 7e édition de l&apos;OIF. 16 critères hors-IA, 1 score IA de 0 à 67 points.
              Vos règles évoluent au fil des dossiers.
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
                  Démarrer une évaluation
                </div>
                <div style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.5 }}>
                  Sélectionnez un dossier candidat et laissez l&apos;IA proposer une grille,
                  puis validez ou ajustez chaque critère.
                </div>
              </div>
              <Link
                href="/evaluation"
                style={{ textDecoration: "none" }}
              >
                <button
                  className="primary"
                  style={{
                    padding: "8px 16px",
                    fontSize: 14,
                    cursor: "pointer",
                  }}
                >
                  Démarrer l&apos;évaluation
                </button>
              </Link>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                gap: 12,
              }}
            >
              <Stat label="Dossiers" value="101" />
              <Stat label="Questions hors-IA" value="16" />
              <Stat label="Score IA" value="0 – 67" />
            </div>
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
