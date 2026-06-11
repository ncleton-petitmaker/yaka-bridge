"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Mark } from "@/components/Mark";
import { Icon } from "@/components/Icon";
import { ConflictBanner } from "@/components/ConflictBanner";
import { BridgeIndicator } from "@/components/BridgeStatusProvider";

/**
 * Onglets affichés dans le header global. Vide par défaut : l'agent
 * `ui-page-generator` l'enrichit lors du scaffolding selon les entités métier
 * définies dans `template.config.json` (clé `shell.nav_tabs`).
 *
 * Format : { href, label }
 *
 * AGENT-SLOT: nav-tabs — l'agent ui-page-generator remplace ce tableau lors du
 * scaffold. Garder le type pour TS.
 */
interface NavTab {
  href: string;
  label: string;
}
const baseTabs: NavTab[] = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/runs", label: "Achats" },
  { href: "/admin/observability", label: "Observation" },
];

const APP_NAME = "Bridge ERP Demo";
const DOMAIN_BRIEF = "Template ERP modulaire cloud/bridge";
const THEME_KEY = "bridge-erp-demo:theme";

/**
 * Header global de l'app : Mark + nom + onglets + theme switcher.
 * Wrap aussi le ConflictBanner pour qu'il apparaisse au-dessus du header.
 *
 * Hérité d'oif-eval, génericisé : tabs et nom d'app via placeholders.
 */
export function AppChromeHeader() {
  const path = usePathname();
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    const t = document.documentElement.getAttribute("data-theme");
    if (t === "dark" || t === "light") setTheme(t);
  }, []);

  const tabs = baseTabs;

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(THEME_KEY, next);
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
          href="/runs"
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
              letterSpacing: 0,
              color: "var(--fg-strong)",
              whiteSpace: "nowrap",
            }}
          >
            {APP_NAME}
          </span>
          <span style={{ color: "var(--muted)", fontSize: 12 }}>·</span>
          <span
            style={{
              fontSize: 11,
              color: "var(--muted)",
              fontWeight: 400,
              maxWidth: 460,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {DOMAIN_BRIEF}
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
          <BridgeIndicator />
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
