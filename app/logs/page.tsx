"use client";
import Link from "next/link";
import { useEffect, useState, useCallback, useMemo } from "react";
import { AppChromeHeader } from "@/components/AppChromeHeader";
import { Icon } from "@/components/Icon";
import { CostsDashboard } from "@/components/CostsDashboard";

interface AuditEvent {
  event_id: string;
  timestamp: string;
  actor_id: string;
  actor_role?: string;
  action: string;
  resource_type: string;
  resource_id?: string;
  resource_label?: string;
  result: "success" | "failure" | "denied";
  reason?: string;
  client_ip?: string;
  app_version?: string;
  metadata?: Record<string, unknown>;
  prev_hash: string;
  hash: string;
}

interface AuditQueryResult {
  events: AuditEvent[];
  total: number;
  truncated: boolean;
}

interface AuditStats {
  total: number;
  windowDays: number;
  byAction: { action: string; count: number }[];
  byActor: { actor_id: string; count: number }[];
  failureCount: number;
  topResources: { resource_type: string; resource_id?: string; count: number }[];
}

interface IntegrityResult {
  valid: boolean;
  totalChecked: number;
  brokenAt?: number;
  reason?: string;
}

const ACTION_LABELS: Record<string, { label: string; color: string }> = {
  "evaluation.run.start": { label: "Lancer évaluation", color: "var(--accent)" },
  "rule.improve.run.start": { label: "Proposer une règle", color: "var(--accent)" },
  "claude.run.start": { label: "Run Claude libre", color: "var(--text-muted)" },
  "dossier.file.read": { label: "Consultation fichier", color: "var(--blue)" },
  "evaluation.review.update": { label: "Validation review", color: "var(--green)" },
  "proposition.promote": { label: "Promouvoir proposition", color: "var(--green)" },
  "proposition.reject": { label: "Rejeter proposition", color: "var(--red)" },
  "proposition.decide": { label: "Décision proposition", color: "var(--text-muted)" },
  "config.update": { label: "Modification config", color: "var(--amber)" },
  "export.xlsx": { label: "Export xlsx", color: "var(--accent-strong)" },
  "audit.read": { label: "Consultation logs", color: "var(--text-muted)" },
  "audit.integrity_check": { label: "Vérif intégrité", color: "var(--text-muted)" },
};

const RESULT_STYLE: Record<AuditEvent["result"], { label: string; color: string; bg: string }> = {
  success: { label: "OK", color: "var(--green)", bg: "var(--green-bg)" },
  failure: { label: "Échec", color: "var(--red)", bg: "var(--red-bg)" },
  denied: { label: "Refusé", color: "var(--red)", bg: "var(--red-bg)" },
};

interface AppConfig {
  isAdmin?: boolean;
  currentUser?: string;
}

type LogsTab = "rgpd" | "couts";

