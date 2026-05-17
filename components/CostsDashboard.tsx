"use client";
/**
 * Dashboard d'analyse des coûts Claude pour les runs d'évaluation FAE.
 *
 * Lit /api/evaluations/costs (qui agrège data/evaluations/ + outputDir NAS).
 * Affiche : vue globale, breakdown par modèle, par dossier (triable),
 * courbe quotidienne 14 derniers jours, top 10 dossiers les plus chers,
 * projection sur 296 dossiers 7e.
 *
 * Pas de lib chart externe : barres en CSS pur (block + width %).
 */
import { useEffect, useMemo, useRef, useState } from "react";

interface ModelTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate5m: number;
  cacheCreate1h: number;
}

interface RunCost {
  dossierId: string;
  costUsd: number;
  durationMs: number;
  success: boolean;
  model: string;
  tokens: ModelTokens;
  ts: number;
}

interface ByModel {
  model: string;
  count: number;
  costUsd: number;
  durationMs: number;
  tokens: ModelTokens;
}

interface ByDay {
  day: string;
  costUsd: number;
  count: number;
}

export interface CostsData {
  costs: RunCost[];
  total: number;
  avg: number;
  count: number;
  totalDurationMs?: number;
  tokensTotals?: ModelTokens;
  cacheHitRate?: number;
  byModel?: ByModel[];
  byDay?: ByDay[];
  top10?: RunCost[];
  sources?: string[];
  pricingMeta?: {
    updatedAt: string | null;
    source: string | null;
    usingDefault: boolean;
  };
  configuredModel?: string | null;
}

function normalizeModelId(m: string): string {
  // Match les alias "sonnet" / "haiku" / "opus" aux IDs full versionnés.
  const lower = m.toLowerCase();
  if (lower === "sonnet") return "claude-sonnet";
  if (lower === "haiku") return "claude-haiku";
  if (lower === "opus") return "claude-opus";
  return lower.replace(/-\d{8}$/, "");
}

type SortKey = "ts" | "costUsd" | "durationMs" | "model" | "dossierId";

const MODEL_COLOR: Record<string, string> = {
  "claude-sonnet-4-6": "var(--accent)",
  "claude-sonnet-4-5": "var(--accent-strong)",
  "claude-opus-4-7": "var(--purple)",
  "claude-opus-4-6": "var(--purple)",
  "claude-haiku-4-5": "var(--blue)",
};

function modelColor(m: string): string {
  return MODEL_COLOR[m] ?? "var(--text-muted)";
}

function modelShort(m: string): string {
  if (!m) return "-";
  return m.replace(/^claude-/, "");
}

