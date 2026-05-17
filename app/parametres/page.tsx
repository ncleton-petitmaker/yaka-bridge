"use client";
import Link from "next/link";
import { useEffect, useState, useCallback } from "react";
import { AppChromeHeader } from "@/components/AppChromeHeader";
import { Icon } from "@/components/Icon";
import { CampaignWizard } from "@/components/CampaignWizard";
import { SkillEditor } from "@/components/SkillEditor";
import { ChatDrawer } from "@/components/ChatDrawer";
import { CalibrageSection } from "@/components/CalibrageSection";
import { StorageModeSelector } from "@/components/StorageModeSelector";
import {
  startRun,
  streamRun,
  listCampaigns,
  activateCampaign,
  archiveCampaign,
  deleteCampaign,
  exportCampaignZip,
  exportDebugBundle,
  importCampaignZip,
  listCalibrageReports,
  type CampaignEntry,
} from "@/lib/client";
import type { CalibrageReportSummary } from "@/lib/calibrage-types";
import type { AgentEvent } from "@/lib/types";

interface AgentStatus {
  id: string;
  name: string;
  available: boolean;
  path: string | null;
  version: string | null;
  loggedIn: boolean | null;
  error?: string;
}

interface ModelOption {
  id: string;
  label: string;
  description: string;
}

interface AppConfig {
  model: string;
  inputDir?: string;
  outputDir?: string;
  sharedSkillsDir?: string;
  auditLogDir?: string;
  currentUser?: string;
  isAdmin?: boolean;
  autoApprove?: boolean;
  autoNotation?: boolean;
  storageMode?: "shared" | "manual";
  maxConcurrentEvaluations?: number;
  lastUpdated?: string;
}

type TabId = "profil" | "stockage" | "campagnes" | "calibrage" | "reglage" | "logs" | "tuto";
const TAB_IDS: TabId[] = ["profil", "stockage", "campagnes", "calibrage", "reglage", "logs", "tuto"];
const ADMIN_TABS: TabId[] = ["campagnes", "calibrage"];

