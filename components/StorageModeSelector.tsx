"use client";

import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import {
  detectStoragePath,
  exportAdminPack,
  exportEvaluationsPack,
  importAdminPack,
  importEvaluationsPack,
  previewEvaluationsPack,
  type StorageDetection,
  type SyncHealth,
} from "@/lib/client";

type StorageMode = "shared" | "manual";

interface Props {
  mode: StorageMode;
  onModeChange: (m: StorageMode) => void;
  isAdmin: boolean;
  /** Path actuellement choisi pour le partage (sharedSkillsDir typiquement). */
  sharedPath?: string;
}

const STORAGE_BADGE: Record<
  StorageDetection["type"],
  { label: string; color: string; bg: string; emoji: string }
> = {
  onedrive: {
    label: "OneDrive",
    color: "var(--accent-strong)",
    bg: "var(--accent-tint)",
    emoji: "☁",
  },
  sharepoint: {
    label: "SharePoint",
    color: "var(--accent-strong)",
    bg: "var(--accent-tint)",
    emoji: "☁",
  },
  dropbox: {
    label: "Dropbox",
    color: "var(--accent-strong)",
    bg: "var(--accent-tint)",
    emoji: "☁",
  },
  "google-drive": {
    label: "Google Drive",
    color: "var(--amber)",
    bg: "var(--amber-bg)",
    emoji: "☁",
  },
  icloud: {
    label: "iCloud Drive",
    color: "var(--amber)",
    bg: "var(--amber-bg)",
    emoji: "☁",
  },
  smb: {
    label: "Partage réseau (SMB)",
    color: "var(--accent-strong)",
    bg: "var(--accent-tint)",
    emoji: "🖧",
  },
  local: {
    label: "Dossier local",
    color: "var(--text-muted)",
    bg: "var(--bg-subtle)",
    emoji: "📁",
  },
};

export function StorageModeSelector({
  mode,
  onModeChange,
  isAdmin,
  sharedPath,
}: Props) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        marginBottom: 16,
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: "var(--text-muted)",
          marginBottom: 4,
        }}
      >
        Mode de partage
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <ModeCard
          selected={mode === "shared"}
          onClick={() => onModeChange("shared")}
          title="Dossier synchronisé"
          subtitle="OneDrive / SharePoint / Dropbox / NAS / SMB"
          desc="Recommandé. Tous les évaluateurs pointent vers le même dossier ; le sync se fait automatiquement."
        />
        <ModeCard
          selected={mode === "manual"}
          onClick={() => onModeChange("manual")}
          title="Import / Export manuel"
          subtitle="Sans serveur partagé"
          desc="Repli si l'OIF n'a pas de dossier partagé. Échange par fichiers ZIP via Teams ou email."
        />
      </div>
      {mode === "manual" && (
        <ManualModePanel isAdmin={isAdmin} />
      )}
    </div>
  );
}

function ModeCard({
  selected,
  onClick,
  title,
  subtitle,
  desc,
}: {
  selected: boolean;
  onClick: () => void;
  title: string;
  subtitle: string;
  desc: string;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: "1 1 240px",
        textAlign: "left",
        padding: "12px 14px",
        borderRadius: "var(--radius)",
        background: selected ? "var(--accent-tint)" : "var(--bg-panel)",
        border: selected
          ? "1px solid color-mix(in srgb, var(--accent) 50%, var(--border))"
          : "1px solid var(--border)",
        cursor: "pointer",
        transition: "all 120ms ease",
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
      }}
    >
      <span
        style={{
          flexShrink: 0,
          marginTop: 3,
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
          {title}
        </div>
        <div
          style={{
            fontSize: 11,
            color: "var(--text-muted)",
            marginBottom: 6,
          }}
        >
          {subtitle}
        </div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
          {desc}
        </div>
      </div>
    </button>
  );
}

