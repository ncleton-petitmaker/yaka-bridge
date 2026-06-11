"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AppChromeHeader } from "@/components/AppChromeHeader";
import { Icon } from "@/components/Icon";
import { listRuns } from "@/lib/client";
import type { RunRecord } from "@/lib/types";

export default function DashboardPage() {
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listRuns()
      .then((next) => {
        setRuns(next.sort((a, b) => b.startedAt - a.startedAt));
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const metrics = useMemo(() => {
    const completed = runs.filter((run) => run.status === "succeeded").length;
    const running = runs.filter((run) => run.status === "running" || run.status === "queued").length;
    const failed = runs.filter((run) => run.status === "failed").length;
    const last = runs[0];
    return [
      { label: "Sessions", value: String(runs.length), icon: "history" as const },
      { label: "Terminees", value: String(completed), icon: "check" as const },
      { label: "En cours", value: String(running), icon: "spinner" as const },
      { label: "A revoir", value: String(failed), icon: "bell" as const },
      {
        label: "Derniere",
        value: last ? new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" }).format(last.startedAt) : "--",
        icon: "reload" as const,
      },
    ];
  }, [runs]);

  return (
    <div className="app">
      <AppChromeHeader />
      <main className="dashboard-shell">
        <header className="dashboard-header">
          <div>
            <span className="eyebrow">Pilotage</span>
            <h1>Bridge ERP Demo</h1>
          </div>
          <Link href="/runs" className="btn primary">
            <Icon name="sparkles" size={14} />
            <span>Assistant</span>
          </Link>
        </header>

        <section className="dashboard-metrics">
          {metrics.map((metric) => (
            <article className="dashboard-metric" key={metric.label}>
              <Icon name={metric.icon} size={16} />
              <span>{metric.label}</span>
              <strong>{metric.value}</strong>
            </article>
          ))}
        </section>

        <section className="dashboard-band">
          <div>
            <h2>Activite recente</h2>
            <p>Analyses lancees depuis cette session demo.</p>
          </div>
          {error ? (
            <div className="ai-error">
              <Icon name="bell" size={14} />
              <span>{error}</span>
            </div>
          ) : runs.length === 0 ? (
            <div className="empty">
              <div className="title">Aucune analyse</div>
              <div className="hint">Lance une premiere session depuis l'assistant.</div>
            </div>
          ) : (
            <div className="dashboard-run-table">
              {runs.slice(0, 8).map((run) => (
                <Link href="/runs" key={run.id} className="dashboard-run-row">
                  <span className="num">{new Date(run.startedAt).toLocaleDateString("fr-FR")}</span>
                  <strong>{run.tag ?? "analyse"}</strong>
                  <span>{run.status}</span>
                </Link>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
