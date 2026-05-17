"use client";
import { useEffect, useState, useCallback, useRef } from "react";
import { Panel, PanelGroup, type ImperativePanelHandle } from "react-resizable-panels";
import { AppChromeHeader } from "@/components/AppChromeHeader";
import { DossierList } from "@/components/DossierList";
import { DossierFilesList } from "@/components/DossierFilesList";
import { DossierFileViewer } from "@/components/DossierFileViewer";
import { StreamingPanel } from "@/components/StreamingPanel";
import { CriteresGrid } from "@/components/CriteresGrid";
import { ChatDrawer } from "@/components/ChatDrawer";
import { RuleProposalForm } from "@/components/RuleProposalForm";
import { ResizeHandle } from "@/components/ResizeHandle";
import { Icon } from "@/components/Icon";
import { ClaudeMark } from "@/components/ClaudeMark";
import {
  listDossiers,
  listDossierFiles,
  startRun,
  streamRun,
  loadEvaluation,
  loadDossierEvents,
  batchEvaluations,
  batchNotations,
  getRunsConcurrency,
} from "@/lib/client";
import type {
  AgentEvent,
  DossierEntry,
  Evaluation,
  FileEntry,
} from "@/lib/types";

type RunStatus = "idle" | "running" | "succeeded" | "failed";
type ViewMode = "stream" | "synthese";
type LeftMode = "files" | "stream";

