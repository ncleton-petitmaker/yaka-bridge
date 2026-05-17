import Link from "next/link";

const navItems = [
  { href: "/runs", label: "Runs", description: "Lancer et suivre les runs Claude Code" },
  { href: "/skills", label: "Skills", description: "Éditer les skills YAML" },
  { href: "/logs", label: "Journal d'audit", description: "Consulter le journal chaîné" },
  { href: "/settings", label: "Paramètres", description: "Modèle, paths, utilisateur" },
];

export default function HomePage() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "48px 24px" }}>
      <header style={{ marginBottom: 32 }}>
        <h1 style={{ fontSize: 32, fontWeight: 600, letterSpacing: "-0.02em" }}>
          {"{{APP_NAME}}"}
        </h1>
        <p style={{ color: "var(--text-muted, #666)", fontSize: 14, marginTop: 8 }}>
          {"{{DOMAIN_BRIEF}}"}
        </p>
        <p style={{ fontSize: 12, color: "#999", marginTop: 4 }}>
          version {"{{VERSION}}"}
        </p>
      </header>

      <nav style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {navItems.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            style={{
              display: "block",
              padding: "16px 20px",
              border: "1px solid var(--border, #e4e4e4)",
              borderRadius: 8,
              textDecoration: "none",
              color: "inherit",
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 15 }}>{item.label}</div>
            <div style={{ fontSize: 13, color: "var(--text-muted, #666)", marginTop: 2 }}>
              {item.description}
            </div>
          </Link>
        ))}
      </nav>
    </main>
  );
}
