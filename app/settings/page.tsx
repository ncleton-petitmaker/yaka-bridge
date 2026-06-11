"use client";

import { useEffect, useMemo, useState } from "react";
import { AppChromeHeader } from "@/components/AppChromeHeader";
import { Icon } from "@/components/Icon";
import { apiFetch } from "@/lib/api-client";

type SettingsTab = "general" | "automations" | "advanced";

interface GmailSupplierInvoiceAutomation {
  enabled?: boolean;
  periodStart?: string;
  periodEnd?: string;
  supplierTypes?: string[];
  excludedSupplierTypes?: string[];
  gmailQuery?: string;
  pennylaneMcpServer?: string;
  schedule?: "manual" | "daily" | "weekly" | "monthly";
}

interface AppConfigShape {
  model: string;
  databaseProvider?: "supabase";
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  maxConcurrentRuns?: number;
  automations?: {
    gmailSupplierInvoices?: GmailSupplierInvoiceAutomation;
  };
  [k: string]: unknown;
}

interface AvailableModel {
  id: string;
  label: string;
  description: string;
}

interface ActionRegistryEntry {
  id: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  audit?: {
    action: string;
    resourceType: string;
    dangerous?: boolean;
    adminOnly?: boolean;
  };
}

const SUPPLIER_TYPES = [
  { id: "materiaux", label: "Matériaux" },
  { id: "quincaillerie", label: "Quincaillerie" },
  { id: "outillage", label: "Outillage" },
  { id: "transport", label: "Transport" },
  { id: "numerique", label: "Numérique" },
] as const;

const TAB_ITEMS: Array<{
  id: SettingsTab;
  icon: "settings" | "import" | "sliders";
  title: string;
  description: string;
}> = [
  {
    id: "general",
    icon: "settings",
    title: "Général",
    description: "Base de données et modèle",
  },
  {
    id: "automations",
    icon: "import",
    title: "Automatisations",
    description: "Gmail, factures, Pennylane",
  },
  {
    id: "advanced",
    icon: "sliders",
    title: "Avancé",
    description: "Actions système et diagnostic",
  },
];

function defaultGmailAutomation(): Required<GmailSupplierInvoiceAutomation> {
  return {
    enabled: false,
    periodStart: "2025-01-01",
    periodEnd: "2025-12-31",
    supplierTypes: ["materiaux", "quincaillerie"],
    excludedSupplierTypes: ["numerique"],
    gmailQuery: 'has:attachment filename:pdf newer:2025/01/01 older:2026/01/01 (facture OR invoice)',
    pennylaneMcpServer: "pennylane",
    schedule: "manual",
  };
}

/**
 * Page paramètres : sous-sections inspirées d'OIF.
 * - Général : base Supabase + modèle Claude Code.
 * - Automatisations : bloc Gmail pour importer les factures fournisseurs.
 * - Avancé : registre des actions exposées au daemon / Bridge / MCP.
 */
