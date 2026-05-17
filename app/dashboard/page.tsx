"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AppChromeHeader } from "@/components/AppChromeHeader";
import { Icon } from "@/components/Icon";
import {
  getDashboard,
  getOperatorDossiers,
  type DashboardSummary,
  type DossierSummary,
  type OperatorStats,
} from "@/lib/client";

export default function DashboardPage() {
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedOp, setSelectedOp] = useState<string | null>(null);
  const [opDossiers, setOpDossiers] = useState<DossierSummary[] | null>(null);
  const [opLoading, setOpLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const s = await getDashboard();
      setSummary(s);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!selectedOp) {
      setOpDossiers(null);
      return;
    }
    let cancelled = false;
    setOpLoading(true);
    getOperatorDossiers(selectedOp)
      .then((r) => {
        if (!cancelled) setOpDossiers(r.dossiers);
      })
      .catch((e) => {
        if (!cancelled) setOpDossiers([]);
        console.error(e);
      })
      .finally(() => {
        if (!cancelled) setOpLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedOp]);

  return (
    <div className="app">
      <AppChromeHeader />
      <main
        style={{
          flex: 1,
          minHeight: 0,
          maxWidth: 1100,
          margin: "0 auto",
          width: "100%",
          overflowY: "auto",
          padding: "24px 28px 80px",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 4,
          }}
        >
          <h1
            style={{
              fontFamily: "var(--serif)",
              fontWeight: 600,
              fontSize: 26,
              color: "var(--text-strong)",
              letterSpacing: "-0.01em",
              margin: 0,
            }}
          >
            Dashboard
          </h1>
          <button
            onClick={refresh}
            disabled={loading}
            className="ghost"
            style={{
              fontSize: 12,
              padding: "5px 12px",
              cursor: loading ? "not-allowed" : "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <Icon name="refresh" size={12} />
            {loading ? "Actualisation…" : "Actualiser"}
          </button>
        </div>
        <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 20 }}>
          Vue admin de l&apos;avancement par évaluateur. Cliquez une carte pour voir
          le détail des dossiers attribués.
        </p>

        {error && (
          <div
            style={{
              padding: "10px 14px",
              background: "var(--red-bg)",
              border: "1px solid var(--red-border)",
              borderRadius: "var(--radius-sm)",
              color: "var(--red)",
              fontSize: 13,
              marginBottom: 16,
            }}
          >
            {error}
            {error.includes("admin") && (
              <span>
                {" — "}
                <Link
                  href="/parametres"
                  style={{ color: "var(--red)", textDecoration: "underline" }}
                >
                  cocher la case admin dans Paramètres
                </Link>
              </span>
            )}
          </div>
        )}

        {summary && <GlobalSummary summary={summary} />}

        {summary && (
          <OperatorGrid
            operators={summary.operators}
            unassigned={summary.unassigned}
            selected={selectedOp}
            onSelect={setSelectedOp}
          />
        )}

        {selectedOp && (
          <OperatorDetail
            operator={selectedOp}
            dossiers={opDossiers}
            loading={opLoading}
            onClose={() => setSelectedOp(null)}
          />
        )}
      </main>
    </div>
  );
}

function GlobalSummary({ summary }: { summary: DashboardSummary }) {
  const tiles = useMemo(
    () => [
      {
        label: "Pool total",
        value: summary.poolTotal,
        color: "var(--text-strong)",
        bg: "var(--bg-subtle)",
      },
      {
        label: "Validés",
        value: summary.totalValidated,
        color: "var(--green)",
        bg: "var(--green-bg)",
      },
      {
        label: "En cours",
        value: summary.totalInProgress,
        color: "var(--amber)",
        bg: "var(--amber-bg)",
      },
      {
        label: "Inéligibles",
        value: summary.totalIneligibles,
        color: "var(--text-muted)",
        bg: "var(--bg-subtle)",
      },
      {
        label: "À traiter",
        value: summary.totalNotStarted,
        color: "var(--accent-strong)",
        bg: "var(--accent-tint)",
      },
    ],
    [summary]
  );

  return (
    <section
      className="pane"
      style={{ padding: 18, marginBottom: 16 }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: "var(--text-muted)",
          marginBottom: 12,
        }}
      >
        Avancement global
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 14 }}>
        <ProgressRing percent={summary.percentGlobal} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 14,
              color: "var(--text-strong)",
              fontWeight: 600,
              marginBottom: 4,
            }}
          >
            {summary.totalValidated + summary.totalIneligibles} dossier
            {summary.totalValidated + summary.totalIneligibles > 1 ? "s" : ""} traité
            {summary.totalValidated + summary.totalIneligibles > 1 ? "s" : ""} sur{" "}
            {summary.poolTotal}
          </div>
          <ProgressBar
            percent={summary.percentGlobal}
            tone="green"
          />
        </div>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
          gap: 10,
        }}
      >
        {tiles.map((t) => (
          <div
            key={t.label}
            style={{
              padding: "10px 12px",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--border-soft)",
              background: t.bg,
            }}
          >
            <div style={{ fontSize: 22, fontWeight: 700, color: t.color, lineHeight: 1.1 }}>
              {t.value}
            </div>
            <div
              style={{
                fontSize: 11,
                color: "var(--text-muted)",
                marginTop: 2,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                fontWeight: 600,
              }}
            >
              {t.label}
            </div>
          </div>
        ))}
      </div>
      {summary.unassigned > 0 && (
        <div
          style={{
            marginTop: 12,
            fontSize: 11.5,
            color: "var(--amber)",
            background: "var(--amber-bg)",
            border: "1px solid var(--amber-border)",
            borderRadius: "var(--radius-sm)",
            padding: "6px 10px",
          }}
        >
          ⚠ {summary.unassigned} dossier{summary.unassigned > 1 ? "s" : ""} touché
          {summary.unassigned > 1 ? "s" : ""} sans owner identifié (anciens fichiers
          ou évaluations sans champ <code>review.evaluateur</code>).
        </div>
      )}
    </section>
  );
}

