"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppChromeHeader } from "@/components/AppChromeHeader";
import { Icon } from "@/components/Icon";
import { PanelLayout3 } from "@/components/PanelLayout3";
import { listRuns, startRun, streamRun } from "@/lib/client";
import type { AgentEvent, RunRecord, RunStatus } from "@/lib/types";

type Flow = {
  id: string;
  label: string;
  intent: string;
  prompt: string;
};

const flows: Flow[] = [
  {
    id: "quote-analysis",
    label: "Analyse devis",
    intent: "Prix, conditions, risques",
    prompt:
      "Analyse les devis fournisseurs disponibles pour cette demande d'achat. Compare les prix, delais, conditions, risques contractuels et donnees manquantes. Termine par une recommandation actionnable.",
  },
  {
    id: "supplier-comparison",
    label: "Fournisseurs",
    intent: "Offres, clauses, fiabilite",
    prompt:
      "Compare les offres fournisseurs d'un dossier achat. Isole le prix total, les delais, les clauses importantes, les frais, les garanties et les points a renegocier.",
  },
  {
    id: "approval-note",
    label: "Note decision",
    intent: "Synthese dirigeant",
    prompt:
      "Prepare une note de decision pour validation achat. Structure: contexte, options, couts, risques, recommandation, prochaines actions et controles a effectuer.",
  },
  {
    id: "data-check",
    label: "Controle dossier",
    intent: "Completude, anomalies",
    prompt:
      "Controle les donnees du dossier achat. Signale les pieces manquantes, incoherences, valeurs aberrantes et questions a clarifier avant decision.",
  },
];

const contextItems = [
  { label: "Domaine", value: "Achats", tone: "info" },
  { label: "Donnees", value: "Demo", tone: "ok" },
  { label: "Mode", value: "Agent bridge", tone: "running" },
];

const evidenceChecklist = [
  "Prix fournisseur, quantites et delais",
  "Conditions de paiement et garanties",
  "Clauses contractuelles et exclusions",
  "Hypotheses, risques et donnees manquantes",
];

function statusLabel(status: RunStatus): string {
  switch (status) {
    case "queued":
      return "En attente";
    case "running":
      return "En cours";
    case "succeeded":
      return "Termine";
    case "failed":
      return "Echec";
    case "cancelled":
      return "Annule";
  }
}

function statusTone(status: RunStatus): string {
  if (status === "running" || status === "queued") return "running";
  if (status === "succeeded") return "ok";
  if (status === "failed") return "error";
  return "warn";
}

function eventText(ev: AgentEvent): string {
  if (ev.text) return ev.text;
  if (ev.error) return ev.error;
  if (ev.result?.output) return ev.result.output;
  if (ev.tool?.name) return `${ev.tool.name}`;
  return "";
}

