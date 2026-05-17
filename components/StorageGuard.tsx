"use client";
import { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";

interface RequiredDirSpec {
  key: string;
  label: string;
}

interface AppConfigShape {
  currentUser?: string;
  requiredDirs?: RequiredDirSpec[];
  [k: string]: unknown;
}

/**
 * Bloque l'application tant que les dossiers de stockage déclarés dans
 * `appConfig.requiredDirs` ne sont pas tous remplis. Affiche un overlay plein
 * écran qui grise tout et propose de naviguer vers /settings.
 *
 * Si `requiredDirs` est vide / absent : le guard est inactif (cas par défaut
 * du template). C'est l'app métier qui décide quels dossiers sont obligatoires.
 *
 * Hérité d'oif-eval, génericisé : la liste OIF (4 dossiers) est remplacée par
 * une lecture dynamique de la config.
 */
export function StorageGuard() {
  const [missing, setMissing] = useState<string[] | null>(null);
  const [checked, setChecked] = useState(false);
  const pathname = usePathname();
  // Ne pas bloquer la page des paramètres : c'est là qu'on configure le stockage.
  const isOnSettingsPage = pathname?.startsWith("/settings") ?? false;

  const computeMissing = useCallback((cfg: AppConfigShape): string[] => {
    const specs = cfg.requiredDirs ?? [];
    const miss: string[] = [];
    for (const spec of specs) {
      const val = cfg[spec.key];
      if (typeof val !== "string" || !val.trim()) miss.push(spec.label);
    }
    return miss;
  }, []);

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
        .then((j: { config?: AppConfigShape }) => {
          if (cancelled) return;
          const cfg = j.config ?? {};
          // Si pas encore d'utilisateur, c'est l'OnboardingWizard qui gère
          if (!cfg.currentUser) {
            setChecked(true);
            return;
          }
          const miss = computeMissing(cfg);
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
  }, [computeMissing]);

  // Recheck après navigation (utile quand l'utilisateur revient des paramètres)
  useEffect(() => {
    function onFocus() {
      fetch("/api/app-config")
        .then((r) => r.json())
        .then((j: { config?: AppConfigShape }) => {
          const cfg = j.config ?? {};
          if (!cfg.currentUser) return;
          const miss = computeMissing(cfg);
          setMissing(miss.length > 0 ? miss : null);
        })
        .catch(() => {});
    }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [computeMissing]);

  if (!checked || !missing || missing.length === 0 || isOnSettingsPage) return null;

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
          Avant d&apos;utiliser cette application, vous devez configurer les
          dossiers de stockage. Rendez-vous dans Paramètres pour les indiquer.
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
            href="/settings"
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