export default function ParametresPage() {
  const user = "Nicolas (test)";
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [savingModel, setSavingModel] = useState(false);
  const [testRunning, setTestRunning] = useState(false);
  const [testOutput, setTestOutput] = useState<string>("");
  const [testStatus, setTestStatus] = useState<"idle" | "running" | "succeeded" | "failed">(
    "idle"
  );

  // Sections collapsables
  const [openEmplacements, setOpenEmplacements] = useState(false);
  const [openDiagnostic, setOpenDiagnostic] = useState(false);

  // Onglet actif (persistance localStorage)
  const [tab, setTab] = useState<TabId>(() => {
    if (typeof window === "undefined") return "profil";
    const saved = window.localStorage.getItem("oif-parametres-tab");
    if (saved === "rgpd") return "logs";
    return saved && (TAB_IDS as string[]).includes(saved) ? (saved as TabId) : "profil";
  });
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("oif-parametres-tab", tab);
    }
  }, [tab]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [agentsRes, cfgRes] = await Promise.all([
        fetch("/api/agents"),
        fetch("/api/app-config"),
      ]);
      const agents = (await agentsRes.json()) as { agents: AgentStatus[] };
      setStatus(agents.agents[0] ?? null);
      const cfg = (await cfgRes.json()) as { config: AppConfig; availableModels: ModelOption[] };
      setConfig(cfg.config);
      setModels(cfg.availableModels);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Si l'utilisateur perd ses droits admin, on bascule sur Profil
  useEffect(() => {
    if (!config) return;
    if (ADMIN_TABS.includes(tab) && !config.isAdmin) {
      setTab("profil");
    }
  }, [config, tab]);

  async function setModel(modelId: string) {
    setSavingModel(true);
    try {
      const r = await fetch("/api/app-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: modelId }),
      });
      const j = (await r.json()) as { config: AppConfig };
      setConfig(j.config);
    } catch (e) {
      console.error(e);
    } finally {
      setSavingModel(false);
    }
  }

  const [inputDirDraft, setInputDirDraft] = useState("");
  const [outputDirDraft, setOutputDirDraft] = useState("");
  const [sharedSkillsDirDraft, setSharedSkillsDirDraft] = useState("");
  const [auditLogDirDraft, setAuditLogDirDraft] = useState("");
  const [currentUserDraft, setCurrentUserDraft] = useState("");
  const [isAdminDraft, setIsAdminDraft] = useState(false);
  const [savingPaths, setSavingPaths] = useState(false);
  const [pathsMsg, setPathsMsg] = useState<string | null>(null);
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileMsg, setProfileMsg] = useState<string | null>(null);
  const [hasElectronDialog, setHasElectronDialog] = useState(false);
  const [setupRootDir, setSetupRootDir] = useState("");
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupResult, setSetupResult] = useState<{
    rootDir: string;
    createdSubdirs: string[];
  } | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [campaigns, setCampaigns] = useState<CampaignEntry[]>([]);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [campaignBusy, setCampaignBusy] = useState<string | null>(null);
  const [editorTarget, setEditorTarget] = useState<{ id: string; label: string } | null>(null);
  const [chatTarget, setChatTarget] = useState<{ id: string; label: string } | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [calibrageReports, setCalibrageReports] = useState<CalibrageReportSummary[]>([]);
  const [debugBundleStatus, setDebugBundleStatus] = useState<
    "idle" | "building" | "saved" | "cancelled" | "error"
  >("idle");
  const [debugBundlePath, setDebugBundlePath] = useState<string | null>(null);
  const [debugBundleError, setDebugBundleError] = useState<string | null>(null);

  const refreshCalibrageReports = useCallback(async () => {
    if (!config?.isAdmin) return;
    try {
      const r = await listCalibrageReports();
      setCalibrageReports(r);
    } catch (e) {
      console.error(e);
    }
  }, [config?.isAdmin]);

  useEffect(() => {
    if (config?.isAdmin) refreshCalibrageReports();
  }, [config?.isAdmin, refreshCalibrageReports]);

  const refreshCampaigns = useCallback(async () => {
    try {
      const j = await listCampaigns();
      setCampaigns(j.campaigns);
    } catch (e) {
      console.error(e);
    }
  }, []);

  useEffect(() => {
    if (config?.isAdmin) refreshCampaigns();
  }, [config?.isAdmin, refreshCampaigns]);

  async function handleActivate(id: string) {
    if (!confirm(`Activer la campagne ${id} ? L'ancienne campagne active sera archivée.`)) return;
    setCampaignBusy(id);
    try {
      await activateCampaign(id);
      await refreshCampaigns();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setCampaignBusy(null);
    }
  }

  async function handleArchive(id: string) {
    if (!confirm(`Archiver la campagne ${id} ?`)) return;
    setCampaignBusy(id);
    try {
      await archiveCampaign(id);
      await refreshCampaigns();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setCampaignBusy(null);
    }
  }

  async function handleExport(id: string) {
    setCampaignBusy(id);
    try {
      const { blob, filename } = await exportCampaignZip(id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setCampaignBusy(null);
    }
  }

  async function handleImport(file: File) {
    setImportBusy(true);
    setImportMsg(null);
    try {
      const result = await importCampaignZip(file);
      let msg = `Importé : ${result.campaignId}`;
      if (result.warnings.length > 0) msg += ` (avertissements : ${result.warnings.join(", ")})`;
      setImportMsg(msg);
      await refreshCampaigns();
      setTimeout(() => setImportMsg(null), 5000);
    } catch (e) {
      setImportMsg("Erreur : " + (e as Error).message);
    } finally {
      setImportBusy(false);
    }
  }

  async function handleDebugBundle() {
    setDebugBundleStatus("building");
    setDebugBundleError(null);
    setDebugBundlePath(null);
    try {
      const { buffer, filename } = await exportDebugBundle();
      const oif = (typeof window !== "undefined"
        ? (window as unknown as { oifEval?: { saveDebugBundle?: (b: ArrayBuffer, n: string) => Promise<{ ok: boolean; path?: string; cancelled?: boolean; error?: string }> } }).oifEval
        : undefined);
      if (oif?.saveDebugBundle) {
        const result = await oif.saveDebugBundle(buffer, filename);
        if (result.ok) {
          setDebugBundlePath(result.path ?? null);
          setDebugBundleStatus("saved");
        } else if (result.cancelled) {
          setDebugBundleStatus("cancelled");
        } else {
          setDebugBundleError(result.error ?? "échec de la sauvegarde");
          setDebugBundleStatus("error");
        }
      } else {
        const blob = new Blob([buffer], { type: "application/zip" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        setDebugBundlePath(filename);
        setDebugBundleStatus("saved");
      }
    } catch (e) {
      setDebugBundleError((e as Error).message);
      setDebugBundleStatus("error");
    }
  }

  async function handleDelete(id: string, status: "draft" | "archived") {
    const msg =
      status === "archived"
        ? `Supprimer définitivement la campagne archivée ${id} ?\n\nLes évaluations qui ont été produites par cette campagne resteront sur disque mais ne seront plus reliées à une campagne existante (lecture seule, plus d'export possible). Cette action est irréversible.`
        : `Supprimer définitivement le brouillon ${id} ?`;
    if (!confirm(msg)) return;
    setCampaignBusy(id);
    try {
      await deleteCampaign(id);
      await refreshCampaigns();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setCampaignBusy(null);
    }
  }

  useEffect(() => {
    setHasElectronDialog(
      typeof window !== "undefined" &&
        Boolean(
          (window as unknown as { oifEval?: { selectDirectory?: unknown } }).oifEval
            ?.selectDirectory
        )
    );
  }, []);

  async function pickDir(kind: "input" | "output") {
    const w = window as unknown as {
      oifEval?: {
        selectDirectory?: (opts?: {
          title?: string;
          defaultPath?: string;
        }) => Promise<string | null>;
      };
    };
    if (!w.oifEval?.selectDirectory) return;
    const path = await w.oifEval.selectDirectory({
      title:
        kind === "input"
          ? "Choisir le dossier des candidatures"
          : "Choisir le dossier des évaluations",
      defaultPath:
        kind === "input" ? inputDirDraft || undefined : outputDirDraft || undefined,
    });
    if (path) {
      if (kind === "input") setInputDirDraft(path);
      else setOutputDirDraft(path);
    }
  }

  useEffect(() => {
    setInputDirDraft(config?.inputDir ?? "");
    setOutputDirDraft(config?.outputDir ?? "");
    setSharedSkillsDirDraft(config?.sharedSkillsDir ?? "");
    setAuditLogDirDraft(config?.auditLogDir ?? "");
    setCurrentUserDraft(config?.currentUser ?? "");
    setIsAdminDraft(config?.isAdmin ?? false);
    // Dériver le dossier racine partagé depuis les chemins config.
    // ATTENTION : `inputDir` pointe sur <root>/candidatures/<user-slug> (2 niveaux
    // sous root), donc on ne peut pas comparer son parent comme on fait pour
    // les autres (qui sont à 1 niveau : <root>/skills, <root>/evaluations, etc.).
    // On utilise donc uniquement les 3 chemins à 1 niveau pour dériver root.
    const oneLevelPaths = [
      config?.sharedSkillsDir,
      config?.auditLogDir,
      config?.outputDir,
    ].filter(Boolean) as string[];
    if (oneLevelPaths.length >= 1) {
      // Normalisation NFC pour gérer les accents NFD de macOS.
      // Regex acceptent / ET \ pour fonctionner sur Windows (chemins UNC type
      // \\nas-nico.lan\Infrastructure\Dossiers partagés\OIF\skills).
      const parents = oneLevelPaths.map((p) =>
        p.normalize("NFC").replace(/[/\\]+$/, "").replace(/[/\\][^/\\]+$/, "")
      );
      const commonParent = parents[0];
      if (parents.every((p) => p === commonParent)) {
        setSetupRootDir((current) => (current.trim() === "" ? commonParent : current));
      }
    }
  }, [
    config?.inputDir,
    config?.outputDir,
    config?.sharedSkillsDir,
    config?.auditLogDir,
    config?.currentUser,
    config?.isAdmin,
  ]);

  async function pickSharedSkillsDir() {
    const w = window as unknown as {
      oifEval?: {
        selectDirectory?: (opts?: {
          title?: string;
          defaultPath?: string;
        }) => Promise<string | null>;
      };
    };
    if (!w.oifEval?.selectDirectory) return;
    const path = await w.oifEval.selectDirectory({
      title: "Choisir le dossier partagé des skills",
      defaultPath: sharedSkillsDirDraft || undefined,
    });
    if (path) setSharedSkillsDirDraft(path);
  }

  async function pickAuditLogDir() {
    const w = window as unknown as {
      oifEval?: {
        selectDirectory?: (opts?: {
          title?: string;
          defaultPath?: string;
        }) => Promise<string | null>;
      };
    };
    if (!w.oifEval?.selectDirectory) return;
    const path = await w.oifEval.selectDirectory({
      title: "Choisir le dossier du journal RGPD",
      defaultPath: auditLogDirDraft || undefined,
    });
    if (path) setAuditLogDirDraft(path);
  }

  async function pickSetupRootDir() {
    const w = window as unknown as {
      oifEval?: {
        selectDirectory?: (opts?: {
          title?: string;
          defaultPath?: string;
        }) => Promise<string | null>;
      };
    };
    if (!w.oifEval?.selectDirectory) return;
    const path = await w.oifEval.selectDirectory({
      title: "Choisir l'emplacement racine partagé OIF",
      defaultPath: setupRootDir || undefined,
    });
    if (path) setSetupRootDir(path);
  }

  async function autoCreateDirs() {
    if (!setupRootDir.trim()) {
      setSetupError("Choisissez d'abord un dossier racine.");
      return;
    }
    setSetupBusy(true);
    setSetupError(null);
    setSetupResult(null);
    try {
      const r = await fetch("/api/setup-shared-dir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rootDir: setupRootDir.trim() }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ error: r.statusText }));
        throw new Error(err.error ?? "échec création");
      }
      const j = (await r.json()) as {
        rootDir: string;
        createdSubdirs: string[];
        config: AppConfig;
      };
      setSetupResult({ rootDir: j.rootDir, createdSubdirs: j.createdSubdirs });
      setConfig(j.config);
    } catch (e) {
      setSetupError((e as Error).message);
    } finally {
      setSetupBusy(false);
    }
  }

  async function saveProfile() {
    setSavingProfile(true);
    setProfileMsg(null);
    try {
      const r = await fetch("/api/app-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentUser: currentUserDraft.trim() || null,
        }),
      });
      const j = (await r.json()) as { config: AppConfig };
      setConfig(j.config);
      window.dispatchEvent(new CustomEvent("fae-config-changed"));
      setProfileMsg("Sauvegardé");
      setTimeout(() => setProfileMsg(null), 2000);
    } catch (e) {
      setProfileMsg("Erreur : " + (e as Error).message);
    } finally {
      setSavingProfile(false);
    }
  }

  async function toggleAdmin(newValue: boolean) {
    setIsAdminDraft(newValue);
    try {
      const r = await fetch("/api/app-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isAdmin: newValue }),
      });
      const j = (await r.json()) as { config: AppConfig };
      setConfig(j.config);
      window.dispatchEvent(new CustomEvent("fae-config-changed"));
    } catch (e) {
      setIsAdminDraft(!newValue);
      console.error(e);
    }
  }

  async function toggleAutoApprove(newValue: boolean) {
    try {
      const r = await fetch("/api/app-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoApprove: newValue }),
      });
      const j = (await r.json()) as { config: AppConfig };
      setConfig(j.config);
    } catch (e) {
      console.error(e);
    }
  }

  async function toggleAutoNotation(newValue: boolean) {
    try {
      const r = await fetch("/api/app-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoNotation: newValue }),
      });
      const j = (await r.json()) as { config: AppConfig };
      setConfig(j.config);
    } catch (e) {
      console.error(e);
    }
  }

  async function setMaxConcurrent(n: number) {
    setConfig((prev) => (prev ? { ...prev, maxConcurrentEvaluations: n } : prev));
    try {
      const r = await fetch("/api/app-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxConcurrentEvaluations: n }),
      });
      const j = (await r.json()) as { config: AppConfig };
      setConfig(j.config);
    } catch (e) {
      console.error(e);
    }
  }

  async function setStorageMode(newMode: "shared" | "manual") {
    // Optimistic : on réagit immédiatement, même si le daemon est encore sur l'ancienne version.
    setConfig((prev) => (prev ? { ...prev, storageMode: newMode } : prev));
    try {
      const r = await fetch("/api/app-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storageMode: newMode }),
      });
      const j = (await r.json()) as { config: AppConfig };
      // Si le serveur a accepté, il renvoie storageMode. Sinon on garde notre version optimiste.
      setConfig((prev) => ({
        ...j.config,
        storageMode: j.config.storageMode ?? newMode,
      }));
    } catch (e) {
      console.error(e);
    }
  }

  async function savePaths() {
    setSavingPaths(true);
    setPathsMsg(null);
    try {
      const r = await fetch("/api/app-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inputDir: inputDirDraft.trim() || null,
          outputDir: outputDirDraft.trim() || null,
          sharedSkillsDir: sharedSkillsDirDraft.trim() || null,
          auditLogDir: auditLogDirDraft.trim() || null,
        }),
      });
      const j = (await r.json()) as { config: AppConfig };
      setConfig(j.config);
      setPathsMsg("Sauvegardé");
      setTimeout(() => setPathsMsg(null), 2000);
    } catch (e) {
      setPathsMsg("Erreur : " + (e as Error).message);
    } finally {
      setSavingPaths(false);
    }
  }

  async function testConnexion() {
    setOpenDiagnostic(true);
    setTestRunning(true);
    setTestStatus("running");
    setTestOutput("");
    try {
      const runId = await startRun({
        message: "Réponds simplement par : OK",
        user: "test-parametres",
      });
      let buf = "";
      await streamRun(runId, {
        onEvent: (ev: AgentEvent) => {
          if (ev.kind === "text_delta") {
            buf += ev.text ?? "";
            setTestOutput(buf);
          }
          if (ev.kind === "result") {
            setTestStatus(ev.result?.success ? "succeeded" : "failed");
          }
        },
        onEnd: () => setTestRunning(false),
        onError: (err) => {
          setTestStatus("failed");
          setTestOutput((b) => b + "\n[Erreur] " + err.message);
          setTestRunning(false);
        },
      });
    } catch (e) {
      setTestStatus("failed");
      setTestOutput("[Erreur] " + (e as Error).message);
      setTestRunning(false);
    }
  }

  const claudeBadge = !status
    ? { color: "var(--text-muted)", bg: "var(--bg-subtle)", label: "Vérification..." }
    : status.available && status.loggedIn !== false
    ? { color: "var(--green)", bg: "var(--green-bg)", label: "Connecté" }
    : { color: "var(--red)", bg: "var(--red-bg)", label: "Indisponible" };

  return (
    <div className="app">
      <AppChromeHeader user={user} />
      <main
        style={{
          flex: 1,
          minHeight: 0,
          maxWidth: 920,
          margin: "0 auto",
          width: "100%",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <TabBar
          active={tab}
          onChange={setTab}
          isAdmin={config?.isAdmin === true}
          claudeStatusColor={claudeBadge.color}
          claudeStatusLabel={claudeBadge.label}
        />

        <div style={{ padding: "24px 28px 80px" }}>
          <h1
            style={{
              fontFamily: "var(--serif)",
              fontWeight: 600,
              fontSize: 26,
              color: "var(--text-strong)",
              letterSpacing: "-0.01em",
              marginBottom: 4,
            }}
          >
            Paramètres
          </h1>
          <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 24 }}>
            Profil, campagnes, stockage et réglage Claude.
          </p>

          {/* 1. Mon profil */}
          {tab === "profil" && (
          <Section title="Mon profil">
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 12, fontWeight: 500, color: "var(--text-strong)" }}>
                  Votre nom (visible dans les propositions)
                </span>
                <div style={{ display: "flex", gap: 6 }}>
                  <input
                    type="text"
                    value={currentUserDraft}
                    onChange={(e) => setCurrentUserDraft(e.target.value)}
                    placeholder="ex. Alice Dupont"
                    style={{ flex: 1, fontSize: 13, padding: "6px 10px" }}
                  />
                  <button
                    onClick={saveProfile}
                    disabled={savingProfile}
                    className="primary"
                    style={{ fontSize: 12, padding: "5px 14px", cursor: "pointer" }}
                  >
                    {savingProfile ? "..." : "Enregistrer"}
                  </button>
                </div>
                {profileMsg && (
                  <span
                    style={{
                      fontSize: 11,
                      color: profileMsg.startsWith("Erreur") ? "var(--red)" : "var(--green)",
                    }}
                  >
                    {profileMsg}
                  </span>
                )}
              </label>

              <label
                style={{
                  display: "grid",
                  gridTemplateColumns: "auto 1fr",
                  alignItems: "start",
                  gap: 12,
                  padding: "12px 14px",
                  background: config?.autoNotation ? "var(--green-bg)" : "var(--bg-subtle)",
                  border: config?.autoNotation
                    ? "1px solid var(--green)"
                    : "1px solid var(--border-soft)",
                  borderRadius: "var(--radius-sm)",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={config?.autoNotation ?? false}
                  onChange={(e) => toggleAutoNotation(e.target.checked)}
                  style={{ accentColor: "var(--green)", marginTop: 3 }}
                />
                <div>
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: "var(--text-strong)",
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    Lancer automatiquement les notations
                    {config?.autoNotation && (
                      <span
                        style={{
                          fontSize: 9.5,
                          fontWeight: 600,
                          textTransform: "uppercase",
                          letterSpacing: "0.06em",
                          color: "var(--green)",
                          background: "color-mix(in srgb, var(--green) 15%, transparent)",
                          padding: "1px 6px",
                          borderRadius: "var(--radius-sm)",
                        }}
                      >
                        Actif
                      </span>
                    )}
                  </div>
                  <div
                    style={{
                      fontSize: 12,
                      color: "var(--text-muted)",
                      marginTop: 4,
                      lineHeight: 1.5,
                    }}
                  >
                    Quand Claude juge un dossier <strong>éligible</strong>, la notation des 49
                    questions est lancée automatiquement dans la foulée. Si désactivé, un bouton
                    &quot;Lancer les notations&quot; apparaît pour choisir le moment.
                  </div>
                </div>
              </label>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "auto 1fr",
                  alignItems: "center",
                  gap: 12,
                  padding: "12px 14px",
                  background: "var(--bg-subtle)",
                  border: "1px solid var(--border-soft)",
                  borderRadius: "var(--radius-sm)",
                }}
              >
                <input
                  type="number"
                  min={1}
                  max={20}
                  step={1}
                  value={config?.maxConcurrentEvaluations ?? 5}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v) && v >= 1 && v <= 20) {
                      setMaxConcurrent(v);
                    }
                  }}
                  style={{
                    width: 60,
                    fontSize: 14,
                    padding: "6px 8px",
                    fontFamily: "var(--mono)",
                    textAlign: "center",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-sm)",
                    background: "var(--bg-panel)",
                    color: "var(--text)",
                  }}
                />
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-strong)" }}>
                    Évaluations en parallèle (batch)
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4, lineHeight: 1.5 }}>
                    Nombre maximum d&apos;évaluations Claude lancées simultanément (1-20). Par défaut <strong>5</strong>. Cette valeur s&apos;applique à <strong>tous les utilisateurs</strong> qui partagent ce dossier. Augmenter si tu veux paralléliser plus de dossiers, mais attention aux limites de rate Anthropic et à ta machine.
                  </div>
                </div>
              </div>

              <label
                style={{
                  display: "grid",
                  gridTemplateColumns: "auto 1fr",
                  alignItems: "start",
                  gap: 12,
                  padding: "12px 14px",
                  background: isAdminDraft ? "var(--accent-tint)" : "var(--bg-subtle)",
                  border: isAdminDraft
                    ? "1px solid color-mix(in srgb, var(--accent) 40%, var(--border))"
                    : "1px solid var(--border-soft)",
                  borderRadius: "var(--radius-sm)",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={isAdminDraft}
                  onChange={(e) => toggleAdmin(e.target.checked)}
                  style={{ accentColor: "var(--accent)", marginTop: 3 }}
                />
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-strong)" }}>
                    Je suis admin
                  </div>
                  <div
                    style={{
                      fontSize: 12,
                      color: "var(--text-muted)",
                      marginTop: 4,
                      lineHeight: 1.5,
                    }}
                  >
                    Cochez cette case <strong>uniquement si vous êtes autorisé</strong> à le
                    faire par le responsable. L&apos;admin valide les propositions de
                    règles ; quand il accepte, la règle devient officielle pour tous les
                    membres de l&apos;équipe.
                  </div>
                </div>
              </label>

              {isAdminDraft && (
                <label
                  style={{
                    display: "grid",
                    gridTemplateColumns: "auto 1fr",
                    alignItems: "start",
                    gap: 12,
                    padding: "12px 14px",
                    background: config?.autoApprove ? "var(--amber-bg)" : "var(--bg-subtle)",
                    border: config?.autoApprove
                      ? "1px solid var(--amber-border)"
                      : "1px solid var(--border-soft)",
                    borderRadius: "var(--radius-sm)",
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={config?.autoApprove ?? false}
                    onChange={(e) => toggleAutoApprove(e.target.checked)}
                    style={{ accentColor: "var(--amber)", marginTop: 3 }}
                  />
                  <div>
                    <div
                      style={{
                        fontSize: 13,
                        fontWeight: 600,
                        color: "var(--text-strong)",
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                      }}
                    >
                      Mode calibrage
                      {config?.autoApprove && (
                        <span
                          style={{
                            fontSize: 9.5,
                            fontWeight: 600,
                            textTransform: "uppercase",
                            letterSpacing: "0.06em",
                            color: "var(--amber)",
                            background: "color-mix(in srgb, var(--amber) 15%, transparent)",
                            padding: "1px 6px",
                            borderRadius: "var(--radius-sm)",
                          }}
                        >
                          Actif
                        </span>
                      )}
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        color: "var(--text-muted)",
                        marginTop: 4,
                        lineHeight: 1.5,
                      }}
                    >
                      Pendant le rodage, les nouvelles propositions sont{" "}
                      <strong>immédiatement promues</strong> en règle officielle. Vous
                      gardez la main : si une règle douteuse passe, vous pouvez{" "}
                      <strong>annuler la promotion</strong> en un clic depuis la page
                      Propositions, ce qui restaure le skill global tel qu&apos;il était
                      avant.
                    </div>
                  </div>
                </label>
              )}
            </div>
          </Section>
          )}

          {/* 2. Campagnes (admin only) */}
          {config?.isAdmin && tab === "campagnes" && (
            <Section
              title="Campagnes"
              adminBadge
              hint="Une campagne = une grille d'évaluation pour une édition (FAE 7e, 8e...). Une seule active à la fois. Vous pouvez aussi importer un bundle ZIP exporté depuis une autre instance."
            >
              <div
                style={{
                  marginBottom: 12,
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  flexWrap: "wrap",
                }}
              >
                <button
                  onClick={() => setWizardOpen(true)}
                  className="primary"
                  style={{
                    fontSize: 13,
                    padding: "7px 14px",
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <Icon name="plus" size={13} />
                  Nouvelle campagne
                </button>
                <label
                  className="ghost"
                  style={{
                    fontSize: 12,
                    padding: "6px 12px",
                    cursor: importBusy ? "not-allowed" : "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    borderRadius: "var(--radius-sm)",
                    border: "1px solid var(--border)",
                    opacity: importBusy ? 0.6 : 1,
                  }}
                >
                  <Icon name="upload" size={12} />
                  {importBusy ? "Import en cours..." : "Importer un ZIP"}
                  <input
                    type="file"
                    accept=".zip,application/zip"
                    disabled={importBusy}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) handleImport(f);
                      e.target.value = "";
                    }}
                    style={{ display: "none" }}
                  />
                </label>
                {importMsg && (
                  <span
                    style={{
                      fontSize: 12,
                      color: importMsg.startsWith("Erreur") ? "var(--red)" : "var(--green)",
                    }}
                  >
                    {importMsg}
                  </span>
                )}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {campaigns.length === 0 && (
                  <div
                    style={{
                      padding: 14,
                      fontSize: 12,
                      color: "var(--text-muted)",
                      fontStyle: "italic",
                      border: "1px dashed var(--border-strong)",
                      borderRadius: "var(--radius-sm)",
                      textAlign: "center",
                    }}
                  >
                    Aucune campagne. Cliquez sur Nouvelle campagne en haut.
                  </div>
                )}
                {campaigns.map((c) => {
                  const isActive = c.status === "active";
                  const isDraft = c.status === "draft";
                  const isArchived = c.status === "archived";
                  const sc = isActive
                    ? "var(--green)"
                    : isDraft
                    ? "var(--amber)"
                    : "var(--text-muted)";
                  const sb = isActive
                    ? "var(--green-bg)"
                    : isDraft
                    ? "var(--amber-bg)"
                    : "var(--bg-subtle)";
                  return (
                    <div
                      key={c.id}
                      style={{
                        padding: "12px 14px",
                        background: "var(--bg-subtle)",
                        border: "1px solid var(--border-soft)",
                        borderRadius: "var(--radius-sm)",
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                        flexWrap: "wrap",
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 200 }}>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            marginBottom: 2,
                            flexWrap: "wrap",
                          }}
                        >
                          <strong style={{ fontSize: 13, color: "var(--text-strong)" }}>
                            {c.label}
                          </strong>
                          <code
                            style={{
                              fontSize: 11,
                              color: "var(--text-muted)",
                              fontFamily: "var(--mono)",
                            }}
                          >
                            {c.id}
                          </code>
                          <span
                            style={{
                              fontSize: 9.5,
                              fontWeight: 600,
                              textTransform: "uppercase",
                              letterSpacing: "0.06em",
                              color: sc,
                              background: sb,
                              padding: "1px 6px",
                              borderRadius: "var(--radius-sm)",
                            }}
                          >
                            {c.status}
                          </span>
                        </div>
                        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                          {c.dateOuverture && c.dateCloture
                            ? `${c.dateOuverture} → ${c.dateCloture} · `
                            : ""}
                          Créée le {new Date(c.createdAt).toLocaleDateString("fr-FR")}
                          {c.basedOn && ` · cloné depuis ${c.basedOn}`}
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {!isArchived && (
                          <button
                            onClick={() =>
                              setChatTarget({ id: c.id, label: c.label })
                            }
                            disabled={campaignBusy === c.id}
                            className="primary"
                            style={{
                              fontSize: 11,
                              padding: "4px 10px",
                              cursor: "pointer",
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 4,
                            }}
                            title={isActive
                              ? "Discuter avec Claude pour modifier les règles de la campagne active. ⚠ Les évaluations en cours utiliseront l'ancienne version."
                              : "Discuter avec Claude pour adapter les règles, joindre un nouveau référentiel..."}
                          >
                            <Icon name="comment" size={11} />
                            Adapter via chat
                          </button>
                        )}
                        {!isArchived && (
                          <button
                            onClick={() =>
                              setEditorTarget({ id: c.id, label: c.label })
                            }
                            disabled={campaignBusy === c.id}
                            className="ghost"
                            style={{
                              fontSize: 11,
                              padding: "4px 10px",
                              cursor: "pointer",
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 4,
                            }}
                            title={isActive
                              ? "Éditer manuellement le markdown des skills de la campagne active (avancé). ⚠ Les évaluations en cours utiliseront l'ancienne version."
                              : "Éditer manuellement le markdown des skills (avancé)"}
                          >
                            <Icon name="edit" size={11} />
                            Édition manuelle
                          </button>
                        )}
                        <button
                          onClick={() => handleExport(c.id)}
                          disabled={campaignBusy === c.id}
                          className="ghost"
                          style={{
                            fontSize: 11,
                            padding: "4px 10px",
                            cursor: "pointer",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 4,
                          }}
                          title="Télécharger un ZIP de cette campagne"
                        >
                          <Icon name="download" size={11} />
                          Exporter
                        </button>
                        {isDraft && (
                          <button
                            onClick={() => handleActivate(c.id)}
                            disabled={campaignBusy === c.id}
                            className="primary"
                            style={{ fontSize: 11, padding: "4px 10px", cursor: "pointer" }}
                          >
                            Activer
                          </button>
                        )}
                        {isArchived && (
                          <button
                            onClick={() => handleActivate(c.id)}
                            disabled={campaignBusy === c.id}
                            className="ghost"
                            style={{ fontSize: 11, padding: "4px 10px", cursor: "pointer" }}
                          >
                            Réactiver
                          </button>
                        )}
                        {isActive && campaigns.length > 1 && (
                          <button
                            onClick={() => handleArchive(c.id)}
                            disabled={campaignBusy === c.id}
                            className="ghost"
                            style={{ fontSize: 11, padding: "4px 10px", cursor: "pointer" }}
                          >
                            Archiver
                          </button>
                        )}
                        {(isDraft || isArchived) && (
                          <button
                            onClick={() =>
                              handleDelete(c.id, isDraft ? "draft" : "archived")
                            }
                            disabled={campaignBusy === c.id}
                            className="ghost"
                            style={{
                              fontSize: 11,
                              padding: "4px 10px",
                              cursor: "pointer",
                              color: "var(--red)",
                              borderColor: "var(--red-border)",
                            }}
                            title={
                              isArchived
                                ? "Supprimer cette campagne archivée définitivement"
                                : "Supprimer ce brouillon"
                            }
                          >
                            Supprimer
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </Section>
          )}

          {/* 2bis. Calibrage des regles (admin only) */}
          {config?.isAdmin && tab === "calibrage" && (
            <CalibrageSection
              reports={calibrageReports}
              onRefresh={refreshCalibrageReports}
            />
          )}

          {/* 3. Stockage et emplacements */}
          {tab === "stockage" && (
          <Section
            title="Stockage et emplacements"
            hint="Comment l'équipe partage les skills, les évaluations et le journal."
          >
            <StorageModeSelector
              mode={config?.storageMode ?? "shared"}
              onModeChange={setStorageMode}
              isAdmin={config?.isAdmin === true}
              sharedPath={config?.sharedSkillsDir}
            />

            {(config?.storageMode ?? "shared") === "shared" && (<>
            {/* 3.1 Configuration rapide */}
            <div
              style={{
                padding: 14,
                background: "var(--accent-tint)",
                border: "1px solid color-mix(in srgb, var(--accent) 30%, var(--border))",
                borderRadius: "var(--radius-sm)",
                marginBottom: 12,
              }}
            >
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: "var(--text-strong)",
                  marginBottom: 4,
                }}
              >
                Choisir le dossier partagé OIF (recommandé)
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: "var(--text-muted)",
                  marginBottom: 12,
                  lineHeight: 1.55,
                }}
              >
                Pointez le <strong>même</strong> dossier racine sur le serveur partagé que les autres
                évaluateurs. Le 1<sup>er</sup> à le configurer crée la structure (
                <code>skills/</code>, <code>audit-log/</code>, <code>evaluations/</code>) ;
                les suivants se branchent dessus sans rien dupliquer ni écraser. Si vous choisissez
                un dossier déjà utilisé par l&apos;équipe, l&apos;app reprend tel quel ce qu&apos;il
                contient.
              </div>
              <DirField
                label="Dossier racine partagé"
                hint="Choisissez le dossier déjà partagé par l'équipe. S'il n'existe pas encore, il sera créé. S'il existe, rien n'est écrasé."
                value={setupRootDir}
                onChange={setSetupRootDir}
                onPick={hasElectronDialog ? pickSetupRootDir : undefined}
                placeholder="ex. /Volumes/Partage-OIF/FAE-7e"
              />
              <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center" }}>
                <button
                  onClick={autoCreateDirs}
                  disabled={setupBusy || !setupRootDir.trim()}
                  className="primary"
                  style={{ fontSize: 12, padding: "6px 14px", cursor: "pointer" }}
                >
                  {setupBusy ? "Configuration..." : "Utiliser ce dossier"}
                </button>
                {setupError && (
                  <span style={{ fontSize: 12, color: "var(--red)" }}>{setupError}</span>
                )}
              </div>
              {setupResult && (() => {
                const nb = setupResult.createdSubdirs.length;
                const isFirst = nb > 0;
                return (
                  <div
                    style={{
                      marginTop: 10,
                      padding: "8px 10px",
                      background: "var(--green-bg)",
                      border: "1px solid var(--green-border)",
                      borderRadius: "var(--radius-sm)",
                      fontSize: 12,
                      color: "var(--text)",
                      lineHeight: 1.55,
                    }}
                  >
                    <strong style={{ color: "var(--green)" }}>
                      {isFirst
                        ? `✓ Structure créée (${nb} sous-dossier${nb > 1 ? "s" : ""})`
                        : "✓ Dossier existant détecté"}
                    </strong>{" "}
                    dans <code>{setupResult.rootDir}</code>.{" "}
                    {isFirst
                      ? "Les autres évaluateurs qui choisiront ce même dossier se brancheront dessus sans rien dupliquer."
                      : "L'app est branchée sur la structure déjà en place, vous travaillez sur les mêmes données que l'équipe."}{" "}
                    Les chemins individuels ont été pré-remplis ci-dessous.
                  </div>
                );
              })()}
            </div>

            {/* 3.2 Emplacements détaillés (collapsable) */}
            <Collapsable
              open={openEmplacements}
              onToggle={() => setOpenEmplacements((v) => !v)}
              title="Emplacements détaillés"
              hint="À ouvrir pour ajuster manuellement chaque chemin (laissez vide pour les défauts)."
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <DirField
                  label="Dossier des candidatures (input)"
                  hint="Contient un sous-dossier par dossier candidat (PDF, xlsx)."
                  value={inputDirDraft}
                  onChange={setInputDirDraft}
                  onPick={hasElectronDialog ? () => pickDir("input") : undefined}
                  placeholder="ex. /Users/alice/Documents/FAE-7e/à-traiter"
                />
                <DirField
                  label="Dossier des évaluations (output)"
                  hint="Où l'app écrit les fichiers JSON d'évaluation."
                  value={outputDirDraft}
                  onChange={setOutputDirDraft}
                  onPick={hasElectronDialog ? () => pickDir("output") : undefined}
                  placeholder="ex. /Users/alice/Documents/FAE-7e/traité"
                />
                <DirField
                  label="Dossier partagé des skills (équipe)"
                  hint="Sur serveur OIF, contient campaigns/<id>/{skills, propositions, snapshots}/. Si vide, fallback local."
                  value={sharedSkillsDirDraft}
                  onChange={setSharedSkillsDirDraft}
                  onPick={hasElectronDialog ? pickSharedSkillsDir : undefined}
                  placeholder="ex. /Volumes/Partage-OIF/skills"
                />
                <DirField
                  label="Dossier du journal RGPD (équipe)"
                  hint="Centralise les logs de tous les évaluateurs. Si vide, le journal est local au poste."
                  value={auditLogDirDraft}
                  onChange={setAuditLogDirDraft}
                  onPick={hasElectronDialog ? pickAuditLogDir : undefined}
                  placeholder="ex. /Volumes/Partage-OIF/audit-log"
                />
                <div style={{ marginTop: 4, display: "flex", gap: 8, alignItems: "center" }}>
                  <button
                    onClick={savePaths}
                    disabled={savingPaths}
                    className="primary"
                    style={{ fontSize: 12, padding: "5px 14px", cursor: "pointer" }}
                  >
                    {savingPaths ? "Sauvegarde..." : "Sauvegarder les chemins"}
                  </button>
                  {pathsMsg && (
                    <span
                      style={{
                        fontSize: 12,
                        color: pathsMsg.startsWith("Erreur") ? "var(--red)" : "var(--green)",
                      }}
                    >
                      {pathsMsg}
                    </span>
                  )}
                </div>
              </div>
            </Collapsable>
            </>)}

          </Section>
          )}

          {/* 4. Réglage Claude */}
          {tab === "reglage" && (
          <Section
            title="Réglage Claude"
            hint="Choix du modèle utilisé pour les évaluations, statut Claude Code et test de connexion."
          >
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                color: "var(--text-muted)",
                marginBottom: 8,
              }}
            >
              Modèle Claude
            </div>
            <div
              style={{
                fontSize: 12,
                color: "var(--text-muted)",
                marginBottom: 12,
                lineHeight: 1.55,
              }}
            >
              Modèle actuellement utilisé pour les évaluations :{" "}
              <strong style={{ color: "var(--text-strong)" }}>
                {models.find((m) => m.id === config?.model)?.label ?? config?.model ?? "..."}
              </strong>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 24 }}>
              {models.map((m) => {
                const selected = config?.model === m.id;
                return (
                  <button
                    key={m.id}
                    onClick={() => setModel(m.id)}
                    disabled={savingModel}
                    style={{
                      textAlign: "left",
                      padding: "10px 14px",
                      borderRadius: "var(--radius)",
                      background: selected ? "var(--accent-tint)" : "var(--bg-panel)",
                      border: selected
                        ? "1px solid color-mix(in srgb, var(--accent) 50%, var(--border))"
                        : "1px solid var(--border)",
                      cursor: savingModel ? "not-allowed" : "pointer",
                      transition: "all 120ms ease",
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 12,
                      opacity: savingModel ? 0.6 : 1,
                    }}
                  >
                    <span
                      style={{
                        flexShrink: 0,
                        marginTop: 2,
                        width: 14,
                        height: 14,
                        borderRadius: "50%",
                        border: selected
                          ? "4px solid var(--accent)"
                          : "1px solid var(--border-strong)",
                        background: selected ? "var(--bg-panel)" : "transparent",
                      }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontWeight: 600,
                          fontSize: 13,
                          color: "var(--text-strong)",
                          marginBottom: 2,
                        }}
                      >
                        {m.label}
                        {m.id !== "default" && (
                          <code
                            style={{
                              marginLeft: 8,
                              fontSize: 11,
                              color: "var(--text-muted)",
                              fontFamily: "var(--mono)",
                              fontWeight: 400,
                            }}
                          >
                            {m.id}
                          </code>
                        )}
                      </div>
                      <div
                        style={{
                          fontSize: 12,
                          color: "var(--text-muted)",
                          lineHeight: 1.5,
                        }}
                      >
                        {m.description}
                      </div>
                    </div>
                    {selected && (
                      <span
                        style={{
                          fontSize: 11,
                          color: "var(--accent-strong)",
                          fontWeight: 600,
                          flexShrink: 0,
                        }}
                      >
                        Actif
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                color: "var(--text-muted)",
                marginBottom: 8,
              }}
            >
              Diagnostic
            </div>
            <div
              style={{
                marginBottom: 16,
                padding: 14,
                background: "var(--bg-subtle)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius)",
                display: "flex",
                alignItems: "center",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "4px 12px",
                  borderRadius: "var(--radius-pill)",
                  fontSize: 12,
                  fontWeight: 500,
                  color: claudeBadge.color,
                  background: claudeBadge.bg,
                  border: `1px solid color-mix(in srgb, ${claudeBadge.color} 30%, transparent)`,
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: 999,
                    background: "currentColor",
                    display: "inline-block",
                  }}
                />
                Claude Code · {claudeBadge.label}
                {status?.version && (
                  <span style={{ fontFamily: "var(--mono)", fontSize: 11, opacity: 0.85 }}>
                    {status.version}
                  </span>
                )}
              </span>
              <button
                onClick={testConnexion}
                disabled={testRunning || !status?.available}
                className="ghost"
                style={{
                  fontSize: 12,
                  padding: "6px 12px",
                  cursor: testRunning || !status?.available ? "not-allowed" : "pointer",
                  opacity: testRunning || !status?.available ? 0.5 : 1,
                }}
              >
                {testRunning ? "Test en cours..." : "Tester la connexion"}
              </button>
            </div>
            <Collapsable
              open={openDiagnostic}
              onToggle={() => setOpenDiagnostic((v) => !v)}
              title="Détail technique"
              hint={
                status?.available
                  ? `Connecté · ${status.path ?? "binaire local"}`
                  : "Indisponible"
              }
            >
              {loading && (
                <div style={{ color: "var(--text-muted)", fontSize: 13 }}>
                  Vérification…
                </div>
              )}
              {status && !loading && (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <Row label="Statut">
                    {status.available ? (
                      <Pill color="green" label="Connecté" emoji="✓" />
                    ) : (
                      <Pill color="red" label="Indisponible" emoji="✗" />
                    )}
                  </Row>
                  <Row label="Binaire">
                    {status.path ? (
                      <span style={{ fontFamily: "var(--mono)", fontSize: 12 }}>
                        {status.path}
                      </span>
                    ) : (
                      <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
                        introuvable sur le PATH
                      </span>
                    )}
                  </Row>
                  <Row label="Version">
                    <span style={{ fontFamily: "var(--mono)", fontSize: 12 }}>
                      {status.version ?? "—"}
                    </span>
                  </Row>
                  <Row label="Login">
                    {status.loggedIn === true && (
                      <span style={{ color: "var(--green)", fontSize: 12 }}>
                        ✓ Connecté
                      </span>
                    )}
                    {status.loggedIn === false && (
                      <span style={{ color: "var(--red)", fontSize: 12 }}>
                        ✗ Pas connecté. Faites <code>claude login</code> dans un terminal.
                      </span>
                    )}
                    {status.loggedIn === null && (
                      <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
                        Non vérifié
                      </span>
                    )}
                  </Row>
                  {status.error && (
                    <div
                      style={{
                        padding: "8px 12px",
                        background: "var(--red-bg)",
                        color: "var(--red)",
                        border: "1px solid var(--red-border)",
                        borderRadius: "var(--radius-sm)",
                        fontSize: 12,
                        fontFamily: "var(--mono)",
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {status.error}
                    </div>
                  )}
                </div>
              )}

              <div
                style={{
                  marginTop: 14,
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                }}
              >
                <button
                  onClick={refresh}
                  disabled={loading}
                  className="ghost"
                  style={{ fontSize: 12, padding: "5px 10px", cursor: "pointer" }}
                >
                  <Icon name="refresh" size={12} /> Re-vérifier le statut
                </button>
                <button
                  onClick={testConnexion}
                  disabled={testRunning || !status?.available}
                  className="primary"
                  style={{
                    fontSize: 12,
                    padding: "5px 12px",
                    cursor: testRunning || !status?.available ? "not-allowed" : "pointer",
                    opacity: testRunning || !status?.available ? 0.5 : 1,
                  }}
                >
                  {testRunning ? "Test en cours…" : "Lancer un test"}
                </button>
              </div>

              {(testStatus !== "idle" || testOutput) && (
                <div style={{ marginTop: 12 }}>
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      textTransform: "uppercase",
                      letterSpacing: "0.08em",
                      color: "var(--text-muted)",
                      marginBottom: 6,
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
                    Résultat du test
                    {testStatus === "running" && (
                      <span
                        style={{
                          width: 7,
                          height: 7,
                          borderRadius: "50%",
                          background: "var(--accent)",
                          animation: "pulse 1.2s ease-in-out infinite",
                          display: "inline-block",
                        }}
                      />
                    )}
                    {testStatus === "succeeded" && (
                      <span style={{ color: "var(--green)", fontSize: 11 }}>✓ OK</span>
                    )}
                    {testStatus === "failed" && (
                      <span style={{ color: "var(--red)", fontSize: 11 }}>✗ Échec</span>
                    )}
                  </div>
                  <pre
                    style={{
                      fontFamily: "var(--mono)",
                      fontSize: 12,
                      background: "var(--bg-subtle)",
                      border: "1px solid var(--border-soft)",
                      borderRadius: "var(--radius-sm)",
                      padding: 10,
                      whiteSpace: "pre-wrap",
                      color: testStatus === "failed" ? "var(--red)" : "var(--text)",
                      margin: 0,
                      minHeight: 32,
                    }}
                  >
                    {testOutput || "(pas encore de sortie)"}
                  </pre>
                </div>
              )}

              <div
                style={{
                  marginTop: 14,
                  padding: 12,
                  background: "var(--bg-subtle)",
                  border: "1px solid var(--border-soft)",
                  borderRadius: "var(--radius-sm)",
                  fontSize: 12,
                  color: "var(--text-muted)",
                  lineHeight: 1.55,
                }}
              >
                <strong style={{ color: "var(--text-strong)" }}>
                  Si Claude Code est indisponible
                </strong>
                , ouvrez un terminal et :
                <pre
                  style={{
                    fontFamily: "var(--mono)",
                    fontSize: 11,
                    background: "var(--bg-panel)",
                    border: "1px solid var(--border-soft)",
                    borderRadius: "var(--radius-sm)",
                    padding: 8,
                    margin: "8px 0 0 0",
                  }}
                >
                  {`# Installer (si absent)
npm install -g @anthropic-ai/claude-code
# Vérifier
claude --version
# Se connecter (Pro/Max/Team/Enterprise)
claude login`}
                </pre>
                Puis redémarrez l&apos;app.
              </div>
            </Collapsable>
          </Section>
          )}

          {/* 5. Logs (visible à tous) - bloc RGPD admin-only + bloc diagnostic public */}
          {config?.isAdmin && tab === "logs" && (
            <Section
              title="Coûts Claude et journal RGPD"
              adminBadge
              hint="Dashboard d'analyse des coûts par modèle/dossier/jour + journal d'audit RGPD avec hash chaîné SHA-256."
            >
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <Link
                  href="/logs"
                  className="primary"
                  style={{
                    fontSize: 12,
                    padding: "6px 14px",
                    textDecoration: "none",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  Ouvrir les logs
                </Link>
                <span style={{ fontSize: 11, color: "var(--text-faint)" }}>
                  Onglet Coûts : dashboard global $, breakdown par modèle, courbe 14j, top 10 dossiers chers
                </span>
              </div>
            </Section>
          )}

          {tab === "logs" && (
            <Section
              title="Diagnostic - Envoyer les logs au support"
              hint="En cas de problème, génère un fichier ZIP contenant les logs techniques de l'application. Aucun contenu de dossier candidat n'est inclus."
            >
              <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 0 }}>
                Cliquez sur le bouton ci-dessous pour générer le fichier de diagnostic, puis
                envoyez-le par email à{" "}
                <a href="mailto:nicolas.cleton@petitmaker.fr">nicolas.cleton@petitmaker.fr</a> en
                décrivant le problème rencontré (action effectuée, message d&apos;erreur, heure
                approximative).
              </p>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="primary"
                  onClick={handleDebugBundle}
                  disabled={debugBundleStatus === "building"}
                  style={{ fontSize: 12, padding: "6px 14px" }}
                >
                  {debugBundleStatus === "building"
                    ? "Génération..."
                    : "Générer le fichier de diagnostic"}
                </button>
                {debugBundleStatus === "saved" && (
                  <a
                    href={`mailto:nicolas.cleton@petitmaker.fr?subject=${encodeURIComponent(
                      "OIF-Eval - Diagnostic"
                    )}&body=${encodeURIComponent(
                      "Bonjour,\n\nJe rencontre un problème avec OIF-Eval.\n\nDescription du problème :\n[à compléter]\n\nMerci de joindre à cet email le fichier de diagnostic ZIP généré depuis l'application.\n"
                    )}`}
                    style={{ fontSize: 12, padding: "6px 14px", textDecoration: "none" }}
                  >
                    Ouvrir l&apos;email
                  </a>
                )}
              </div>
              {debugBundleStatus === "saved" && (
                <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8 }}>
                  Fichier enregistré
                  {debugBundlePath ? (
                    <>
                      {" "}: <code style={{ fontSize: 11 }}>{debugBundlePath}</code>
                    </>
                  ) : (
                    "."
                  )}
                </p>
              )}
              {debugBundleStatus === "cancelled" && (
                <p style={{ fontSize: 12, color: "var(--text-faint)", marginTop: 8 }}>
                  Sauvegarde annulée.
                </p>
              )}
              {debugBundleStatus === "error" && (
                <p style={{ fontSize: 12, color: "var(--danger, #c00)", marginTop: 8 }}>
                  Erreur : {debugBundleError ?? "inconnue"}
                </p>
              )}
            </Section>
          )}

          {tab === "tuto" && (
            <TutoSection />
          )}
        </div>

        <CampaignWizard
          open={wizardOpen}
          onClose={() => setWizardOpen(false)}
          campaigns={campaigns}
          onCreated={async (event) => {
            setWizardOpen(false);
            await refreshCampaigns();
            if (event.openChat) {
              setChatTarget({ id: event.id, label: event.label });
            } else if (event.openEditor) {
              setEditorTarget({ id: event.id, label: event.label });
            }
          }}
        />

        {editorTarget && (
          <SkillEditor
            open
            campaignId={editorTarget.id}
            campaignLabel={editorTarget.label}
            onClose={() => setEditorTarget(null)}
            onSaved={refreshCampaigns}
          />
        )}

        {chatTarget && (
          <ChatDrawer
            key={`regen-${chatTarget.id}`}
            open
            onClose={() => setChatTarget(null)}
            user={config?.currentUser ?? "admin"}
            title={`Adapter les règles : ${chatTarget.label}`}
            campaignId={chatTarget.id}
            campaignLabel={chatTarget.label}
            contextHint={`Joignez votre référentiel (.docx, .md, .pdf...) puis tapez « régénère les règles à partir de ce fichier ». Claude lira le référentiel, identifiera les critères et régénérera les skills de la campagne brouillon ${chatTarget.id}. Édition manuelle plus fine possible ensuite via Paramètres > Campagnes > Édition manuelle.`}
            placeholder={`Ex : « Régénère le skill evaluer-notation à partir du référentiel joint. » Joignez d'abord le fichier via le bouton ci-dessous.`}
          />
        )}
      </main>
    </div>
  );
}

