"use client";
import { useEffect, useState } from "react";
import { Mark } from "@/components/Mark";

interface AppConfigShape {
  currentUser?: string;
  isAdmin?: boolean;
}

/**
 * Mini-wizard d'onboarding au premier lancement de l'app.
 * Apparaît en plein écran tant que `cfg.currentUser` n'est pas défini, et
 * demande simplement un prénom + un rôle admin.
 *
 * Hérité du shell UX d'oif-eval, fortement génericisé : pas de step "campagne"
 * ni "dossier partagé" (ces sujets sont métier et seront ré-ajoutés par les
 * agents de la factory si l'app en a besoin).
 */
export function OnboardingWizard() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [prenom, setPrenom] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/app-config")
      .then((r) => r.json())
      .then((j: { config?: AppConfigShape }) => {
        if (cancelled) return;
        const cfg = j.config ?? {};
        if (!cfg.currentUser) setOpen(true);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function save() {
    if (!prenom.trim()) {
      setError("Prénom obligatoire");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const r = await fetch("/api/app-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentUser: prenom.trim(), isAdmin }),
      });
      if (!r.ok) throw new Error(await r.text());
      setOpen(false);
      // Notifier les autres composants pour rafraîchir leur état (AppChromeHeader)
      window.dispatchEvent(new Event("app-config-changed"));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (loading || !open) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "rgba(0, 0, 0, 0.7)",
        backdropFilter: "blur(6px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div
        style={{
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: 32,
          maxWidth: 480,
          width: "100%",
          boxShadow: "0 20px 60px rgba(0, 0, 0, 0.5)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            marginBottom: 16,
          }}
        >
          <Mark size={32} />
          <div>
            <div
              style={{
                fontFamily: "var(--serif)",
                fontSize: 20,
                fontWeight: 600,
                color: "var(--text-strong)",
              }}
            >
              Bienvenue dans {"{{APP_NAME}}"}
            </div>
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
              {"{{DOMAIN_BRIEF}}"}
            </div>
          </div>
        </div>
        <label
          style={{
            display: "block",
            fontSize: 13,
            fontWeight: 500,
            color: "var(--text)",
            marginBottom: 6,
          }}
        >
          Votre prénom
        </label>
        <input
          type="text"
          value={prenom}
          onChange={(e) => setPrenom(e.target.value)}
          placeholder="Ex. Nicolas"
          style={{ width: "100%", marginBottom: 16 }}
          autoFocus
        />
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 13,
            color: "var(--text)",
            marginBottom: 20,
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={isAdmin}
            onChange={(e) => setIsAdmin(e.target.checked)}
          />
          Je suis administrateur de cette app
        </label>
        {error && (
          <div
            style={{
              fontSize: 12,
              color: "var(--red, crimson)",
              marginBottom: 12,
            }}
          >
            {error}
          </div>
        )}
        <button
          onClick={save}
          disabled={saving || !prenom.trim()}
          className="primary"
          style={{
            width: "100%",
            padding: "10px 16px",
            fontSize: 14,
            fontWeight: 500,
            cursor: saving ? "default" : "pointer",
          }}
        >
          {saving ? "Enregistrement…" : "Commencer"}
        </button>
      </div>
    </div>
  );
}