function OperatorGrid({
  operators,
  unassigned,
  selected,
  onSelect,
}: {
  operators: OperatorStats[];
  unassigned: number;
  selected: string | null;
  onSelect: (op: string | null) => void;
}) {
  if (operators.length === 0 && unassigned === 0) {
    return (
      <section
        className="pane"
        style={{
          padding: 18,
          marginBottom: 16,
          textAlign: "center",
          color: "var(--text-muted)",
          fontSize: 13,
          fontStyle: "italic",
        }}
      >
        Aucun évaluateur n&apos;a encore touché de dossier.
      </section>
    );
  }
  return (
    <section className="pane" style={{ padding: 18, marginBottom: 16 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: "var(--text-muted)",
          marginBottom: 12,
        }}
      >
        Évaluateurs ({operators.length})
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
          gap: 12,
        }}
      >
        {operators.map((op) => (
          <OperatorCard
            key={op.operator}
            stats={op}
            selected={selected === op.operator}
            onClick={() =>
              onSelect(selected === op.operator ? null : op.operator)
            }
          />
        ))}
      </div>
    </section>
  );
}

function OperatorCard({
  stats,
  selected,
  onClick,
}: {
  stats: OperatorStats;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        textAlign: "left",
        padding: "14px 14px",
        background: selected ? "var(--accent-tint)" : "var(--bg-panel)",
        border: selected
          ? "1px solid color-mix(in srgb, var(--accent) 50%, var(--border))"
          : "1px solid var(--border)",
        borderRadius: "var(--radius)",
        cursor: "pointer",
        transition: "all 120ms ease",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <div
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: "var(--text-strong)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {stats.operator}
        </div>
        <div
          style={{
            fontSize: 14,
            fontWeight: 700,
            color: stats.percentDone >= 100 ? "var(--green)" : "var(--text-strong)",
          }}
        >
          {stats.percentDone}%
        </div>
      </div>
      <ProgressBar
        percent={stats.percentDone}
        tone={stats.percentDone >= 100 ? "green" : "accent"}
      />
      <div
        style={{
          display: "flex",
          gap: 12,
          fontSize: 11,
          color: "var(--text-muted)",
          flexWrap: "wrap",
        }}
      >
        <span>
          <strong style={{ color: "var(--green)" }}>{stats.validated}</strong> validés
        </span>
        <span>
          <strong style={{ color: "var(--amber)" }}>{stats.inProgress}</strong> en cours
        </span>
        {stats.ineligibles > 0 && (
          <span>
            <strong style={{ color: "var(--text)" }}>{stats.ineligibles}</strong>{" "}
            inéligibles
          </span>
        )}
        <span style={{ marginLeft: "auto" }}>{stats.bucketSize} au total</span>
      </div>
      {stats.lastActivity && (
        <div style={{ fontSize: 10.5, color: "var(--text-faint)" }}>
          dernière action : {new Date(stats.lastActivity).toLocaleString("fr-FR")}
        </div>
      )}
    </button>
  );
}

