"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { AppChromeHeader } from "@/components/AppChromeHeader";
import { Icon } from "@/components/Icon";

const adminNav = [
  {
    href: "/admin/design-systems",
    label: "Design",
    description: "Sites et design systems",
    icon: "sparkles" as const,
  },
  {
    href: "/admin/observability",
    label: "Observation",
    description: "Sessions et erreurs",
    icon: "eye" as const,
  },
  {
    href: "/admin/agent-routing",
    label: "Routage",
    description: "Cloud et local",
    icon: "git-merge" as const,
  },
];

interface AdminShellProps {
  title: string;
  description?: string;
  eyebrow?: string;
  actions?: ReactNode;
  children: ReactNode;
}

export function AdminShell({ title, description, eyebrow = "Admin", actions, children }: AdminShellProps) {
  const pathname = usePathname();

  return (
    <div className="app">
      <AppChromeHeader />
      <main className="admin-shell">
        <aside
          className="admin-sidebar"
          style={{
            padding: 14,
          }}
        >
          <div style={{ display: "grid", gap: 4, padding: "4px 4px 12px" }}>
            <span className="eyebrow">{eyebrow}</span>
            <strong style={{ color: "var(--fg-strong)", fontSize: 15 }}>Pilotage</strong>
          </div>
          <nav style={{ display: "grid", gap: 6 }}>
            {adminNav.map((item) => {
              const active = pathname === item.href || Boolean(pathname?.startsWith(`${item.href}/`));
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "18px minmax(0, 1fr)",
                    gap: 10,
                    alignItems: "center",
                    minHeight: 44,
                    padding: "8px 10px",
                    borderRadius: "var(--radius-sm)",
                    border: "1px solid",
                    borderColor: active ? "var(--border-strong)" : "transparent",
                    background: active ? "var(--subtle)" : "transparent",
                    color: active ? "var(--fg-strong)" : "var(--muted)",
                    textDecoration: "none",
                  }}
                >
                  <Icon name={item.icon} size={15} />
                  <span style={{ minWidth: 0, display: "grid", gap: 2 }}>
                    <strong style={{ fontSize: 13, fontWeight: 650, color: "inherit" }}>{item.label}</strong>
                    <span style={{ fontSize: 11, color: "var(--soft)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {item.description}
                    </span>
                  </span>
                </Link>
              );
            })}
          </nav>
        </aside>

        <section className="admin-content">
          <div className="admin-page-inner">
            <header
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 16,
                alignItems: "flex-end",
                marginBottom: 18,
              }}
            >
              <div style={{ minWidth: 0 }}>
                <span className="eyebrow">{eyebrow}</span>
                <h1 style={{ marginTop: 7 }}>{title}</h1>
                {description && (
                  <p style={{ color: "var(--muted)", fontSize: 13, marginTop: 6, maxWidth: 680 }}>
                    {description}
                  </p>
                )}
              </div>
              {actions && <div style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>{actions}</div>}
            </header>
            {children}
          </div>
        </section>
      </main>
    </div>
  );
}

export function AdminStat({ label, value, tone }: { label: string; value: string | number; tone?: "ok" | "warn" | "error" }) {
  const color = tone === "ok" ? "var(--green-fg)" : tone === "warn" ? "var(--amber-fg)" : tone === "error" ? "var(--red-fg)" : "var(--fg-strong)";
  return (
    <article className="card" style={{ padding: 14 }}>
      <span className="eyebrow" style={{ color: "var(--muted)" }}>{label}</span>
      <strong style={{ display: "block", marginTop: 7, fontSize: 22, color }}>{value}</strong>
    </article>
  );
}