function SharedFolderHealth({ path }: { path: string }) {
  const [detection, setDetection] = useState<StorageDetection | null>(null);
  const [health, setHealth] = useState<SyncHealth | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!path) {
      setDetection(null);
      setHealth(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    detectStoragePath(path)
      .then((r) => {
        if (cancelled) return;
        setDetection(r.detection);
        setHealth(r.health);
      })
      .catch(() => {
        /* ignore */
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  if (!path) return null;
  if (loading) {
    return (
      <div style={{ fontSize: 11, color: "var(--text-muted)", padding: "6px 0" }}>
        Analyse du dossier en cours…
      </div>
    );
  }
  if (!detection) return null;
  const badge = STORAGE_BADGE[detection.type];
  const syncIndicator =
    health?.available === "not-applicable"
      ? null
      : health?.available === "yes"
      ? { color: "var(--green)", label: `${health.processName} actif` }
      : health?.available === "no"
      ? { color: "var(--red)", label: `${health.processName} introuvable` }
      : { color: "var(--text-muted)", label: "statut inconnu" };

  return (
    <div
      style={{
        marginTop: 4,
        padding: "8px 12px",
        background: "var(--bg-subtle)",
        border: "1px solid var(--border-soft)",
        borderRadius: "var(--radius-sm)",
        fontSize: 12,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "2px 8px",
            background: badge.bg,
            color: badge.color,
            border: `1px solid color-mix(in srgb, ${badge.color} 30%, transparent)`,
            borderRadius: "var(--radius-pill)",
            fontWeight: 600,
            fontSize: 11,
          }}
        >
          {badge.emoji} {badge.label}
          {detection.tenant && (
            <span style={{ opacity: 0.85 }}>· {detection.tenant}</span>
          )}
        </span>
        {syncIndicator && (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              fontSize: 11,
              color: syncIndicator.color,
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: 999,
                background: "currentColor",
              }}
            />
            {syncIndicator.label}
          </span>
        )}
      </div>
      {detection.warnings.length > 0 && (
        <ul
          style={{
            margin: 0,
            paddingLeft: 18,
            color: "var(--amber)",
            fontSize: 11.5,
            lineHeight: 1.5,
          }}
        >
          {detection.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
      {health?.available === "no" && (
        <div
          style={{
            color: "var(--red)",
            fontSize: 11.5,
            lineHeight: 1.5,
          }}
        >
          Le sync engine ne tourne pas sur ce poste. Vérifiez que {health.processName}{" "}
          est lancé, sinon les modifications ne seront pas propagées.
        </div>
      )}
    </div>
  );
}

function ManualModePanel({ isAdmin }: { isAdmin: boolean }) {
  const [evalCount, setEvalCount] = useState<number | null>(null);
  const [auditCount, setAuditCount] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    previewEvaluationsPack()
      .then((p) => {
        if (cancelled) return;
        setEvalCount(p.evaluations);
        setAuditCount(p.auditFiles);
      })
      .catch(() => {
        /* ignore */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function showMsg(s: string, ms = 4000) {
    setMsg(s);
    setTimeout(() => setMsg(null), ms);
  }

  async function downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function handleExportAdminPack() {
    setBusy("export-admin");
    try {
      const { blob, filename } = await exportAdminPack();
      await downloadBlob(blob, filename);
      showMsg(`Pack admin exporté : ${filename}`);
    } catch (e) {
      showMsg("Erreur : " + (e as Error).message, 6000);
    } finally {
      setBusy(null);
    }
  }

  async function handleExportEvalsPack() {
    setBusy("export-evals");
    try {
      const { blob, filename } = await exportEvaluationsPack();
      await downloadBlob(blob, filename);
      showMsg(`Pack évaluations exporté : ${filename}`);
    } catch (e) {
      showMsg("Erreur : " + (e as Error).message, 6000);
    } finally {
      setBusy(null);
    }
  }

  async function handleImport(
    file: File,
    kind: "admin" | "evals"
  ): Promise<void> {
    setBusy("import-" + kind);
    try {
      const fn = kind === "admin" ? importAdminPack : importEvaluationsPack;
      const result = await fn(file, { overwrite: false });
      const counts = result.manifest?.counts ?? {};
      const summary =
        `Import ok : ${result.imported} fichier${result.imported > 1 ? "s" : ""}` +
        (result.skipped ? `, ${result.skipped} ignoré${result.skipped > 1 ? "s" : ""}` : "") +
        (result.warnings.length > 0 ? ` (${result.warnings.length} warning)` : "") +
        (counts.skills ? `. ${counts.skills} skill${counts.skills > 1 ? "s" : ""}` : "") +
        (counts.evaluations
          ? `. ${counts.evaluations} évaluation${counts.evaluations > 1 ? "s" : ""}`
          : "");
      showMsg(summary, 8000);
    } catch (e) {
      showMsg("Erreur : " + (e as Error).message, 8000);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      style={{
        marginTop: 4,
        padding: "12px 14px",
        background: "var(--accent-tint)",
        border:
          "1px solid color-mix(in srgb, var(--accent) 30%, var(--border))",
        borderRadius: "var(--radius-sm)",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div style={{ fontSize: 12, color: "var(--text)", lineHeight: 1.55 }}>
        <strong>Mode autonome.</strong>{" "}
        {isAdmin
          ? "L'admin centralise les données. Exportez régulièrement un pack admin pour les évaluateurs ; importez les packs d'évaluations qu'ils vous renvoient."
          : "Vos évaluations restent locales. Importez le pack admin envoyé par l'admin OIF, puis exportez vos évaluations finalisées en fin de journée pour les lui renvoyer."}
      </div>

      <div style={{ display: "grid", gap: 8, gridTemplateColumns: "1fr 1fr" }}>
        {isAdmin && (
          <ActionTile
            title="Exporter le pack admin"
            hint="Skills + propositions à diffuser aux évaluateurs"
            buttonLabel={busy === "export-admin" ? "Export…" : "Exporter"}
            disabled={busy !== null}
            onClick={handleExportAdminPack}
            icon="download"
          />
        )}
        {!isAdmin && (
          <ActionTile
            title="Importer le pack admin"
            hint="Met à jour vos skills depuis l'admin OIF"
            buttonLabel={busy === "import-admin" ? "Import…" : "Choisir un ZIP"}
            disabled={busy !== null}
            isFile
            onFile={(f) => handleImport(f, "admin")}
            icon="upload"
          />
        )}
        <ActionTile
          title={isAdmin ? "Importer un pack évaluations" : "Exporter mes évaluations"}
          hint={
            isAdmin
              ? "Pack reçu d'un évaluateur — sera mergé dans la base centrale"
              : `${evalCount ?? "?"} évaluation${(evalCount ?? 0) > 1 ? "s" : ""} prête${(evalCount ?? 0) > 1 ? "s" : ""} à exporter${
                  auditCount ? ` (+ ${auditCount} fichiers d'audit)` : ""
                }`
          }
          buttonLabel={
            isAdmin
              ? busy === "import-evals"
                ? "Import…"
                : "Choisir un ZIP"
              : busy === "export-evals"
              ? "Export…"
              : "Exporter"
          }
          disabled={busy !== null}
          isFile={isAdmin}
          onFile={isAdmin ? (f) => handleImport(f, "evals") : undefined}
          onClick={!isAdmin ? handleExportEvalsPack : undefined}
          icon={isAdmin ? "upload" : "download"}
        />
      </div>

      {msg && (
        <div
          style={{
            fontSize: 12,
            color: msg.startsWith("Erreur") ? "var(--red)" : "var(--green)",
            background: msg.startsWith("Erreur")
              ? "var(--red-bg)"
              : "var(--green-bg)",
            padding: "6px 10px",
            borderRadius: "var(--radius-sm)",
            border: `1px solid ${
              msg.startsWith("Erreur") ? "var(--red-border)" : "var(--green-border)"
            }`,
          }}
        >
          {msg}
        </div>
      )}
    </div>
  );
}

function ActionTile({
  title,
  hint,
  buttonLabel,
  disabled,
  onClick,
  onFile,
  isFile,
  icon,
}: {
  title: string;
  hint: string;
  buttonLabel: string;
  disabled: boolean;
  onClick?: () => void;
  onFile?: (f: File) => void;
  isFile?: boolean;
  icon: "download" | "upload";
}) {
  return (
    <div
      style={{
        background: "var(--bg-panel)",
        border: "1px solid var(--border-soft)",
        borderRadius: "var(--radius-sm)",
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text-strong)" }}>
        {title}
      </div>
      <div style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.5, flex: 1 }}>
        {hint}
      </div>
      {isFile ? (
        <label
          className="primary"
          style={{
            fontSize: 12,
            padding: "6px 12px",
            cursor: disabled ? "not-allowed" : "pointer",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            opacity: disabled ? 0.6 : 1,
            borderRadius: "var(--radius-sm)",
          }}
        >
          <Icon name={icon} size={12} />
          {buttonLabel}
          <input
            type="file"
            accept=".zip,application/zip"
            disabled={disabled}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f && onFile) onFile(f);
              e.target.value = "";
            }}
            style={{ display: "none" }}
          />
        </label>
      ) : (
        <button
          className="primary"
          onClick={onClick}
          disabled={disabled}
          style={{
            fontSize: 12,
            padding: "6px 12px",
            cursor: disabled ? "not-allowed" : "pointer",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            opacity: disabled ? 0.6 : 1,
          }}
        >
          <Icon name={icon} size={12} />
          {buttonLabel}
        </button>
      )}
    </div>
  );
}
