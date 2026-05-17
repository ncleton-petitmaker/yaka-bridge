"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/Icon";
import { ProgressBar } from "@/components/ProgressBar";
import {
  getCalibrageReport,
  genPropositionsFromReport,
  streamRun,
  startCalibrageWithImport,
  cancelCalibrageRun,
  streamCalibrageRun,
  getCurrentCalibrageRun,
  getCalibrageImport,
  deleteCalibrageReport,
  importCalibrageBundle,
  downloadCalibrageTemplate,
  updateCalibrageImportMapping,
} from "@/lib/client";
import type {
  CalibrageReportJson,
  CalibrageReportSummary,
} from "@/lib/calibrage-types";
import type {
  CalibrageImport,
  CalibrageProgress,
} from "@/lib/calibrage-import-types";

/**
 * Section Calibrage : remplace l'ancien modal full-screen par une navigation
 * inline (liste des rapports, puis vue detail au clic). La TabBar et l'entete
 * de l'app restent visibles, donc on garde toujours un chemin de retour.
 */
interface Props {
  reports: CalibrageReportSummary[];
  onRefresh: () => Promise<void> | void;
}

export function CalibrageSection({ reports, onRefresh }: Props) {
  const [selected, setSelected] = useState<CalibrageReportSummary | null>(null);
  // DEBUG - à retirer avant livraison
  const [modeCompat, setModeCompat] = useState(false);

  if (selected) {
    return (
      <CalibrageReportDetail
        summary={selected}
        modeCompat={modeCompat}
        onBack={() => setSelected(null)}
        onDeleted={async () => {
          setSelected(null);
          await onRefresh();
        }}
      />
    );
  }

  return (
    <CalibrageReportsList
      reports={reports}
      onOpen={setSelected}
      onRefresh={onRefresh}
      modeCompat={modeCompat}
      onModeCompatChange={setModeCompat}
    />
  );
}

// ============================================================
// Vue 1 : liste des rapports
// ============================================================

