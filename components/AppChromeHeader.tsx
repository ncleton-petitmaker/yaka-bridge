"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Mark } from "@/components/Mark";
import { Icon } from "@/components/Icon";
import { ConflictBanner } from "@/components/ConflictBanner";

const baseTabs = [
  { href: "/evaluation", label: "Évaluation", adminOnly: false },
  { href: "/dashboard", label: "Dashboard", adminOnly: true },
  { href: "/propositions", label: "Propositions", adminOnly: false },
  { href: "/export", label: "Export", adminOnly: false },
  { href: "/parametres", label: "Paramètres", adminOnly: false },
];

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
    window.addEventListener("fae-config-changed", loadProfile);
    return () => window.removeEventListener("fae-config-changed", loadProfile);
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
      localStorage.setItem("fae-eval:theme", next);
    } catch {
      // ignore
    }
    setTheme(next);
  }

  return (
    <>
    <ConflictBanner />
    <header
      className="app-chrome-header"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "4px 14px",
        borderBottom: "1px solid var(--border)",
        height: 40,
        background: "var(--bg)",
      }}
    >
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
            color: "var(--text-strong)",
          }}
        >
          OIF-Eval
        </span>
        <span style={{ color: "var(--text-muted)", fontSize: 12 }}>·</span>
        <span
          style={{
            fontSize: 11,
            color: "var(--text-muted)",
            fontWeight: 400,
          }}
        >
          Outil d&apos;évaluation FAE 7e
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
                color: active ? "var(--text-strong)" : "var(--text-muted)",
                borderBottom: active ? "2px solid var(--text)" : "2px solid transparent",
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
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "4px 10px",
            borderRadius: 999,
            background: "var(--bg-subtle)",
            border: "1px solid var(--border)",
            fontSize: 12,
            color: "var(--text)",
          }}
        >
          <span
            aria-hidden
            style={{
              width: 6,
              height: 6,
              borderRadius: 999,
              background: "var(--green)",
              display: "inline-block",
            }}
          />
          {userLabel}
          {profile.isAdmin && (
            <span
              style={{
                fontSize: 9.5,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                color: "var(--accent-strong)",
                background: "var(--accent-tint)",
                padding: "1px 5px",
                borderRadius: "var(--radius-sm)",
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
          className="ghost"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 28,
            height: 28,
            padding: 0,
            borderRadius: "var(--radius-sm)",
            background: "transparent",
            border: "1px solid var(--border)",
            color: "var(--text-muted)",
            cursor: "pointer",
          }}
        >
          <Icon name="sun-moon" size={14} />
        </button>
      </div>
    </header>
    </>
  );
}
