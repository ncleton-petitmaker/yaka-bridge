"use client";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

interface AppConfig {
  currentUser?: string;
  inputDir?: string;
  outputDir?: string;
  sharedSkillsDir?: string;
  auditLogDir?: string;
}

/**
 * Bloque l'application tant que les 4 dossiers de stockage ne sont pas
 * configurés explicitement. Affiche un overlay plein écran qui grise tout
 * et propose de configurer.
 *
 * Les 4 dossiers sont créés automatiquement par "Utiliser ce dossier" dans
 * Paramètres → Stockage.
 */
export function StorageGuard() {
  const [missing, setMissing] = useState<string[] | null>(null);
  const [checked, setChecked] = useState(false);
  const pathname = usePathname();
  // Ne pas bloquer la page des paramètres : c'est là qu'on configure le stockage.
  const isOnSettingsPage = pathname?.startsWith("/parametres") ?? false;

  useEffect(() => {
    let cancelled = false;
    let attempts = 0;

    function tryFetch() {
      attempts++;
      fetch("/api/app-config")
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
        .then((j: { config?: AppConfig }) => {
          if (cancelled) return;
          const cfg = j.config ?? {};
          // Si pas encore d'utilisateur, c'est l'OnboardingWizard qui gère
          if (!cfg.currentUser) {
            setChecked(true);
            return;
          }
          const miss: string[] = [];
          if (!cfg.inputDir?.trim()) miss.push("Dossier des candidatures");
          if (!cfg.outputDir?.trim()) miss.push("Dossier des évaluations");
          if (!cfg.sharedSkillsDir?.trim()) miss.push("Dossier partagé des skills");
          if (!cfg.auditLogDir?.trim()) miss.push("Dossier du journal RGPD");
          setMissing(miss.length > 0 ? miss : null);
          setChecked(true);
        })
        .catch(() => {
          if (cancelled) return;
          if (attempts < 10) setTimeout(tryFetch, 1500);
          else setChecked(true);
        });
    }
    tryFetch();
    return () => {
      cancelled = true;
    };
  }, []);

  // Recheck après navigation (utile quand l'utilisateur revient des paramètres)
  useEffect(() => {
    function onFocus() {
      fetch("/api/app-config")
        .then((r) => r.json())
        .then((j: { config?: AppConfig }) => {
          const cfg = j.config ?? {};
          if (!cfg.currentUser) return;
          const miss: string[] = [];
          if (!cfg.inputDir?.trim()) miss.push("Dossier des candidatures");
          if (!cfg.outputDir?.trim()) miss.push("Dossier des évaluations");
          if (!cfg.sharedSkillsDir?.trim()) miss.push("Dossier partagé des skills");
          if (!cfg.auditLogDir?.trim()) miss.push("Dossier du journal RGPD");
          setMissing(miss.length > 0 ? miss : null);
        })
        .catch(() => {});
    }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  if (!checked || !missing || isOnSettingsPage) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9998,
        background: "rgba(0, 0, 0, 0.65)",
        backdropFilter: "blur(4px)",
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
          padding: 28,
          maxWidth: 560,
          width: "100%",
          boxShadow: "0 20px 60px rgba(0, 0, 0, 0.4)",
        }}
      >
        <div
          style={{
            fontSize: 18,
            fontWeight: 600,
            color: "var(--text-strong)",
            marginBottom: 8,
          }}
        >
          Configuration de stockage requise
        </div>
        <div
          style={{
            fontSize: 13,
            color: "var(--text-muted)",
            marginBottom: 16,
            lineHeight: 1.6,
          }}
        >
          Avant d&apos;utiliser OIF-Eval, vous devez choisir un dossier de stockage.
          Les sous-dossiers nécessaires seront créés automatiquement.
        </div>
        <div
          style={{
            fontSize: 12,
            color: "var(--text)",
            background: "var(--accent-tint)",
            border: "1px solid color-mix(in srgb, var(--accent) 30%, var(--border))",
            borderRadius: "var(--radius-sm)",
            padding: 12,
            marginBottom: 18,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Éléments manquants :</div>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {missing.map((m) => (
              <li key={m} style={{ marginBottom: 4 }}>
                {m}
              </li>
            ))}
          </ul>
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <a
            href="/parametres?tab=stockage"
            className="primary"
            style={{
              fontSize: 13,
              padding: "8px 16px",
              borderRadius: "var(--radius-sm)",
              textDecoration: "none",
              fontWeight: 500,
            }}
          >
            Configurer le stockage
          </a>
        </div>
      </div>
    </div>
  );
}