function CalibrageReportsList({
  reports,
  onOpen,
  onRefresh,
  modeCompat,
  onModeCompatChange,
}: {
  reports: CalibrageReportSummary[];
  onOpen: (r: CalibrageReportSummary) => void;
  onRefresh: () => Promise<void> | void;
  modeCompat: boolean;
  onModeCompatChange: (v: boolean) => void;
}) {
  return (
    <section
      className="pane"
      style={{
        padding: 22,
        marginBottom: 16,
        borderColor:
          "color-mix(in srgb, var(--accent) 30%, var(--border))",
      }}
    >
      <SectionLabel adminBadge>Calibrage des règles</SectionLabel>
      <h2
        style={{
          fontFamily: "var(--serif)",
          fontWeight: 600,
          fontSize: 22,
          color: "var(--text-strong)",
          letterSpacing: "-0.01em",
          margin: "2px 0 6px",
        }}
      >
        Rapports de calibrage
      </h2>
      <p
        style={{
          fontSize: 13,
          color: "var(--text-muted)",
          lineHeight: 1.55,
          margin: 0,
          maxWidth: 720,
        }}
      >
        On compare les notes de l&apos;IA aux notes humaines fournies dans le
        bundle importé. L&apos;app remonte les critères où l&apos;IA dérape et
        permet de générer des propositions de correction des règles, à valider
        une par une.
      </p>
      {/* DEBUG - à retirer avant livraison */}
      <label
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 7,
          marginTop: 10,
          fontSize: 12,
          color: "var(--text-muted)",
          cursor: "pointer",
          userSelect: "none",
        }}
      >
        <input
          type="checkbox"
          checked={modeCompat}
          onChange={(e) => onModeCompatChange(e.target.checked)}
          style={{ cursor: "pointer" }}
        />
        Mode compat. 6e/7e - exclut Q8, Q37 et Q46 du score de similarite
      </label>

      {/* Zone import + lancement du calibrage */}
      <CalibrageLauncher onFinished={onRefresh} pastReports={reports} modeCompat={modeCompat} />

      {/* Liste des rapports */}
      <div style={{ marginTop: 22 }}>
        {reports.length === 0 ? (
          <EmptyState />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {reports.map((r, i) => (
              <ReportCard
                key={r.filename}
                report={r}
                latest={i === 0}
                onOpen={() => onOpen(r)}
                onDeleted={onRefresh}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

// ============================================================
// Sous-composant : import + lancement du calibrage
// ============================================================

type LauncherState =
  | { kind: "idle" }
  | { kind: "parsing"; filename: string }
  | {
      kind: "ready";
      bundle: CalibrageImport;
    }
  | {
      kind: "running";
      runId: string;
      bundle: CalibrageImport;
      progress: CalibrageProgress | null;
      cancelling: boolean;
    }
  | {
      kind: "done";
      bundle: CalibrageImport;
    };

function CalibrageLauncher({
  onFinished,
  pastReports,
  modeCompat,
}: {
  onFinished: () => Promise<void> | void;
  pastReports: CalibrageReportSummary[];
  modeCompat: boolean; // DEBUG à retirer avant livraison
}) {
  const [state, setState] = useState<LauncherState>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const closeStreamRef = useRef<(() => void) | null>(null);
  // Overrides admin du mapping colonnes -> Q (vue ready). Clé "col_<N>", valeur
  // qId | null (null = ignorer). Stockés en local jusqu'à "Sauvegarder".
  const [mappingOverrides, setMappingOverrides] = useState<
    Record<string, number | null>
  >({});
  const [savingMapping, setSavingMapping] = useState(false);

  // Cleanup SSE quand le composant se démonte
  useEffect(() => {
    return () => {
      if (closeStreamRef.current) closeStreamRef.current();
    };
  }, []);

  // Au mount : si un calibrage tourne déjà côté daemon (reload page, change
  // d'onglet, restart Electron), on récupère son état + branche le SSE pour
  // afficher la progression au lieu de la drop zone vide.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const current = await getCurrentCalibrageRun();
        if (cancelled || !current) return;
        // Reconstruit le bundle complet depuis l'importId si dispo
        let bundle: CalibrageImport | null = null;
        if (current.importId) {
          try {
            bundle = await getCalibrageImport(current.importId);
          } catch {
            // bundle introuvable, on continue avec un stub minimal
          }
        }
        if (cancelled) return;
        if (!bundle) {
          // Stub minimal pour pouvoir afficher la vue running
          bundle = {
            importId: current.importId ?? "inconnu",
            createdAt: new Date(current.startedAt).toISOString(),
            bundleName: "Calibrage en cours",
            totalDossiers: current.evaluationsTotal,
            dossiers: [],
            warnings: [],
          };
        }
        setState({
          kind: "running",
          runId: current.runId,
          bundle,
          progress: current.lastProgress ?? null,
          cancelling: false,
        });
        // Branche le SSE sur le run en cours
        const close = streamCalibrageRun(current.runId, (ev) => {
          if (ev.kind === "progress" && ev.progress) {
            setState((prev) =>
              prev.kind === "running"
                ? { ...prev, progress: ev.progress ?? null }
                : prev
            );
          }
          if (ev.kind === "end") {
            setState({ kind: "done", bundle: bundle! });
            if (closeStreamRef.current) {
              closeStreamRef.current();
              closeStreamRef.current = null;
            }
            void onFinished();
          }
        });
        closeStreamRef.current = close;
      } catch {
        // Pas admin, daemon down, ou rien en cours : on reste en idle
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleFile(file: File) {
    setError(null);
    setWarnings([]);
    setMappingOverrides({});
    setState({ kind: "parsing", filename: file.name });
    try {
      const bundle = await importCalibrageBundle(file);
      setWarnings(bundle.warnings);
      setState({ kind: "ready", bundle });
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes("admin")) {
        setError("Reservé aux comptes administrateurs.");
      } else {
        setError(msg);
      }
      setState({ kind: "idle" });
    }
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".zip")) {
      setError("Le fichier doit être un ZIP.");
      return;
    }
    void handleFile(file);
  }

  function handleClickPicker() {
    fileInputRef.current?.click();
  }

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) void handleFile(file);
    // Reset le input pour permettre de re-uploader le même fichier après cancel
    e.target.value = "";
  }

  async function handleLaunch() {
    if (state.kind !== "ready") return;
    setError(null);
    const bundle = state.bundle;
    try {
      const { runId } = await startCalibrageWithImport(bundle.importId, { modeCompat }); // DEBUG modeCompat
      setState({
        kind: "running",
        runId,
        bundle,
        progress: null,
        cancelling: false,
      });
      const close = streamCalibrageRun(runId, (ev) => {
        if (ev.kind === "progress" && ev.progress) {
          setState((prev) =>
            prev.kind === "running"
              ? { ...prev, progress: ev.progress ?? null }
              : prev
          );
        }
        if (ev.kind === "end") {
          setState({ kind: "done", bundle });
          if (closeStreamRef.current) {
            closeStreamRef.current();
            closeStreamRef.current = null;
          }
          void onFinished();
          // Retour à l'idle après quelques secondes pour laisser voir le succès
          setTimeout(() => {
            setState({ kind: "idle" });
            setWarnings([]);
          }, 5000);
        }
        if (ev.kind === "error") {
          setError(
            "Une erreur est survenue pendant le calibrage. Reessayer plus tard."
          );
          setState({ kind: "idle" });
          if (closeStreamRef.current) {
            closeStreamRef.current();
            closeStreamRef.current = null;
          }
        }
      });
      closeStreamRef.current = close;
    } catch (e) {
      const msg = (e as Error).message;
      if (msg === "already_running") {
        setError("Un calibrage est déjà en cours, attendez qu'il termine.");
      } else {
        setError(msg);
      }
    }
  }

  async function handleCancel() {
    if (state.kind !== "running") return;
    if (!confirm("Annuler le calibrage en cours ?")) return;
    setState((prev) =>
      prev.kind === "running" ? { ...prev, cancelling: true } : prev
    );
    try {
      await cancelCalibrageRun(state.runId);
      // Le SSE end nettoyera l'état
    } catch (e) {
      setError((e as Error).message);
      setState((prev) =>
        prev.kind === "running" ? { ...prev, cancelling: false } : prev
      );
    }
  }

  function handleResetReady() {
    setState({ kind: "idle" });
    setWarnings([]);
    setError(null);
    setMappingOverrides({});
  }

  /**
   * Sauvegarde les overrides admin du mapping. Re-fetch le bundle complet
   * (manifest patché) pour rafraîchir l'état UI avec les nouveaux scores.
   */
  async function handleSaveMapping() {
    if (state.kind !== "ready") return;
    if (Object.keys(mappingOverrides).length === 0) return;
    setSavingMapping(true);
    setError(null);
    try {
      const updated = await updateCalibrageImportMapping(
        state.bundle.importId,
        mappingOverrides
      );
      setState({ kind: "ready", bundle: updated });
      setWarnings(updated.warnings);
      setMappingOverrides({});
    } catch (e) {
      setError(`Sauvegarde du mapping échouée : ${(e as Error).message}`);
    } finally {
      setSavingMapping(false);
    }
  }

  const isParsing = state.kind === "parsing";
  const isReady = state.kind === "ready";
  const isRunning = state.kind === "running";
  const isDone = state.kind === "done";
  const isIdle = state.kind === "idle" || isParsing;

  return (
    <div style={{ marginTop: 16 }}>
      {/* Toast succès */}
      {isDone && (
        <div
          style={{
            padding: "10px 14px",
            marginBottom: 12,
            background: "var(--green-bg)",
            border: "1px solid var(--green-border)",
            borderRadius: "var(--radius-sm)",
            fontSize: 13,
            color: "var(--text)",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <Icon name="check" size={14} />
          <strong style={{ color: "var(--green)" }}>
            Calibrage terminé
          </strong>
          <span style={{ color: "var(--text-muted)" }}>
            Le nouveau rapport est disponible ci-dessous.
          </span>
        </div>
      )}

      {/* Erreur */}
      {error && (
        <div
          style={{
            padding: "10px 14px",
            marginBottom: 12,
            background: "var(--amber-bg)",
            border: "1px solid var(--amber-border)",
            borderRadius: "var(--radius-sm)",
            fontSize: 13,
            color: "var(--text)",
          }}
        >
          {error}
        </div>
      )}

      {/* État Parsing : grosse bannière bien visible */}
      {isParsing && (
        <div
          style={{
            padding: "32px 24px",
            border: "2px solid var(--accent)",
            borderRadius: "var(--radius)",
            background: "var(--accent-tint)",
            textAlign: "center",
            marginBottom: 12,
          }}
          role="status"
          aria-live="polite"
        >
          <SpinnerAccent size={36} />
          <div
            style={{
              fontFamily: "var(--serif)",
              fontWeight: 600,
              fontSize: 19,
              color: "var(--text-strong)",
              marginTop: 14,
              marginBottom: 6,
            }}
          >
            Lecture de votre bundle en cours...
          </div>
          <div
            style={{
              fontSize: 13,
              color: "var(--text-muted)",
              lineHeight: 1.55,
              maxWidth: 520,
              margin: "0 auto",
            }}
          >
            On décompresse le ZIP, on lit le fichier Excel et on vérifie que
            chaque référence a bien ses PDFs. Cela peut prendre 10 à 30
            secondes selon la taille du bundle. Ne quittez pas cette page.
          </div>
        </div>
      )}

      {/* État Idle : drop zone */}
      {isIdle && !isParsing && (
        <div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".zip,application/zip"
            onChange={handleInputChange}
            style={{ display: "none" }}
            aria-label="Choisir un bundle de calibrage"
          />
          <div
            onDrop={handleDrop}
            onDragOver={(e) => {
              e.preventDefault();
              if (!dragOver) setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onClick={handleClickPicker}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                handleClickPicker();
              }
            }}
            style={{
              padding: "26px 18px",
              border: `2px dashed ${
                dragOver
                  ? "var(--accent)"
                  : "color-mix(in srgb, var(--accent) 35%, var(--border-strong))"
              }`,
              borderRadius: "var(--radius)",
              background: dragOver ? "var(--accent-tint)" : "var(--bg-panel)",
              cursor: "pointer",
              textAlign: "center",
              transition: "background 150ms ease, border-color 150ms ease",
            }}
          >
            <div
              style={{
                fontSize: 32,
                color: "var(--accent-strong)",
                marginBottom: 6,
                lineHeight: 1,
              }}
              aria-hidden
            >
              ↑
            </div>
            <div
              style={{
                fontFamily: "var(--serif)",
                fontWeight: 600,
                fontSize: 17,
                color: "var(--text-strong)",
                marginBottom: 4,
              }}
            >
              Importer un bundle de calibrage
            </div>
            <div
              style={{
                fontSize: 12.5,
                color: "var(--text-muted)",
                lineHeight: 1.55,
                maxWidth: 480,
                margin: "0 auto",
              }}
            >
              Glisser un fichier ZIP ici ou cliquer pour parcourir. Le ZIP doit
              contenir un fichier xlsx (notes humaines) et un dossier
              <code
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: 11,
                  marginLeft: 4,
                  marginRight: 4,
                  padding: "1px 5px",
                  background: "var(--bg-subtle)",
                  borderRadius: 3,
                }}
              >
                dossiers/
              </code>
              avec un sous-dossier PDF par référence.
              <br />
              <strong>Conseil :</strong> 20 dossiers répartis (hauts, moyens,
              bas scores) suffisent pour mesurer la qualité de l&apos;IA. Au-delà,
              le calibrage prend plusieurs heures sans bénéfice net.
            </div>
          </div>
          <div
            style={{
              marginTop: 10,
              fontSize: 12.5,
              color: "var(--text-muted)",
              textAlign: "center",
            }}
          >
            Pas de modèle ?{" "}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                downloadCalibrageTemplate();
              }}
              style={{
                background: "none",
                border: "none",
                color: "var(--accent-strong)",
                fontSize: "inherit",
                fontFamily: "inherit",
                cursor: "pointer",
                textDecoration: "underline",
                padding: 0,
              }}
            >
              Télécharger le modèle Excel
            </button>
          </div>

          {/* Exemple de structure ZIP attendue */}
          <div
            style={{
              marginTop: 16,
              padding: 14,
              background: "var(--accent-tint)",
              border:
                "1px solid color-mix(in srgb, var(--accent) 30%, var(--border))",
              borderRadius: "var(--radius-sm)",
            }}
          >
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: "var(--text-strong)",
                marginBottom: 4,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
              }}
            >
              Structure attendue du ZIP
            </div>
            <div
              style={{
                fontSize: 12,
                color: "var(--text-muted)",
                lineHeight: 1.55,
                marginBottom: 10,
              }}
            >
              Un fichier <code>notes-humaines.xlsx</code> à la racine (format
              OIF, onglet &laquo;&nbsp;Classement général&nbsp;&raquo;) et un
              dossier <code>dossiers/</code> avec un sous-dossier par
              référence (10 caractères hex), contenant les PDFs du candidat.
              <br />
              <strong>Taille recommandée : 20 dossiers</strong> (assez pour
              être représentatif, sans noyer la machine).
            </div>
            <pre
              style={{
                fontFamily: "var(--mono)",
                fontSize: 11.5,
                color: "var(--text)",
                background: "var(--bg-panel)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm)",
                padding: "10px 12px",
                margin: 0,
                lineHeight: 1.55,
                overflow: "auto",
              }}
            >
{`calibrage-test.zip
├── notes-humaines.xlsx
└── dossiers/
    ├── 29e0252257/
    │   ├── formulaire.pdf
    │   ├── rapport-activites.pdf
    │   └── ...
    ├── 7291c3f84c/
    │   └── ...
    └── ... (1 sous-dossier par référence du xlsx)`}
            </pre>
          </div>
        </div>
      )}

      {/* État Ready : récap + bouton lancer */}
      {isReady && (
        <div
          style={{
            padding: 18,
            background: "var(--accent-tint)",
            border:
              "1px solid color-mix(in srgb, var(--accent) 30%, transparent)",
            borderRadius: "var(--radius)",
          }}
        >
          <div
            style={{
              fontFamily: "var(--serif)",
              fontWeight: 600,
              fontSize: 17,
              color: "var(--text-strong)",
              marginBottom: 6,
            }}
          >
            Bundle prêt à analyser
          </div>
          <div
            style={{
              fontSize: 13,
              color: "var(--text)",
              lineHeight: 1.55,
              marginBottom: 4,
            }}
          >
            <strong>{state.bundle.totalDossiers}</strong> dossiers détectés dans{" "}
            <code style={{ fontFamily: "var(--mono)", fontSize: 11 }}>
              {state.bundle.bundleName}
            </code>
            .{" "}
            <strong>
              {state.bundle.dossiers.filter((d) => d.hasFolder).length}
            </strong>{" "}
            avec PDF associé.
          </div>
          {state.bundle.colonnes && state.bundle.colonnes.length > 0 && (
            <div
              style={{
                marginTop: 8,
                fontSize: 12.5,
                color: "var(--text-muted)",
                lineHeight: 1.55,
              }}
            >
              <strong>{state.bundle.colonnes.length}</strong> colonnes xlsx
              détectées,{" "}
              <strong>
                {
                  state.bundle.colonnes.filter(
                    (c) => c.matchedSkillQId != null
                  ).length
                }
              </strong>{" "}
              mappées à des Q du skill (seuil 70%).
            </div>
          )}
          {state.bundle.colonnes &&
            state.bundle.colonnes.some((c) => c.matchWarning) && (
              <div
                style={{
                  marginTop: 8,
                  padding: "8px 12px",
                  background: "var(--amber-bg)",
                  border: "1px solid var(--amber-border)",
                  borderRadius: "var(--radius-sm)",
                  fontSize: 12.5,
                  color: "var(--text)",
                  lineHeight: 1.55,
                }}
              >
                Mapping imparfait :{" "}
                {
                  state.bundle.colonnes.filter(
                    (c) => c.matchedSkillQId == null
                  ).length
                }{" "}
                libellés xlsx sans correspondance,{" "}
                {
                  state.bundle.colonnes.filter(
                    (c) =>
                      c.matchedSkillQId != null && c.matchWarning != null
                  ).length
                }{" "}
                avec match faible. Le calibrage sera partiel.
              </div>
            )}
          {state.bundle.colonnes && state.bundle.colonnes.length > 0 && (
            <details style={{ marginTop: 8, fontSize: 12 }}>
              <summary
                style={{
                  cursor: "pointer",
                  color: "var(--text-muted)",
                  fontWeight: 500,
                }}
              >
                Voir le détail du mapping
              </summary>
              <div
                style={{
                  marginTop: 8,
                  border: "1px solid var(--border-soft)",
                  borderRadius: "var(--radius-sm)",
                  overflow: "hidden",
                  maxHeight: 320,
                  overflowY: "auto",
                }}
              >
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    fontSize: 11.5,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  <thead
                    style={{
                      background: "var(--bg-subtle)",
                      position: "sticky",
                      top: 0,
                    }}
                  >
                    <tr>
                      <th
                        style={{
                          textAlign: "left",
                          padding: "6px 10px",
                          fontWeight: 600,
                          color: "var(--text-faint)",
                        }}
                      >
                        Col
                      </th>
                      <th
                        style={{
                          textAlign: "left",
                          padding: "6px 10px",
                          fontWeight: 600,
                          color: "var(--text-faint)",
                        }}
                      >
                        Libellé xlsx
                      </th>
                      <th
                        style={{
                          textAlign: "right",
                          padding: "6px 10px",
                          fontWeight: 600,
                          color: "var(--text-faint)",
                        }}
                      >
                        Q skill
                      </th>
                      <th
                        style={{
                          textAlign: "right",
                          padding: "6px 10px",
                          fontWeight: 600,
                          color: "var(--text-faint)",
                        }}
                      >
                        Score
                      </th>
                      <th
                        style={{
                          textAlign: "left",
                          padding: "6px 10px",
                          fontWeight: 600,
                          color: "var(--text-faint)",
                        }}
                      >
                        Override admin
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.bundle.colonnes.map((c) => {
                      const lib =
                        c.libelleXlsx.length > 60
                          ? c.libelleXlsx.slice(0, 57) + "..."
                          : c.libelleXlsx;
                      const color =
                        c.matchedSkillQId == null
                          ? "var(--red)"
                          : c.matchWarning != null
                          ? "var(--amber)"
                          : "var(--text-muted)";
                      const key = `col_${c.positionXlsx}`;
                      // Match "faible" : score < 0.6 ou pas de match du tout.
                      // On laisse l'admin overrider, même en cas de match haut
                      // (au cas où il sait que c'est faux).
                      const isWeak =
                        c.matchedSkillQId == null || c.matchScore < 0.6;
                      const overrideVal = mappingOverrides[key];
                      const currentVal =
                        overrideVal !== undefined
                          ? overrideVal
                          : c.matchedSkillQId;
                      const isPending = overrideVal !== undefined;
                      return (
                        <tr
                          key={c.positionXlsx}
                          style={{
                            borderTop: "1px solid var(--border-soft)",
                            background: isPending
                              ? "color-mix(in srgb, var(--accent) 8%, transparent)"
                              : undefined,
                          }}
                        >
                          <td
                            style={{
                              padding: "5px 10px",
                              fontFamily: "var(--mono)",
                              color: "var(--text-faint)",
                            }}
                          >
                            {c.positionXlsx + 1}
                          </td>
                          <td style={{ padding: "5px 10px" }}>{lib}</td>
                          <td
                            style={{
                              padding: "5px 10px",
                              textAlign: "right",
                              fontFamily: "var(--mono)",
                              color,
                              fontWeight: 600,
                            }}
                          >
                            {c.matchedSkillQId != null
                              ? `Q${c.matchedSkillQId}`
                              : "-"}
                          </td>
                          <td
                            style={{
                              padding: "5px 10px",
                              textAlign: "right",
                              color,
                            }}
                          >
                            {c.matchScore > 0
                              ? c.matchScore.toFixed(2)
                              : "-"}
                          </td>
                          <td style={{ padding: "5px 10px" }}>
                            {isWeak || isPending ? (
                              <select
                                value={
                                  currentVal == null
                                    ? "__null"
                                    : String(currentVal)
                                }
                                onChange={(e) => {
                                  const v = e.target.value;
                                  let nextVal: number | null;
                                  if (v === "__null") nextVal = null;
                                  else nextVal = Number(v);
                                  setMappingOverrides((prev) => {
                                    const next = { ...prev };
                                    // Si on revient à la valeur initiale, on
                                    // retire l'override (rien à sauvegarder).
                                    if (nextVal === c.matchedSkillQId) {
                                      delete next[key];
                                    } else {
                                      next[key] = nextVal;
                                    }
                                    return next;
                                  });
                                }}
                                style={{
                                  fontSize: 11,
                                  fontFamily: "var(--mono)",
                                  padding: "2px 4px",
                                  border: "1px solid var(--border-soft)",
                                  borderRadius: "var(--radius-xs)",
                                  background: "var(--bg-panel)",
                                  color: "var(--text)",
                                }}
                              >
                                <option value="__null">- ignorer -</option>
                                {Array.from({ length: 49 }, (_, i) => i + 1).map(
                                  (qId) => (
                                    <option key={qId} value={qId}>
                                      Q{qId}
                                    </option>
                                  )
                                )}
                              </select>
                            ) : (
                              <span
                                style={{
                                  color: "var(--text-faint)",
                                  fontSize: 10.5,
                                }}
                              >
                                ok
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {Object.keys(mappingOverrides).length > 0 && (
                <div
                  style={{
                    marginTop: 8,
                    display: "flex",
                    gap: 10,
                    alignItems: "center",
                    padding: "8px 12px",
                    background:
                      "color-mix(in srgb, var(--accent) 10%, transparent)",
                    border: "1px solid var(--accent-soft)",
                    borderRadius: "var(--radius-sm)",
                    fontSize: 12,
                  }}
                >
                  <span style={{ color: "var(--text)", flex: 1 }}>
                    {Object.keys(mappingOverrides).length} override
                    {Object.keys(mappingOverrides).length > 1 ? "s" : ""} en
                    attente.
                  </span>
                  <button
                    type="button"
                    onClick={handleSaveMapping}
                    disabled={savingMapping}
                    style={{
                      padding: "5px 12px",
                      fontSize: 12,
                      fontWeight: 600,
                      color: "#fff",
                      background: "var(--accent)",
                      border: "none",
                      borderRadius: "var(--radius-sm)",
                      cursor: savingMapping ? "wait" : "pointer",
                      opacity: savingMapping ? 0.6 : 1,
                    }}
                  >
                    {savingMapping
                      ? "Sauvegarde..."
                      : "Sauvegarder le mapping"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setMappingOverrides({})}
                    disabled={savingMapping}
                    style={{
                      padding: "5px 12px",
                      fontSize: 12,
                      color: "var(--text-muted)",
                      background: "transparent",
                      border: "1px solid var(--border-soft)",
                      borderRadius: "var(--radius-sm)",
                      cursor: savingMapping ? "wait" : "pointer",
                    }}
                  >
                    Réinitialiser
                  </button>
                </div>
              )}
            </details>
          )}
          {warnings.length > 0 && (
            <details style={{ marginTop: 8, fontSize: 12 }}>
              <summary
                style={{
                  cursor: "pointer",
                  color: "var(--amber)",
                  fontWeight: 600,
                }}
              >
                {warnings.length} avertissement
                {warnings.length > 1 ? "s" : ""}
              </summary>
              <ul
                style={{
                  margin: "6px 0 0 18px",
                  padding: 0,
                  color: "var(--text-muted)",
                  lineHeight: 1.5,
                }}
              >
                {warnings.slice(0, 10).map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
                {warnings.length > 10 && (
                  <li style={{ fontStyle: "italic" }}>
                    ... et {warnings.length - 10} autre
                    {warnings.length - 10 > 1 ? "s" : ""}
                  </li>
                )}
              </ul>
            </details>
          )}
          {/* Garde-fou : on bloque le lancement tant que < 70% des colonnes
              sont mappées (l'admin doit corriger via les overrides ci-dessus). */}
          {(() => {
            const cols = state.bundle.colonnes ?? [];
            const mappedCount = cols.filter(
              (c) => c.matchedSkillQId != null
            ).length;
            const ratio =
              cols.length > 0 ? mappedCount / cols.length : 1;
            const blocked = ratio < 0.7;
            const hasPendingOverrides =
              Object.keys(mappingOverrides).length > 0;
            return (
              <div
                style={{
                  marginTop: 14,
                  display: "flex",
                  gap: 10,
                  flexWrap: "wrap",
                  alignItems: "center",
                }}
              >
                <button
                  type="button"
                  onClick={handleLaunch}
                  disabled={blocked || hasPendingOverrides}
                  title={
                    blocked
                      ? `Mapping insuffisant (${mappedCount}/${cols.length}). Corriger via les overrides ci-dessus avant de lancer.`
                      : hasPendingOverrides
                      ? "Sauvegarder le mapping en attente avant de lancer."
                      : "Lancer le calibrage IA sur ce bundle"
                  }
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "10px 20px",
                    fontSize: 13.5,
                    fontWeight: 600,
                    color: "#fff",
                    background:
                      blocked || hasPendingOverrides
                        ? "var(--text-faint)"
                        : "var(--accent)",
                    border: "1px solid transparent",
                    borderRadius: "var(--radius-sm)",
                    cursor:
                      blocked || hasPendingOverrides
                        ? "not-allowed"
                        : "pointer",
                    fontFamily: "var(--sans)",
                    transition: "background 150ms ease",
                    opacity: blocked || hasPendingOverrides ? 0.7 : 1,
                  }}
                  onMouseEnter={(e) => {
                    if (blocked || hasPendingOverrides) return;
                    e.currentTarget.style.background = "var(--accent-strong)";
                  }}
                  onMouseLeave={(e) => {
                    if (blocked || hasPendingOverrides) return;
                    e.currentTarget.style.background = "var(--accent)";
                  }}
                >
                  <Icon name="sparkles" size={14} />
                  <span>
                    Lancer l&apos;analyse (
                    {formatEstimateLabel(state.bundle, pastReports)})
                  </span>
                </button>
                {blocked && (
                  <span
                    style={{
                      fontSize: 12,
                      color: "var(--red)",
                    }}
                  >
                    Mapping insuffisant ({mappedCount}/{cols.length}). Cible
                    minimum 70%.
                  </span>
                )}
              </div>
            );
          })()}
          {/* Bloc résiduel d'actions secondaires (annuler) - on garde l'ancien
              wrapper pour ne rien casser visuellement. */}
          <div
            style={{
              marginTop: 8,
              display: "flex",
              gap: 10,
              flexWrap: "wrap",
            }}
          >
            <button
              type="button"
              onClick={handleResetReady}
              style={{
                padding: "9px 16px",
                fontSize: 12.5,
                fontWeight: 500,
                color: "var(--text-muted)",
                background: "transparent",
                border: "1px solid var(--border-soft)",
                borderRadius: "var(--radius-sm)",
                cursor: "pointer",
                fontFamily: "var(--sans)",
                transition: "background 150ms ease",
              }}
            >
              Annuler
            </button>
          </div>
        </div>
      )}

      {/* État Running : barre de progression */}
      {isRunning && (
        <div
          style={{
            padding: 18,
            background: "var(--accent-tint)",
            border:
              "1px solid color-mix(in srgb, var(--accent) 30%, transparent)",
            borderRadius: "var(--radius)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 12,
              flexWrap: "wrap",
            }}
          >
            <SpinnerAccent />
            <strong style={{ color: "var(--accent-strong)", fontSize: 14 }}>
              Calibrage en cours
            </strong>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
              Vous pouvez quitter cette page, le calibrage continue en
              arrière-plan.
            </span>
          </div>
          <ProgressBar
            done={state.progress?.done ?? 0}
            total={
              state.progress?.total ??
              state.bundle.dossiers.filter((d) => d.hasFolder).length
            }
            label={
              state.progress?.lastDossier
                ? `Dernier dossier : ${state.progress.lastDossier}`
                : "Préparation..."
            }
            etaSeconds={state.progress?.etaSeconds ?? null}
          />
          <div style={{ marginTop: 14 }}>
            <button
              type="button"
              onClick={handleCancel}
              disabled={state.cancelling}
              style={{
                padding: "8px 14px",
                fontSize: 12.5,
                fontWeight: 600,
                color: state.cancelling ? "var(--text-faint)" : "var(--red)",
                background: "transparent",
                border: state.cancelling
                  ? "1px solid var(--border-soft)"
                  : "1px solid var(--red-border)",
                borderRadius: "var(--radius-sm)",
                cursor: state.cancelling ? "not-allowed" : "pointer",
                fontFamily: "var(--sans)",
                transition: "background 150ms ease",
              }}
              onMouseEnter={(e) => {
                if (state.cancelling) return;
                e.currentTarget.style.background = "var(--red-bg)";
              }}
              onMouseLeave={(e) => {
                if (state.cancelling) return;
                e.currentTarget.style.background = "transparent";
              }}
            >
              {state.cancelling ? "Annulation..." : "Annuler le calibrage"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Concurrence du batch côté daemon (cf. MAX_CONCURRENT_EVALUATIONS). */
const CALIBRAGE_PARALLELISM = 3;

/**
 * Estime la durée totale du calibrage à partir de la durée moyenne par
 * évaluation observée sur les calibrages précédents (`duree_moyenne_s` du
 * rapport JSON). On prend les 3 derniers rapports avec une durée connue,
 * on en fait la moyenne, et on multiplie par `nbDossiers / parallélisme`.
 *
 * S'il n'y a aucun historique exploitable, on retourne `null` : l'UI affiche
 * alors un placeholder honnête au lieu d'un faux chiffre.
 */
function estimateCalibrageRange(
  bundle: CalibrageImport,
  pastReports: CalibrageReportSummary[]
): { min: number; max: number } | null {
  const nbDossiers = bundle.dossiers.filter((d) => d.hasFolder).length;
  if (nbDossiers <= 0) return null;

  const recents = pastReports
    .filter(
      (r) =>
        typeof r.duree_moyenne_s === "number" &&
        r.duree_moyenne_s > 0 &&
        typeof r.nb_dossiers === "number" &&
        r.nb_dossiers > 0
    )
    .slice(0, 3);
  if (recents.length === 0) return null;

  const avgPerDossierS =
    recents.reduce((s, r) => s + (r.duree_moyenne_s ?? 0), 0) / recents.length;
  const expectedTotalS = (nbDossiers / CALIBRAGE_PARALLELISM) * avgPerDossierS;
  const minMin = Math.max(1, Math.floor((expectedTotalS * 0.85) / 60));
  const maxMin = Math.max(minMin + 1, Math.ceil((expectedTotalS * 1.25) / 60));
  return { min: minMin, max: maxMin };
}

/**
 * Format affichable de l'estimation. Renvoie une chaîne du type "12 à 18 min"
 * ou "estimation indisponible (1er calibrage)" si pas d'historique.
 */
function formatEstimateLabel(
  bundle: CalibrageImport,
  pastReports: CalibrageReportSummary[]
): string {
  const r = estimateCalibrageRange(bundle, pastReports);
  if (!r) return "durée inconnue (1er calibrage)";
  if (r.min === r.max) return `~${r.min} min`;
  return `${r.min} à ${r.max} min`;
}

function EmptyState() {
  return (
    <div
      style={{
        padding: 22,
        fontSize: 13,
        color: "var(--text-muted)",
        background: "var(--bg-subtle)",
        border: "1px dashed var(--border-strong)",
        borderRadius: "var(--radius)",
        textAlign: "center",
        lineHeight: 1.55,
      }}
    >
      Aucun rapport pour le moment. Cliquer sur{" "}
      <strong style={{ color: "var(--text)" }}>
        Lancer un nouveau calibrage
      </strong>{" "}
      ci-dessus pour en produire un.
    </div>
  );
}

function ReportCard({
  report,
  latest,
  onOpen,
  onDeleted,
}: {
  report: CalibrageReportSummary;
  latest: boolean;
  onOpen: () => void;
  onDeleted: () => Promise<void> | void;
}) {
  const [deleting, setDeleting] = useState(false);
  const dt = report.timestamp
    ? new Date(report.timestamp).toLocaleString("fr-FR", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : report.filename;

  const accord = report.accord_pct ?? 0;
  const accordTone = scoreToTone(accord, [85, 60]);
  const dAbs = Math.abs(report.delta_score_moyen ?? 0);
  const deltaTone = scoreToTone(15 - dAbs, [10, 0]);

  const disabled = !report.has_json;

  async function handleDelete(e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm("Supprimer ce rapport ? (action irréversible)")) return;
    setDeleting(true);
    try {
      await deleteCalibrageReport(report.filename);
      await onDeleted();
    } catch (err) {
      alert("Suppression impossible : " + (err as Error).message);
      setDeleting(false);
    }
  }

  return (
    <div
      onClick={() => {
        if (!disabled) onOpen();
      }}
      role="button"
      tabIndex={disabled ? -1 : 0}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && !disabled) {
          e.preventDefault();
          onOpen();
        }
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.boxShadow = "var(--shadow-md)";
        e.currentTarget.style.borderColor = "var(--accent-soft)";
        e.currentTarget.style.transform = "translateY(-1px)";
      }}
      onMouseLeave={(e) => {
        if (disabled) return;
        e.currentTarget.style.boxShadow = "var(--shadow-xs)";
        e.currentTarget.style.borderColor = latest
          ? "color-mix(in srgb, var(--accent) 25%, var(--border))"
          : "var(--border)";
        e.currentTarget.style.transform = "translateY(0)";
      }}
      style={{
        padding: "16px 18px",
        background: latest ? "var(--accent-tint)" : "var(--bg-panel)",
        border: `1px solid ${
          latest
            ? "color-mix(in srgb, var(--accent) 25%, var(--border))"
            : "var(--border)"
        }`,
        borderRadius: "var(--radius)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.7 : 1,
        boxShadow: "var(--shadow-xs)",
        transition:
          "box-shadow 180ms ease, border-color 180ms ease, transform 180ms ease",
        display: "flex",
        alignItems: "center",
        gap: 14,
        flexWrap: "wrap",
      }}
      title={
        disabled
          ? "Format ancien (markdown seul). Lancer un nouveau calibrage pour voir le détail."
          : "Voir le détail du rapport"
      }
    >
      {/* Bloc info */}
      <div style={{ flex: "1 1 220px", minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 4,
            flexWrap: "wrap",
          }}
        >
          <span
            style={{
              fontFamily: "var(--serif)",
              fontWeight: 600,
              fontSize: 16,
              color: "var(--text-strong)",
              letterSpacing: "-0.005em",
            }}
          >
            {dt}
          </span>
          {latest && (
            <span
              style={{
                fontSize: 9.5,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                color: "var(--accent-strong)",
                background: "var(--bg-panel)",
                padding: "2px 8px",
                borderRadius: "var(--radius-pill)",
                border:
                  "1px solid color-mix(in srgb, var(--accent) 30%, transparent)",
              }}
            >
              Dernier
            </span>
          )}
          {disabled && (
            <span
              style={{
                fontSize: 9.5,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                color: "var(--amber)",
                background: "var(--amber-bg)",
                padding: "2px 8px",
                borderRadius: "var(--radius-pill)",
                border: "1px solid var(--amber-border)",
              }}
            >
              markdown seul
            </span>
          )}
        </div>
        <div
          style={{
            fontSize: 12,
            color: "var(--text-muted)",
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <span style={{ fontFamily: "var(--mono)" }}>
            {report.modele_ia ?? "?"}
          </span>
          <Sep />
          <span>{report.nb_dossiers ?? "?"} dossiers</span>
        </div>
      </div>

      {/* Pills metriques */}
      <div
        style={{
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        {report.has_json && report.similitude_ia_pct != null && (
          <Pill
            label="similitude"
            value={`${report.similitude_ia_pct.toFixed(1)}%`}
            tone={scoreToTone(report.similitude_ia_pct, [90, 75])}
            title="Similitude IA vs humain sur les questions IA uniquement (cible >= 90%)"
          />
        )}
        {report.has_json && report.accord_pct != null && (
          <Pill
            label="eligibilite"
            value={`${accord.toFixed(0)}%`}
            tone={accordTone}
            title="Accord du verdict d'éligibilité (IA vs humain)"
          />
        )}
        {report.has_json && report.delta_score_moyen != null && report.similitude_ia_pct == null && (
          <Pill
            label="ecart score"
            value={fmtDelta(report.delta_score_moyen)}
            tone={deltaTone}
            mono
            title="Écart moyen IA - humain sur le score total"
          />
        )}
      </div>

      {/* Bouton supprimer (ghost, ne déclenche pas l'ouverture) */}
      <button
        type="button"
        onClick={handleDelete}
        onKeyDown={(e) => e.stopPropagation()}
        disabled={deleting}
        title="Supprimer ce rapport"
        aria-label="Supprimer ce rapport"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          padding: "5px 9px",
          fontSize: 11.5,
          fontWeight: 500,
          color: "var(--text-muted)",
          background: "transparent",
          border: "1px solid var(--border-soft)",
          borderRadius: "var(--radius-sm)",
          cursor: deleting ? "wait" : "pointer",
          transition: "color 150ms ease, border-color 150ms ease, background 150ms ease",
          opacity: deleting ? 0.6 : 1,
        }}
        onMouseEnter={(e) => {
          if (deleting) return;
          e.currentTarget.style.color = "var(--red)";
          e.currentTarget.style.borderColor = "var(--red-border)";
          e.currentTarget.style.background = "var(--red-bg)";
        }}
        onMouseLeave={(e) => {
          if (deleting) return;
          e.currentTarget.style.color = "var(--text-muted)";
          e.currentTarget.style.borderColor = "var(--border-soft)";
          e.currentTarget.style.background = "transparent";
        }}
      >
        <Icon name="close" size={11} />
        <span>Supprimer</span>
      </button>

      {/* Chevron */}
      <span
        style={{
          color: disabled ? "var(--text-faint)" : "var(--accent-strong)",
          fontSize: 18,
          marginLeft: 4,
          fontFamily: "var(--sans)",
          lineHeight: 1,
        }}
        aria-hidden
      >
        ›
      </span>
    </div>
  );
}

// ============================================================
// Vue 2 : detail d'un rapport (inline, pas de modal)
// ============================================================

// DEBUG - à retirer avant livraison
// Q8 : liste pays prioritaires 6e ≠ 7e (cf. mapping-6e-7e.json)
// Q37 : artefact barème xlsx 6e /3 vs skill 7e /1
// Q46 : seuil suivi-accompagnement 15-20% (6e) vs 10-12% (7e)
const COMPAT_EXCLUDED_QIDS = new Set<number>([8, 37, 46]);

function recomputeCompat(json: CalibrageReportJson): {
  similitudeIaPct: number | null;
  deltaIaAbsPct: number | null;
} {
  const dossierIaPcts: number[] = [];
  for (const c of json.dossiers ?? []) {
    let iaSum = 0, iaMax = 0, humSum = 0, humMax = 0;
    for (const q of c.q_diff ?? []) {
      if (q.score_ia == null || q.score_humain_moyen == null) continue;
      if (q.bareme_max <= 0) continue;
      const baremeXlsx = q.bareme_xlsx_max ?? q.bareme_max;
      if (baremeXlsx <= 0) continue;
      if (COMPAT_EXCLUDED_QIDS.has(q.id)) continue;
      if (q.hors_ia) continue;
      iaSum += q.score_ia;
      iaMax += q.bareme_max;
      humSum += q.score_humain_moyen;
      humMax += baremeXlsx;
    }
    if (iaMax > 0 && humMax > 0) {
      dossierIaPcts.push((iaSum / iaMax - humSum / humMax) * 100);
    }
  }
  if (dossierIaPcts.length === 0) return { similitudeIaPct: null, deltaIaAbsPct: null };
  const deltaIaAbsPct = dossierIaPcts.map(Math.abs).reduce((a, b) => a + b, 0) / dossierIaPcts.length;
  const similitudeIaPct = Math.max(0, 100 - deltaIaAbsPct);
  return {
    similitudeIaPct: Number(similitudeIaPct.toFixed(1)),
    deltaIaAbsPct: Number(deltaIaAbsPct.toFixed(1)),
  };
}

function CalibrageReportDetail({
  summary,
  modeCompat, // DEBUG
  onBack,
  onDeleted,
}: {
  summary: CalibrageReportSummary;
  modeCompat: boolean; // DEBUG
  onBack: () => void;
  onDeleted: () => Promise<void> | void;
}) {
  const [report, setReport] = useState<CalibrageReportJson | null>(null);
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [genStatus, setGenStatus] = useState<string>("");
  const [openDossier, setOpenDossier] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const router = useRouter();

  async function handleDelete() {
    if (!confirm("Supprimer ce rapport ? (action irréversible)")) return;
    setDeleting(true);
    try {
      await deleteCalibrageReport(summary.filename);
      await onDeleted();
    } catch (err) {
      alert("Suppression impossible : " + (err as Error).message);
      setDeleting(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    getCalibrageReport(summary.filename)
      .then((d) => {
        setReport(d.json);
        setMarkdown(d.markdown);
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [summary.filename]);

  // Esc renvoie à la liste (sauf pendant la génération)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !generating) onBack();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack, generating]);

  async function handleGenerate() {
    if (
      !confirm(
        "Claude va analyser ce rapport et créer jusqu'à 5 propositions de modifications dans /propositions. Vous pourrez les valider ou rejeter une par une via le diff visuel. Continuer ?"
      )
    )
      return;
    setGenerating(true);
    setGenStatus("Lancement du run Claude...");
    try {
      const { runId } = await genPropositionsFromReport(summary.filename);
      setGenStatus("Claude analyse le rapport, environ 30 secondes...");
      let lastText = "";
      await streamRun(runId, {
        onEvent: (ev) => {
          if (ev.kind === "tool_use_start") {
            const tool = ev.tool?.name ?? "?";
            setGenStatus(`Outil : ${tool}`);
          } else if (ev.kind === "text_delta" && ev.text) {
            lastText += ev.text;
            const last = lastText.slice(-100).replace(/\n/g, " ");
            setGenStatus(`Claude : ...${last}`);
          }
        },
        onEnd: () => {
          setGenStatus("5 propositions créées, redirection vers /propositions...");
          setTimeout(() => router.push("/propositions"), 1500);
        },
        onError: (err) => {
          setGenStatus(`Erreur : ${err.message}`);
          setGenerating(false);
        },
      });
    } catch (e) {
      setGenStatus((e as Error).message);
      setGenerating(false);
    }
  }

  const dt = summary.timestamp
    ? new Date(summary.timestamp).toLocaleString("fr-FR", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : summary.filename;

  return (
    <section
      className="pane"
      style={{
        padding: 22,
        marginBottom: 16,
        borderColor:
          "color-mix(in srgb, var(--accent) 30%, var(--border))",
      }}
    >
      {/* Bandeau retour + breadcrumb */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 14,
          flexWrap: "wrap",
        }}
      >
        <button
          type="button"
          onClick={onBack}
          disabled={generating}
          aria-label="Retour aux rapports"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "7px 14px",
            fontSize: 13,
            fontWeight: 600,
            color: "var(--accent-strong)",
            background: "var(--bg-panel)",
            border:
              "1px solid color-mix(in srgb, var(--accent) 25%, var(--border))",
            borderRadius: "var(--radius-sm)",
            cursor: generating ? "not-allowed" : "pointer",
            opacity: generating ? 0.5 : 1,
            transition: "background 150ms ease, border-color 150ms ease",
          }}
          onMouseEnter={(e) => {
            if (generating) return;
            e.currentTarget.style.background = "var(--accent-tint)";
          }}
          onMouseLeave={(e) => {
            if (generating) return;
            e.currentTarget.style.background = "var(--bg-panel)";
          }}
        >
          <Icon name="arrow-left" size={13} />
          <span>Retour aux rapports</span>
        </button>
        <div
          style={{
            fontSize: 12,
            color: "var(--text-muted)",
            display: "flex",
            alignItems: "center",
            gap: 6,
            flexWrap: "wrap",
          }}
        >
          <span>Calibrage</span>
          <span style={{ color: "var(--text-faint)" }}>›</span>
          <span style={{ color: "var(--text-strong)", fontWeight: 600 }}>
            {dt}
          </span>
        </div>
      </div>

      {/* Titre + meta */}
      <SectionLabel adminBadge>Detail du rapport</SectionLabel>
      <h2
        style={{
          fontFamily: "var(--serif)",
          fontWeight: 600,
          fontSize: 22,
          color: "var(--text-strong)",
          letterSpacing: "-0.01em",
          margin: "2px 0 4px",
        }}
      >
        Rapport du {dt}
      </h2>
      <div
        style={{
          fontSize: 12.5,
          color: "var(--text-muted)",
          marginBottom: 22,
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <span style={{ fontFamily: "var(--mono)" }}>
          {summary.modele_ia ?? "?"}
        </span>
        <Sep />
        <span>{summary.nb_dossiers ?? "?"} dossiers compares</span>
      </div>

      {/* Etat de chargement */}
      {loading && (
        <div
          style={{
            padding: 22,
            fontSize: 13,
            color: "var(--text-muted)",
            textAlign: "center",
            background: "var(--bg-subtle)",
            border: "1px solid var(--border-soft)",
            borderRadius: "var(--radius-sm)",
          }}
        >
          Chargement du rapport...
        </div>
      )}

      {error && (
        <div
          style={{
            padding: 14,
            background: "var(--red-bg)",
            border: "1px solid var(--red-border)",
            borderRadius: "var(--radius-sm)",
            color: "var(--red)",
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}

      {/* Markdown seul */}
      {!loading && !report && markdown && (
        <div>
          <div
            style={{
              padding: "12px 16px",
              background: "var(--amber-bg)",
              border: "1px solid var(--amber-border)",
              borderRadius: "var(--radius-sm)",
              fontSize: 12.5,
              color: "var(--text)",
              marginBottom: 16,
              lineHeight: 1.55,
            }}
          >
            Ce rapport est dans un ancien format. Affichage du texte brut
            uniquement, la génération de propositions est désactivée. Lancer
            un nouveau calibrage pour avoir le détail interactif.
          </div>
          <pre
            style={{
              fontFamily: "var(--mono)",
              fontSize: 12,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              background: "var(--bg-subtle)",
              border: "1px solid var(--border-soft)",
              borderRadius: "var(--radius-sm)",
              padding: 14,
              maxHeight: 560,
              overflow: "auto",
            }}
          >
            {markdown}
          </pre>
        </div>
      )}

      {!loading && report && (() => {
        // DEBUG - à retirer avant livraison
        const compatRecompute = modeCompat ? recomputeCompat(report) : null;
        const displaySimilitude = compatRecompute?.similitudeIaPct ?? report.synthese.similitude_ia_pct ?? null;
        const displayDeltaAbsPct = compatRecompute?.deltaIaAbsPct ?? report.synthese.delta_ia_abs_moyen_pct ?? null;
        const compatBiaisQ = modeCompat
          ? report.biais_q.filter((q) => !COMPAT_EXCLUDED_QIDS.has(q.id))
          : report.biais_q;
        return (
        <>
          {/* DEBUG - badge mode compat à retirer avant livraison */}
          {modeCompat && (
            <div
              style={{
                padding: "8px 12px",
                marginBottom: 12,
                background: "var(--amber-bg)",
                border: "1px dashed var(--amber-border)",
                borderRadius: "var(--radius-sm)",
                fontSize: 12,
                color: "var(--text)",
              }}
            >
              Mode compat. 6e/7e actif - Q8, Q37 et Q46 exclues du recalcul de similarite.
            </div>
          )}
          {/* Bandeau alerte global (mapping insuffisant, etc.) */}
          {report.alerte && (
            <div
              style={{
                padding: "12px 16px",
                marginBottom: 16,
                background: "var(--amber-bg)",
                border: "1px solid var(--amber-border)",
                borderRadius: "var(--radius-sm)",
                fontSize: 13,
                color: "var(--text)",
                lineHeight: 1.55,
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  color: "var(--amber)",
                  fontWeight: 700,
                  fontSize: 14,
                  lineHeight: 1,
                  marginTop: 1,
                }}
              >
                !
              </span>
              <div>
                <strong style={{ color: "var(--amber)" }}>Alerte</strong>
                <div style={{ marginTop: 4 }}>{report.alerte}</div>
              </div>
            </div>
          )}

          {/* Score de similitude global - indicateur principal */}
          {displaySimilitude != null && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 20,
                padding: "16px 22px",
                marginBottom: 16,
                background:
                  displaySimilitude >= 90
                    ? "color-mix(in srgb, var(--green) 8%, var(--bg-panel))"
                    : displaySimilitude >= 75
                    ? "color-mix(in srgb, var(--amber) 8%, var(--bg-panel))"
                    : "color-mix(in srgb, var(--red) 8%, var(--bg-panel))",
                border: `2px solid ${
                  displaySimilitude >= 90
                    ? "var(--green)"
                    : displaySimilitude >= 75
                    ? "var(--amber)"
                    : "var(--red)"
                }`,
                borderRadius: "var(--radius)",
              }}
            >
              <div>
                <div
                  style={{
                    fontSize: 42,
                    fontWeight: 800,
                    lineHeight: 1,
                    fontVariantNumeric: "tabular-nums",
                    color:
                      displaySimilitude >= 90
                        ? "var(--green)"
                        : displaySimilitude >= 75
                        ? "var(--amber)"
                        : "var(--red)",
                  }}
                >
                  {displaySimilitude.toFixed(1)}
                  <span style={{ fontSize: 22, fontWeight: 600 }}>%</span>
                </div>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    color: "var(--text-muted)",
                    marginTop: 2,
                  }}
                >
                  Similitude IA vs humain
                </div>
              </div>
              <div style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.55, maxWidth: 340 }}>
                <div>
                  Sur les <strong>{report.coverage?.qDansRapport ?? "?"} questions IA</strong> comparées
                  (hors {report.coverage?.qHorsIa ?? 16} questions réservées aux humains).
                </div>
                <div style={{ marginTop: 4, color: "var(--text-muted)", fontSize: 12 }}>
                  Ecart absolu moyen :{" "}
                  <strong>
                    {displayDeltaAbsPct != null
                      ? `${displayDeltaAbsPct.toFixed(1)} pts %`
                      : "-"}
                  </strong>{" "}
                  - Cible : &lt; 10 pts % (similitude &gt;= 90%)
                </div>
                <div style={{ marginTop: 4, color: "var(--text-muted)", fontSize: 12 }}>
                  {displaySimilitude >= 90
                    ? "Cible atteinte. Calibrage satisfaisant."
                    : displaySimilitude >= 75
                    ? "Cible non atteinte. Appliquer les recommandations ci-dessous."
                    : "Calibrage insuffisant. Retravailler les questions a fort delta."}
                </div>
              </div>
            </div>
          )}

          {/* Stat cards */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
              gap: 12,
              marginBottom: 26,
            }}
          >
            <StatCard
              label="Accord éligibilité"
              value={`${report.synthese.accord_eligibilite.pct.toFixed(0)}`}
              unit="%"
              hint={`${report.synthese.accord_eligibilite.ok}/${report.synthese.accord_eligibilite.total} dossiers, cible >= 85%`}
              tone={scoreToTone(report.synthese.accord_eligibilite.pct, [85, 60])}
            />
            <StatCard
              label="Ecart de score moyen"
              value={
                typeof report.synthese.delta_score_moyen_pct === "number"
                  ? fmtDelta(report.synthese.delta_score_moyen_pct)
                  : fmtDelta(report.synthese.delta_score_moyen)
              }
              unit={
                typeof report.synthese.delta_score_moyen_pct === "number"
                  ? "pts %"
                  : "pts"
              }
              hint={
                typeof report.synthese.delta_score_moyen_pct === "number"
                  ? "Normalisé sur les barèmes IA et xlsx (ideal proche 0)"
                  : "Ideal proche de 0"
              }
              tone={scoreToTone(
                15 -
                  Math.abs(
                    report.synthese.delta_score_moyen_pct ??
                      report.synthese.delta_score_moyen
                  ),
                [10, 0]
              )}
            />
            <StatCard
              label="Ecarts importants"
              value={`${report.synthese.delta_distribution.grand}`}
              unit={`/ ${report.synthese.delta_distribution.petit + report.synthese.delta_distribution.moyen + report.synthese.delta_distribution.grand}`}
              hint={`>15 pts % (petits ${report.synthese.delta_distribution.petit}, moyens ${report.synthese.delta_distribution.moyen})`}
            />
            <StatCard
              label="Vitesse"
              value={`${report.meta.duree_moyenne_s}`}
              unit="s / dossier"
              hint="Durée moyenne par évaluation IA"
            />
          </div>

          {/* Couverture du skill par le xlsx humain */}
          {report.coverage && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                gap: 8,
                marginBottom: 22,
              }}
            >
              <StatCard
                label="Q skill"
                value={`${report.coverage.qSkillTotal}`}
                hint="Questions définies dans le skill"
              />
              <StatCard
                label="Dans rapport"
                value={`${report.coverage.qDansRapport}`}
                hint="Q comparées IA vs humain"
                tone={
                  report.coverage.qDansRapport >=
                  report.coverage.qSkillTotal - report.coverage.qHorsIa - 5
                    ? "ok"
                    : "warn"
                }
              />
              <StatCard
                label="Hors-IA"
                value={`${report.coverage.qHorsIa}`}
                hint="Q réservées au jugement humain"
              />
              <StatCard
                label="Non matchées"
                value={`${report.coverage.qNonMatchees}`}
                hint="Q skill sans colonne xlsx correspondante"
                tone={report.coverage.qNonMatchees > 5 ? "warn" : "ok"}
              />
            </div>
          )}


          {/* Avertissements détaillés (repliables) */}
          {report.warnings && report.warnings.length > 0 && (
            <details
              style={{
                marginBottom: 22,
                fontSize: 12.5,
                background: "var(--bg-subtle)",
                border: "1px solid var(--border-soft)",
                borderRadius: "var(--radius-sm)",
                padding: "8px 12px",
              }}
            >
              <summary
                style={{
                  cursor: "pointer",
                  color: "var(--amber)",
                  fontWeight: 600,
                }}
              >
                {report.warnings.length} avertissement
                {report.warnings.length > 1 ? "s" : ""} détecté
                {report.warnings.length > 1 ? "s" : ""} (cliquer pour voir)
              </summary>
              <ul
                style={{
                  margin: "8px 0 0 18px",
                  padding: 0,
                  color: "var(--text-muted)",
                  lineHeight: 1.55,
                }}
              >
                {report.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </details>
          )}

          {/* Biais ELG */}
          <SectionTitle>Biais par critère d&apos;éligibilité</SectionTitle>
          <p
            style={{
              fontSize: 12.5,
              color: "var(--text-muted)",
              margin: "4px 0 10px",
              lineHeight: 1.55,
            }}
          >
            Désaccord = l&apos;IA et l&apos;humain ne sont pas alignés. Une
            réponse AMBIGU de l&apos;IA est comptée comme alignement positif si
            l&apos;humain a mis OUI.
          </p>
          <div
            style={{
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)",
              overflow: "hidden",
              marginBottom: 26,
              background: "var(--bg-panel)",
            }}
          >
            <div style={{ overflowX: "auto" }}>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: 12.5,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                <thead style={{ background: "var(--bg-subtle)" }}>
                  <tr>
                    <Th>ELG</Th>
                    <Th>Intitule</Th>
                    <Th align="right">Desaccords</Th>
                    <Th align="right">IA OUI / Hum NON</Th>
                    <Th align="right">IA NON / Hum OUI</Th>
                    <Th align="right">AMBIGU</Th>
                    <Th align="right">NON_TROUVE</Th>
                  </tr>
                </thead>
                <tbody>
                  {report.biais_elg.map((e) => {
                    const ratio = e.total > 0 ? e.desaccords / e.total : 0;
                    const tone =
                      ratio === 0 ? "ok" : ratio < 0.3 ? "warn" : "bad";
                    const color = toneColor(tone);
                    return (
                      <tr
                        key={e.id}
                        style={{
                          borderTop: "1px solid var(--border-soft)",
                        }}
                      >
                        <Td>
                          <strong
                            style={{ color, fontFamily: "var(--mono)" }}
                          >
                            {e.id}
                          </strong>
                        </Td>
                        <Td>{e.intitule}</Td>
                        <Td align="right">
                          <span style={{ color, fontWeight: 600 }}>
                            {e.desaccords}/{e.total}
                          </span>
                        </Td>
                        <Td align="right">{e.ia_oui_hum_non || ""}</Td>
                        <Td align="right">{e.ia_non_hum_oui || ""}</Td>
                        <Td align="right">{e.ia_ambigu || ""}</Td>
                        <Td align="right">{e.ia_non_trouve || ""}</Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Biais Q */}
          <SectionTitle>Biais par question (top 15)</SectionTitle>
          <p
            style={{
              fontSize: 12.5,
              color: "var(--text-muted)",
              margin: "4px 0 10px",
              lineHeight: 1.55,
            }}
          >
            Écart en points de pourcentage : on normalise IA et humain sur leur
            barème respectif (skill / xlsx peuvent différer) pour rendre les
            écarts comparables. Cliquer sur Détail pour voir les valeurs brutes.
          </p>
          <div
            style={{
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)",
              overflow: "hidden",
              marginBottom: 26,
              background: "var(--bg-panel)",
            }}
          >
            <div style={{ overflowX: "auto" }}>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: 12.5,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                <thead style={{ background: "var(--bg-subtle)" }}>
                  <tr>
                    <Th>Q</Th>
                    <Th>Intitule</Th>
                    <Th align="right">IA %</Th>
                    <Th align="right">Hum %</Th>
                    <Th align="right">Ecart pts %</Th>
                    <Th align="right">n</Th>
                    <Th>Detail</Th>
                  </tr>
                </thead>
                <tbody>
                  {compatBiaisQ.slice(0, 15).map((q) => {
                    // Fallback v1 : pas de delta_pct, on retombe sur delta brut
                    // (multiplié par 50 pour approximer l'échelle %, sans
                    // référence xlsx c'est juste un ordre de grandeur).
                    const hasPct = typeof q.delta_pct === "number";
                    const deltaPctVal = hasPct
                      ? q.delta_pct!
                      : q.bareme_max > 0
                      ? (q.delta_moyen / q.bareme_max) * 100
                      : 0;
                    const abs = Math.abs(deltaPctVal);
                    const tone = abs < 15 ? "ok" : abs < 30 ? "warn" : "bad";
                    const color =
                      tone === "ok"
                        ? "var(--text-muted)"
                        : tone === "warn"
                        ? "var(--amber)"
                        : "var(--red)";
                    const iaPct =
                      typeof q.ia_pct === "number"
                        ? q.ia_pct
                        : q.bareme_max > 0
                        ? (q.ia_avg / q.bareme_max) * 100
                        : 0;
                    const humPct =
                      typeof q.humain_pct === "number"
                        ? q.humain_pct
                        : q.bareme_max > 0
                        ? (q.humain_avg / q.bareme_max) * 100
                        : 0;
                    const baremeXlsx = q.bareme_xlsx_max ?? null;
                    return (
                      <tr
                        key={q.id}
                        style={{
                          borderTop: "1px solid var(--border-soft)",
                        }}
                      >
                        <Td>
                          <strong style={{ fontFamily: "var(--mono)" }}>
                            Q{q.id}
                          </strong>
                        </Td>
                        <Td>
                          {q.intitule}
                          {q.hors_ia && (
                            <span
                              style={{
                                fontSize: 10,
                                color: "var(--amber)",
                                marginLeft: 6,
                              }}
                            >
                              (hors-IA)
                            </span>
                          )}
                        </Td>
                        <Td align="right">{iaPct.toFixed(0)}%</Td>
                        <Td align="right">{humPct.toFixed(0)}%</Td>
                        <Td align="right">
                          <span style={{ color, fontWeight: 600 }}>
                            {fmtDelta(deltaPctVal)}
                          </span>
                        </Td>
                        <Td align="right">{q.n}</Td>
                        <Td>
                          <details style={{ fontSize: 11 }}>
                            <summary
                              style={{
                                cursor: "pointer",
                                color: "var(--text-faint)",
                              }}
                            >
                              voir
                            </summary>
                            <div
                              style={{
                                marginTop: 4,
                                color: "var(--text-muted)",
                                fontFamily: "var(--mono)",
                                fontSize: 10.5,
                                lineHeight: 1.5,
                              }}
                            >
                              IA {q.ia_avg.toFixed(2)}/{q.bareme_max} (
                              {iaPct.toFixed(0)}%)
                              <br />
                              Hum {q.humain_avg.toFixed(2)}/
                              {baremeXlsx ?? q.bareme_max}
                              {baremeXlsx != null &&
                              baremeXlsx !== q.bareme_max ? (
                                <span style={{ color: "var(--amber)" }}>
                                  {" "}
                                  (xlsx /{baremeXlsx})
                                </span>
                              ) : null}{" "}
                              ({humPct.toFixed(0)}%)
                              <br />
                              Δ brut {fmtDelta(q.delta_moyen)} pts
                            </div>
                          </details>
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Recommandations */}
          {(report.recommandations.elg.length > 0 ||
            report.recommandations.notation.length > 0) && (
            <>
              <SectionTitle>Recommandations d&apos;ajustement</SectionTitle>
              <div
                style={{
                  padding: 16,
                  background: "var(--accent-tint)",
                  border:
                    "1px solid color-mix(in srgb, var(--accent) 30%, transparent)",
                  borderRadius: "var(--radius-sm)",
                  fontSize: 13,
                  color: "var(--text)",
                  marginBottom: 26,
                  lineHeight: 1.6,
                }}
              >
                {report.recommandations.elg.length > 0 && (
                  <>
                    <strong>evaluer-eligibilite.skill.md</strong>
                    <ul style={{ margin: "4px 0 12px 18px", padding: 0 }}>
                      {report.recommandations.elg.map((r) => (
                        <li key={r.id}>
                          <strong>{r.id}</strong> : {r.recommandation}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {report.recommandations.notation.length > 0 && (
                  <>
                    <strong>evaluer-notation.skill.md</strong>
                    <ul style={{ margin: "4px 0 0 18px", padding: 0 }}>
                      {report.recommandations.notation.map((r) => (
                        <li key={r.id}>
                          <strong>Q{r.id}</strong> : {r.recommandation}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            </>
          )}

          {/* Detail par dossier */}
          <SectionTitle>
            Detail par dossier ({report.dossiers.length})
          </SectionTitle>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              marginBottom: 26,
            }}
          >
            {report.dossiers
              .slice()
              .sort(
                (a, b) =>
                  Math.abs(b.delta_ia_matchees ?? b.delta_score ?? 0) -
                  Math.abs(a.delta_ia_matchees ?? a.delta_score ?? 0)
              )
              .map((d) => {
                const isOpen = openDossier === d.id;
                // Utilise delta_ia_matchees (correct) si disponible, sinon delta_score (legacy)
                const deltaRef = d.delta_ia_matchees ?? d.delta_score;
                const abs = Math.abs(deltaRef ?? 0);
                const tone = abs < 5 ? "ok" : abs < 15 ? "warn" : "bad";
                const dotColor = toneColor(tone);
                return (
                  <div
                    key={d.id}
                    style={{
                      border: "1px solid var(--border-soft)",
                      borderRadius: "var(--radius-sm)",
                      background: "var(--bg-panel)",
                      transition: "border-color 150ms ease",
                    }}
                  >
                    <button
                      onClick={() =>
                        setOpenDossier(isOpen ? null : d.id)
                      }
                      style={{
                        width: "100%",
                        padding: "10px 14px",
                        background: "transparent",
                        border: "none",
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        textAlign: "left",
                        fontSize: 12.5,
                      }}
                    >
                      <span
                        style={{
                          transition: "transform 150ms",
                          transform: isOpen
                            ? "rotate(90deg)"
                            : "rotate(0deg)",
                          color: "var(--text-muted)",
                          fontSize: 11,
                          width: 10,
                          display: "inline-block",
                        }}
                      >
                        ›
                      </span>
                      <span
                        aria-hidden
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: "50%",
                          background: dotColor,
                          flexShrink: 0,
                        }}
                      />
                      <code
                        style={{
                          fontFamily: "var(--mono)",
                          fontSize: 11,
                          color: "var(--text-muted)",
                          maxWidth: 280,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {d.id}
                      </code>
                      <strong style={{ color: "var(--text-strong)" }}>
                        {d.nom}
                      </strong>
                      <span
                        style={{
                          marginLeft: "auto",
                          fontSize: 11.5,
                          color: "var(--text-muted)",
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {d.verdict_ia ?? "-"} vs {d.verdict_humain ?? "-"}
                        {d.delta_ia_matchees != null ? (
                          <>
                            {" "}- ecart IA {fmtDelta(d.delta_ia_matchees)} pts
                          </>
                        ) : (
                          <> , ecart {fmtDelta(d.delta_score)}</>
                        )}
                      </span>
                    </button>
                    {isOpen && (
                      <div
                        style={{
                          padding: "0 16px 14px 16px",
                          borderTop: "1px solid var(--border-soft)",
                          fontSize: 12,
                          color: "var(--text)",
                        }}
                      >
                        <div
                          style={{
                            marginTop: 10,
                            marginBottom: 8,
                            lineHeight: 1.55,
                          }}
                        >
                          {d.score_ia_matchees != null ? (
                            <>
                              <strong>Score IA</strong> (questions IA uniquement) :{" "}
                              {d.score_ia_matchees} vs humain{" "}
                              {d.score_humain_ia_matchees?.toFixed(1) ?? "-"}{" "}
                              - ecart{" "}
                              <strong
                                style={{
                                  color:
                                    Math.abs(d.delta_ia_matchees ?? 0) < 5
                                      ? "var(--green)"
                                      : Math.abs(d.delta_ia_matchees ?? 0) < 15
                                      ? "var(--amber)"
                                      : "var(--red)",
                                }}
                              >
                                {fmtDelta(d.delta_ia_matchees)} pts
                              </strong>
                            </>
                          ) : (
                            <>
                              <strong>Score</strong> : IA {d.score_ia ?? "-"} vs
                              humain {d.score_humain_moyen?.toFixed(1) ?? "-"}
                              {d.score_humain_min != null &&
                                d.score_humain_max != null &&
                                ` (plage ${d.score_humain_min}-${d.score_humain_max})`}
                              {d.nb_evaluateurs &&
                                ` sur ${d.nb_evaluateurs} evaluateurs`}
                            </>
                          )}{" "}
                          , ELG : {d.elg_match_count}/{d.elg_total_count} en
                          accord
                        </div>
                        {d.elg_diff
                          .filter(
                            (e) => !e.match && e.statut_humain !== "?"
                          )
                          .map((e) => (
                            <div
                              key={e.id}
                              style={{
                                marginTop: 6,
                                paddingLeft: 10,
                                borderLeft: "2px solid var(--red-border)",
                              }}
                            >
                              <strong>{e.id}</strong>{" "}
                              {e.intitule.slice(0, 50)} : IA{" "}
                              <code
                                style={{
                                  fontFamily: "var(--mono)",
                                  color: "var(--red)",
                                }}
                              >
                                {e.statut_ia}
                              </code>{" "}
                              vs humain{" "}
                              <code
                                style={{
                                  fontFamily: "var(--mono)",
                                  color: "var(--green)",
                                }}
                              >
                                {e.statut_humain}
                              </code>
                              {e.justification_ia && (
                                <div
                                  style={{
                                    marginTop: 2,
                                    fontSize: 11,
                                    color: "var(--text-muted)",
                                    fontStyle: "italic",
                                  }}
                                >
                                  {e.justification_ia.slice(0, 240)}
                                </div>
                              )}
                            </div>
                          ))}
                      </div>
                    )}
                  </div>
                );
              })}
          </div>

          {/* Bandeau action : générer propositions */}
          <div
            style={{
              padding: 18,
              background: "var(--bg-subtle)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              display: "flex",
              alignItems: "center",
              gap: 16,
              flexWrap: "wrap",
            }}
          >
            <div style={{ flex: "1 1 280px", minWidth: 0 }}>
              <div
                style={{
                  fontFamily: "var(--serif)",
                  fontWeight: 600,
                  fontSize: 16,
                  color: "var(--text-strong)",
                  marginBottom: 2,
                }}
              >
                Générer 5 propositions de correction
              </div>
              <div
                style={{
                  fontSize: 12.5,
                  color: "var(--text-muted)",
                  lineHeight: 1.5,
                }}
              >
                Claude analyse ce rapport et crée jusqu&apos;à 5 propositions
                de modifications de skills. Vous validez ou rejetez une par une
                via le diff visuel.
              </div>
              {generating && genStatus && (
                <div
                  style={{
                    marginTop: 8,
                    fontSize: 11.5,
                    color: "var(--accent-strong)",
                    fontStyle: "italic",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontFamily: "var(--mono)",
                  }}
                >
                  {genStatus}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={handleGenerate}
              disabled={!report || generating || !summary.has_json}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                padding: "10px 20px",
                fontSize: 13.5,
                fontWeight: 600,
                color: "#fff",
                background:
                  !report || generating || !summary.has_json
                    ? "var(--text-faint)"
                    : "var(--accent)",
                border: "1px solid transparent",
                borderRadius: "var(--radius-sm)",
                cursor:
                  generating || !summary.has_json
                    ? "not-allowed"
                    : "pointer",
                transition: "background 150ms ease",
                fontFamily: "var(--sans)",
                whiteSpace: "nowrap",
              }}
              onMouseEnter={(e) => {
                if (!report || generating || !summary.has_json) return;
                e.currentTarget.style.background = "var(--accent-strong)";
              }}
              onMouseLeave={(e) => {
                if (!report || generating || !summary.has_json) return;
                e.currentTarget.style.background = "var(--accent)";
              }}
              title={
                !summary.has_json
                  ? "Ce rapport n'a pas de JSON, génération impossible"
                  : "Claude analyse le rapport et crée jusqu'à 5 propositions"
              }
            >
              {generating ? (
                <>
                  <Spinner />
                  <span>Génération en cours...</span>
                </>
              ) : (
                <>
                  <Icon name="sparkles" size={14} />
                  <span>Générer les propositions</span>
                </>
              )}
            </button>
            {/* Bouton Supprimer ce rapport (style danger ghost) */}
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleting || generating}
              title="Supprimer definitivement ce rapport"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "9px 14px",
                fontSize: 12.5,
                fontWeight: 600,
                color: deleting || generating ? "var(--text-faint)" : "var(--red)",
                background: "transparent",
                border:
                  deleting || generating
                    ? "1px solid var(--border-soft)"
                    : "1px solid var(--red-border)",
                borderRadius: "var(--radius-sm)",
                cursor: deleting || generating ? "not-allowed" : "pointer",
                fontFamily: "var(--sans)",
                whiteSpace: "nowrap",
                transition: "background 150ms ease",
              }}
              onMouseEnter={(e) => {
                if (deleting || generating) return;
                e.currentTarget.style.background = "var(--red-bg)";
              }}
              onMouseLeave={(e) => {
                if (deleting || generating) return;
                e.currentTarget.style.background = "transparent";
              }}
            >
              <Icon name="close" size={12} />
              <span>{deleting ? "Suppression..." : "Supprimer ce rapport"}</span>
            </button>
          </div>
        </>
        );
      })()}
    </section>
  );
}

// ============================================================
// Section "Coût et tokens" (mode --import uniquement)
// ============================================================

/** Convertit USD -> EUR avec un taux fixe (approximation, à ajuster). */
const USD_TO_EUR = 0.93;

/** Formate un nombre de tokens en notation compacte : 1234567 -> "1.2M". */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}

function fmtUsd(n: number): string {
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 10) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(3)}`;
}

function fmtEur(usd: number): string {
  const eur = usd * USD_TO_EUR;
  if (eur >= 100) return `${eur.toFixed(0)} €`;
  if (eur >= 10) return `${eur.toFixed(2)} €`;
  return `${eur.toFixed(3)} €`;
}

/**
 * Détecte la famille du modèle (Opus / Sonnet / Haiku) à partir d'un nom
 * type "claude-opus-4-7" pour la recommandation.
 */
function detectModelFamily(model: string): "opus" | "sonnet" | "haiku" | "?" {
  const m = model.toLowerCase();
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("haiku")) return "haiku";
  return "?";
}

function CoutsSection({
  couts,
  dossiers,
}: {
  couts: NonNullable<CalibrageReportJson["couts"]>;
  dossiers: CalibrageReportJson["dossiers"];
}) {
  const cacheGainPct = (couts.cache_hit_ratio * 100).toFixed(0);
  const totalTokens =
    couts.total_input_tokens +
    couts.total_output_tokens +
    couts.total_cache_read +
    couts.total_cache_create;

  // Dossiers triés par coût décroissant pour identifier les outliers + threshold
  // de surlignage (1.5x du coût moyen).
  const dossiersAvecCout = dossiers.filter((d) => d.cout && d.cout.cost_usd > 0);
  const sorted = [...dossiersAvecCout].sort(
    (a, b) => (b.cout!.cost_usd ?? 0) - (a.cout!.cost_usd ?? 0)
  );
  const threshold = couts.cost_par_dossier_moyen * 1.5;

  const family = detectModelFamily(couts.modele_dominant);
  let recommandation: string | null = null;
  if (family === "opus") {
    recommandation =
      `Coût élevé : passer à Sonnet 4.6 réduirait le budget d'environ 80% ($${(
        couts.total_usd * 0.2
      ).toFixed(2)} au lieu de $${couts.total_usd.toFixed(2)}). À tester si la qualité reste acceptable.`;
  } else if (family === "sonnet") {
    recommandation =
      `Coût optimisé. Passer à Opus 4.7 multiplierait le budget par environ 5x ($${(
        couts.total_usd * 5
      ).toFixed(2)}) pour potentiellement améliorer la précision sur les dossiers ambigus.`;
  } else if (family === "haiku") {
    recommandation =
      `Coût minimal. Passer à Sonnet 4.6 multiplierait le budget par environ 3x pour une précision typiquement supérieure.`;
  }

  return (
    <>
      <SectionTitle>Coût et tokens</SectionTitle>
      <p
        style={{
          fontSize: 12.5,
          color: "var(--text-muted)",
          margin: "4px 0 10px",
          lineHeight: 1.55,
        }}
      >
        Coût mesuré sur les {dossiersAvecCout.length} dossiers évalués via Claude
        Code. Les projections supposent un coût par dossier constant et un
        parallélisme de 3 (limite anti rate-limit).
      </p>

      {/* 4 stat cards top-niveau */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: 12,
          marginBottom: 14,
        }}
      >
        <StatCard
          label="Coût total"
          value={fmtUsd(couts.total_usd)}
          unit="USD"
          hint={`environ ${fmtEur(couts.total_usd)}`}
        />
        <StatCard
          label="Tokens consommés"
          value={fmtTokens(totalTokens)}
          hint={`${fmtTokens(couts.total_input_tokens)} input + ${fmtTokens(
            couts.total_output_tokens
          )} output + ${fmtTokens(couts.total_cache_read)} cache`}
        />
        <StatCard
          label="Cache hit ratio"
          value={`${cacheGainPct}`}
          unit="%"
          hint={
            couts.cache_hit_ratio >= 0.5
              ? "Bon recyclage du cache"
              : couts.cache_hit_ratio >= 0.2
              ? "Recyclage moyen"
              : "Cache peu utilisé (premiers runs ou prompts très variables)"
          }
          tone={
            couts.cache_hit_ratio >= 0.5
              ? "ok"
              : couts.cache_hit_ratio >= 0.2
              ? "warn"
              : "neutral"
          }
        />
        <StatCard
          label="Coût moyen / dossier"
          value={fmtUsd(couts.cost_par_dossier_moyen)}
          hint={`min ${fmtUsd(couts.cost_par_dossier_min)} / max ${fmtUsd(
            couts.cost_par_dossier_max
          )}`}
        />
      </div>

      {/* Encart projection prod */}
      <div
        style={{
          padding: 16,
          background: "var(--accent-tint)",
          border:
            "1px solid color-mix(in srgb, var(--accent) 30%, transparent)",
          borderRadius: "var(--radius-sm)",
          fontSize: 13,
          color: "var(--text)",
          marginBottom: 18,
          lineHeight: 1.6,
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Projections prod</div>
        <ul style={{ margin: "0 0 0 18px", padding: 0 }}>
          <li>
            <strong>296 candidatures FAE 7e</strong> :{" "}
            <span style={{ fontFamily: "var(--mono)", fontWeight: 600 }}>
              {fmtUsd(couts.projections.nb_dossiers_296.cost_usd)}
            </span>{" "}
            ({fmtEur(couts.projections.nb_dossiers_296.cost_usd)}), environ{" "}
            <strong>
              {couts.projections.nb_dossiers_296.duree_h.toFixed(1)} h
            </strong>{" "}
            sur 3 parallèles.
          </li>
          <li style={{ marginTop: 4 }}>
            <strong>2000 candidatures</strong> :{" "}
            <span style={{ fontFamily: "var(--mono)", fontWeight: 600 }}>
              {fmtUsd(couts.projections.nb_dossiers_2000.cost_usd)}
            </span>{" "}
            ({fmtEur(couts.projections.nb_dossiers_2000.cost_usd)}), environ{" "}
            <strong>
              {couts.projections.nb_dossiers_2000.duree_h.toFixed(1)} h
            </strong>{" "}
            sur 3 parallèles.
          </li>
        </ul>
      </div>

      {/* Recommandation modèle */}
      {recommandation && (
        <div
          style={{
            padding: "10px 14px",
            background: "var(--bg-subtle)",
            border: "1px solid var(--border-soft)",
            borderRadius: "var(--radius-sm)",
            fontSize: 12.5,
            color: "var(--text)",
            marginBottom: 18,
            lineHeight: 1.55,
          }}
        >
          <span
            style={{
              fontSize: 9.5,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              color: "var(--text-faint)",
              marginRight: 8,
            }}
          >
            Recommandation
          </span>
          {recommandation}
        </div>
      )}

      {/* Détail par dossier (repliable) */}
      <details
        style={{
          marginBottom: 26,
          fontSize: 12.5,
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-sm)",
          padding: "8px 12px",
        }}
      >
        <summary
          style={{
            cursor: "pointer",
            color: "var(--text-strong)",
            fontWeight: 600,
            padding: "4px 0",
          }}
        >
          Détail par dossier ({sorted.length}, trié par coût décroissant)
        </summary>
        <div style={{ overflowX: "auto", marginTop: 8 }}>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: 12,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            <thead style={{ background: "var(--bg-subtle)" }}>
              <tr>
                <Th>Référence</Th>
                <Th>Modèle</Th>
                <Th align="right">Tokens (in / out)</Th>
                <Th align="right">Cache (read / create)</Th>
                <Th align="right">Coût USD</Th>
                <Th align="right">Durée</Th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((d) => {
                const c = d.cout!;
                const outlier = c.cost_usd > threshold;
                return (
                  <tr
                    key={d.id}
                    style={{
                      borderTop: "1px solid var(--border-soft)",
                      background: outlier ? "var(--amber-bg)" : undefined,
                    }}
                  >
                    <Td>
                      <span
                        style={{
                          fontFamily: "var(--mono)",
                          fontSize: 11,
                          color: outlier ? "var(--amber)" : "var(--text)",
                        }}
                      >
                        {d.reference ?? d.id}
                      </span>
                    </Td>
                    <Td>
                      <span style={{ fontFamily: "var(--mono)", fontSize: 11 }}>
                        {c.model || "?"}
                      </span>
                    </Td>
                    <Td align="right">
                      {fmtTokens(c.input_tokens)} / {fmtTokens(c.output_tokens)}
                    </Td>
                    <Td align="right">
                      {fmtTokens(c.cache_read)} /{" "}
                      {fmtTokens(c.cache_create_5m + c.cache_create_1h)}
                    </Td>
                    <Td align="right">
                      <strong style={{ color: outlier ? "var(--amber)" : undefined }}>
                        {fmtUsd(c.cost_usd)}
                      </strong>
                    </Td>
                    <Td align="right">
                      {c.duration_ms > 0
                        ? `${Math.round(c.duration_ms / 1000)}s`
                        : "-"}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}

// ============================================================
// Helpers UI
// ============================================================

type Tone = "ok" | "warn" | "bad" | "neutral";

function toneColor(tone: Tone): string {
  switch (tone) {
    case "ok":
      return "var(--green)";
    case "warn":
      return "var(--amber)";
    case "bad":
      return "var(--red)";
    default:
      return "var(--text-muted)";
  }
}

function toneBg(tone: Tone): string {
  switch (tone) {
    case "ok":
      return "var(--green-bg)";
    case "warn":
      return "var(--amber-bg)";
    case "bad":
      return "var(--red-bg)";
    default:
      return "var(--bg-subtle)";
  }
}

function toneBorder(tone: Tone): string {
  switch (tone) {
    case "ok":
      return "var(--green-border)";
    case "warn":
      return "var(--amber-border)";
    case "bad":
      return "var(--red-border)";
    default:
      return "var(--border)";
  }
}

function scoreToTone(value: number, [okMin, warnMin]: [number, number]): Tone {
  if (value >= okMin) return "ok";
  if (value >= warnMin) return "warn";
  return "bad";
}

function Pill({
  label,
  value,
  tone,
  mono,
  title,
}: {
  label: string;
  value: string;
  tone: Tone;
  mono?: boolean;
  title?: string;
}) {
  return (
    <span
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "baseline",
        gap: 6,
        padding: "4px 10px",
        fontSize: 12,
        borderRadius: "var(--radius-pill)",
        color: toneColor(tone),
        background: toneBg(tone),
        border: `1px solid ${toneBorder(tone)}`,
        fontVariantNumeric: "tabular-nums",
        whiteSpace: "nowrap",
      }}
    >
      <span
        style={{
          fontSize: 9.5,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          opacity: 0.75,
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontWeight: 700,
          fontFamily: mono ? "var(--mono)" : "var(--sans)",
        }}
      >
        {value}
      </span>
    </span>
  );
}

function StatCard({
  label,
  value,
  unit,
  hint,
  tone,
}: {
  label: string;
  value: string;
  unit?: string;
  hint?: string;
  tone?: Tone;
}) {
  const color = tone ? toneColor(tone) : "var(--text-strong)";
  return (
    <div
      style={{
        padding: "16px 18px",
        background: "var(--bg-subtle)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <span
        style={{
          fontSize: 9.5,
          color: "var(--text-faint)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          fontWeight: 700,
        }}
      >
        {label}
      </span>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 6,
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            fontFamily: "var(--serif)",
            fontSize: 30,
            fontWeight: 600,
            color,
            letterSpacing: "-0.015em",
            lineHeight: 1,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {value}
        </span>
        {unit && (
          <span
            style={{
              fontSize: 13,
              color: "var(--text-muted)",
              fontWeight: 500,
            }}
          >
            {unit}
          </span>
        )}
      </div>
      {hint && (
        <span
          style={{
            fontSize: 11.5,
            color: "var(--text-muted)",
            lineHeight: 1.4,
          }}
        >
          {hint}
        </span>
      )}
    </div>
  );
}

function SectionLabel({
  children,
  adminBadge,
}: {
  children: React.ReactNode;
  adminBadge?: boolean;
}) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.08em",
        color: "var(--text-muted)",
        marginBottom: 4,
        display: "flex",
        alignItems: "center",
        gap: 8,
      }}
    >
      {children}
      {adminBadge && (
        <span
          style={{
            fontSize: 9.5,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            color: "var(--accent-strong)",
            background: "var(--accent-tint)",
            padding: "1px 6px",
            borderRadius: "var(--radius-sm)",
          }}
        >
          Admin
        </span>
      )}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3
      style={{
        fontSize: 11,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "0.08em",
        color: "var(--text-muted)",
        marginBottom: 4,
        marginTop: 0,
      }}
    >
      {children}
    </h3>
  );
}

function Th({
  children,
  align,
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      style={{
        textAlign: align ?? "left",
        padding: "10px 14px",
        fontSize: 10.5,
        fontWeight: 700,
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
  align,
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <td
      style={{
        padding: "8px 14px",
        textAlign: align ?? "left",
        verticalAlign: "top",
      }}
    >
      {children}
    </td>
  );
}

function Sep() {
  return (
    <span
      aria-hidden
      style={{ color: "var(--text-faint)", fontSize: 10 }}
    >
      ·
    </span>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden
      style={{
        width: 12,
        height: 12,
        borderRadius: "50%",
        border: "2px solid rgba(255,255,255,0.4)",
        borderTopColor: "#fff",
        animation: "calibrage-spin 700ms linear infinite",
        display: "inline-block",
      }}
    >
      <style>{`@keyframes calibrage-spin { to { transform: rotate(360deg); } }`}</style>
    </span>
  );
}

/** Spinner sur fond clair (pour l'encart progression). */
function SpinnerAccent({ size = 12 }: { size?: number } = {}) {
  const border = Math.max(2, Math.round(size / 6));
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        border: `${border}px solid color-mix(in srgb, var(--accent) 25%, transparent)`,
        borderTopColor: "var(--accent-strong)",
        animation: "calibrage-spin 700ms linear infinite",
        display: "inline-block",
      }}
    >
      <style>{`@keyframes calibrage-spin { to { transform: rotate(360deg); } }`}</style>
    </span>
  );
}

function fmtDelta(d: number | null | undefined): string {
  if (d == null) return "-";
  if (d === 0) return "0";
  return d > 0 ? `+${d.toFixed(1)}` : d.toFixed(1);
}
