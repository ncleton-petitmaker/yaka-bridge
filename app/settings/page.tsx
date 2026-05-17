"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

interface AppConfigShape {
  model: string;
  currentUser?: string;
  isAdmin?: boolean;
  maxConcurrentRuns?: number;
  inputDir?: string;
  outputDir?: string;
  auditLogDir?: string;
}

interface AvailableModel {
  id: string;
  label: string;
  description: string;
}

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
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "32px 24px" }}>
      <header style={{ marginBottom: 16 }}>
        <Link href="/" style={{ fontSize: 13, color: "#666" }}>
          ← Accueil
        </Link>
        <h1 style={{ fontSize: 22, fontWeight: 600, marginTop: 8 }}>Paramètres</h1>
      </header>

      {!config ? (
        <p>Chargement…</p>
      ) : (
        <section style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <Field label="Utilisateur connecté">
            <input
              type="text"
              defaultValue={config.currentUser ?? ""}
              onBlur={(e) => save({ currentUser: e.target.value })}
            />
          </Field>

          <Field label="Modèle Claude Code">
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

          <Field label="Admin">
            <input
              type="checkbox"
              checked={!!config.isAdmin}
              onChange={(e) => save({ isAdmin: e.target.checked })}
            />
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

          <Field label="Dossier input (lecture)">
            <input
              type="text"
              defaultValue={config.inputDir ?? ""}
              onBlur={(e) => save({ inputDir: e.target.value || undefined })}
              style={{ width: "100%" }}
            />
          </Field>

          <Field label="Dossier output (écriture)">
            <input
              type="text"
              defaultValue={config.outputDir ?? ""}
              onBlur={(e) => save({ outputDir: e.target.value || undefined })}
              style={{ width: "100%" }}
            />
          </Field>

          <Field label="Dossier audit-log">
            <input
              type="text"
              defaultValue={config.auditLogDir ?? ""}
              onBlur={(e) => save({ auditLogDir: e.target.value || undefined })}
              style={{ width: "100%" }}
            />
          </Field>

          {saving && <p style={{ fontSize: 13, color: "#666" }}>Enregistrement…</p>}
          {info && <p style={{ fontSize: 13, color: "green" }}>{info}</p>}
          {error && <p style={{ fontSize: 13, color: "crimson" }}>{error}</p>}
        </section>
      )}
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 13, fontWeight: 500 }}>{label}</span>
      {children}
    </label>
  );
}
