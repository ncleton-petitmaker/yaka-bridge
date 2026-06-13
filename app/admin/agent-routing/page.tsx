"use client";

import { useEffect, useMemo, useState } from "react";
import { AdminShell, AdminStat } from "@/components/AdminShell";
import { Icon } from "@/components/Icon";
import { apiFetch } from "@/lib/api-client";

type AgentRoutingPrivacy = "normal" | "sensitive" | "local-only";

interface AgentRoutingPolicy {
  mode?: "cloud" | "local";
  privacy?: AgentRoutingPrivacy;
  localModel?: string;
  reason?: string;
}

interface BridgeAiPolicy {
  localAi: {
    enabled: boolean;
    installRequired: boolean;
    provider: "lmstudio";
    model: string;
    allowUserModelOverride: boolean;
  };
  voice: {
    enabled: boolean;
    installRequired: boolean;
    provider: "bridge-voice";
    model: string;
    defaultShortcut: string;
    allowUserShortcutOverride: boolean;
    allowUserModelOverride: boolean;
    insertMode: "bridge-fields" | "system";
  };
}

interface RoutingAction {
  id: string;
  label?: string;
  description?: string;
  agentRouting?: AgentRoutingPolicy;
}

interface RoutingService {
  serviceId: string;
  serviceInstanceId?: string | null;
  name: string;
  description?: string | null;
  defaultAgentRouting?: AgentRoutingPolicy;
  actions: RoutingAction[];
}

interface LocalModelRecommendation {
  platform: string;
  arch: string;
  totalMemoryGb: number;
  cpuCount: number;
  accelerator?: "apple-silicon" | "nvidia" | "cpu";
  gpuMemoryGb?: number;
  tier: "cloud-first" | "small-local" | "standard-local" | "large-local";
  recommendedModel: string;
  minimumMemoryGb?: number;
  downloadSizeGb?: number;
  reason: string;
}

interface RoutingResponse {
  defaultAgentProvider: "codex-cloud";
  aiPolicy: BridgeAiPolicy;
  localModelRecommendation?: LocalModelRecommendation;
  generatedAt: string;
  services: RoutingService[];
}

const DEFAULT_LOCAL_MODEL = "ibm/granite-4-micro";
const DEFAULT_VOICE_MODEL = "parakeet-tdt-0.6b-v3-int8";
const DEFAULT_VOICE_SHORTCUT = "CommandOrControl+Shift+Space";

