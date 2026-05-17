"use client";

import { AppChromeHeader } from "@/components/AppChromeHeader";
import { PanelLayout3 } from "@/components/PanelLayout3";

/**
 * Page Runs : pattern 3-panneaux extrait d'oif-eval (/evaluation).
 * - Panel gauche : liste d'items (entité métier principale).
 * - Panel centre : viewer principal (détail, stream, etc.).
 * - Panel droit : panneau secondaire (grille, synthèse, etc.).
 *
 * L'agent ui-page-generator remplit chaque slot selon le brief métier (par
 * exemple : <ItemList /> dans le slot gauche, <StreamingPanel /> au centre,
 * <ItemDetail /> à droite).
 */
export default function RunsPage() {
  return (
    <div className="app">
      <AppChromeHeader />
      <div style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0 }}>
        <PanelLayout3
          autoSaveId="{{APP_NAME_KEBAB}}:runs-layout-v1"
          leftPanel={
            /* AGENT-SLOT: panel-left
             * L'agent ui-page-generator remplace ce placeholder par la liste de
             * l'entité métier (par exemple <ItemList />). */
            <div className="p-4 text-[var(--text-muted)] text-sm">
              Liste à remplir par l&apos;agent ui-page-generator
              (composant <code>&lt;ItemList /&gt;</code>)
            </div>
          }
          centerPanel={
            /* AGENT-SLOT: panel-center
             * Viewer principal : détail d'un item, stream du run en cours, etc. */
            <div className="p-4 text-[var(--text-muted)] text-sm">
              Viewer principal (composant <code>&lt;ItemDetail /&gt;</code> ou{" "}
              <code>&lt;StreamingPanel /&gt;</code>)
            </div>
          }
          rightPanel={
            /* AGENT-SLOT: panel-right
             * Panneau secondaire : grille de critères, synthèse, etc. */
            <div className="p-4 text-[var(--text-muted)] text-sm">
              Panneau secondaire (grille / synthèse)
            </div>
          }
        />
      </div>
    </div>
  );
}
