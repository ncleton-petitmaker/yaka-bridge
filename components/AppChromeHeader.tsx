"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Mark } from "@/components/Mark";
import { Icon } from "@/components/Icon";
import { ConflictBanner } from "@/components/ConflictBanner";

/**
 * Onglets affichés dans le header global. Vide par défaut : l'agent
 * `ui-page-generator` l'enrichit lors du scaffolding selon les entités métier
 * définies dans `template.config.json` (clé `shell.nav_tabs`).
 *
 * Format : { href, label, adminOnly? }
 *
 * AGENT-SLOT: nav-tabs — l'agent ui-page-generator remplace ce tableau lors du
 * scaffold. Garder le type pour TS.
 */
interface NavTab {
  href: string;
  label: string;
  adminOnly?: boolean;
}
const baseTabs: NavTab[] = [];

/**
 * Header global de l'app : Mark + nom + onglets + profile chip + theme switcher.
 * Wrap aussi le ConflictBanner pour qu'il apparaisse au-dessus du header.
 *
 * Hérité d'oif-eval, génericisé : tabs et nom d'app via placeholders.
 */
export function AppChromeHeader({ user: userProp }: { user?: string }) {
  const path = usePathname();
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [profile, setProfile] = useState<{ currentUser?: string; isAdmin?: boolean }>({});

  useEffect(() => {
    function loadProfile() {
      fetch("/api/app-config")
        .then((r) => r.json())
        .then((j: { config?: { currentUser?: string; isAdmin?: boolean } }) =>
          setProfile({ currentUser: j.config?.currentUser, isAdmin: j.config?.isAdmin })
        )
        .catch(() => {
          // ignore
        });
    }
    loadProfile();
    window.addEventListener("app-config-changed", loadProfile);
    return () => window.removeEventListener("app-config-changed", loadProfile);
  }, []);

  useEffect(() => {
    const t = document.documentElement.getAttribute("data-theme");
    if (t === "dark" || t === "light") setTheme(t);
  }, []);

  const tabs = baseTabs.filter((t) => !t.adminOnly || profile.isAdmin);
  const userLabel = profile.currentUser ?? userProp ?? "Non connecté";

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("{{APP_NAME_KEBAB}}:theme", next);
    } catch {
      // ignore
    }
    setTheme(next);
  }

  return (
    <>
      <ConflictBanner />
      <header className="app-chrome-header">
        <Link
          href="/"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 10,
            textDecoration: "none",
            color: "inherit",
            minWidth: 0,
          }}
        >
          <Mark size={22} />
          <span
            style={{
              fontFamily: "var(--serif)",
              fontWeight: 600,
              fontSize: 14,
              letterSpacing: "-0.01em",
              color: "var(--fg-strong)",
            }}
          >
            {"{{APP_NAME}}"}
          </span>
          <span style={{ color: "var(--muted)", fontSize: 12 }}>·</span>
          <span
            style={{
              fontSize: 11,
              color: "var(--muted)",
              fontWeight: 400,
            }}
          >
            {"{{DOMAIN_BRIEF}}"}
          </span>
        </Link>

        <nav
          style={{
            display: "inline-flex",
            gap: 16,
            marginLeft: 24,
            flex: 1,
            alignItems: "stretch",
          }}
        >
          {tabs.map((t) => {
            const active = path?.startsWith(t.href) ?? false;
            return (
              <Link
                key={t.href}
                href={t.href}
                className={`chat-header-tab${active ? " active" : ""}`}
                style={{
                  textDecoration: "none",
                  padding: "8px 0",
                  fontSize: 13,
                  fontWeight: 500,
                  display: "inline-flex",
                  alignItems: "center",
                }}
              >
                {t.label}
              </Link>
            );
          })}
        </nav>

        <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <span
            className="pill ok"
            style={{ cursor: "default" }}
          >
            <span className="dot" aria-hidden />
            {userLabel}
            {profile.isAdmin && (
              <span
                style={{
                  fontSize: 9.5,
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  color: "var(--muted)",
                  fontFamily: "var(--mono)",
                  marginLeft: 2,
                }}
              >
                admin
              </span>
            )}
          </span>
          <button
            type="button"
            onClick={toggleTheme}
            aria-label={theme === "dark" ? "Passer en mode clair" : "Passer en mode sombre"}
            className="ghost icon-btn"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 28,
              height: 28,
              padding: 0,
              color: "var(--muted)",
            }}
          >
            <Icon name="sun-moon" size={14} />
          </button>
        </div>
      </header>
    </>
  );
}