export default function LogsPage() {
  const [profile, setProfile] = useState<AppConfig>({});
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<AuditQueryResult | null>(null);
  const [stats, setStats] = useState<AuditStats | null>(null);
  const [integrity, setIntegrity] = useState<IntegrityResult | null>(null);
  const [checkingIntegrity, setCheckingIntegrity] = useState(false);
  const [filterAction, setFilterAction] = useState<string>("");
  const [filterActor, setFilterActor] = useState<string>("");
  const [filterResult, setFilterResult] = useState<string>("");
  const [filterDays, setFilterDays] = useState<number>(30);
  const [openDetail, setOpenDetail] = useState<AuditEvent | null>(null);
  const [tab, setTab] = useState<LogsTab>("couts");

  useEffect(() => {
    fetch("/api/app-config")
      .then((r) => r.json())
      .then((j: { config?: AppConfig }) => setProfile(j.config ?? {}))
      .catch(() => {});
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const fromIso = new Date(Date.now() - filterDays * 86400000).toISOString();
      const qs = new URLSearchParams({ from: fromIso, limit: "500" });
      if (filterAction) qs.set("action", filterAction);
      if (filterActor) qs.set("actor_id", filterActor);
      if (filterResult) qs.set("result", filterResult);
      const [logsRes, statsRes] = await Promise.all([
        fetch(`/api/audit-log?${qs}`),
        fetch(`/api/audit-log/stats?days=${filterDays}`),
      ]);
      if (!logsRes.ok) throw new Error(await logsRes.text());
      setData((await logsRes.json()) as AuditQueryResult);
      if (statsRes.ok) setStats((await statsRes.json()) as AuditStats);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [filterAction, filterActor, filterResult, filterDays]);

  useEffect(() => {
    if (profile.isAdmin) {
      refresh();
    } else {
      setLoading(false);
    }
  }, [profile.isAdmin, refresh]);

  async function checkIntegrity() {
    setCheckingIntegrity(true);
    try {
      const r = await fetch("/api/audit-log/integrity");
      if (!r.ok) throw new Error(await r.text());
      setIntegrity((await r.json()) as IntegrityResult);
    } catch (e) {
      setIntegrity({ valid: false, totalChecked: 0, reason: (e as Error).message });
    } finally {
      setCheckingIntegrity(false);
    }
  }

  const uniqueActors = useMemo(() => {
    if (!stats) return [];
    return stats.byActor.map((a) => a.actor_id);
  }, [stats]);

  if (!profile.isAdmin) {
    return (
      <div className="app">
        <AppChromeHeader user={profile.currentUser ?? "Non connecté"} />
        <main
          style={{
            padding: "32px 28px",
            maxWidth: 720,
            margin: "0 auto",
            width: "100%",
          }}
        >
          <div
            style={{
              padding: "24px",
              background: "var(--red-bg)",
              border: "1px solid var(--red-border)",
              borderRadius: "var(--radius)",
              fontSize: 13,
              color: "var(--text)",
              lineHeight: 1.6,
            }}
          >
            <h1 style={{ fontSize: 16, color: "var(--red)", marginBottom: 8 }}>
              Accès réservé
            </h1>
            Le journal de traçabilité RGPD est accessible uniquement aux administrateurs.
            Recommandation CNIL n° 2021-122 : les logs ne doivent pas être accessibles
            aux personnes dont l&apos;activité est tracée.
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="app">
      <AppChromeHeader user={profile.currentUser ?? "admin"} />
      <main
        style={{
          padding: "28px 28px 80px",
          maxWidth: 1200,
          margin: "0 auto",
          width: "100%",
          overflowY: "auto",
        }}
      >
        <Link
          href="/parametres"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12,
            color: "var(--text-muted)",
            textDecoration: "none",
            marginBottom: 12,
            padding: "4px 10px 4px 6px",
            borderRadius: "var(--radius-sm)",
            border: "1px solid var(--border-soft)",
            background: "var(--bg-panel)",
            width: "fit-content",
            transition: "all 120ms ease",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--bg-subtle)";
            e.currentTarget.style.color = "var(--text-strong)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "var(--bg-panel)";
            e.currentTarget.style.color = "var(--text-muted)";
          }}
        >
          <Icon name="arrow-left" size={12} /> Retour aux paramètres
        </Link>
        <div style={{ display: "flex", alignItems: "flex-start", marginBottom: 14, gap: 12 }}>
          <div style={{ flex: 1 }}>
            <h1
              style={{
                fontFamily: "var(--serif)",
                fontWeight: 600,
                fontSize: 24,
                color: "var(--text-strong)",
                letterSpacing: "-0.01em",
              }}
            >
              Logs
            </h1>
            <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 4, lineHeight: 1.55 }}>
              Coûts Claude et journal RGPD des actions sensibles. Conformité CNIL n° 2021-122,
              conservation 12 mois glissants pour les logs métier.
            </p>
          </div>
        </div>

        {/* Tab bar */}
        <div
          style={{
            display: "flex",
            gap: 4,
            borderBottom: "1px solid var(--border)",
            marginBottom: 18,
          }}
        >
          {([
            { id: "couts", label: "Coûts Claude" },
            { id: "rgpd", label: "Journal RGPD" },
          ] as { id: LogsTab; label: string }[]).map((t) => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                style={{
                  background: "transparent",
                  border: "none",
                  padding: "8px 14px",
                  fontSize: 13,
                  fontWeight: 500,
                  color: active ? "var(--text-strong)" : "var(--text-muted)",
                  borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
                  marginBottom: -1,
                  cursor: "pointer",
                }}
              >
                {t.label}
              </button>
            );
          })}
        </div>

        {tab === "couts" && (
          <section style={{ marginBottom: 24 }}>
            <CostsDashboard targetCount={2000} />
          </section>
        )}

        {tab === "rgpd" && stats && (
          <section style={{ marginBottom: 18 }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                gap: 10,
              }}
            >
              <StatCard label="Événements" value={stats.total} hint={`Sur ${stats.windowDays} j`} />
              <StatCard
                label="Échecs / refus"
                value={stats.failureCount}
                tone={stats.failureCount > 0 ? "warn" : "ok"}
              />
              <StatCard
                label="Utilisateurs actifs"
                value={stats.byActor.length}
              />
              <StatCard
                label="Action la + fréquente"
                valueText={stats.byAction[0]?.action ?? "-"}
                hint={stats.byAction[0] ? `${stats.byAction[0].count} fois` : undefined}
              />
            </div>
          </section>
        )}

        {tab === "rgpd" && (
        <section
          className="pane"
          style={{ padding: 14, marginBottom: 14 }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
              gap: 10,
              marginBottom: 10,
            }}
          >
            <Field label="Période">
              <select
                value={filterDays}
                onChange={(e) => setFilterDays(Number(e.target.value))}
                style={{ width: "100%", fontSize: 13, padding: "5px 8px" }}
              >
                <option value={1}>Dernières 24 h</option>
                <option value={7}>7 derniers jours</option>
                <option value={30}>30 derniers jours</option>
                <option value={90}>3 derniers mois</option>
                <option value={365}>1 an</option>
              </select>
            </Field>
            <Field label="Action">
              <select
                value={filterAction}
                onChange={(e) => setFilterAction(e.target.value)}
                style={{ width: "100%", fontSize: 13, padding: "5px 8px" }}
              >
                <option value="">Toutes</option>
                {Object.entries(ACTION_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Utilisateur">
              <select
                value={filterActor}
                onChange={(e) => setFilterActor(e.target.value)}
                style={{ width: "100%", fontSize: 13, padding: "5px 8px" }}
              >
                <option value="">Tous</option>
                {uniqueActors.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Résultat">
              <select
                value={filterResult}
                onChange={(e) => setFilterResult(e.target.value)}
                style={{ width: "100%", fontSize: 13, padding: "5px 8px" }}
              >
                <option value="">Tous</option>
                <option value="success">Succès</option>
                <option value="failure">Échec</option>
                <option value="denied">Refusé</option>
              </select>
            </Field>
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button
              onClick={refresh}
              className="ghost"
              disabled={loading}
              style={{ fontSize: 12, padding: "6px 12px" }}
            >
              <Icon name="refresh" size={12} /> Actualiser
            </button>
            <button
              onClick={checkIntegrity}
              disabled={checkingIntegrity}
              className="ghost"
              style={{ fontSize: 12, padding: "6px 12px" }}
            >
              {checkingIntegrity ? "Vérif..." : "Vérifier l'intégrité"}
            </button>
          </div>
        </section>
        )}

        {tab === "rgpd" && integrity && (
          <div
            style={{
              padding: "10px 14px",
              borderRadius: "var(--radius-sm)",
              marginBottom: 12,
              fontSize: 13,
              background: integrity.valid ? "var(--green-bg)" : "var(--red-bg)",
              border: integrity.valid
                ? "1px solid var(--green-border)"
                : "1px solid var(--red-border)",
              color: "var(--text)",
            }}
          >
            {integrity.valid ? (
              <>
                <strong style={{ color: "var(--green)" }}>✓ Chaîne de hash valide</strong>{" "}
                — {integrity.totalChecked} entrées vérifiées, aucune altération détectée.
              </>
            ) : (
              <>
                <strong style={{ color: "var(--red)" }}>✗ Chaîne corrompue</strong>{" "}
                — {integrity.reason}
                {integrity.brokenAt
                  ? ` (entrée n° ${integrity.brokenAt})`
                  : null}
                . Vérifié sur {integrity.totalChecked} entrées avant rupture.
              </>
            )}
          </div>
        )}

        {tab === "rgpd" && loading && (
          <div style={{ padding: 24, color: "var(--text-muted)", fontSize: 13 }}>
            Chargement…
          </div>
        )}

        {tab === "rgpd" && !loading && data && (
          <section
            className="pane"
            style={{ padding: 0, overflow: "hidden" }}
          >
            <div
              style={{
                padding: "8px 14px",
                background: "var(--bg-subtle)",
                borderBottom: "1px solid var(--border)",
                fontSize: 11,
                color: "var(--text-muted)",
                display: "flex",
                gap: 12,
                alignItems: "center",
              }}
            >
              <span>
                {data.events.length} entrées affichées
                {data.truncated ? ` (sur ${data.total} correspondantes, tronqué)` : ""}
              </span>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: 12,
                }}
              >
                <thead>
                  <tr
                    style={{
                      background: "var(--bg-subtle)",
                      borderBottom: "1px solid var(--border)",
                    }}
                  >
                    <Th>Date</Th>
                    <Th>Utilisateur</Th>
                    <Th>Action</Th>
                    <Th>Ressource</Th>
                    <Th>Résultat</Th>
                    <Th>Détail</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.events.length === 0 && (
                    <tr>
                      <td
                        colSpan={6}
                        style={{
                          padding: 24,
                          textAlign: "center",
                          color: "var(--text-muted)",
                          fontStyle: "italic",
                        }}
                      >
                        Aucun événement pour ces filtres.
                      </td>
                    </tr>
                  )}
                  {data.events.map((ev) => {
                    const meta = ACTION_LABELS[ev.action];
                    const result = RESULT_STYLE[ev.result];
                    return (
                      <tr
                        key={ev.event_id}
                        style={{
                          borderBottom: "1px solid var(--border-soft)",
                        }}
                      >
                        <Td>
                          <span
                            style={{
                              fontFamily: "var(--mono)",
                              fontSize: 11,
                              color: "var(--text-muted)",
                            }}
                          >
                            {new Date(ev.timestamp).toLocaleString("fr-FR")}
                          </span>
                        </Td>
                        <Td>
                          <strong>{ev.actor_id}</strong>
                          {ev.actor_role === "admin" && (
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
                                marginLeft: 6,
                              }}
                            >
                              admin
                            </span>
                          )}
                        </Td>
                        <Td>
                          <span
                            style={{
                              color: meta?.color ?? "var(--text)",
                              fontWeight: 500,
                            }}
                          >
                            {meta?.label ?? ev.action}
                          </span>
                          <div
                            style={{
                              fontSize: 10,
                              color: "var(--text-faint)",
                              fontFamily: "var(--mono)",
                              marginTop: 1,
                            }}
                          >
                            {ev.action}
                          </div>
                        </Td>
                        <Td>
                          <span
                            style={{
                              fontSize: 10.5,
                              color: "var(--text-muted)",
                              fontFamily: "var(--mono)",
                            }}
                          >
                            {ev.resource_type}
                          </span>
                          {ev.resource_id && (
                            <div
                              style={{
                                fontFamily: "var(--mono)",
                                fontSize: 11,
                                color: "var(--text)",
                                marginTop: 1,
                                maxWidth: 220,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                              title={ev.resource_id}
                            >
                              {ev.resource_label || ev.resource_id}
                            </div>
                          )}
                        </Td>
                        <Td>
                          <span
                            style={{
                              fontSize: 11,
                              padding: "2px 8px",
                              borderRadius: "var(--radius-sm)",
                              color: result.color,
                              background: result.bg,
                              fontWeight: 500,
                            }}
                          >
                            {result.label}
                          </span>
                        </Td>
                        <Td>
                          <button
                            onClick={() => setOpenDetail(ev)}
                            className="ghost"
                            style={{ fontSize: 11, padding: "3px 8px" }}
                          >
                            Voir JSON
                          </button>
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {tab === "rgpd" && (
        <footer
          style={{
            marginTop: 24,
            padding: "14px 16px",
            background: "var(--bg-subtle)",
            border: "1px solid var(--border-soft)",
            borderRadius: "var(--radius-sm)",
            fontSize: 11,
            color: "var(--text-muted)",
            lineHeight: 1.6,
          }}
        >
          <strong style={{ color: "var(--text-strong)" }}>Politique de journalisation</strong>
          <br />
          Base légale : article 32 RGPD (sécurité du traitement) et article 5.2
          (responsabilité). Référentiel : recommandation CNIL n° 2021-122 du 14
          octobre 2021. Format : JSONL append-only avec hash SHA-256 chaîné
          (tamper-evident). Champs personnels : identifiant utilisateur,
          horodatage, action, ressource, IP locale. <strong>Aucune donnée des
          dossiers candidats n&apos;est dupliquée dans le journal</strong>{" "}
          (référencement par identifiant uniquement). Conservation : 12 mois
          glissants pour les logs métier, 6 mois pour les logs techniques. Les
          consultations de cette page sont elles-mêmes journalisées (méta-log).
        </footer>
        )}
      </main>

      {openDetail && (
        <DetailModal event={openDetail} onClose={() => setOpenDetail(null)} />
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span
        style={{
          fontSize: 10,
          color: "var(--text-muted)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          fontWeight: 600,
        }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      style={{
        padding: "8px 12px",
        textAlign: "left",
        fontSize: 10,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        color: "var(--text-muted)",
      }}
    >
      {children}
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return (
    <td style={{ padding: "8px 12px", verticalAlign: "top" }}>{children}</td>
  );
}

function StatCard({
  label,
  value,
  valueText,
  hint,
  tone,
}: {
  label: string;
  value?: number;
  valueText?: string;
  hint?: string;
  tone?: "ok" | "warn";
}) {
  return (
    <div
      className="pane"
      style={{
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <span
        style={{
          fontSize: 10,
          color: "var(--text-muted)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          fontWeight: 600,
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontFamily: value !== undefined ? "var(--serif)" : "var(--mono)",
          fontSize: value !== undefined ? 22 : 13,
          fontWeight: 600,
          color: tone === "warn" ? "var(--red)" : "var(--text-strong)",
        }}
      >
        {value !== undefined ? value : valueText}
      </span>
      {hint && (
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{hint}</span>
      )}
    </div>
  );
}

function DetailModal({
  event,
  onClose,
}: {
  event: AuditEvent;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "color-mix(in srgb, var(--text-strong) 40%, transparent)",
        backdropFilter: "blur(2px)",
        zIndex: 60,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div
        style={{
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          boxShadow: "var(--shadow-lg)",
          width: "min(720px, 100%)",
          maxHeight: "90vh",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <header
          style={{
            padding: "12px 18px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
          }}
        >
          <div style={{ fontWeight: 600, fontSize: 14, color: "var(--text-strong)" }}>
            Détail événement
          </div>
          <span
            style={{
              fontSize: 10,
              color: "var(--text-muted)",
              fontFamily: "var(--mono)",
              marginLeft: 12,
            }}
          >
            {event.event_id}
          </span>
          <button
            onClick={onClose}
            className="ghost"
            aria-label="Fermer"
            style={{ marginLeft: "auto", padding: "4px 8px" }}
          >
            <Icon name="close" size={14} />
          </button>
        </header>
        <div style={{ padding: 14, overflowY: "auto", flex: 1 }}>
          <pre
            style={{
              fontFamily: "var(--mono)",
              fontSize: 12,
              background: "var(--bg-subtle)",
              border: "1px solid var(--border-soft)",
              borderRadius: "var(--radius-sm)",
              padding: 12,
              margin: 0,
              overflowX: "auto",
              lineHeight: 1.5,
              color: "var(--text)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
            }}
          >
            {JSON.stringify(event, null, 2)}
          </pre>
          <div
            style={{
              fontSize: 11,
              color: "var(--text-muted)",
              marginTop: 10,
              padding: "8px 10px",
              background: "var(--bg-subtle)",
              borderRadius: "var(--radius-sm)",
            }}
          >
            <strong style={{ color: "var(--text)" }}>prev_hash</strong>{" "}
            <span style={{ fontFamily: "var(--mono)" }}>
              {event.prev_hash.slice(0, 24)}…
            </span>
            <br />
            <strong style={{ color: "var(--text)" }}>hash</strong>{" "}
            <span style={{ fontFamily: "var(--mono)" }}>
              {event.hash.slice(0, 24)}…
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
