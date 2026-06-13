"use client";

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { AdminShell, AdminStat } from "@/components/AdminShell";
import { Icon } from "@/components/Icon";
import { apiFetch } from "@/lib/api-client";

interface DesignSystemOption {
  id: string;
  name: string;
  version: string;
  description?: string;
  sourceKind?: string;
  targets: string[];
}

interface DesignSystemService {
  serviceId: string;
  serviceInstanceId?: string | null;
  name: string;
  description?: string | null;
  baseUrl?: string | null;
  adminUrl?: string | null;
  enabled: boolean;
  designSystem: {
    id: string;
    name?: string;
    version?: string;
    sourceKind?: string;
    appliedAt?: string;
  };
  designSystemSource: "service" | "active";
}

interface DesignSystemsResponse {
  active: DesignSystemOption | null;
  available: DesignSystemOption[];
  services: DesignSystemService[];
  generatedAt: string;
}

export default function DesignSystemsAdminPage() {
  const [data, setData] = useState<DesignSystemsResponse | null>(null);
  const [selectedDesignSystemId, setSelectedDesignSystemId] = useState("");
  const [selectedServiceIds, setSelectedServiceIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<"all" | "selected" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      const response = await apiFetch("/api/admin/design-systems");
      const json = (await response.json().catch(() => ({}))) as DesignSystemsResponse & { error?: string };
      if (!response.ok) throw new Error(json.error ?? `HTTP ${response.status}`);
      setData(json);
      setSelectedDesignSystemId((current) => current || json.active?.id || json.available[0]?.id || "");
      setSelectedServiceIds(json.services.map((service) => service.serviceId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const services = data?.services ?? [];
  const available = data?.available ?? [];
  const selectedOption = available.find((option) => option.id === selectedDesignSystemId) ?? data?.active ?? available[0] ?? null;
  const selectedSet = useMemo(() => new Set(selectedServiceIds), [selectedServiceIds]);
  const alignedCount = selectedOption
    ? services.filter((service) => service.designSystem.id === selectedOption.id).length
    : 0;

  async function applyDesignSystem(scope: "all" | "selected") {
    if (!selectedOption) return;
    setSaving(scope);
    setError(null);
    try {
      const response = await apiFetch("/api/admin/design-systems/services", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          designSystemId: selectedOption.id,
          ...(scope === "selected" ? { serviceIds: selectedServiceIds } : {}),
        }),
      });
      const json = (await response.json().catch(() => ({}))) as { services?: DesignSystemService[]; error?: string };
      if (!response.ok) throw new Error(json.error ?? `HTTP ${response.status}`);
      if (json.services) {
        setData((current) => {
          if (!current) return current;
          const byId = new Map(json.services?.map((service) => [service.serviceId, service]));
          return {
            ...current,
            services: current.services.map((service) => byId.get(service.serviceId) ?? service),
            generatedAt: new Date().toISOString(),
          };
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(null);
    }
  }

  function toggleService(serviceId: string) {
    setSelectedServiceIds((current) =>
      current.includes(serviceId)
        ? current.filter((candidate) => candidate !== serviceId)
        : [...current, serviceId]
    );
  }

  return (
    <AdminShell
      title="Design systems"
      description="Le design publié ici est écrit dans le manifest des sites actifs de l'organisation."
      actions={
        <button type="button" className="icon-btn" onClick={() => void load()} disabled={loading} title="Actualiser" aria-label="Actualiser">
          <Icon name="refresh" size={14} />
        </button>
      }
    >
      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 190px), 1fr))", gap: 10, marginBottom: 14 }}>
        <AdminStat label="Design actif admin" value={data?.active?.name ?? "-"} />
        <AdminStat label="Sites actifs" value={services.length} />
        <AdminStat label="Alignés cible" value={alignedCount} tone={services.length && alignedCount === services.length ? "ok" : undefined} />
      </section>

      {error && (
        <div className="pane" style={{ padding: 12, color: "var(--red-fg)", borderColor: "var(--red-border)", background: "var(--red-bg)", marginBottom: 14 }}>
          {error}
        </div>
      )}

      {loading ? (
        <section className="pane" style={{ padding: 18 }}>
          <p style={{ color: "var(--muted)", margin: 0 }}>Chargement...</p>
        </section>
      ) : !data ? (
        <section className="pane" style={{ padding: 18 }}>
          <p style={{ color: "var(--muted)", margin: 0 }}>Aucune donnée design system disponible.</p>
        </section>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))", gap: 14, alignItems: "start" }}>
          <section className="pane" style={{ padding: 16 }}>
            <div style={{ display: "grid", gap: 12 }}>
              <label className="field">
                <span>Design cible</span>
                <select value={selectedDesignSystemId} onChange={(event) => setSelectedDesignSystemId(event.target.value)}>
                  {available.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name} · {option.version}
                    </option>
                  ))}
                </select>
              </label>

              {selectedOption && (
                <article
                  style={{
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius)",
                    background: "var(--surface)",
                    padding: 12,
                    display: "grid",
                    gap: 8,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                    <strong>{selectedOption.name}</strong>
                    <span className="pill info">{selectedOption.sourceKind ?? "local"}</span>
                  </div>
                  <p style={{ color: "var(--muted)", fontSize: 12, margin: 0 }}>{selectedOption.description ?? selectedOption.id}</p>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {selectedOption.targets.map((target) => (
                      <span key={target} className="pill">{target}</span>
                    ))}
                  </div>
                </article>
              )}

              <div style={{ display: "grid", gap: 8 }}>
                <button
                  type="button"
                  className="primary"
                  onClick={() => void applyDesignSystem("all")}
                  disabled={!selectedOption || services.length === 0 || saving !== null}
                >
                  {saving === "all" ? "Application..." : "Appliquer à tous les sites"}
                </button>
                <button
                  type="button"
                  onClick={() => void applyDesignSystem("selected")}
                  disabled={!selectedOption || selectedServiceIds.length === 0 || saving !== null}
                >
                  {saving === "selected" ? "Application..." : `Appliquer à la sélection (${selectedServiceIds.length})`}
                </button>
              </div>
            </div>
          </section>

          <section className="pane" style={{ overflow: "hidden" }}>
            <div style={sectionHeadStyle}>
              <div>
                <strong>Sites associés</strong>
                <p style={{ margin: "3px 0 0", color: "var(--muted)", fontSize: 12 }}>Manifests Bridge actifs</p>
              </div>
              <button
                type="button"
                onClick={() =>
                  setSelectedServiceIds(
                    selectedServiceIds.length === services.length
                      ? []
                      : services.map((service) => service.serviceId)
                  )
                }
              >
                {selectedServiceIds.length === services.length ? "Tout désélectionner" : "Tout sélectionner"}
              </button>
            </div>
            {services.length === 0 ? (
              <p style={{ padding: 14, color: "var(--muted)", margin: 0 }}>Aucun site actif pour cette organisation.</p>
            ) : (
              services.map((service) => (
                <label
                  key={service.serviceId}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "18px minmax(0, 1.2fr) minmax(150px, 0.8fr) auto",
                    gap: 12,
                    alignItems: "center",
                    padding: "12px 14px",
                    borderTop: "1px solid var(--border-soft)",
                    background: selectedSet.has(service.serviceId) ? "var(--subtle)" : "transparent",
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selectedSet.has(service.serviceId)}
                    onChange={() => toggleService(service.serviceId)}
                    style={{ width: 16, height: 16 }}
                  />
                  <span style={{ minWidth: 0, display: "grid", gap: 2 }}>
                    <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {service.name || service.serviceId}
                    </strong>
                    <span style={{ color: "var(--muted)", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {service.baseUrl ?? service.adminUrl ?? service.serviceId}
                    </span>
                  </span>
                  <span style={{ minWidth: 0, display: "grid", gap: 2 }}>
                    <span style={{ fontSize: 12, color: "var(--muted)" }}>Design</span>
                    <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {service.designSystem.name ?? service.designSystem.id}
                    </strong>
                  </span>
                  <span className={`pill ${service.designSystem.id === selectedOption?.id ? "ok" : "warn"}`}>
                    {service.designSystemSource === "active" ? "hérité" : "site"}
                  </span>
                </label>
              ))
            )}
          </section>
        </div>
      )}
    </AdminShell>
  );
}

const sectionHeadStyle: CSSProperties = {
  padding: "12px 14px",
  borderBottom: "1px solid var(--border-soft)",
  display: "flex",
  justifyContent: "space-between",
  gap: 12,
  alignItems: "center",
};