export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");
  const [config, setConfig] = useState<AppConfigShape | null>(null);
  const [models, setModels] = useState<AvailableModel[]>([]);
  const [actions, setActions] = useState<ActionRegistryEntry[]>([]);
  const [actionsError, setActionsError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch("/api/app-config")
      .then((r) => r.json())
      .then((j: { config: AppConfigShape; availableModels: AvailableModel[] }) => {
        setConfig(j.config);
        setModels(j.availableModels);
      })
      .catch((err) => setError(String(err)));

    apiFetch("/api/actions")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j: { actions?: ActionRegistryEntry[] }) => {
        setActions(Array.isArray(j.actions) ? j.actions : []);
        setActionsError(null);
      })
      .catch((err) => setActionsError(err instanceof Error ? err.message : String(err)));
  }, []);

  const gmailAutomation = useMemo(
    () => ({
      ...defaultGmailAutomation(),
      ...(config?.automations?.gmailSupplierInvoices ?? {}),
    }),
    [config]
  );

  async function save(partial: Partial<AppConfigShape>) {
    setSaving(true);
    setInfo(null);
    setError(null);
    try {
      const r = await apiFetch("/api/app-config", {
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

  function saveGmailAutomation(partial: Partial<GmailSupplierInvoiceAutomation>) {
    const next = {
      ...gmailAutomation,
      ...partial,
    };
    return save({
      automations: {
        ...(config?.automations ?? {}),
        gmailSupplierInvoices: next,
      },
    });
  }

  function toggleSupplierType(type: string, checked: boolean) {
    const current = new Set(gmailAutomation.supplierTypes);
    if (checked) current.add(type);
    else current.delete(type);
    void saveGmailAutomation({ supplierTypes: Array.from(current) });
  }

  function toggleExcludedSupplierType(type: string, checked: boolean) {
    const current = new Set(gmailAutomation.excludedSupplierTypes);
    if (checked) current.add(type);
    else current.delete(type);
    void saveGmailAutomation({ excludedSupplierTypes: Array.from(current) });
  }

  return (
    <div className="app">
      <AppChromeHeader />
      <main
        style={{
          flex: 1,
          overflowY: "auto",
          padding: 32,
          width: "100%",
        }}
      >
        <div style={{ maxWidth: 1120, width: "100%", margin: "0 auto" }}>
          <header style={{ marginBottom: 24 }}>
            <h1
              style={{
                fontFamily: "var(--serif)",
                fontWeight: 600,
                fontSize: 28,
                letterSpacing: 0,
                color: "var(--text-strong)",
                marginBottom: 6,
              }}
            >
              Paramètres
            </h1>
            <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
              Réglages structurés par sous-sections.
            </p>
          </header>

          {!config ? (
            <p>Chargement…</p>
          ) : (
            <div
              className="settings-sections-layout"
              style={{
                display: "grid",
                gridTemplateColumns: "260px minmax(0, 1fr)",
                gap: 20,
                alignItems: "start",
              }}
            >
              <aside
                className="pane"
                style={{
                  padding: 10,
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                  position: "sticky",
                  top: 24,
                }}
              >
                {TAB_ITEMS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`settings-nav-item${activeTab === item.id ? " active" : ""}`}
                    onClick={() => setActiveTab(item.id)}
                  >
                    <Icon name={item.icon} size={15} />
                    <span>
                      <strong>{item.title}</strong>
                      <small>{item.description}</small>
                    </span>
                  </button>
                ))}
              </aside>

              <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                {activeTab === "general" && (
                  <>
                    <Section title="Base de données Supabase">
                      <p style={{ fontSize: 12, color: "var(--muted)", marginBottom: 12 }}>
                        Le template persiste les données métier dans Supabase. La clé
                        service-role doit rester côté daemon via{" "}
                        <code>SUPABASE_SERVICE_ROLE_KEY</code>; elle n&apos;est jamais
                        saisie ici.
                      </p>
                      <Field label="URL Supabase">
                        <input
                          type="url"
                          defaultValue={config.supabaseUrl ?? ""}
                          placeholder="https://api.customer.example"
                          onBlur={(e) => save({ supabaseUrl: e.target.value.trim() || undefined })}
                        />
                      </Field>
                      <Field label="Anon key Supabase">
                        <input
                          type="password"
                          defaultValue={config.supabaseAnonKey ?? ""}
                          placeholder="eyJ..."
                          onBlur={(e) => save({ supabaseAnonKey: e.target.value.trim() || undefined })}
                        />
                      </Field>
                    </Section>

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
                  </>
                )}

                {activeTab === "automations" && (
                  <Section title="Gmail · import factures fournisseurs">
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 16,
                        borderBottom: "1px solid var(--border-soft)",
                        paddingBottom: 12,
                      }}
                    >
                      <div>
                        <h3 style={{ fontSize: 17 }}>Bloc Gmail</h3>
                        <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
                          Prépare l&apos;import automatique des factures fournisseurs vers Pennylane.
                        </p>
                      </div>
                      <label
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          fontSize: 13,
                          fontWeight: 600,
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={Boolean(gmailAutomation.enabled)}
                          onChange={(e) => saveGmailAutomation({ enabled: e.target.checked })}
                          style={{ width: 16, height: 16 }}
                        />
                        Actif
                      </label>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                      <Field label="Début de période">
                        <input
                          type="date"
                          value={gmailAutomation.periodStart}
                          onChange={(e) => saveGmailAutomation({ periodStart: e.target.value })}
                        />
                      </Field>
                      <Field label="Fin de période">
                        <input
                          type="date"
                          value={gmailAutomation.periodEnd}
                          onChange={(e) => saveGmailAutomation({ periodEnd: e.target.value })}
                        />
                      </Field>
                    </div>

                    <Field label="Fréquence">
                      <select
                        value={gmailAutomation.schedule}
                        onChange={(e) =>
                          saveGmailAutomation({
                            schedule: e.target.value as GmailSupplierInvoiceAutomation["schedule"],
                          })
                        }
                      >
                        <option value="manual">Manuel</option>
                        <option value="daily">Tous les jours</option>
                        <option value="weekly">Chaque semaine</option>
                        <option value="monthly">Chaque mois</option>
                      </select>
                    </Field>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                      <Checklist
                        title="Types fournisseurs à importer"
                        values={gmailAutomation.supplierTypes}
                        onToggle={toggleSupplierType}
                      />
                      <Checklist
                        title="Types à exclure"
                        values={gmailAutomation.excludedSupplierTypes}
                        onToggle={toggleExcludedSupplierType}
                      />
                    </div>

                    <Field label="Requête Gmail">
                      <textarea
                        value={gmailAutomation.gmailQuery}
                        onChange={(e) => saveGmailAutomation({ gmailQuery: e.target.value })}
                        rows={3}
                      />
                    </Field>

                    <Field label="Serveur MCP Pennylane">
                      <input
                        value={gmailAutomation.pennylaneMcpServer}
                        onChange={(e) => saveGmailAutomation({ pennylaneMcpServer: e.target.value })}
                        placeholder="pennylane"
                      />
                    </Field>

                    <div
                      style={{
                        border: "1px solid var(--blue-border)",
                        borderRadius: "var(--radius-sm)",
                        background: "var(--blue-bg)",
                        color: "var(--blue-fg)",
                        padding: "10px 12px",
                        fontSize: 12,
                      }}
                    >
                      Cette version enregistre le périmètre d&apos;automatisation. Le
                      déclenchement effectif pourra ensuite appeler le serveur MCP Pennylane
                      actif côté Hermes avec ces critères.
                    </div>
                  </Section>
                )}

                {activeTab === "advanced" && (
                  <Section title="Avancé · actions système">
                    <p style={{ fontSize: 12, color: "var(--muted)", marginBottom: 4 }}>
                      Les actions ne sont pas une page métier. Ce sont les commandes
                      internes utilisées par l&apos;interface, Bridge, Codex et MCP avec
                      validation, droits et audit.
                    </p>
                    <details>
                      <summary
                        style={{
                          cursor: "pointer",
                          fontSize: 13,
                          fontWeight: 600,
                          color: "var(--fg)",
                        }}
                      >
                        Voir le registre des actions
                      </summary>
                      {actionsError ? (
                        <p style={{ fontSize: 12, color: "var(--red-fg)", marginTop: 12 }}>
                          Impossible de charger les actions : {actionsError}
                        </p>
                      ) : actions.length === 0 ? (
                        <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 12 }}>
                          Aucune action exposée par le daemon.
                        </p>
                      ) : (
                        <div
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 8,
                            marginTop: 12,
                          }}
                        >
                          {actions.map((action) => (
                            <div
                              key={action.id}
                              style={{
                                border: "1px solid var(--border-soft, var(--border))",
                                borderRadius: "var(--radius-sm, 6px)",
                                padding: "10px 12px",
                                background: "var(--surface)",
                              }}
                            >
                              <div
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 8,
                                  flexWrap: "wrap",
                                  marginBottom: 4,
                                }}
                              >
                                <code style={{ fontSize: 12 }}>{action.id}</code>
                                {action.audit && <ActionBadge>audit</ActionBadge>}
                                {action.audit?.adminOnly && <ActionBadge>admin</ActionBadge>}
                                {action.audit?.dangerous && <ActionBadge>critique</ActionBadge>}
                              </div>
                              <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0 }}>
                                {action.description}
                              </p>
                            </div>
                          ))}
                        </div>
                      )}
                    </details>
                  </Section>
                )}

                {saving && <p style={{ fontSize: 13, color: "var(--text-muted)" }}>Enregistrement…</p>}
                {info && <p style={{ fontSize: 13, color: "var(--green, green)" }}>{info}</p>}
                {error && <p style={{ fontSize: 13, color: "var(--red-fg)" }}>{error}</p>}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function Checklist({
  title,
  values,
  onToggle,
}: {
  title: string;
  values: string[];
  onToggle: (type: string, checked: boolean) => void;
}) {
  const selected = new Set(values);
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-sm)",
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <strong style={{ fontSize: 13 }}>{title}</strong>
      {SUPPLIER_TYPES.map((type) => (
        <label
          key={type.id}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            color: "var(--fg)",
            fontSize: 13,
          }}
        >
          <input
            type="checkbox"
            checked={selected.has(type.id)}
            onChange={(e) => onToggle(type.id, e.target.checked)}
            style={{ width: 16, height: 16 }}
          />
          {type.label}
        </label>
      ))}
    </div>
  );
}

function ActionBadge({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        border: "1px solid var(--border)",
        borderRadius: 999,
        padding: "1px 7px",
        fontSize: 10,
        color: "var(--text-muted)",
        lineHeight: "16px",
      }}
    >
      {children}
    </span>
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