export default function EvaluationPage() {
  const [user, setUser] = useState<string>("");
  const [dossiers, setDossiers] = useState<DossierEntry[]>([]);
  const [selected, setSelected] = useState<DossierEntry | null>(null);
  const [selectedFile, setSelectedFile] = useState<FileEntry | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [runStatus, setRunStatus] = useState<RunStatus>("idle");
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  const [view, setView] = useState<ViewMode>("stream");
  const [leftMode, setLeftMode] = useState<LeftMode>("files");
  const [drawerMode, setDrawerMode] = useState<"chat" | "rule" | null>(null);
  const [horsIa, setHorsIa] = useState<number[] | undefined>(undefined);
  const [concurrency, setConcurrency] = useState<{ running: number; max: number }>({
    running: 0,
    max: 5,
  });
  const [batchBusy, setBatchBusy] = useState(false);
  const [inputDir, setInputDir] = useState<string | undefined>(undefined);
  const [autoNotation, setAutoNotation] = useState(false);
  const [sourcePageHint, setSourcePageHint] = useState<number | undefined>(undefined);
  const [sourceSearchHint, setSourceSearchHint] = useState<string | undefined>(undefined);
  const [sourceQuoteHint, setSourceQuoteHint] = useState<string | undefined>(undefined);
  /**
   * AbortController du stream SSE actuellement attaché côté client. Permet de
   * détacher l'EventSource (le run côté daemon continue de tourner) quand
   * l'utilisateur change de dossier, pour ne pas polluer le state avec les
   * events d'un dossier précédent.
   */
  const streamAbortRef = useRef<AbortController | null>(null);

  // Récupère le chemin du dossier candidatures + le nom de l'utilisateur
  // courant depuis la config (utilisé pour le bouton "Ouvrir le dossier" + nom
  // affiché dans le header).
  useEffect(() => {
    fetch("/api/app-config")
      .then((r) => r.json())
      .then((j: { config?: { inputDir?: string; currentUser?: string; autoNotation?: boolean } }) => {
        if (j.config?.currentUser) setUser(j.config.currentUser);
        setInputDir(j.config?.inputDir || undefined);
        setAutoNotation(j.config?.autoNotation ?? false);
      })
      .catch(() => {});
  }, []);

  const refreshConcurrency = useCallback(async () => {
    try {
      const j = await getRunsConcurrency();
      setConcurrency({ running: j.running, max: j.max });
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    refreshConcurrency();
    const t = setInterval(refreshConcurrency, 4000);
    return () => clearInterval(t);
  }, [refreshConcurrency]);

  async function handleBatch(dossierIds: string[]) {
    if (dossierIds.length === 0) return;
    setBatchBusy(true);
    try {
      const r = await batchEvaluations(dossierIds);
      if (r.launched.length === 0 && r.skipped.length > 0) {
        const reasons = Array.from(new Set(r.skipped.map((s) => s.reason)));
        alert(`Aucune évaluation lancée. Raison(s) : ${reasons.join(", ")}`);
      }
      await refreshDossiers();
      await refreshConcurrency();
      // Affiche automatiquement le streaming du premier dossier lancé
      // (l'utilisateur n'a pas à cliquer pour voir le travail de Claude).
      if (r.launched.length > 0) {
        const firstId = r.launched[0].dossier_id;
        const dossiers = await listDossiers();
        const target = dossiers.find((d) => d.id === firstId);
        if (target) {
          pickDossier(target);
          setLeftMode("stream");
        }
      }
    } catch (e) {
      alert("Batch échoué : " + (e as Error).message);
    } finally {
      setBatchBusy(false);
    }
  }

  const dossiersPanelRef = useRef<ImperativePanelHandle>(null);
  const filesPanelRef = useRef<ImperativePanelHandle>(null);
  const gridPanelRef = useRef<ImperativePanelHandle>(null);
  const [dossiersCollapsed, setDossiersCollapsed] = useState(false);
  const [filesCollapsed, setFilesCollapsed] = useState(false);
  const [gridCollapsed, setGridCollapsed] = useState(false);

  const toggleDossiers = useCallback(() => {
    const p = dossiersPanelRef.current;
    if (!p) return;
    if (p.isCollapsed()) p.expand();
    else p.collapse();
  }, []);
  const toggleFiles = useCallback(() => {
    const p = filesPanelRef.current;
    if (!p) return;
    if (p.isCollapsed()) p.expand();
    else p.collapse();
  }, []);
  const toggleGrid = useCallback(() => {
    const p = gridPanelRef.current;
    if (!p) return;
    if (p.isCollapsed()) p.expand();
    else p.collapse();
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isMac = /Mac/i.test(navigator.platform);
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleDossiers();
      }
      if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleFiles();
      }
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "j") {
        e.preventDefault();
        toggleGrid();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleDossiers, toggleFiles, toggleGrid]);

  const refreshDossiers = useCallback(async () => {
    try {
      setDossiers(await listDossiers());
    } catch (e) {
      console.error(e);
    }
  }, []);

  useEffect(() => {
    refreshDossiers();
    const interval = setInterval(refreshDossiers, 5000);
    return () => clearInterval(interval);
  }, [refreshDossiers]);

  // Auto-sélection du premier dossier au démarrage : dès que la liste est
  // chargée, sélectionne celui en cours (running) en priorité, sinon le
  // premier "a_faire". L'utilisateur n'arrive plus sur un écran vide.
  const [autoSelected, setAutoSelected] = useState(false);
  useEffect(() => {
    if (autoSelected || selected || dossiers.length === 0) return;
    const first =
      dossiers.find((d) => d.running) ??
      dossiers.find((d) => d.status === "a_faire") ??
      dossiers[0];
    if (first) {
      pickDossier(first);
      setAutoSelected(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dossiers, autoSelected, selected]);

  // Charge la metadata de la grille (questions hors-IA, barème max) depuis
  // la campagne active au mount. Permet à CriteresGrid et ReviewForm d'être
  // dynamiques selon la campagne.
  useEffect(() => {
    fetch("/api/grid-metadata")
      .then((r) => r.json())
      .then((j: { questionsHorsIa?: number[] }) => {
        if (Array.isArray(j.questionsHorsIa)) setHorsIa(j.questionsHorsIa);
      })
      .catch(() => {
        // garde le fallback DEFAULT_HORS_IA des composants
      });
  }, []);

  // Sécurité : si la liste des dossiers est collapsée au mount (état restauré
  // depuis localStorage par autoSaveId) et qu'aucun dossier n'est sélectionné,
  // on force l'expansion sinon impossible de cliquer sur un dossier.
  useEffect(() => {
    const t = setTimeout(() => {
      if (dossiersPanelRef.current?.isCollapsed()) {
        dossiersPanelRef.current.expand();
      }
    }, 100);
    return () => clearTimeout(t);
  }, []);

  async function pickDossier(d: DossierEntry) {
    // Détache le stream SSE précédent (le run côté daemon continue de tourner).
    if (streamAbortRef.current) {
      streamAbortRef.current.abort();
      streamAbortRef.current = null;
    }
    setSelected(d);
    setEvents([]);
    setRunStatus("idle");
    setSelectedFile(null);
    setSourcePageHint(undefined);
    setSourceSearchHint(undefined);
    setSourceQuoteHint(undefined);
    setEvaluation(null);
    setView("stream");
    if (d.evaluationPath) {
      const ev = await loadEvaluation(d.id);
      // Vérifie qu'on est toujours sur le bon dossier (l'utilisateur a pu
      // re-switcher pendant l'await) avant d'appliquer l'évaluation.
      if (ev && ev.dossier_id === d.id) {
        setEvaluation(ev);
      }
    }
    // Charge l'historique du travail de Claude (events persistés ou run en cours)
    const hist = await loadDossierEvents(d.id);
    if (hist.events.length > 0) {
      setEvents(hist.events);
      setRunStatus(
        hist.status === "running"
          ? "running"
          : hist.status === "succeeded"
          ? "succeeded"
          : hist.status === "failed"
          ? "failed"
          : "idle"
      );
      // Si run en cours, attache le stream pour les nouveaux events
      if (hist.status === "running" && hist.runId) {
        const ctrl = new AbortController();
        streamAbortRef.current = ctrl;
        streamRun(hist.runId, {
          signal: ctrl.signal,
          onEvent: (ev) => setEvents((prev) => [...prev, ev]),
          onEnd: async () => {
            if (ctrl.signal.aborted) return;
            setRunStatus("succeeded");
            const ev = await loadEvaluation(d.id);
            if (ev && ev.dossier_id === d.id) setEvaluation(ev);
            await refreshDossiers();
            // Auto-notation après rechargement de page : même logique que lancerEvaluation
            if (autoNotation && ev?.phase_eligibilite && !ev?.phase_notation) {
              const verdict = ev.phase_eligibilite.verdict;
              if (verdict === "ELIGIBLE") {
                await lancerNotation(d.id);
              }
            }
          },
          onError: () => {
            if (!ctrl.signal.aborted) setRunStatus("failed");
          },
        }).catch(() => {
          if (!ctrl.signal.aborted) setRunStatus("failed");
        });
      }
    }
  }

  const [currentRunId, setCurrentRunId] = useState<string | null>(null);

  async function stopperEvaluation() {
    if (!currentRunId) return;
    try {
      await fetch(`/api/runs/${currentRunId}/cancel`, { method: "POST" });
      setRunStatus("failed");
      setCurrentRunId(null);
    } catch (e) {
      console.error(e);
    }
  }

  async function lancerEvaluation() {
    if (!selected) return;
    const dossierId = selected.id;
    if (streamAbortRef.current) streamAbortRef.current.abort();
    setEvents([]);
    setRunStatus("running");
    setEvaluation(null);
    setLeftMode("stream");
    try {
      const runId = await startRun({
        message: `/evaluer-eligibilite ${dossierId}`,
        user: user || "anonyme",
      });
      setCurrentRunId(runId);
      const ctrl = new AbortController();
      streamAbortRef.current = ctrl;
      await streamRun(runId, {
        signal: ctrl.signal,
        onEvent: (ev) => setEvents((prev) => [...prev, ev]),
        onEnd: async () => {
          if (ctrl.signal.aborted) return;
          setRunStatus("succeeded");
          setCurrentRunId(null);
          const ev = await loadEvaluation(dossierId);
          if (ev && ev.dossier_id === dossierId) setEvaluation(ev);
          await refreshDossiers();
          // Auto-notation : si éligible et option activée, enchaîne immédiatement
          if (autoNotation && ev?.phase_eligibilite && !ev?.phase_notation) {
            const verdict = ev.phase_eligibilite.verdict;
            if (verdict === "ELIGIBLE") {
              await lancerNotation(dossierId);
            }
          }
        },
        onError: (err) => {
          if (ctrl.signal.aborted) return;
          console.error(err);
          setRunStatus("failed");
          setCurrentRunId(null);
        },
      });
    } catch (e) {
      console.error(e);
      setRunStatus("failed");
      setCurrentRunId(null);
    }
  }

  async function lancerNotation(dossierId: string) {
    if (streamAbortRef.current) streamAbortRef.current.abort();
    setRunStatus("running");
    setLeftMode("stream");
    try {
      const runId = await startRun({
        message: `/evaluer-notation ${dossierId}`,
        user: user || "anonyme",
      });
      setCurrentRunId(runId);
      const ctrl = new AbortController();
      streamAbortRef.current = ctrl;
      await streamRun(runId, {
        signal: ctrl.signal,
        onEvent: (ev) => setEvents((prev) => [...prev, ev]),
        onEnd: async () => {
          if (ctrl.signal.aborted) return;
          setRunStatus("succeeded");
          setCurrentRunId(null);
          const ev = await loadEvaluation(dossierId);
          if (ev && ev.dossier_id === dossierId) setEvaluation(ev);
          await refreshDossiers();
        },
        onError: (err) => {
          if (ctrl.signal.aborted) return;
          console.error(err);
          setRunStatus("failed");
          setCurrentRunId(null);
        },
      });
    } catch (e) {
      console.error(e);
      setRunStatus("failed");
      setCurrentRunId(null);
    }
  }

  return (
    <div className="app">
      <AppChromeHeader user={user} />
      <div style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0 }}>
        <PanelGroup
          direction="horizontal"
          autoSaveId="oif-eval:layout-v3"
          style={{ flex: 1 }}
        >
          {/* Sidebar 1 : dossiers */}
          <Panel
            ref={dossiersPanelRef}
            defaultSize={18}
            minSize={12}
            maxSize={32}
            collapsible
            collapsedSize={0}
            onCollapse={() => setDossiersCollapsed(true)}
            onExpand={() => setDossiersCollapsed(false)}
            style={{ display: "flex", flexDirection: "column", minWidth: 0 }}
          >
            <DossierList
              dossiers={dossiers}
              selectedId={selected?.id}
              onSelect={pickDossier}
              onCollapse={toggleDossiers}
              onBatch={handleBatch}
              batchBusy={batchBusy}
              concurrency={concurrency}
              inputDir={inputDir}
            />
          </Panel>
          <ResizeHandle />

          {/* Sidebar 2 : fichiers du dossier sélectionné */}
          <Panel
            ref={filesPanelRef}
            defaultSize={17}
            minSize={11}
            maxSize={28}
            collapsible
            collapsedSize={0}
            onCollapse={() => setFilesCollapsed(true)}
            onExpand={() => setFilesCollapsed(false)}
            style={{ display: "flex", flexDirection: "column", minWidth: 0 }}
          >
            {selected ? (
              <DossierFilesList
                dossierId={selected.id}
                selectedFile={selectedFile}
                onSelect={(f) => {
                  setSelectedFile(f);
                  setSourcePageHint(undefined);
                  setSourceSearchHint(undefined);
                  setSourceQuoteHint(undefined);
                }}
                onCollapse={toggleFiles}
              />
            ) : (
              <div
                style={{
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--text-faint)",
                  fontSize: 11,
                  padding: 14,
                  textAlign: "center",
                  background: "var(--bg-panel)",
                }}
              >
                Sélectionnez un dossier
              </div>
            )}
          </Panel>
          <ResizeHandle />

          {/* Main : split horizontal preview/stream + grille/review */}
          <Panel
            defaultSize={65}
            style={{ display: "flex", flexDirection: "column", minWidth: 0 }}
          >
            {!selected ? (
              <EmptyState />
            ) : (
              <PanelGroup
                direction="horizontal"
                autoSaveId="oif-eval:layout-v3-main"
                style={{ flex: 1 }}
              >
                <Panel
                  defaultSize={50}
                  minSize={25}
                  style={{ display: "flex", flexDirection: "column", minWidth: 0 }}
                >
                  <PanelHeader>
                    <CollapsedToggle
                      collapsed={dossiersCollapsed}
                      onClick={toggleDossiers}
                      title="Afficher la liste des dossiers (Cmd+B)"
                    />
                    <CollapsedToggle
                      collapsed={filesCollapsed}
                      onClick={toggleFiles}
                      title="Afficher la liste des fichiers (Cmd+Shift+B)"
                    />
                    <SegmentedControl
                      value={leftMode}
                      onChange={(v) => setLeftMode(v as LeftMode)}
                      options={[
                        { value: "files", label: "Aperçu fichier" },
                        { value: "stream", label: "Travail de Claude" },
                      ]}
                    />
                    <div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
                      <button
                        onClick={() => setDrawerMode("chat")}
                        className="ghost"
                        title="Poser une question à Claude sur ce dossier (la conversation reste isolée à ce dossier)"
                        style={{
                          fontSize: 12,
                          padding: "5px 10px",
                          cursor: "pointer",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 6,
                        }}
                      >
                        <ClaudeMark size={14} />
                        Demander à Claude
                      </button>
                      <button
                        onClick={() => setDrawerMode("rule")}
                        className="ghost"
                        title="Signaler que Claude a raté quelque chose et proposer une règle pour toute la campagne"
                        style={{ fontSize: 12, padding: "5px 10px", cursor: "pointer" }}
                      >
                        Signaler un problème
                      </button>
                      {runStatus === "running" ? (
                        <button
                          onClick={stopperEvaluation}
                          style={{
                            fontSize: 12,
                            padding: "5px 12px",
                            cursor: "pointer",
                            background: "var(--red)",
                            color: "#fff",
                            border: "1px solid var(--red)",
                            borderRadius: "var(--radius-sm)",
                          }}
                          title="Arrêter l'évaluation en cours"
                        >
                          ⏹ Arrêter
                        </button>
                      ) : (
                        <>
                          <button
                            onClick={lancerEvaluation}
                            className="primary"
                            style={{
                              fontSize: 12,
                              padding: "5px 12px",
                              cursor: "pointer",
                            }}
                          >
                            {evaluation ? "Re-évaluer" : "Évaluer"}
                          </button>
                        </>
                      )}
                      {gridCollapsed && (
                        <>
                          <span
                            style={{
                              width: 1,
                              height: 18,
                              background: "var(--border)",
                              marginLeft: 4,
                            }}
                            aria-hidden
                          />
                          <button
                            onClick={toggleGrid}
                            aria-label="Afficher la grille (Cmd+J)"
                            title="Afficher la grille (Cmd+J)"
                            style={{
                              width: 26,
                              height: 26,
                              display: "inline-flex",
                              alignItems: "center",
                              justifyContent: "center",
                              background: "transparent",
                              border: "1px solid transparent",
                              borderRadius: "var(--radius-sm)",
                              color: "var(--text-muted)",
                              cursor: "pointer",
                              transition: "background 120ms ease, color 120ms ease",
                              padding: 0,
                            }}
                            onMouseEnter={(e) => {
                              e.currentTarget.style.background = "var(--bg-subtle)";
                              e.currentTarget.style.color = "var(--text-strong)";
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.background = "transparent";
                              e.currentTarget.style.color = "var(--text-muted)";
                            }}
                          >
                            <Icon name="panel-right-open" size={16} />
                          </button>
                        </>
                      )}
                    </div>
                  </PanelHeader>
                  <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
                    {leftMode === "files" ? (
                      <DossierFileViewer
                        dossierId={selected.id}
                        file={selectedFile}
                        initialPage={sourcePageHint}
                        initialSearch={sourceSearchHint}
                        initialQuote={sourceQuoteHint}
                      />
                    ) : (
                      <StreamingPanel events={events} status={runStatus} />
                    )}
                  </div>
                </Panel>
                <ResizeHandle />
                <Panel
                  ref={gridPanelRef}
                  defaultSize={50}
                  minSize={25}
                  collapsible
                  collapsedSize={0}
                  onCollapse={() => setGridCollapsed(true)}
                  onExpand={() => setGridCollapsed(false)}
                  style={{ display: "flex", flexDirection: "column", minWidth: 0 }}
                >
                  <PanelHeader>
                    <h2
                      style={{
                        fontSize: 13,
                        fontWeight: 600,
                        color: "var(--text-strong)",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        maxWidth: 220,
                        fontFamily: "var(--mono)",
                      }}
                      title={selected.id}
                    >
                      {selected.id}
                    </h2>
                    <SegmentedControl
                      value={view}
                      onChange={(v) => setView(v as ViewMode)}
                      options={[
                        { value: "stream", label: "Grille" },
                        {
                          value: "synthese",
                          label: "Synthèse",
                          disabled: !evaluation?.synthese,
                        },
                      ]}
                    />
                    {evaluation?.review?.validee_par && (
                      <span
                        style={{
                          fontSize: 11,
                          color: "var(--green)",
                          marginLeft: 8,
                          fontWeight: 500,
                        }}
                      >
                        ✓ Validé par {evaluation.review.validee_par}
                      </span>
                    )}
                    <button
                      onClick={toggleGrid}
                      aria-label="Réduire le panneau de la grille (Cmd+J)"
                      title="Réduire le panneau de la grille (Cmd+J)"
                      style={{
                        marginLeft: "auto",
                        width: 26,
                        height: 26,
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        background: "transparent",
                        border: "1px solid transparent",
                        borderRadius: "var(--radius-sm)",
                        color: "var(--text-muted)",
                        cursor: "pointer",
                        transition: "background 120ms ease, color 120ms ease",
                        padding: 0,
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = "var(--bg-subtle)";
                        e.currentTarget.style.color = "var(--text-strong)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = "transparent";
                        e.currentTarget.style.color = "var(--text-muted)";
                      }}
                    >
                      <Icon name="panel-right-close" size={14} />
                    </button>
                  </PanelHeader>
                  <div style={{ flex: 1, overflow: "hidden" }}>
                    {view === "stream" && (
                      <CriteresGrid
                        evaluation={evaluation}
                        horsIa={horsIa}
                        onChange={(updated) => {
                          setEvaluation(updated);
                          refreshDossiers();
                        }}
                        onPickSource={async (fileName, hint) => {
                          if (!selected) return;
                          // Récupère la liste des FileEntry du dossier puis fuzzy-match
                          // par nom (insensible casse, accents, séparateurs).
                          const files = await listDossierFiles(selected.id).catch(() => []);
                          const norm = (s: string): string =>
                            s
                              .toLowerCase()
                              .normalize("NFD")
                              .replace(/[̀-ͯ]/g, "")
                              .replace(/[^a-z0-9.]+/g, "");
                          const target = norm(fileName);
                          let match = files.find((f) => norm(f.name) === target);
                          if (!match) {
                            match = files.find(
                              (f) =>
                                norm(f.name).includes(target) ||
                                target.includes(norm(f.name))
                            );
                          }
                          if (match) {
                            setSelectedFile(match);
                            setLeftMode("files");
                            setSourcePageHint(hint?.page);
                            setSourceSearchHint(hint?.search);
                            setSourceQuoteHint(hint?.quote);
                          }
                        }}
                        onLancerNotation={
                          evaluation?.phase_eligibilite &&
                          !evaluation?.phase_notation &&
                          !autoNotation
                            ? () => lancerNotation(selected.id)
                            : undefined
                        }
                      />
                    )}
                    {view === "synthese" && evaluation?.synthese && (
                      <SyntheseView evaluation={evaluation} />
                    )}
                  </div>
                </Panel>
              </PanelGroup>
            )}
          </Panel>
        </PanelGroup>
      </div>
      {selected && drawerMode === "chat" && (
        <ChatDrawer
          key={`chat-${selected.id}`}
          open
          onClose={() => setDrawerMode(null)}
          user={user}
          title="Demander à Claude"
          contextHint={`Conversation isolée au dossier ${selected.id}. Pas de pollution avec les autres dossiers.`}
          initialPrompt=""
          dossierId={selected.id}
          placeholder={`Posez votre question sur le dossier ${selected.id}…`}
        />
      )}
      {selected && drawerMode === "rule" && (
        <RuleProposalForm
          key={`rule-${selected.id}`}
          user={user}
          dossierId={selected.id}
          onClose={() => setDrawerMode(null)}
        />
      )}
    </div>
  );
}