function OperatorDetail({
  operator,
  dossiers,
  loading,
  onClose,
}: {
  operator: string;
  dossiers: DossierSummary[] | null;
  loading: boolean;
  onClose: () => void;
}) {
  return (
    <section
      className="pane"
      style={{
        padding: 18,
        marginBottom: 16,
        borderColor: "color-mix(in srgb, var(--accent) 30%, var(--border))",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 12,
        }}
      >
        <div>
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              color: "var(--text-muted)",
            }}
          >
            Détail évaluateur
          </div>
          <div
            style={{
              fontSize: 18,
              fontWeight: 600,
              color: "var(--text-strong)",
              marginTop: 2,
            }}
          >
            {operator}
          </div>
        </div>
        <button
          onClick={onClose}
          className="ghost"
          style={{ fontSize: 12, padding: "4px 10px", cursor: "pointer" }}
        >
          Fermer
        </button>
      </div>
      {loading && (
        <div style={{ color: "var(--text-muted)", fontSize: 13, padding: 12 }}>
          Chargement…
        </div>
      )}
      {!loading && dossiers && dossiers.length === 0 && (
        <div
          style={{
            color: "var(--text-muted)",
            fontSize: 13,
            padding: 12,
            fontStyle: "italic",
          }}
        >
          Aucun dossier attribué à cet évaluateur.
        </div>
      )}
      {!loading && dossiers && dossiers.length > 0 && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            maxHeight: "60vh",
            overflowY: "auto",
          }}
        >
          {dossiers.map((d) => (
            <DossierRow key={d.id} d={d} />
          ))}
        </div>
      )}
    </section>
  );
}

function DossierRow({ d }: { d: DossierSummary }) {
  const statusInfo = STATUS_INFO[d.status];
  return (
    <Link
      href={`/evaluation?id=${encodeURIComponent(d.id)}`}
      style={{
        display: "grid",
        gridTemplateColumns: "1fr auto auto",
        alignItems: "center",
        gap: 10,
        padding: "8px 12px",
        borderRadius: "var(--radius-sm)",
        background: "var(--bg-subtle)",
        border: "1px solid var(--border-soft)",
        textDecoration: "none",
        color: "inherit",
        transition: "background 120ms",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--accent-tint)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "var(--bg-subtle)")}
    >
      <div
        style={{
          fontFamily: "var(--mono)",
          fontSize: 12,
          color: "var(--text-strong)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {d.id}
      </div>
      <span
        style={{
          padding: "2px 8px",
          borderRadius: "var(--radius-pill)",
          fontSize: 10.5,
          fontWeight: 600,
          color: statusInfo.color,
          background: statusInfo.bg,
          border: `1px solid color-mix(in srgb, ${statusInfo.color} 30%, transparent)`,
          whiteSpace: "nowrap",
        }}
      >
        {statusInfo.label}
      </span>
      <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
        {d.validatedAt
          ? new Date(d.validatedAt).toLocaleDateString("fr-FR")
          : d.mtime
          ? new Date(d.mtime).toLocaleDateString("fr-FR")
          : ""}
      </span>
    </Link>
  );
}

const STATUS_INFO: Record<
  DossierSummary["status"],
  { label: string; color: string; bg: string }
> = {
  valide: { label: "Validé", color: "var(--green)", bg: "var(--green-bg)" },
  en_review: { label: "En cours", color: "var(--amber)", bg: "var(--amber-bg)" },
  eligibilite_ok: { label: "Eligible - à noter", color: "var(--accent-strong)", bg: "var(--accent-tint)" },
  ineligible: {
    label: "Inéligible",
    color: "var(--text-muted)",
    bg: "var(--bg-subtle)",
  },
  a_faire: { label: "À traiter", color: "var(--accent-strong)", bg: "var(--accent-tint)" },
};

function ProgressBar({
  percent,
  tone,
}: {
  percent: number;
  tone: "green" | "accent";
}) {
  const color = tone === "green" ? "var(--green)" : "var(--accent)";
  return (
    <div
      style={{
        height: 6,
        background: "var(--bg-subtle)",
        borderRadius: 999,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          width: `${Math.min(100, Math.max(0, percent))}%`,
          height: "100%",
          background: color,
          transition: "width 200ms ease",
        }}
      />
    </div>
  );
}

function ProgressRing({ percent }: { percent: number }) {
  const size = 64;
  const stroke = 6;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c - (Math.min(100, Math.max(0, percent)) / 100) * c;
  return (
    <div style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke="var(--border)"
          strokeWidth={stroke}
          fill="none"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke="var(--green)"
          strokeWidth={stroke}
          fill="none"
          strokeDasharray={c}
          strokeDashoffset={offset}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: "stroke-dashoffset 300ms ease" }}
        />
      </svg>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 14,
          fontWeight: 700,
          color: "var(--text-strong)",
        }}
      >
        {percent}%
      </div>
    </div>
  );
}