export default function AgentRoutingAdminPage() {
  const [data, setData] = useState<RoutingResponse | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      const response = await apiFetch("/api/admin/agent-routing");
      const json = (await response.json().catch(() => ({}))) as RoutingResponse & { error?: string };
      if (!response.ok) {
        setError(json.error ?? `HTTP ${response.status}`);
        return;
      }
      setData(json);
    } finally {
      setLoaded(true);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function saveService(serviceId: string, patch: Record<string, unknown>) {
    setSaving(serviceId);
    setError(null);
    try {
      const response = await apiFetch(`/api/admin/agent-routing/services/${encodeURIComponent(serviceId)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      const json = (await response.json().catch(() => ({}))) as { service?: RoutingService; error?: string };
      if (!response.ok) throw new Error(json.error ?? `HTTP ${response.status}`);
      if (json.service) {
        setData((current) =>
          current
            ? {
                ...current,
                services: current.services.map((service) =>
                  service.serviceId === serviceId ? json.service as RoutingService : service
                ),
              }
            : current
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(null);
    }
  }

  async function saveAiPolicy(policy: BridgeAiPolicy) {
    setSaving("__policy");
    setError(null);
    try {
      const response = await apiFetch("/api/admin/agent-routing/policy", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ aiPolicy: policy }),
      });
      const json = (await response.json().catch(() => ({}))) as Partial<RoutingResponse> & { error?: string };
      if (!response.ok) throw new Error(json.error ?? `HTTP ${response.status}`);
      setData((current) =>
        current
          ? {
              ...current,
              aiPolicy: json.aiPolicy ?? policy,
              localModelRecommendation: json.localModelRecommendation ?? current.localModelRecommendation,
              services: json.services ?? current.services,
              generatedAt: json.generatedAt ?? current.generatedAt,
            }
          : current
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(null);
    }
  }

  const services = data?.services ?? [];
  const aiPolicy = data?.aiPolicy ?? defaultAiPolicy();
  const recommendation = data?.localModelRecommendation;
  const localActionCount = useMemo(
    () => services.flatMap((service) => service.actions).filter((action) => action.agentRouting?.mode === "local").length,
    [services]
  );

  return (
    <AdminShell
      title="Routage agentique"
      description="ChatGPT Codex reste le défaut. Les exceptions locales sont publiées dans le manifest de chaque site."
      actions={
        <button type="button" className="icon-btn" onClick={() => void load()} title="Actualiser" aria-label="Actualiser">
          <Icon name="refresh" size={14} />
        </button>
      }
    >
        <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 190px), 1fr))", gap: 10, marginBottom: 14 }}>
          <AdminStat label="Défaut global" value="ChatGPT Codex" />
          <AdminStat label="Services" value={services.length} />
          <AdminStat label="Actions locales" value={localActionCount} />
          <AdminStat label="Moteur local" value={aiPolicy.localAi.enabled ? "Installé par Bridge" : "Désactivé"} />
          <AdminStat label="Conseil local" value={recommendation?.recommendedModel ?? "-"} />
        </section>

        {error && (
          <div className="pane" style={{ padding: 12, color: "var(--red-fg)", borderColor: "var(--red-fg)", marginBottom: 14 }}>
            {error}
          </div>
        )}

        {!loaded ? (
          <p style={{ color: "var(--text-muted)" }}>Chargement...</p>
        ) : !data ? (
          <section className="pane" style={{ padding: 18 }}>
            <p style={{ margin: 0, color: "var(--text-muted)" }}>Routage indisponible pour cette organisation.</p>
          </section>
        ) : services.length === 0 ? (
          <section className="pane" style={{ padding: 18 }}>
            <p style={{ margin: 0, color: "var(--text-muted)" }}>Aucun service Bridge actif.</p>
          </section>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <section className="pane" style={{ padding: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", marginBottom: 14 }}>
                <div>
                  <h2 style={{ margin: 0, fontSize: 18 }}>Politique IA locale</h2>
                  <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-muted)" }}>
                    L&apos;admin choisit les modèles. Les utilisateurs sont guidés automatiquement.
                  </p>
                </div>
                {saving === "__policy" && <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Enregistrement...</span>}
              </div>
              {recommendation && (
                <LocalModelRecommendationCard
                  recommendation={recommendation}
                  activeModel={aiPolicy.localAi.model}
                  onApply={() =>
                    void saveAiPolicy({
                      ...aiPolicy,
                      localAi: {
                        ...aiPolicy.localAi,
                        enabled: true,
                        installRequired: true,
                        model: recommendation.recommendedModel,
                      },
                    })
                  }
                />
              )}
              <AiPolicyControls policy={aiPolicy} onChange={(policy) => void saveAiPolicy(policy)} />
            </section>

            {services.map((service) => (
              <section key={service.serviceId} className="pane" style={{ padding: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", marginBottom: 14 }}>
                  <div>
                    <h2 style={{ margin: 0, fontSize: 18 }}>{service.name || service.serviceId}</h2>
                    <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-muted)" }}>
                      {service.serviceId}
                      {service.description ? ` · ${service.description}` : ""}
                    </p>
                  </div>
                  {saving === service.serviceId && <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Enregistrement...</span>}
                </div>

                <div style={{ borderTop: "1px solid var(--border-soft)", paddingTop: 12, marginBottom: 12 }}>
                  <RoutingControls
                    label="Défaut du module"
                    inheritLabel="ChatGPT Codex global"
                    policy={service.defaultAgentRouting}
                    allowInherit
                    onChange={(policy) => void saveService(service.serviceId, { defaultAgentRouting: policy })}
                  />
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {service.actions.length === 0 ? (
                    <p style={{ color: "var(--text-muted)", fontSize: 12, margin: 0 }}>Aucune action déclarée dans le manifest.</p>
                  ) : (
                    service.actions.map((action) => (
                      <div key={action.id} style={{ borderTop: "1px solid var(--border-soft)", paddingTop: 10 }}>
                        <RoutingControls
                          label={action.label || action.id}
                          description={action.description || action.id}
                          inheritLabel={effectiveInheritedLabel(service.defaultAgentRouting)}
                          policy={action.agentRouting}
                          allowInherit
                          onChange={(policy) =>
                            void saveService(service.serviceId, {
                              actions: [{ id: action.id, agentRouting: policy }],
                            })
                          }
                        />
                      </div>
                    ))
                  )}
                </div>
              </section>
            ))}
          </div>
        )}
    </AdminShell>
  );
}

function LocalModelRecommendationCard({
  recommendation,
  activeModel,
  onApply,
}: {
  recommendation: LocalModelRecommendation;
  activeModel: string;
  onApply: () => void;
}) {
  const alreadySelected = activeModel === recommendation.recommendedModel;
  const canApply = recommendation.tier !== "cloud-first";
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) auto",
        gap: 12,
        alignItems: "center",
        border: "1px solid var(--border-soft)",
        borderRadius: 8,
        padding: 12,
        marginBottom: 14,
        background: "var(--bg-subtle)",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 4 }}>
          <strong style={{ fontSize: 13 }}>Modèle conseillé</strong>
          <code style={{ fontSize: 12, overflowWrap: "anywhere" }}>{recommendation.recommendedModel}</code>
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
            {recommendation.totalMemoryGb} GB RAM · {recommendation.cpuCount} CPU
            {recommendation.gpuMemoryGb ? ` · GPU ${recommendation.gpuMemoryGb} GB` : ""}
            {recommendation.accelerator ? ` · ${recommendation.accelerator}` : ""}
            {" · "}
            {recommendation.platform}/{recommendation.arch}
          </span>
        </div>
        {(recommendation.minimumMemoryGb || recommendation.downloadSizeGb) && (
          <p style={{ margin: "0 0 4px", color: "var(--text-muted)", fontSize: 11, lineHeight: 1.4 }}>
            Mémoire min. {recommendation.minimumMemoryGb ?? "-"} GB · téléchargement env. {recommendation.downloadSizeGb ?? "-"} GB
          </p>
        )}
        <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 12, lineHeight: 1.45 }}>{recommendation.reason}</p>
      </div>
      <button type="button" disabled={alreadySelected || !canApply} onClick={onApply} style={{ minHeight: 34 }}>
        {alreadySelected ? "Sélectionné" : canApply ? "Utiliser" : "Cloud conseillé"}
      </button>
    </div>
  );
}

function RoutingControls({
  label,
  description,
  inheritLabel,
  policy,
  allowInherit,
  onChange,
}: {
  label: string;
  description?: string;
  inheritLabel: string;
  policy?: AgentRoutingPolicy;
  allowInherit: boolean;
  onChange: (policy: AgentRoutingPolicy | null) => void;
}) {
  const mode = policy?.mode ?? "inherit";
  const privacy = policy?.privacy ?? "normal";
  const localModel = policy?.localModel ?? DEFAULT_LOCAL_MODEL;

  function nextPolicy(partial: Partial<AgentRoutingPolicy>): AgentRoutingPolicy {
    const nextMode = partial.mode ?? policy?.mode ?? "cloud";
    const nextPrivacy = partial.privacy ?? policy?.privacy ?? "normal";
    return {
      mode: nextMode,
      privacy: nextPrivacy,
      ...(nextMode === "local" ? { localModel: partial.localModel ?? policy?.localModel ?? DEFAULT_LOCAL_MODEL } : {}),
      ...(policy?.reason ? { reason: policy.reason } : {}),
    };
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, alignItems: "end" }}>
      <div>
        <strong style={{ display: "block", fontSize: 13 }}>{label}</strong>
        {description && <span style={{ display: "block", color: "var(--text-muted)", fontSize: 11, marginTop: 2 }}>{description}</span>}
      </div>
      <label style={fieldStyle}>
        <span>Mode</span>
        <select
          value={mode}
          onChange={(event) => {
            const value = event.target.value;
            if (value === "inherit") onChange(null);
            else onChange(nextPolicy({ mode: value as "cloud" | "local" }));
          }}
        >
          {allowInherit && <option value="inherit">Hériter · {inheritLabel}</option>}
          <option value="cloud">ChatGPT Codex</option>
          <option value="local">LM Studio local</option>
        </select>
      </label>
      <label style={fieldStyle}>
        <span>Confidentialité</span>
        <select
          value={privacy}
          disabled={mode !== "local"}
          onChange={(event) => onChange(nextPolicy({ privacy: event.target.value as AgentRoutingPrivacy }))}
        >
          <option value="normal">Normal</option>
          <option value="sensitive">Sensible</option>
          <option value="local-only">Local-only</option>
        </select>
      </label>
      <label style={fieldStyle}>
        <span>Modèle local</span>
        <input
          value={mode === "local" ? localModel : ""}
          disabled={mode !== "local"}
          placeholder={DEFAULT_LOCAL_MODEL}
          onChange={(event) => onChange(nextPolicy({ localModel: event.target.value.trim() || DEFAULT_LOCAL_MODEL }))}
        />
      </label>
    </div>
  );
}

function AiPolicyControls({
  policy,
  onChange,
}: {
  policy: BridgeAiPolicy;
  onChange: (policy: BridgeAiPolicy) => void;
}) {
  const next = (partial: Partial<BridgeAiPolicy>): BridgeAiPolicy => ({
    localAi: { ...policy.localAi, ...(partial.localAi ?? {}) },
    voice: { ...policy.voice, ...(partial.voice ?? {}) },
  });

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))", gap: 14 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <label style={{ ...fieldStyle, flexDirection: "row", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={policy.localAi.enabled}
            onChange={(event) =>
              onChange(next({ localAi: { ...policy.localAi, enabled: event.target.checked, installRequired: event.target.checked } }))
            }
            style={{ width: 16, height: 16 }}
          />
          <span>Installer LM Studio si le local est activé</span>
        </label>
        <label style={fieldStyle}>
          <span>Modèle local global</span>
          <input
            value={policy.localAi.model}
            disabled={!policy.localAi.enabled}
            placeholder={DEFAULT_LOCAL_MODEL}
            onChange={(event) =>
              onChange(next({ localAi: { ...policy.localAi, model: event.target.value.trim() || DEFAULT_LOCAL_MODEL } }))
            }
          />
        </label>
        <label style={{ ...fieldStyle, flexDirection: "row", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={policy.localAi.allowUserModelOverride}
            disabled={!policy.localAi.enabled}
            onChange={(event) =>
              onChange(next({ localAi: { ...policy.localAi, allowUserModelOverride: event.target.checked } }))
            }
            style={{ width: 16, height: 16 }}
          />
          <span>Autoriser l&apos;utilisateur à changer le modèle local</span>
        </label>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <label style={{ ...fieldStyle, flexDirection: "row", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={policy.voice.enabled}
            onChange={(event) =>
              onChange(next({ voice: { ...policy.voice, enabled: event.target.checked, installRequired: event.target.checked } }))
            }
            style={{ width: 16, height: 16 }}
          />
          <span>Activer le push-to-talk local</span>
        </label>
        <label style={fieldStyle}>
          <span>Modèle vocal global</span>
          <input
            value={policy.voice.model}
            disabled={!policy.voice.enabled}
            placeholder={DEFAULT_VOICE_MODEL}
            onChange={(event) =>
              onChange(next({ voice: { ...policy.voice, model: event.target.value.trim() || DEFAULT_VOICE_MODEL } }))
            }
          />
        </label>
        <label style={fieldStyle}>
          <span>Raccourci par défaut</span>
          <input
            value={policy.voice.defaultShortcut}
            disabled={!policy.voice.enabled}
            placeholder={DEFAULT_VOICE_SHORTCUT}
            onChange={(event) =>
              onChange(next({ voice: { ...policy.voice, defaultShortcut: event.target.value.trim() || DEFAULT_VOICE_SHORTCUT } }))
            }
          />
        </label>
        <label style={fieldStyle}>
          <span>Insertion de la dictée</span>
          <select
            value={policy.voice.insertMode}
            disabled={!policy.voice.enabled}
            onChange={(event) =>
              onChange(next({ voice: { ...policy.voice, insertMode: event.target.value as "system" | "bridge-fields" } }))
            }
          >
            <option value="system">Champ actif du système</option>
            <option value="bridge-fields">Presse-papiers Bridge</option>
          </select>
        </label>
        <label style={{ ...fieldStyle, flexDirection: "row", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={policy.voice.allowUserShortcutOverride}
            disabled={!policy.voice.enabled}
            onChange={(event) =>
              onChange(next({ voice: { ...policy.voice, allowUserShortcutOverride: event.target.checked } }))
            }
            style={{ width: 16, height: 16 }}
          />
          <span>L&apos;utilisateur peut changer seulement le raccourci</span>
        </label>
      </div>
    </div>
  );
}

function effectiveInheritedLabel(policy?: AgentRoutingPolicy): string {
  if (policy?.mode === "local") return "Module local";
  if (policy?.mode === "cloud") return "Module cloud";
  return "ChatGPT Codex global";
}

function defaultAiPolicy(): BridgeAiPolicy {
  return {
    localAi: {
      enabled: false,
      installRequired: false,
      provider: "lmstudio",
      model: DEFAULT_LOCAL_MODEL,
      allowUserModelOverride: false,
    },
    voice: {
      enabled: false,
      installRequired: false,
      provider: "bridge-voice",
      model: DEFAULT_VOICE_MODEL,
      defaultShortcut: DEFAULT_VOICE_SHORTCUT,
      allowUserShortcutOverride: true,
      allowUserModelOverride: false,
      insertMode: "system",
    },
  };
}

const fieldStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: 12,
  color: "var(--text-muted)",
};