function PanelHeader({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "8px 12px",
        borderBottom: "1px solid var(--border-soft)",
        display: "flex",
        alignItems: "center",
        gap: 10,
        background: "var(--bg-panel)",
        minHeight: 44,
        flexShrink: 0,
      }}
    >
      {children}
    </div>
  );
}

function CollapsedToggle({
  collapsed,
  onClick,
  title,
}: {
  collapsed: boolean;
  onClick: () => void;
  title: string;
}) {
  if (!collapsed) return null;
  return (
    <button
      onClick={onClick}
      aria-label={title}
      title={title}
      style={{
        width: 26,
        height: 26,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        background: "transparent",
        border: "1px solid transparent",
        borderRadius: "var(--radius-sm)",
        color: "var(--text-muted)",
        cursor: "pointer",
        transition: "background 120ms ease, color 120ms ease",
        padding: 0,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--bg-subtle)";
        e.currentTarget.style.color = "var(--text-strong)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
        e.currentTarget.style.color = "var(--text-muted)";
      }}
    >
      <Icon name="panel-left-open" size={16} />
    </button>
  );
}

function SegmentedControl({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string; disabled?: boolean }[];
}) {
  return (
    <div
      style={{
        display: "inline-flex",
        background: "var(--bg-subtle)",
        border: "1px solid var(--border-soft)",
        borderRadius: "var(--radius-sm)",
        padding: 2,
        gap: 2,
      }}
    >
      {options.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            onClick={() => !opt.disabled && onChange(opt.value)}
            disabled={opt.disabled}
            style={{
              padding: "3px 10px",
              fontSize: 12,
              fontWeight: 500,
              borderRadius: 4,
              background: active ? "var(--bg-panel)" : "transparent",
              color: active
                ? "var(--text-strong)"
                : opt.disabled
                ? "var(--text-faint)"
                : "var(--text-muted)",
              border: "none",
              cursor: opt.disabled ? "not-allowed" : "pointer",
              transition: "all 120ms ease",
              boxShadow: active ? "var(--shadow-xs)" : "none",
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function EmptyState() {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--text-muted)",
        fontSize: 13,
        background: "var(--bg)",
      }}
    >
      Sélectionnez un dossier dans la liste à gauche.
    </div>
  );
}

function NoteFinaleEtayee({ evaluation, horsIa }: { evaluation: Evaluation; horsIa?: number[] }) {
  const not = evaluation.phase_notation;
  if (!not) return null;
  const HORS_IA = horsIa ?? [15, 16, 18, 23, 24, 26, 27, 33, 38, 39, 40, 42, 43, 47, 48, 49];
  const overrides = evaluation.review?.overrides_ia ?? [];
  const overrideById = new Map(overrides.map((o) => [o.question_id, o]));
  let scoreTotal = 0;
  let scoreMaxTotal = 0;
  let iaCount = 0, iaScore = 0;
  let overrideCount = 0, overrideScore = 0;
  let humanCount = 0, humanScore = 0;
  let humanTotal = 0;
  const overrideQs: { id: number; intitule: string; score_ia: number | null; score_human: number; raison: string }[] = [];
  const humanQs: { id: number; intitule: string; score: number | null; bareme: number }[] = [];
  for (const q of not.questions) {
    scoreMaxTotal += q.bareme_max;
    const isHorsIa = HORS_IA.includes(q.id);
    const ov = overrideById.get(q.id);
    if (isHorsIa) humanTotal++;
    if (ov) {
      scoreTotal += ov.score_human;
      if (isHorsIa) { humanCount++; humanScore += ov.score_human; humanQs.push({ id: q.id, intitule: q.intitule, score: ov.score_human, bareme: q.bareme_max }); }
      else { overrideCount++; overrideScore += ov.score_human; overrideQs.push({ id: q.id, intitule: q.intitule, score_ia: ov.score_ia, score_human: ov.score_human, raison: ov.raison }); }
    } else if (q.score !== null) {
      scoreTotal += q.score;
      if (!isHorsIa) { iaCount++; iaScore += q.score; }
    }
  }
  const pct = scoreMaxTotal > 0 ? (scoreTotal / scoreMaxTotal) * 100 : 0;
  const isComplete = humanCount === humanTotal && iaCount + overrideCount === not.questions.length - humanTotal;
  return (
    <section style={{ marginBottom: 28 }}>
      <div
        style={{
          padding: "16px 20px",
          background: isComplete ? "var(--green-bg)" : "var(--amber-bg)",
          border: `1.5px solid ${isComplete ? "var(--green-border)" : "var(--amber-border)"}`,
          borderRadius: "var(--radius)",
          marginBottom: 16,
        }}
      >
        <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-muted)", fontWeight: 600, marginBottom: 6 }}>
          {isComplete ? "✓ Note finale" : "Note partielle"}
        </div>
        <div style={{ fontSize: 32, fontWeight: 700, color: isComplete ? "var(--green)" : "var(--amber)", fontFamily: "var(--mono)", lineHeight: 1.1 }}>
          {scoreTotal.toFixed(scoreTotal % 1 === 0 ? 0 : 1)}<span style={{ fontSize: 18, fontWeight: 500, color: "var(--text-muted)" }}>/{scoreMaxTotal}</span>
          <span style={{ fontSize: 14, marginLeft: 12, color: "var(--text-muted)", fontWeight: 500 }}>{pct.toFixed(1)} %</span>
        </div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8, display: "flex", gap: 14, flexWrap: "wrap" }}>
          <span>🤖 IA : <strong>{iaScore}</strong> ({iaCount} Q)</span>
          {overrideCount > 0 && <span>✏️ Overrides : <strong>{overrideScore}</strong> ({overrideCount} Q)</span>}
          <span>👤 Humain : <strong>{humanScore}</strong> ({humanCount}/{humanTotal} Q)</span>
        </div>
      </div>

      {overrideQs.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <h4 style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--amber)", marginBottom: 8 }}>
            ✏️ Notes IA modifiées par humain ({overrideQs.length})
          </h4>
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
            {overrideQs.map((q) => (
              <li key={q.id} style={{ padding: "8px 12px", background: "var(--amber-bg)", border: "1px solid var(--amber-border)", borderRadius: "var(--radius-sm)", fontSize: 12.5 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                  <span style={{ flex: 1 }}><strong style={{ fontFamily: "var(--mono)" }}>Q{q.id}</strong> {q.intitule}</span>
                  <span style={{ fontFamily: "var(--mono)", color: "var(--text-muted)" }}>
                    IA <span style={{ textDecoration: "line-through" }}>{q.score_ia ?? "—"}</span> → <strong style={{ color: "var(--amber)" }}>{q.score_human}</strong>
                  </span>
                </div>
                {q.raison && (
                  <div style={{ marginTop: 4, fontSize: 11, color: "var(--text-muted)", fontStyle: "italic" }}>{q.raison}</div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {humanQs.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <h4 style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-muted)", marginBottom: 8 }}>
            👤 Notes humaines ({humanQs.length})
          </h4>
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
            {humanQs.map((q) => (
              <li key={q.id} style={{ padding: "8px 12px", background: "var(--bg-panel)", border: "1px solid var(--border-soft)", borderRadius: "var(--radius-sm)", fontSize: 12.5, display: "flex", justifyContent: "space-between", gap: 12 }}>
                <span style={{ flex: 1 }}><strong style={{ fontFamily: "var(--mono)" }}>Q{q.id}</strong> {q.intitule}</span>
                <span style={{ fontFamily: "var(--mono)", fontWeight: 600 }}>{q.score}/{q.bareme}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function SyntheseView({ evaluation }: { evaluation: Evaluation }) {
  const s = evaluation.synthese;
  if (!s) return null;
  const sections: { titre: string; items: string[]; color: string; bg: string; border: string; icon: string }[] = [
    {
      titre: "Points forts",
      items: s.points_forts ?? [],
      color: "var(--green)",
      bg: "var(--green-bg)",
      border: "var(--green-border)",
      icon: "✓",
    },
    {
      titre: "Points de vigilance",
      items: s.points_vigilance ?? [],
      color: "var(--amber)",
      bg: "var(--amber-bg)",
      border: "var(--amber-border)",
      icon: "⚠",
    },
    {
      titre: "Vérifications externes requises",
      items: s.verifications_externes ?? [],
      color: "var(--blue)",
      bg: "var(--blue-bg)",
      border: "var(--blue-border, var(--border))",
      icon: "🔎",
    },
  ];
  return (
    <div style={{ padding: 20, overflowY: "auto", height: "100%" }}>
      <NoteFinaleEtayee evaluation={evaluation} />
      {sections.map((sec) => (
        <section key={sec.titre} style={{ marginBottom: 24 }}>
          <h3
            style={{
              fontSize: 11,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              color: sec.color,
              marginBottom: 10,
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span>{sec.icon}</span>
            <span>{sec.titre}</span>
            <span style={{ color: "var(--text-faint)", fontWeight: 400 }}>
              ({sec.items.length})
            </span>
          </h3>
          {sec.items.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--text-faint)", fontStyle: "italic", paddingLeft: 8 }}>
              Aucun élément.
            </div>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
              {sec.items.map((item, i) => (
                <li
                  key={i}
                  style={{
                    padding: "8px 12px",
                    background: sec.bg,
                    border: `1px solid ${sec.border}`,
                    borderRadius: "var(--radius-sm)",
                    color: "var(--text)",
                    fontSize: 13,
                    lineHeight: 1.5,
                  }}
                >
                  {item}
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
      {evaluation.commentaires_internes && evaluation.commentaires_internes.length > 0 && (
        <section style={{ marginBottom: 24 }}>
          <h3
            style={{
              fontSize: 11,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              color: "var(--text-muted)",
              marginBottom: 10,
            }}
          >
            Commentaires internes ({evaluation.commentaires_internes.length})
          </h3>
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
            {evaluation.commentaires_internes.map((c, i) => (
              <li
                key={i}
                style={{
                  padding: "8px 12px",
                  background: "var(--bg-panel)",
                  border: "1px solid var(--border-soft)",
                  borderRadius: "var(--radius-sm)",
                  color: "var(--text)",
                  fontSize: 13,
                  lineHeight: 1.5,
                }}
              >
                {c}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