function TabBar({
  active,
  onChange,
  isAdmin,
  claudeStatusColor,
  claudeStatusLabel,
}: {
  active: TabId;
  onChange: (t: TabId) => void;
  isAdmin: boolean;
  claudeStatusColor: string;
  claudeStatusLabel: string;
}) {
  const allTabs: { id: TabId; label: string; admin?: boolean }[] = [
    { id: "profil", label: "Profil" },
    { id: "stockage", label: "Stockage" },
    { id: "campagnes", label: "Campagnes", admin: true },
    { id: "calibrage", label: "Calibrage", admin: true },
    { id: "reglage", label: "Réglage Claude" },
    { id: "logs", label: "Logs" },
    { id: "tuto", label: "Tuto" },
  ];
  const tabs = allTabs.filter((t) => !t.admin || isAdmin);
  return (
    <div
      style={{
        display: "flex",
        gap: 4,
        padding: "12px 28px",
        background: "var(--bg-app)",
        borderBottom: "1px solid var(--border)",
        overflowX: "auto",
        scrollbarWidth: "none",
        flexShrink: 0,
      }}
    >
      {tabs.map((t) => {
        const isActive = active === t.id;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onChange(t.id)}
            onMouseEnter={(e) => {
              if (!isActive) {
                e.currentTarget.style.background = "var(--accent-tint)";
                e.currentTarget.style.color = "var(--accent-strong)";
              }
            }}
            onMouseLeave={(e) => {
              if (!isActive) {
                e.currentTarget.style.background = "transparent";
                e.currentTarget.style.color = "var(--text-muted)";
              }
            }}
            style={{
              border: isActive ? "1px solid var(--accent)" : "1px solid transparent",
              borderRadius: "var(--radius-pill)",
              background: isActive ? "var(--accent)" : "transparent",
              padding: "7px 16px",
              fontSize: 13,
              fontWeight: isActive ? 600 : 500,
              color: isActive ? "#fff" : "var(--text-muted)",
              cursor: "pointer",
              whiteSpace: "nowrap",
              transition: "background 120ms ease, color 120ms ease, border-color 120ms ease",
              boxShadow: "none",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontFamily: "var(--sans)",
            }}
            title={t.id === "reglage" ? `Claude Code · ${claudeStatusLabel}` : undefined}
          >
            {t.id === "reglage" && (
              <span
                aria-label={`Claude Code ${claudeStatusLabel}`}
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 999,
                  background: claudeStatusColor,
                  boxShadow: `0 0 0 2px color-mix(in srgb, ${claudeStatusColor} 25%, transparent)`,
                  display: "inline-block",
                  flexShrink: 0,
                }}
              />
            )}
            {t.label}
            {t.admin && (
              <span
                style={{
                  fontSize: 9,
                  color: isActive ? "rgba(255,255,255,0.75)" : "var(--text-faint)",
                  fontWeight: 600,
                  letterSpacing: "0.08em",
                }}
              >
                ADMIN
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function Section({
  title,
  hint,
  adminBadge,
  children,
}: {
  title: string;
  hint?: string;
  adminBadge?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      className="pane"
      style={{
        padding: 18,
        marginBottom: 16,
        ...(adminBadge && {
          borderColor: "color-mix(in srgb, var(--accent) 30%, var(--border))",
        }),
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: "var(--text-muted)",
          marginBottom: hint ? 4 : 14,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        {title}
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
      {hint && (
        <div
          style={{
            fontSize: 12,
            color: "var(--text-muted)",
            marginBottom: 14,
            lineHeight: 1.55,
          }}
        >
          {hint}
        </div>
      )}
      {children}
    </section>
  );
}

function Collapsable({
  open,
  onToggle,
  title,
  hint,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--border-soft)",
        borderRadius: "var(--radius-sm)",
        marginBottom: 8,
        background: "var(--bg-panel)",
      }}
    >
      <button
        onClick={onToggle}
        style={{
          width: "100%",
          padding: "10px 14px",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 8,
          textAlign: "left",
        }}
      >
        <span
          style={{
            color: "var(--text-muted)",
            fontSize: 11,
            transition: "transform 120ms",
            transform: open ? "rotate(90deg)" : "rotate(0deg)",
            display: "inline-block",
          }}
        >
          ▶
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-strong)" }}>
            {title}
          </div>
          {hint && (
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
              {hint}
            </div>
          )}
        </div>
      </button>
      {open && (
        <div
          style={{
            padding: "0 14px 14px 14px",
            borderTop: "1px solid var(--border-soft)",
            paddingTop: 14,
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
      <span
        style={{
          width: 80,
          flexShrink: 0,
          fontSize: 12,
          color: "var(--text-muted)",
        }}
      >
        {label}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  );
}

function Pill({
  color,
  label,
  emoji,
}: {
  color: "green" | "red" | "amber";
  label: string;
  emoji: string;
}) {
  const styles: Record<string, React.CSSProperties> = {
    green: {
      background: "var(--green-bg)",
      color: "var(--green)",
      border: "1px solid var(--green-border)",
    },
    red: {
      background: "var(--red-bg)",
      color: "var(--red)",
      border: "1px solid var(--red-border)",
    },
    amber: {
      background: "var(--amber-bg)",
      color: "var(--amber)",
      border: "1px solid var(--amber-border)",
    },
  };
  return (
    <span
      style={{
        ...styles[color],
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 10px",
        borderRadius: "var(--radius-pill)",
        fontSize: 12,
        fontWeight: 500,
      }}
    >
      {emoji} {label}
    </span>
  );
}

function DirField({
  label,
  hint,
  value,
  onChange,
  onPick,
  placeholder,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  onPick?: () => void;
  placeholder: string;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 12, fontWeight: 500, color: "var(--text-strong)" }}>
        {label}
      </span>
      <span style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 2 }}>
        {hint}
      </span>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          style={{
            flex: 1,
            fontSize: 12,
            fontFamily: "var(--mono)",
            padding: "6px 10px",
          }}
        />
        {onPick && (
          <button
            onClick={onPick}
            className="ghost"
            style={{ fontSize: 12, padding: "5px 12px", cursor: "pointer", flexShrink: 0 }}
          >
            Parcourir…
          </button>
        )}
      </div>
    </div>
  );
}

function TutoSection() {
  const [relaunching, setRelaunching] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [activePdf, setActivePdf] = useState<"demarrer" | "admin">("demarrer");
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    fetch("/api/app-config")
      .then((r) => r.json())
      .then((j: { config?: { isAdmin?: boolean } }) =>
        setIsAdmin(j.config?.isAdmin === true)
      )
      .catch(() => {});
  }, []);

  async function relaunchWizard() {
    if (
      !confirm(
        "Relancer l'assistant de premier lancement ? Vous repasserez par toutes les étapes (prénom, install Claude, rôle, dossiers, campagne)."
      )
    ) {
      return;
    }
    setRelaunching(true);
    setMsg(null);
    try {
      await fetch("/api/app-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentUser: null }),
      });
      setMsg("Wizard relancé. Rechargement...");
      setTimeout(() => window.location.reload(), 600);
    } catch (e) {
      setMsg("Erreur : " + (e as Error).message);
      setRelaunching(false);
    }
  }

  const PDF_OPTIONS = [
    {
      id: "demarrer" as const,
      title: "Démarrer en 5 minutes",
      desc: "Installation et utilisation de base. Le doc à lire en premier.",
      file: "/docs/GUIDE-DEMARRER.pdf",
    },
    ...(isAdmin
      ? [
          {
            id: "admin" as const,
            title: "Guide admin",
            desc: "Suivi équipe, stockage, campagnes, calibrage, journal.",
            file: "/docs/GUIDE-ADMIN.pdf",
          },
        ]
      : []),
  ];

  const activeFile =
    PDF_OPTIONS.find((p) => p.id === activePdf)?.file ??
    "/docs/GUIDE-DEMARRER.pdf";
  const activeFilename =
    activeFile.split("/").pop() ?? "GUIDE-DEMARRER.pdf";

  return (
    <Section
      title="Tuto - Guides d'utilisation"
      hint="Trois guides courts ciblés. Le premier (Démarrer en 5 minutes) couvre l'essentiel pour 90% des cas."
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
        {PDF_OPTIONS.map((p) => (
          <button
            key={p.id}
            onClick={() => setActivePdf(p.id)}
            style={{
              display: "grid",
              gridTemplateColumns: "auto 1fr auto",
              alignItems: "center",
              gap: 14,
              padding: "10px 14px",
              background:
                activePdf === p.id ? "var(--accent-tint)" : "var(--bg-subtle)",
              border:
                activePdf === p.id
                  ? "1px solid color-mix(in srgb, var(--accent) 50%, var(--border))"
                  : "1px solid var(--border-soft)",
              borderRadius: "var(--radius-sm)",
              textAlign: "left",
              cursor: "pointer",
              transition: "all 120ms ease",
            }}
          >
            <span
              style={{
                width: 12,
                height: 12,
                borderRadius: "50%",
                border:
                  activePdf === p.id
                    ? "4px solid var(--accent)"
                    : "1px solid var(--border-strong)",
                background:
                  activePdf === p.id ? "var(--bg-panel)" : "transparent",
                flexShrink: 0,
              }}
            />
            <div>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: "var(--text-strong)",
                }}
              >
                {p.title}
              </div>
              <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 2 }}>
                {p.desc}
              </div>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <a
                href={p.file}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="ghost"
                style={{
                  fontSize: 11,
                  padding: "4px 10px",
                  textDecoration: "none",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-sm)",
                  color: "var(--text-muted)",
                }}
              >
                Ouvrir
              </a>
              <a
                href={p.file}
                download
                onClick={(e) => e.stopPropagation()}
                className="ghost"
                style={{
                  fontSize: 11,
                  padding: "4px 10px",
                  textDecoration: "none",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-sm)",
                  color: "var(--text-muted)",
                }}
              >
                Télécharger
              </a>
            </div>
          </button>
        ))}
      </div>

      <div
        style={{
          fontSize: 11,
          color: "var(--text-muted)",
          marginBottom: 8,
        }}
      >
        Aperçu : <code style={{ fontSize: 11 }}>{activeFilename}</code>
      </div>
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-sm)",
          overflow: "hidden",
          background: "var(--bg-subtle)",
          marginBottom: 18,
        }}
      >
        <iframe
          src={`${activeFile}#pagemode=none&navpanes=0&toolbar=1&zoom=page-width`}
          title={activeFilename}
          style={{
            width: "100%",
            height: "70vh",
            minHeight: 540,
            border: "none",
            background: "var(--bg-panel)",
          }}
        />
      </div>

      <div
        style={{
          padding: "14px 16px",
          background: "var(--accent-tint)",
          border: "1px solid color-mix(in srgb, var(--accent) 30%, var(--border))",
          borderRadius: "var(--radius-sm)",
        }}
      >
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: "var(--text-strong)",
            marginBottom: 4,
          }}
        >
          Relancer l&apos;assistant de premier lancement
        </div>
        <div
          style={{
            fontSize: 12,
            color: "var(--text-muted)",
            lineHeight: 1.55,
            marginBottom: 10,
          }}
        >
          Pour repasser par les étapes d&apos;onboarding (prénom, installation
          Claude Code, rôle admin, dossiers, campagne). Utile si vous avez
          changé de poste ou si vous voulez reconfigurer.
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={relaunchWizard}
            disabled={relaunching}
            className="primary"
            style={{
              fontSize: 12,
              padding: "6px 14px",
              cursor: relaunching ? "not-allowed" : "pointer",
              opacity: relaunching ? 0.6 : 1,
            }}
          >
            {relaunching ? "Lancement..." : "Relancer l'assistant"}
          </button>
          {msg && (
            <span
              style={{
                fontSize: 12,
                color: msg.startsWith("Erreur") ? "var(--red)" : "var(--green)",
              }}
            >
              {msg}
            </span>
          )}
        </div>
      </div>
    </Section>
  );
}
