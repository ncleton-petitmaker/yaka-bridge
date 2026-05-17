import Link from "next/link";
import { AppChromeHeader } from "@/components/AppChromeHeader";
import { Icon } from "@/components/Icon";

/**
 * Page d'accueil — mini-showcase TeamFactory.
 *
 * Layout : header global + main centré avec :
 *  - Hero serif "{{APP_NAME}}" + sous-titre `--muted`
 *  - Grille de 3 object-cards (auto-fill, minmax(220px, 1fr))
 *  - Demo des 5 status pills (1 par tint family)
 *  - 1 seul bouton primary `--accent` + 1 bouton ghost border
 *
 * L'agent ui-page-generator personnalise les cards selon le brief métier
 * (clé `home.cards` dans template.config.json). Les valeurs ici sont
 * des placeholders neutres.
 *
 * IMPORTANT — TeamFactory invariant : aucun hex hardcodé, accent rationné
 * à ≤2 uses (1 primary CTA + 1 brand mark active). Status via tints
 * sémantiques (.pill.ok/.info/.running/.warn/.error).
 */
const homeCards: {
  href: string;
  label: string;
  description: string;
  icon: Parameters<typeof Icon>[0]["name"];
}[] = [
  // AGENT-SLOT: home-cards — l'agent ui-page-generator remplit selon le brief.
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

export default function HomePage() {
  return (
    <div className="app">
      <AppChromeHeader />
      <main
        style={{
          overflowY: "auto",
          padding: "40px 32px",
          background: "var(--bg)",
        }}
      >
        <div style={{ maxWidth: 920, margin: "0 auto" }}>
          {/* Hero */}
          <h1
            style={{
              fontFamily: "var(--serif)",
              fontWeight: 600,
              fontSize: 36,
              letterSpacing: "-0.02em",
              color: "var(--fg-strong)",
              margin: 0,
              marginBottom: 12,
            }}
          >
            {"{{APP_NAME}}"}
          </h1>
          <p
            style={{
              fontSize: 14,
              color: "var(--muted)",
              lineHeight: 1.6,
              maxWidth: 640,
              marginBottom: 28,
            }}
          >
            {"{{DOMAIN_BRIEF}}"}
          </p>

          {/* CTA row — 1 primary accent + 1 ghost border */}
          <div style={{ display: "flex", gap: 8, marginBottom: 36 }}>
            <Link href="/runs" style={{ textDecoration: "none" }}>
              <button className="primary" style={{ padding: "8px 16px", fontSize: 13 }}>
                Nouveau run
              </button>
            </Link>
            <Link href="/dashboard" style={{ textDecoration: "none" }}>
              <button className="ghost" style={{ padding: "8px 16px", fontSize: 13 }}>
                Voir le dashboard
              </button>
            </Link>
          </div>

          {/* Object cards grid */}
          <div
            style={{
              display: "grid",
              gap: 14,
              gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
              marginBottom: 36,
            }}
          >
            {homeCards.map((c) => (
              <Link
                key={c.href}
                href={c.href}
                className="object-card"
                style={{ textDecoration: "none", color: "inherit", padding: 14 }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    marginBottom: 10,
                    color: "var(--muted)",
                  }}
                >
                  <Icon name={c.icon} size={16} />
                </div>
                <div
                  style={{
                    fontFamily: "var(--serif)",
                    fontWeight: 600,
                    fontSize: 15,
                    color: "var(--fg-strong)",
                    marginBottom: 4,
                  }}
                >
                  {c.label}
                </div>
                <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.45 }}>
                  {c.description}
                </div>
              </Link>
            ))}
          </div>

          {/* Status pills demo — 1 per tint family (purple uses the pulse) */}
          <div
            style={{
              borderTop: "1px solid var(--border-soft)",
              paddingTop: 20,
            }}
          >
            <div className="eyebrow" style={{ marginBottom: 10 }}>
              États
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <span className="pill ok">
                <span className="dot" />
                terminé
              </span>
              <span className="pill info">
                <span className="dot" />
                info
              </span>
              <span className="pill running">
                <span className="dot" />
                en cours
              </span>
              <span className="pill warn">
                <span className="dot" />
                en attente
              </span>
              <span className="pill error">
                <span className="dot" />
                erreur
              </span>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
