"use client";

import { AppChromeHeader } from "@/components/AppChromeHeader";

/**
 * Page Dashboard : pattern admin stats hérité d'oif-eval.
 * Flex column avec cards de stats en haut, charts au-dessous.
 *
 * L'agent ui-page-generator remplace les placeholders par les cards/charts
 * spécifiques à l'app (par exemple : nb d'items traités, coût Claude, etc.).
 */
export default function DashboardPage() {
  return (
    <div className="app">
      <AppChromeHeader />
      <main
        style={{
          flex: 1,
          overflowY: "auto",
          padding: 32,
          maxWidth: 1200,
          width: "100%",
          margin: "0 auto",
        }}
      >
        <header style={{ marginBottom: 28 }}>
          <h1
            style={{
              fontFamily: "var(--serif)",
              fontWeight: 600,
              fontSize: 28,
              letterSpacing: "-0.01em",
              color: "var(--text-strong)",
              marginBottom: 6,
            }}
          >
            Dashboard
          </h1>
          <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
            {/* AGENT-SLOT: dashboard-intro */}
            Vue d&apos;ensemble de l&apos;activité.
          </p>
        </header>

        {/* AGENT-SLOT: dashboard-stats-cards
            Bloc de cards stats : nombre d'items, coûts, latences, etc. */}
        <section
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: 12,
            marginBottom: 28,
          }}
        >
          <StatCard label="{{STAT_1_LABEL}}" value="—" />
          <StatCard label="{{STAT_2_LABEL}}" value="—" />
          <StatCard label="{{STAT_3_LABEL}}" value="—" />
          <StatCard label="{{STAT_4_LABEL}}" value="—" />
        </section>

        {/* AGENT-SLOT: dashboard-charts
            Bloc charts : timeline d'activité, distribution de scores, etc. */}
        <section
          className="pane"
          style={{
            padding: 24,
            minHeight: 320,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--text-muted)",
            fontSize: 13,
            fontStyle: "italic",
          }}
        >
          Charts à remplir par l&apos;agent ui-page-generator
        </section>
      </main>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
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
          fontSize: 24,
          color: "var(--text-strong)",
        }}
      >
        {value}
      </div>
    </div>
  );
}