function formatTime(ts: number): string {
  return new Intl.DateTimeFormat("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(ts);
}

function buildAgentPrompt(input: string, flow: Flow): string {
  return [
    "Tu es l'agent achats d'un ERP demo.",
    "Travaille en mode decisionnel: clarifie les hypotheses, cite les donnees utilisees, distingue faits et deductions, puis propose la prochaine action.",
    "",
    `Mission: ${flow.label} - ${flow.intent}`,
    "",
    "Cadre metier:",
    "- Achats B2B generiques",
    "- Priorite: prix, delais, risque fournisseur, clauses contractuelles, donnees manquantes",
    "- Sortie attendue: synthese courte, tableau si utile, recommandation explicite",
    "",
    "Demande utilisateur:",
    input.trim(),
  ].join("\n");
}

export function PurchasingWorkspace() {
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [selectedFlow, setSelectedFlow] = useState<Flow>(flows[0]);
  const [draft, setDraft] = useState(flows[0].prompt);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandRightSignal, setExpandRightSignal] = useState(0);
  const streamAbortRef = useRef<AbortController | null>(null);

  const activeRun = useMemo(
    () => runs.find((run) => run.id === activeRunId) ?? null,
    [activeRunId, runs]
  );

  const visibleEvents = activeRun?.events?.length ? activeRun.events : events;
  const assistantText = visibleEvents
    .filter((ev) => ev.kind === "text_delta" || ev.kind === "result" || ev.kind === "error")
    .map(eventText)
    .filter(Boolean)
    .join("");

  const loadRuns = useCallback(async () => {
    try {
      const next = await listRuns();
      setRuns(next.sort((a, b) => b.startedAt - a.startedAt));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void loadRuns();
    const timer = window.setInterval(() => void loadRuns(), 5000);
    return () => window.clearInterval(timer);
  }, [loadRuns]);

  function selectFlow(flow: Flow) {
    setSelectedFlow(flow);
    setDraft(flow.prompt);
    setExpandRightSignal((n) => n + 1);
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const prompt = draft.trim();
    if (!prompt || isStarting) return;

    streamAbortRef.current?.abort();
    const abort = new AbortController();
    streamAbortRef.current = abort;
    setIsStarting(true);
    setError(null);
    setEvents([]);

    try {
      const runId = await startRun({
        prompt: buildAgentPrompt(prompt, selectedFlow),
        tag: selectedFlow.id,
        maxTurns: 30,
      });
      setActiveRunId(runId);
      await loadRuns();
      await streamRun(runId, {
        signal: abort.signal,
        onEvent: (ev) => setEvents((prev) => [...prev, ev]),
        onError: (err) => setError(err.message),
      });
      await loadRuns();
    } catch (err) {
      if (!abort.signal.aborted) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setIsStarting(false);
    }
  }

  function openRun(run: RunRecord) {
    streamAbortRef.current?.abort();
    setActiveRunId(run.id);
    setEvents(run.events ?? []);
  }

  return (
    <div className="app ai-workspace">
      <AppChromeHeader />
      <div className="ai-shell">
        <PanelLayout3
          autoSaveId="purchasing:agent-layout-v1"
          defaultSizes={[23, 54, 23]}
          minSizes={[17, 36, 18]}
          expandRightSignal={expandRightSignal}
          leftPanel={
            <aside className="ai-pane ai-sidebar">
              <div className="ai-pane-header">
                <div>
                  <span className="eyebrow">Sessions</span>
                  <h2>Achats</h2>
                </div>
                <button
                  type="button"
                  className="ghost icon-btn"
                  onClick={() => {
                    setActiveRunId(null);
                    setEvents([]);
                    setDraft(selectedFlow.prompt);
                  }}
                  aria-label="Nouvelle analyse"
                  title="Nouvelle analyse"
                >
                  <Icon name="plus" size={15} />
                </button>
              </div>

              <div className="ai-flow-list">
                {flows.map((flow) => (
                  <button
                    key={flow.id}
                    type="button"
                    className={`ai-flow${selectedFlow.id === flow.id ? " active" : ""}`}
                    onClick={() => selectFlow(flow)}
                  >
                    <span>{flow.label}</span>
                    <small>{flow.intent}</small>
                  </button>
                ))}
              </div>

              <div className="ai-run-list">
                {runs.length === 0 ? (
                  <div className="ai-empty-compact">Aucune session lancee</div>
                ) : (
                  runs.map((run) => (
                    <button
                      key={run.id}
                      type="button"
                      className={`ai-run${activeRunId === run.id ? " active" : ""}`}
                      onClick={() => openRun(run)}
                    >
                      <span className={`pill ${statusTone(run.status)}`}>
                        <span className="dot" aria-hidden />
                        {statusLabel(run.status)}
                      </span>
                      <strong>{run.tag ?? "Analyse"}</strong>
                      <small>{formatTime(run.startedAt)}</small>
                    </button>
                  ))
                )}
              </div>
            </aside>
          }
          centerPanel={
            <main className="ai-pane ai-chat">
              <div className="ai-chat-scroll">
                <section className="ai-welcome">
                  <span className="pill running">
                    <span className="dot" aria-hidden />
                    Agent local
                  </span>
                  <h1>Achats demo</h1>
                  <p>
                    Analyse des devis, comparaison fournisseurs, risques contractuels et
                    donnees manquantes pour les decisions d'achats.
                  </p>
                </section>

                {(activeRun || draft) && (
                  <section className="ai-message user">
                    <div className="ai-avatar">U</div>
                    <div className="ai-bubble">
                      <span className="eyebrow">{selectedFlow.label}</span>
                      <p>{activeRun?.prompt ? activeRun.prompt.split("Demande utilisateur:\n").pop() : draft}</p>
                    </div>
                  </section>
                )}

                {(assistantText || isStarting) && (
                  <section className="ai-message assistant">
                    <div className="ai-avatar accent">A</div>
                    <div className="ai-bubble">
                      <span className="eyebrow">Agent</span>
                      {assistantText ? (
                        <pre>{assistantText}</pre>
                      ) : (
                        <div className="ai-thinking">
                          <span className="spinner" />
                          Preparation de l'analyse
                        </div>
                      )}
                    </div>
                  </section>
                )}

                {visibleEvents
                  .filter((ev) => ev.kind === "tool_use_start" || ev.kind === "tool_use_end" || ev.kind === "stderr")
                  .slice(-6)
                  .map((ev, index) => (
                    <div key={`${ev.ts}-${index}`} className="ai-tool-row">
                      <Icon name={ev.kind === "stderr" ? "bell" : "tweaks"} size={13} />
                      <span>{eventText(ev) || ev.kind}</span>
                    </div>
                  ))}

                {error && (
                  <div className="ai-error">
                    <Icon name="bell" size={14} />
                    <span>{error}</span>
                  </div>
                )}
              </div>

              <form className="ai-composer" onSubmit={handleSubmit}>
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={4}
                  placeholder="Demande une analyse, une comparaison ou une note de decision..."
                />
                <div className="ai-composer-bar">
                  <div className="ai-composer-meta">
                    <Icon name="sparkles" size={14} />
                    <span>{selectedFlow.label}</span>
                  </div>
                  <button type="submit" className="primary icon-btn" disabled={isStarting || !draft.trim()}>
                    {isStarting ? <span className="spinner" /> : <Icon name="send" size={15} />}
                    <span>Lancer</span>
                  </button>
                </div>
              </form>
            </main>
          }
          rightPanel={
            <aside className="ai-pane ai-context">
              <div className="ai-pane-header">
                <div>
                  <span className="eyebrow">Contexte</span>
                  <h2>Decision</h2>
                </div>
                <button
                  type="button"
                  className="ghost icon-btn"
                  onClick={() => void loadRuns()}
                  aria-label="Rafraichir"
                  title="Rafraichir"
                >
                  <Icon name="refresh" size={15} />
                </button>
              </div>

              <div className="ai-context-grid">
                {contextItems.map((item) => (
                  <div className="ai-metric" key={item.label}>
                    <span className={`pill ${item.tone}`}>
                      <span className="dot" aria-hidden />
                      {item.label}
                    </span>
                    <strong>{item.value}</strong>
                  </div>
                ))}
              </div>

              <section className="ai-section">
                <h3>Pieces a verifier</h3>
                <div className="ai-checklist">
                  {evidenceChecklist.map((item) => (
                    <div key={item} className="ai-check-row">
                      <Icon name="check" size={13} />
                      <span>{item}</span>
                    </div>
                  ))}
                </div>
              </section>

              <section className="ai-section">
                <h3>Sortie cible</h3>
                <div className="ai-output-map">
                  <span>Synthese</span>
                  <span>Comparatif</span>
                  <span>Risques</span>
                  <span>Action</span>
                </div>
              </section>
            </aside>
          }
        />
      </div>
    </div>
  );
}