function formatDuration(ms: number): string {
  if (!ms || ms < 0) return "-";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function formatUsd(v: number, digits = 4): string {
  return `$${v.toFixed(digits)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)} M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)} k`;
  return n.toLocaleString("fr-FR");
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function dayLabel(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${d}/${m}`;
}

/** Calcule un range continu de N jours (YYYY-MM-DD) finissant aujourd'hui. */
function lastNDays(n: number): string[] {
  const out: string[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    out.push(key);
  }
  return out;
}

interface Props {
  /** Nombre total de dossiers ciblés pour la projection. Persisté via localStorage. */
  targetCount?: number;
}

const PROJECTION_KEY = "fae.costs.projectionTarget";

export function CostsDashboard({ targetCount: initialTarget = 2000 }: Props) {
  const [targetCount, setTargetCount] = useState<number>(() => {
    if (typeof window === "undefined") return initialTarget;
    const v = window.localStorage.getItem(PROJECTION_KEY);
    const n = v ? Number(v) : NaN;
    return Number.isFinite(n) && n > 0 ? n : initialTarget;
  });
  function commitTarget(n: number) {
    if (!Number.isFinite(n) || n <= 0) return;
    setTargetCount(Math.round(n));
    try { window.localStorage.setItem(PROJECTION_KEY, String(Math.round(n))); } catch {}
  }

  const [data, setData] = useState<CostsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("ts");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [openRow, setOpenRow] = useState<RunCost | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    let cancel = false;
    setLoading(true);
    setError(null);
    fetch("/api/evaluations/costs")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j: CostsData) => {
        if (!cancel) setData(j);
      })
      .catch((e: Error) => {
        if (!cancel) setError(e.message);
      })
      .finally(() => {
        if (!cancel) setLoading(false);
      });
    return () => {
      cancel = true;
    };
  }, [refreshTick]);

  const sorted = useMemo(() => {
    if (!data) return [];
    const arr = [...data.costs];
    arr.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "ts":
          cmp = a.ts - b.ts;
          break;
        case "costUsd":
          cmp = a.costUsd - b.costUsd;
          break;
        case "durationMs":
          cmp = a.durationMs - b.durationMs;
          break;
        case "model":
          cmp = a.model.localeCompare(b.model);
          break;
        case "dossierId":
          cmp = a.dossierId.localeCompare(b.dossierId);
          break;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [data, sortKey, sortDir]);

  const dailySeries = useMemo(() => {
    if (!data?.byDay) return [];
    const map = new Map(data.byDay.map((d) => [d.day, d]));
    return lastNDays(14).map((day) => {
      const e = map.get(day);
      return { day, costUsd: e?.costUsd ?? 0, count: e?.count ?? 0 };
    });
  }, [data]);

  const dailyMax = useMemo(() => {
    return Math.max(0.001, ...dailySeries.map((d) => d.costUsd));
  }, [dailySeries]);

  if (loading && !data) {
    return (
      <div style={{ padding: 24, color: "var(--text-muted)", fontSize: 13 }}>
        Chargement du rapport de coûts...
      </div>
    );
  }

  if (error) {
    return (
      <div
        style={{
          padding: "12px 14px",
          background: "var(--red-bg)",
          border: "1px solid var(--red-border)",
          borderRadius: "var(--radius-sm)",
          fontSize: 13,
          color: "var(--text)",
        }}
      >
        Echec chargement coûts : {error}
      </div>
    );
  }

  if (!data || data.count === 0) {
    return (
      <div
        style={{
          padding: "16px 18px",
          border: "1px dashed var(--border)",
          borderRadius: "var(--radius)",
          color: "var(--text-muted)",
          fontSize: 13,
          lineHeight: 1.6,
        }}
      >
        Aucun run d&apos;évaluation n&apos;a encore généré d&apos;event.
        Lance une évaluation depuis le dashboard pour commencer à mesurer.
        {data?.sources && data.sources.length > 0 && (
          <div style={{ marginTop: 8, fontSize: 11, fontFamily: "var(--mono)", color: "var(--text-faint)" }}>
            Sources scannées :
            <ul style={{ marginTop: 4 }}>
              {data.sources.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }

  const tokenStats = data.tokensTotals ?? { input: 0, output: 0, cacheRead: 0, cacheCreate5m: 0, cacheCreate1h: 0 };
  const cacheHit = (data.cacheHitRate ?? 0) * 100;
  const totalCacheTokens = tokenStats.cacheCreate5m + tokenStats.cacheCreate1h + tokenStats.cacheRead;
  // Coût moyen ADAPTÉ au modèle config courant. Si on a des runs sur ce modèle,
  // on prend leur coût moyen ; sinon on fallback sur la moyenne historique globale.
  const configuredModel = data.configuredModel;
  const modelStat = configuredModel
    ? data.byModel?.find((m) => {
        const a = m.model.toLowerCase();
        const b = configuredModel.toLowerCase();
        // alias "sonnet" matche claude-sonnet-*, etc.
        if (["sonnet", "haiku", "opus"].includes(b)) return a.includes(`claude-${b}`);
        return a === b || a.startsWith(b) || b.startsWith(a);
      })
    : undefined;
  const projectionUnit = modelStat && modelStat.count > 0 ? modelStat.costUsd / modelStat.count : data.avg;
  const projectionLabel = modelStat
    ? `sur ${modelStat.count} run${modelStat.count > 1 ? "s" : ""} ${modelShort(modelStat.model)}`
    : configuredModel
    ? `modèle ${configuredModel} jamais utilisé — base moyenne historique`
    : "au rythme actuel";
  const projection = projectionUnit * targetCount;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {/* Header + bouton refresh */}
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
        <div>
          <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--text-strong)", margin: 0 }}>
            Dashboard coûts Claude
          </h2>
          <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 3, lineHeight: 1.5 }}>
            Lecture des events .jsonl persistés ({data.count} run{data.count > 1 ? "s" : ""} agrégé{data.count > 1 ? "s" : ""}).
            Source de vérité officielle : console.anthropic.com / Pro Plan.
            {data.sources && data.sources.length > 0 && (
              <span style={{ display: "block", marginTop: 2, fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-faint)" }}>
                {data.sources.join("  +  ")}
              </span>
            )}
          </p>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <ShowTariffsButton />
          <RefreshTariffsButton onDone={() => setRefreshTick((t) => t + 1)} pricingMeta={data.pricingMeta} />
          <button
            className="ghost"
            onClick={() => setRefreshTick((t) => t + 1)}
            disabled={loading}
            style={{ fontSize: 11, padding: "5px 12px" }}
          >
            {loading ? "Actualisation..." : "Actualiser"}
          </button>
        </div>
      </div>

      {/* Vue globale */}
      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          gap: 10,
        }}
      >
        <BigStat label="Coût total" value={formatUsd(data.total, 2)} hint={`${data.count} run${data.count > 1 ? "s" : ""}`} accent />
        <BigStat label="Coût moyen / dossier" value={formatUsd(data.avg, 4)} />
        <EditableProjectionStat
          targetCount={targetCount}
          onChange={commitTarget}
          projection={projection}
          hint={projectionLabel}
        />
        <BigStat label="Durée totale" value={formatDuration(data.totalDurationMs ?? 0)} hint={`moy. ${formatDuration((data.totalDurationMs ?? 0) / Math.max(1, data.count))}`} />
        <BigStat
          label="Tokens entrée"
          value={formatTokens(tokenStats.input + tokenStats.cacheRead + tokenStats.cacheCreate5m + tokenStats.cacheCreate1h)}
          hint={`${formatTokens(tokenStats.input)} hors cache`}
          tooltip="Total des tokens d'entrée envoyés à Claude (prompt + skill + dossier + cache). Inclut les tokens lus depuis le cache (moins chers)."
        />
        <BigStat
          label="Tokens sortie"
          value={formatTokens(tokenStats.output)}
          hint="texte généré par Claude"
          tooltip="Tokens de texte écrits directement par Claude entre 2 tool calls. NE COMPTE PAS le contenu écrit via Write/Edit (qui passe en input des tools). Pour les évaluations qui utilisent surtout Write, ce nombre reste bas - c'est normal."
        />
        <BigStat
          label="Cache hit rate"
          value={`${cacheHit.toFixed(1)} %`}
          hint={`${formatTokens(tokenStats.cacheRead)} lus / ${formatTokens(totalCacheTokens)}`}
          tone={cacheHit > 60 ? "ok" : cacheHit < 30 ? "warn" : undefined}
          tooltip="% des tokens d'entrée lus depuis le cache Anthropic (système prompt + skills réutilisés). Le cache coûte 10× moins cher que les tokens normaux. Un taux > 60 % est bon, > 80 % excellent. Plus ton skill est stable et tes runs proches dans le temps, plus le cache marche."
        />
      </section>

      {/* Par modèle */}
      {data.byModel && data.byModel.length > 0 && (
        <section>
          <SectionTitle>Répartition par modèle</SectionTitle>
          <div className="pane" style={{ padding: 0, overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ background: "var(--bg-subtle)" }}>
                  <Th>Modèle</Th>
                  <Th align="right">Runs</Th>
                  <Th align="right">Coût total</Th>
                  <Th align="right">Coût moyen</Th>
                  <Th align="right">Tokens entrée</Th>
                  <Th align="right">Tokens sortie</Th>
                  <Th align="right">Cache lu</Th>
                  <Th>Part du total</Th>
                </tr>
              </thead>
              <tbody>
                {data.byModel.map((m) => {
                  const pct = data.total > 0 ? (m.costUsd / data.total) * 100 : 0;
                  return (
                    <tr key={m.model} style={{ borderTop: "1px solid var(--border-soft)" }}>
                      <Td>
                        <span
                          style={{
                            display: "inline-block",
                            width: 8,
                            height: 8,
                            borderRadius: "50%",
                            background: modelColor(m.model),
                            marginRight: 6,
                            verticalAlign: "middle",
                          }}
                        />
                        <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-strong)" }}>
                          {modelShort(m.model)}
                        </span>
                      </Td>
                      <Td align="right">{m.count}</Td>
                      <Td align="right" mono strong>
                        {formatUsd(m.costUsd, 3)}
                      </Td>
                      <Td align="right" mono>
                        {formatUsd(m.costUsd / Math.max(1, m.count), 4)}
                      </Td>
                      <Td align="right" mono muted>
                        {formatTokens(m.tokens.input)}
                      </Td>
                      <Td align="right" mono muted>
                        {formatTokens(m.tokens.output)}
                      </Td>
                      <Td align="right" mono muted>
                        {formatTokens(m.tokens.cacheRead)}
                      </Td>
                      <Td>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <div
                            style={{
                              flex: 1,
                              height: 6,
                              background: "var(--bg-subtle)",
                              borderRadius: 3,
                              overflow: "hidden",
                              minWidth: 60,
                            }}
                          >
                            <div
                              style={{
                                width: `${pct}%`,
                                height: "100%",
                                background: modelColor(m.model),
                              }}
                            />
                          </div>
                          <span
                            style={{
                              fontFamily: "var(--mono)",
                              fontSize: 11,
                              color: "var(--text-muted)",
                              minWidth: 42,
                              textAlign: "right",
                            }}
                          >
                            {pct.toFixed(1)} %
                          </span>
                        </div>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Courbe quotidienne 14 derniers jours */}
      <section>
        <SectionTitle>
          Coût quotidien - 14 derniers jours
          <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-muted)", fontWeight: 400, marginLeft: 8 }}>
            (total {formatUsd(dailySeries.reduce((s, d) => s + d.costUsd, 0), 2)})
          </span>
        </SectionTitle>
        <div className="pane" style={{ padding: "16px 18px 14px" }}>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 8, height: 130 }}>
            {dailySeries.map((d) => {
              const h = d.costUsd > 0 ? Math.max(3, (d.costUsd / dailyMax) * 120) : 0;
              const empty = d.costUsd === 0;
              return (
                <div
                  key={d.day}
                  style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", gap: 4, minWidth: 0 }}
                  title={`${d.day} : ${formatUsd(d.costUsd, 3)} (${d.count} run${d.count > 1 ? "s" : ""})`}
                >
                  <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: empty ? "transparent" : "var(--text-strong)", fontWeight: 600, whiteSpace: "nowrap" }}>
                    {empty ? "·" : `$${d.costUsd < 1 ? d.costUsd.toFixed(2) : d.costUsd.toFixed(0)}`}
                  </span>
                  <div
                    style={{
                      width: "100%",
                      height: h,
                      background: empty ? "var(--bg-subtle)" : "var(--accent)",
                      borderRadius: "3px 3px 0 0",
                      transition: "height 200ms ease",
                    }}
                  />
                </div>
              );
            })}
          </div>
          {/* Labels x sous le graphique, alignés en grille pour rester droits */}
          <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
            {dailySeries.map((d) => (
              <div
                key={d.day + "-lbl"}
                style={{
                  flex: 1,
                  textAlign: "center",
                  fontFamily: "var(--mono)",
                  fontSize: 10,
                  color: "var(--text-muted)",
                  whiteSpace: "nowrap",
                }}
              >
                {dayLabel(d.day)}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Top 10 dossiers les plus chers */}
      {data.top10 && data.top10.length > 0 && (
        <section>
          <SectionTitle>Top 10 dossiers les plus chers</SectionTitle>
          <div className="pane" style={{ padding: 0, overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ background: "var(--bg-subtle)" }}>
                  <Th>#</Th>
                  <Th>Dossier</Th>
                  <Th>Modèle</Th>
                  <Th>Date</Th>
                  <Th align="right">Durée</Th>
                  <Th align="right">Coût</Th>
                  <Th align="right">Vs moy.</Th>
                </tr>
              </thead>
              <tbody>
                {data.top10.map((r, i) => {
                  const ratio = data.avg > 0 ? r.costUsd / data.avg : 1;
                  return (
                    <tr key={r.dossierId} style={{ borderTop: "1px solid var(--border-soft)" }}>
                      <Td muted>{i + 1}</Td>
                      <Td mono>{r.dossierId}</Td>
                      <Td mono muted>{modelShort(r.model)}</Td>
                      <Td muted>{formatDate(r.ts)}</Td>
                      <Td align="right" mono muted>
                        {formatDuration(r.durationMs)}
                      </Td>
                      <Td align="right" mono strong>
                        {formatUsd(r.costUsd, 4)}
                      </Td>
                      <Td align="right" mono>
                        <span
                          style={{
                            color: ratio > 2 ? "var(--red)" : ratio > 1.5 ? "var(--amber)" : "var(--text-muted)",
                            fontWeight: ratio > 1.5 ? 600 : 400,
                          }}
                        >
                          x{ratio.toFixed(2)}
                        </span>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Tableau exhaustif triable */}
      <section>
        <SectionTitle>Tous les runs ({data.count})</SectionTitle>
        <div className="pane" style={{ padding: 0, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ background: "var(--bg-subtle)" }}>
                <SortHeader k="dossierId" cur={sortKey} dir={sortDir} onChange={(k, d) => { setSortKey(k); setSortDir(d); }}>
                  Dossier
                </SortHeader>
                <SortHeader k="model" cur={sortKey} dir={sortDir} onChange={(k, d) => { setSortKey(k); setSortDir(d); }}>
                  Modèle
                </SortHeader>
                <SortHeader k="ts" cur={sortKey} dir={sortDir} onChange={(k, d) => { setSortKey(k); setSortDir(d); }}>
                  Date
                </SortHeader>
                <SortHeader k="durationMs" cur={sortKey} dir={sortDir} onChange={(k, d) => { setSortKey(k); setSortDir(d); }} align="right">
                  Durée
                </SortHeader>
                <SortHeader k="costUsd" cur={sortKey} dir={sortDir} onChange={(k, d) => { setSortKey(k); setSortDir(d); }} align="right">
                  Coût (USD)
                </SortHeader>
                <Th align="right">Tokens in</Th>
                <Th align="right">Tokens out</Th>
                <Th align="right">Cache lu</Th>
                <Th>Statut</Th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr
                  key={r.dossierId}
                  style={{ borderTop: "1px solid var(--border-soft)", cursor: "pointer" }}
                  onClick={() => setOpenRow(r)}
                >
                  <Td mono>{r.dossierId}</Td>
                  <Td>
                    <span
                      style={{
                        display: "inline-block",
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background: modelColor(r.model),
                        marginRight: 5,
                        verticalAlign: "middle",
                      }}
                    />
                    <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-muted)" }}>
                      {modelShort(r.model)}
                    </span>
                  </Td>
                  <Td muted>{formatDate(r.ts)}</Td>
                  <Td align="right" mono muted>{formatDuration(r.durationMs)}</Td>
                  <Td align="right" mono strong>{formatUsd(r.costUsd, 4)}</Td>
                  <Td align="right" mono muted>{formatTokens(r.tokens.input + r.tokens.cacheRead + r.tokens.cacheCreate5m + r.tokens.cacheCreate1h)}</Td>
                  <Td align="right" mono muted>{formatTokens(r.tokens.output)}</Td>
                  <Td align="right" mono muted>{formatTokens(r.tokens.cacheRead)}</Td>
                  <Td>
                    <span
                      style={{
                        fontSize: 10.5,
                        padding: "2px 7px",
                        borderRadius: "var(--radius-sm)",
                        color: r.success ? "var(--green)" : "var(--red)",
                        background: r.success ? "var(--green-bg)" : "var(--red-bg)",
                        fontWeight: 500,
                      }}
                    >
                      {r.success ? "OK" : "Echec"}
                    </span>
                  </Td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ background: "var(--bg-subtle)", borderTop: "1px solid var(--border)" }}>
                <Td strong>TOTAL</Td>
                <Td muted>{data.byModel?.length ?? 0} modèle{(data.byModel?.length ?? 0) > 1 ? "s" : ""}</Td>
                <Td muted>{data.count} run{data.count > 1 ? "s" : ""}</Td>
                <Td align="right" mono muted>{formatDuration(data.totalDurationMs ?? 0)}</Td>
                <Td align="right" mono strong>{formatUsd(data.total, 3)}</Td>
                <Td align="right" mono muted>{formatTokens(tokenStats.input + tokenStats.cacheRead + tokenStats.cacheCreate5m + tokenStats.cacheCreate1h)}</Td>
                <Td align="right" mono muted>{formatTokens(tokenStats.output)}</Td>
                <Td align="right" mono muted>{formatTokens(tokenStats.cacheRead)}</Td>
                <Td />
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      {openRow && <RunDetailModal run={openRow} onClose={() => setOpenRow(null)} />}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3
      style={{
        fontSize: 11,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        color: "var(--text-muted)",
        margin: "0 0 8px",
      }}
    >
      {children}
    </h3>
  );
}

function BigStat({
  label,
  value,
  hint,
  accent,
  tone,
  tooltip,
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: boolean;
  tone?: "ok" | "warn";
  tooltip?: string;
}) {
  const color = tone === "warn" ? "var(--amber)" : tone === "ok" ? "var(--green)" : accent ? "var(--accent-strong)" : "var(--text-strong)";
  return (
    <div
      className="pane"
      style={{ padding: 12, display: "flex", flexDirection: "column", gap: 3 }}
    >
      <span
        style={{
          fontSize: 10,
          color: "var(--text-muted)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          fontWeight: 600,
          display: "flex",
          alignItems: "center",
          gap: 4,
        }}
      >
        {label}
        {tooltip && <InfoTooltip text={tooltip} />}
      </span>
      <span style={{ fontFamily: "var(--mono)", fontSize: 18, fontWeight: 600, color }}>{value}</span>
      {hint && <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>{hint}</span>}
    </div>
  );
}

interface PricingPayload {
  tariffs: Record<string, {
    input: number;
    output: number;
    cache_read: number;
    cache_create_5m: number;
    cache_create_1h_multiplier: number;
  }>;
  meta: {
    updatedAt: string | null;
    source: string | null;
    usingDefault: boolean;
  };
}

function ShowTariffsButton() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<PricingPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function show() {
    setOpen(true);
    setErr(null);
    try {
      const r = await fetch("/api/pricing");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData((await r.json()) as PricingPayload);
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  const rows = data
    ? Object.entries(data.tariffs).sort((a, b) => a[0].localeCompare(b[0]))
    : [];
  return (
    <>
      <button
        className="ghost"
        onClick={show}
        style={{ fontSize: 11, padding: "5px 12px" }}
        title="Afficher la grille tarifaire actuellement utilisée"
      >
        Voir les tarifs
      </button>
      {open && (
        <Modal onClose={() => setOpen(false)}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
            <h3 style={{ fontSize: 15, fontWeight: 600, color: "var(--text-strong)", margin: 0 }}>
              Grille tarifaire Claude
            </h3>
            <button onClick={() => setOpen(false)} className="ghost" style={{ fontSize: 11, padding: "3px 8px", cursor: "pointer" }}>
              Fermer
            </button>
          </div>
          {err && (
            <div style={{ padding: "8px 10px", background: "var(--red-bg)", border: "1px solid var(--red-border)", borderRadius: "var(--radius-sm)", fontSize: 12, color: "var(--text)", marginBottom: 10 }}>
              {err}
            </div>
          )}
          {data && (
            <>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 10, lineHeight: 1.5 }}>
                {data.meta.usingDefault ? (
                  <span>Tarifs par défaut (mai 2026). Clique <strong>↻ Tarifs Claude</strong> pour aller chercher la version officielle.</span>
                ) : (
                  <>
                    Mis à jour le {data.meta.updatedAt ? new Date(data.meta.updatedAt).toLocaleString("fr-FR") : "?"}.
                    {data.meta.source && (
                      <span style={{ display: "block", marginTop: 2, fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-faint)" }}>
                        Source : {data.meta.source}
                      </span>
                    )}
                  </>
                )}
              </div>
              <div style={{ overflowX: "auto", maxHeight: "60vh", overflowY: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead style={{ position: "sticky", top: 0, background: "var(--bg-panel)" }}>
                    <tr style={{ background: "var(--bg-subtle)" }}>
                      <Th>Modèle</Th>
                      <Th align="right">Input</Th>
                      <Th align="right">Output</Th>
                      <Th align="right">Cache R</Th>
                      <Th align="right">Cache W 5m</Th>
                      <Th align="right">×1h</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(([model, t]) => (
                      <tr key={model} style={{ borderTop: "1px solid var(--border-soft)" }}>
                        <Td mono strong>{model}</Td>
                        <Td align="right" mono>${t.input.toFixed(2)}</Td>
                        <Td align="right" mono>${t.output.toFixed(2)}</Td>
                        <Td align="right" mono muted>${t.cache_read.toFixed(2)}</Td>
                        <Td align="right" mono muted>${t.cache_create_5m.toFixed(2)}</Td>
                        <Td align="right" mono muted>{t.cache_create_1h_multiplier.toFixed(1)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ fontSize: 10.5, color: "var(--text-faint)", marginTop: 10, lineHeight: 1.5 }}>
                Tous les prix en USD par million de tokens. <strong>Cache R</strong> = lecture de prompt déjà mis en cache. <strong>Cache W 5m</strong> = écriture cache TTL 5 min. <strong>×1h</strong> = multiplicateur appliqué à Cache W 5m pour estimer le tarif cache 1h.
              </div>
            </>
          )}
          {!data && !err && (
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>Chargement…</div>
          )}
        </Modal>
      )}
    </>
  );
}

function RefreshTariffsButton({
  onDone,
  pricingMeta,
}: {
  onDone: () => void;
  pricingMeta?: CostsData["pricingMeta"];
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  async function doRefresh() {
    setConfirmOpen(false);
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/pricing/refresh", { method: "POST" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const { runId } = (await r.json()) as { runId: string };
      const start = Date.now();
      while (Date.now() - start < 120_000) {
        await new Promise((res) => setTimeout(res, 2500));
        const rr = await fetch(`/api/runs/${runId}`);
        if (!rr.ok) continue;
        const run = (await rr.json()) as { status: string };
        if (run.status === "succeeded") { onDone(); return; }
        if (run.status === "failed" || run.status === "cancelled") {
          throw new Error(`Run ${run.status}`);
        }
      }
      throw new Error("Timeout après 2 minutes");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const dt = pricingMeta?.updatedAt;
  const tooltipText = dt
    ? `Tarifs mis à jour le ${new Date(dt).toLocaleString("fr-FR")} depuis ${pricingMeta?.source ?? "?"}.`
    : "Tarifs par défaut (jamais actualisés). Clique pour aller chercher la grille Anthropic à jour.";
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
      <button
        onClick={() => setConfirmOpen(true)}
        disabled={busy}
        title={tooltipText}
        style={{
          fontSize: 11,
          padding: "5px 12px",
          background: pricingMeta?.usingDefault ? "var(--amber-bg)" : "var(--bg-panel)",
          border: `1px solid ${pricingMeta?.usingDefault ? "var(--amber-border)" : "var(--border)"}`,
          borderRadius: "var(--radius-sm)",
          color: "var(--text)",
          cursor: busy ? "not-allowed" : "pointer",
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
        }}
      >
        {busy ? "Recherche..." : "↻ Tarifs Claude"}
      </button>
      {error && (
        <span style={{ fontSize: 10, color: "var(--red)" }}>{error}</span>
      )}
      {confirmOpen && (
        <Modal onClose={() => setConfirmOpen(false)}>
          <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-strong)", marginBottom: 8 }}>
            Actualiser les tarifs Claude ?
          </div>
          <div style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.6, marginBottom: 16 }}>
            Un agent Claude va aller chercher la grille tarifaire actuelle sur{" "}
            <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text)" }}>docs.claude.com/pricing</span>
            {" "}via WebFetch, puis mettre à jour le fichier <span style={{ fontFamily: "var(--mono)", fontSize: 12 }}>data/.claude/pricing.json</span>.
            <br /><br />
            <strong>Tous les coûts historiques seront recalculés</strong> avec les nouveaux tarifs.
            <br /><br />
            <span style={{ color: "var(--text-faint)" }}>Coût estimé : ~$0.05. Durée : ~30 secondes.</span>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button onClick={() => setConfirmOpen(false)} className="ghost" style={{ fontSize: 12, padding: "6px 14px", cursor: "pointer" }}>
              Annuler
            </button>
            <button onClick={doRefresh} className="primary" style={{ fontSize: 12, padding: "6px 14px", cursor: "pointer" }}>
              Lancer la recherche
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function InfoTooltip({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const TOOLTIP_W = 280;
    const MARGIN = 8;
    // Aligne par défaut le bord gauche du tooltip sur le ?, sauf si ça dépasse
    // à droite du viewport : dans ce cas, on aligne le bord droit du tooltip
    // sur le ? + on garde une marge avec le bord.
    let left = rect.left;
    if (left + TOOLTIP_W > window.innerWidth - MARGIN) {
      left = Math.max(MARGIN, window.innerWidth - TOOLTIP_W - MARGIN);
    }
    setPos({ left, top: rect.bottom + 6 });
  }, [open]);

  return (
    <>
      <span
        ref={triggerRef}
        style={{ display: "inline-flex", position: "relative" }}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 13,
            height: 13,
            fontSize: 9,
            borderRadius: "50%",
            border: "1px solid var(--text-faint)",
            color: "var(--text-faint)",
            cursor: "help",
            textTransform: "none",
            letterSpacing: 0,
            fontWeight: 500,
          }}
          aria-label={text}
        >
          ?
        </span>
      </span>
      {open && pos && (
        <span
          style={{
            position: "fixed",
            left: pos.left,
            top: pos.top,
            zIndex: 10000,
            background: "var(--bg-strong, #1a1a1a)",
            color: "#fff",
            fontSize: 11.5,
            lineHeight: 1.45,
            padding: "8px 11px",
            borderRadius: 6,
            boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
            width: 280,
            maxWidth: "min(90vw, 320px)",
            textTransform: "none",
            letterSpacing: 0,
            fontWeight: 400,
            whiteSpace: "normal",
            pointerEvents: "none",
          }}
        >
          {text}
        </span>
      )}
    </>
  );
}

function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
        animation: "fade-in 120ms ease",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: 20,
          maxWidth: 480,
          width: "90%",
          boxShadow: "0 10px 40px rgba(0,0,0,0.3)",
          animation: "pop-in 160ms ease",
        }}
      >
        {children}
      </div>
    </div>
  );
}

function EditableProjectionStat({
  targetCount,
  onChange,
  projection,
  hint,
}: {
  targetCount: number;
  onChange: (n: number) => void;
  projection: number;
  hint?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(targetCount));
  const tone = projection > 1000 ? "warn" : projection > 100 ? undefined : "ok";
  const color = tone === "warn" ? "var(--amber)" : tone === "ok" ? "var(--green)" : "var(--accent-strong)";
  return (
    <div
      className="pane"
      style={{
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 3,
        cursor: editing ? "default" : "pointer",
        minWidth: 0,
        overflow: "hidden",
      }}
      onClick={() => {
        if (!editing) { setDraft(String(targetCount)); setEditing(true); }
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
        Projection
      </span>
      <span style={{ fontFamily: "var(--mono)", fontSize: 18, fontWeight: 600, color, lineHeight: 1.1 }}>
        {formatUsd(projection, 2)}
      </span>
      <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10.5, color: "var(--text-muted)", minWidth: 0 }}>
        {editing ? (
          <input
            autoFocus
            type="number"
            min={1}
            max={1000000}
            step={100}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              const n = Number(draft);
              if (Number.isFinite(n) && n > 0) onChange(n);
              setEditing(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") { setDraft(String(targetCount)); setEditing(false); }
            }}
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 64,
              maxWidth: "100%",
              fontFamily: "var(--mono)",
              fontSize: 11,
              padding: "1px 4px",
              background: "var(--bg-panel)",
              border: "1px solid var(--accent)",
              borderRadius: 3,
              color: "var(--text)",
              flexShrink: 1,
              minWidth: 0,
            }}
          />
        ) : (
          <span style={{ fontFamily: "var(--mono)", color: "var(--accent)", fontWeight: 500 }}>
            {targetCount.toLocaleString("fr-FR")}
          </span>
        )}
        <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          dossiers · {editing ? "↵" : "✎"}
        </span>
      </div>
      {hint && (
        <span style={{ fontSize: 10, color: "var(--text-faint)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={hint}>
          {hint}
        </span>
      )}
    </div>
  );
}

function Th({ children, align = "left" }: { children?: React.ReactNode; align?: "left" | "right" }) {
  return (
    <th
      style={{
        padding: "7px 10px",
        textAlign: align,
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

function Td({
  children,
  align = "left",
  mono,
  muted,
  strong,
}: {
  children?: React.ReactNode;
  align?: "left" | "right";
  mono?: boolean;
  muted?: boolean;
  strong?: boolean;
}) {
  return (
    <td
      style={{
        padding: "6px 10px",
        textAlign: align,
        fontFamily: mono ? "var(--mono)" : "inherit",
        fontSize: mono ? 11 : 12,
        color: muted ? "var(--text-muted)" : strong ? "var(--text-strong)" : "var(--text)",
        fontWeight: strong ? 600 : 400,
        verticalAlign: "middle",
      }}
    >
      {children}
    </td>
  );
}

function SortHeader({
  k,
  cur,
  dir,
  onChange,
  align,
  children,
}: {
  k: SortKey;
  cur: SortKey;
  dir: "asc" | "desc";
  onChange: (k: SortKey, d: "asc" | "desc") => void;
  align?: "left" | "right";
  children: React.ReactNode;
}) {
  const active = cur === k;
  return (
    <th
      onClick={() => onChange(k, active ? (dir === "asc" ? "desc" : "asc") : "desc")}
      style={{
        padding: "7px 10px",
        textAlign: align ?? "left",
        fontSize: 10,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        color: active ? "var(--text-strong)" : "var(--text-muted)",
        cursor: "pointer",
        userSelect: "none",
      }}
    >
      {children}
      {active && (
        <span style={{ marginLeft: 4, fontSize: 8 }}>
          {dir === "asc" ? "↑" : "↓"}
        </span>
      )}
    </th>
  );
}

function RunDetailModal({ run, onClose }: { run: RunCost; onClose: () => void }) {
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
        zIndex: 70,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          boxShadow: "var(--shadow-lg)",
          width: "min(560px, 100%)",
          padding: 22,
        }}
      >
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "var(--text-strong)" }}>
          {run.dossierId}
        </h3>
        <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4, fontFamily: "var(--mono)" }}>
          {run.model || "modèle inconnu"} - {formatDate(run.ts)}
        </p>
        <div
          style={{
            marginTop: 14,
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 10,
            fontSize: 12,
          }}
        >
          <Detail k="Coût" v={formatUsd(run.costUsd, 6)} strong />
          <Detail k="Durée" v={formatDuration(run.durationMs)} />
          <Detail k="Statut" v={run.success ? "OK" : "Echec"} />
          <Detail k="Modèle" v={modelShort(run.model) || "-"} mono />
          <Detail k="Tokens input" v={formatTokens(run.tokens.input)} mono />
          <Detail k="Tokens output" v={formatTokens(run.tokens.output)} mono />
          <Detail k="Cache lu" v={formatTokens(run.tokens.cacheRead)} mono />
          <Detail k="Cache écrit 5m" v={formatTokens(run.tokens.cacheCreate5m)} mono />
          <Detail k="Cache écrit 1h" v={formatTokens(run.tokens.cacheCreate1h)} mono />
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
          <a
            href={`/evaluation?dossierId=${encodeURIComponent(run.dossierId)}`}
            className="ghost"
            style={{ fontSize: 12, padding: "5px 12px", textDecoration: "none" }}
          >
            Voir le dossier
          </a>
          <button className="ghost" onClick={onClose} style={{ fontSize: 12, padding: "5px 12px" }}>
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
}

function Detail({ k, v, mono, strong }: { k: string; v: string; mono?: boolean; strong?: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600 }}>
        {k}
      </span>
      <span
        style={{
          fontFamily: mono ? "var(--mono)" : "inherit",
          fontSize: 13,
          color: strong ? "var(--text-strong)" : "var(--text)",
          fontWeight: strong ? 600 : 400,
        }}
      >
        {v}
      </span>
    </div>
  );
}
