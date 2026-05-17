"use client";

import { useEffect, useState } from "react";
import { AppChromeHeader } from "@/components/AppChromeHeader";
import { isElectron, openFile, revealFile, selectDirectory } from "@/lib/electron";

interface RequiredDirSpec {
  key: string;
  label: string;
  /**
   * Sous-dossiers créés automatiquement quand l'utilisateur choisit la
   * racine via le picker natif. Pattern OIF-eval — le storage est
   * "self-organizing", l'utilisateur ne touche pas aux sous-dossiers.
   */
  subdirs?: string[];
}

interface AppConfigShape {
  model: string;
  currentUser?: string;
  isAdmin?: boolean;
  maxConcurrentRuns?: number;
  inputDir?: string;
  outputDir?: string;
  auditLogDir?: string;
  requiredDirs?: RequiredDirSpec[];
  [k: string]: unknown;
}

interface AvailableModel {
  id: string;
  label: string;
  description: string;
}

/**
 * Page paramètres : sections séparées en cards, hérité d'oif-eval.
 * - Profil (utilisateur courant, rôle admin)
 * - Stockage (dossiers requis lus dynamiquement depuis `requiredDirs`)
 * - Modèle Claude Code + concurrence
 * - AGENT-SLOT: settings-section-calibrage (vide dans le template)
 */
export default function SettingsPage() {
  const [config, setConfig] = useState<AppConfigShape | null>(null);
  const [models, setModels] = useState<AvailableModel[]>([]);
  const [saving, setSaving] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/app-config")
      .then((r) => r.json())
      .then((j: { config: AppConfigShape; availableModels: AvailableModel[] }) => {
        setConfig(j.config);
        setModels(j.availableModels);
      })
      .catch((err) => setError(String(err)));
  }, []);

  async function save(partial: Partial<AppConfigShape>) {
    setSaving(true);
    setInfo(null);
    setError(null);
    try {
      const r = await fetch("/api/app-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(partial),
      });
      if (!r.ok) throw new Error(await r.text());
      const j = (await r.json()) as { config: AppConfigShape };
      setConfig(j.config);
      setInfo("Enregistré.");
      window.dispatchEvent(new Event("app-config-changed"));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const requiredDirs = config?.requiredDirs ?? [];
  // Fallback : si l'app n'a déclaré aucun requiredDirs, on affiche quand même
  // les 3 dossiers classiques (input/output/audit) pour permettre la conf manuelle.
  const dirsToShow: RequiredDirSpec[] =
    requiredDirs.length > 0
      ? requiredDirs
      : [
          { key: "inputDir", label: "Dossier input (lecture)" },
          { key: "outputDir", label: "Dossier output (écriture)" },
          { key: "auditLogDir", label: "Dossier audit-log" },
        ];

  return (
    <div className="app">
      <AppChromeHeader />
      <main
        style={{
          flex: 1,
          overflowY: "auto",
          padding: 32,
          maxWidth: 880,
          width: "100%",
          margin: "0 auto",
        }}
      >
        <header style={{ marginBottom: 24 }}>
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
            Paramètres
          </h1>
          <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
            Configuration de l&apos;app : profil, stockage, modèle.
          </p>
        </header>

        {!config ? (
          <p>Chargement…</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            {/* Section : Profil */}
            <Section title="Profil">
              <Field label="Utilisateur connecté">
                <input
                  type="text"
                  defaultValue={config.currentUser ?? ""}
                  onBlur={(e) => save({ currentUser: e.target.value })}
                />
              </Field>
              <Field label="Administrateur">
                <input
                  type="checkbox"
                  checked={!!config.isAdmin}
                  onChange={(e) => save({ isAdmin: e.target.checked })}
                />
              </Field>
            </Section>

            {/* Section : Stockage */}
            <Section title="Stockage">
              <p style={{ fontSize: 12, color: "var(--muted)", marginBottom: 12 }}>
                Chemins de dossiers que l&apos;app peut lire/écrire. Ces dossiers
                sont autorisés à Claude Code via <code>--add-dir</code>. Clique
                sur <strong>Parcourir</strong> pour ouvrir un sélecteur natif —
                les sous-dossiers nécessaires sont créés automatiquement.
              </p>
              {dirsToShow.map((spec) => (
                <DirField
                  key={spec.key}
                  spec={spec}
                  value={(config[spec.key] as string | undefined) ?? ""}
                  onSave={(v) => save({ [spec.key]: v || undefined })}
                />
              ))}
            </Section>

            {/* Section : Modèle Claude Code */}
            <Section title="Modèle Claude Code">
              <Field label="Modèle">
                <select
                  value={config.model}
                  onChange={(e) => save({ model: e.target.value })}
                >
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Max runs concurrents">
                <input
                  type="number"
                  defaultValue={config.maxConcurrentRuns ?? 5}
                  onBlur={(e) =>
                    save({ maxConcurrentRuns: Number(e.target.value) || undefined })
                  }
                />
              </Field>
            </Section>

            {/* AGENT-SLOT: settings-section-calibrage
                L'agent ui-page-generator ajoute ici une section "Calibrage"
                ou autre section métier si le brief le demande. */}

            {saving && <p style={{ fontSize: 13, color: "var(--text-muted)" }}>Enregistrement…</p>}
            {info && <p style={{ fontSize: 13, color: "var(--green, green)" }}>{info}</p>}
            {error && <p style={{ fontSize: 13, color: "var(--red-fg)" }}>{error}</p>}
          </div>
        )}
      </main>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      className="pane"
      style={{
        padding: 20,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <h2
        style={{
          fontSize: 11,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: "var(--text-muted)",
          margin: 0,
        }}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 13, fontWeight: 500, color: "var(--fg)" }}>{label}</span>
      {children}
    </label>
  );
}

/**
 * Champ dossier avec picker natif (Electron) + bouton "Ouvrir" pour révéler
 * dans le Finder/Explorer. Tombe sur un input texte simple en mode browser
 * pur (préview Next sans Electron).
 *
 * Pattern OIF-eval — l'utilisateur choisit la racine, les sous-dossiers
 * (`spec.subdirs`) sont créés automatiquement.
 */
function DirField({
  spec,
  value,
  onSave,
}: {
  spec: RequiredDirSpec;
  value: string;
  onSave: (path: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [picking, setPicking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inEl = isElectron();

  useEffect(() => {
    setDraft(value);
  }, [value]);

  async function browse() {
    setPicking(true);
    setErr(null);
    try {
      const r = await selectDirectory({
        title: `Choisir : ${spec.label}`,
        defaultPath: draft || undefined,
        subdirs: spec.subdirs,
      });
      if (r.ok) {
        setDraft(r.path);
        onSave(r.path);
      } else if ("cancelled" in r && r.cancelled) {
        /* utilisateur annulé — silencieux */
      } else if ("unavailable" in r && r.unavailable) {
        setErr("Picker natif indispo (pas en Electron).");
      } else if ("error" in r) {
        setErr(r.error);
      }
    } finally {
      setPicking(false);
    }
  }

  return (
    <Field label={spec.label}>
      <div style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (draft !== value) onSave(draft);
          }}
          placeholder={`/chemin/vers/${spec.key}`}
          style={{
            flex: 1,
            padding: "6px 8px",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm, 6px)",
            background: "var(--surface)",
            color: "var(--fg)",
            fontSize: 13,
            fontFamily: "var(--mono)",
          }}
        />
        <button
          type="button"
          onClick={browse}
          disabled={picking}
          style={{
            padding: "6px 12px",
            fontSize: 12,
            cursor: picking ? "wait" : "pointer",
            whiteSpace: "nowrap",
          }}
          title={
            inEl
              ? "Ouvrir le sélecteur natif"
              : "Picker indispo hors Electron — colle le chemin à la main"
          }
        >
          {picking ? "…" : "Parcourir"}
        </button>
        {draft && (
          <button
            type="button"
            onClick={() => revealFile(draft)}
            disabled={!inEl}
            style={{
              padding: "6px 10px",
              fontSize: 12,
              cursor: inEl ? "pointer" : "not-allowed",
              whiteSpace: "nowrap",
            }}
            title="Révéler dans le Finder / Explorer"
          >
            Ouvrir
          </button>
        )}
      </div>
      {spec.subdirs && spec.subdirs.length > 0 && (
        <p
          style={{
            fontSize: 11,
            color: "var(--muted)",
            margin: "2px 0 0",
            fontFamily: "var(--mono)",
          }}
        >
          ↳ sous-dossiers auto : {spec.subdirs.join(", ")}
        </p>
      )}
      {err && <span style={{ fontSize: 11, color: "var(--red-fg)" }}>{err}</span>}
    </Field>
  );
}
