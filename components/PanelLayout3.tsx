"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Panel,
  PanelGroup,
  type ImperativePanelHandle,
} from "react-resizable-panels";
import { ResizeHandle } from "@/components/ResizeHandle";
import { Icon } from "@/components/Icon";

export interface PanelLayout3Props {
  leftPanel: ReactNode;
  centerPanel: ReactNode;
  rightPanel: ReactNode;
  /**
   * Identifiant pour la persistance des tailles dans localStorage via
   * react-resizable-panels. Changer la valeur invalide l'état persisté.
   */
  autoSaveId?: string;
  defaultSizes?: [number, number, number];
  minSizes?: [number, number, number];
  /**
   * Raccourcis clavier pour toggle chaque panneau. Touches passées sans modifier
   * (Cmd/Ctrl est ajouté automatiquement). Mettre "" pour désactiver.
   */
  keyboardShortcuts?: {
    toggleLeft?: string;
    toggleCenter?: string;
    toggleRight?: string;
  };
  /**
   * Compteur incrémental piloté par le parent pour forcer l'expansion du
   * panneau de droite (utile quand un click sur un item dans le centre doit
   * faire apparaître un drawer de détail). Le hook se déclenche à chaque
   * changement de valeur (pas seulement quand elle augmente).
   */
  expandRightSignal?: number;
  /** Pareil pour le panneau de gauche. */
  expandLeftSignal?: number;
}

/**
 * Layout 3 panneaux générique, extrait du shell d'oif-eval (page /evaluation).
 *
 * - Panneaux gauche et droit collapsibles (collapsedSize=0).
 * - Raccourcis clavier : Cmd+B (toggle gauche), Cmd+J (toggle droite) par défaut.
 * - Tailles persistées via `autoSaveId` (localStorage).
 * - **Safety net "panel disparu = bloqué"** : dès qu'un panneau collapsible
 *   est replié (drag jusqu'au minSize ou Cmd+B/Cmd+J), un **sliver toggle
 *   permanent** (32px de large, bord du layout) s'affiche avec une icône
 *   panel-left-open / panel-right-open cliquable pour re-ouvrir. Pattern
 *   inspiré d'OIF-eval (`CollapsedToggle` qui ne rend rien quand expanded),
 *   intégré directement dans le layout pour que les apps métier en héritent
 *   sans avoir à le re-implémenter.
 *
 * Les apps métier remplissent les 3 slots avec leurs composants spécifiques
 * (par exemple ItemList / ItemDetail / StreamingPanel).
 */
export function PanelLayout3({
  leftPanel,
  centerPanel,
  rightPanel,
  autoSaveId = "bridge-erp-template:panel-layout-v1",
  defaultSizes = [22, 56, 22],
  minSizes = [12, 30, 12],
  keyboardShortcuts,
  expandRightSignal,
  expandLeftSignal,
}: PanelLayout3Props) {
  const leftRef = useRef<ImperativePanelHandle>(null);
  const centerRef = useRef<ImperativePanelHandle>(null);
  const rightRef = useRef<ImperativePanelHandle>(null);

  // Suit l'état collapse de chaque panneau collapsible pour piloter le sliver
  // toggle permanent. Mis à jour via les callbacks onCollapse/onExpand des
  // <Panel> (react-resizable-panels) — la source de vérité reste le DOM, on
  // ne fait que mirrorer.
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);

  const togglePanel = useCallback(
    (ref: React.RefObject<ImperativePanelHandle | null>) => {
      const p = ref.current;
      if (!p) return;
      if (p.isCollapsed()) p.expand();
      else p.collapse();
    },
    []
  );

  const sc = {
    toggleLeft: keyboardShortcuts?.toggleLeft ?? "b",
    toggleCenter: keyboardShortcuts?.toggleCenter ?? "",
    toggleRight: keyboardShortcuts?.toggleRight ?? "j",
  };

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isMac = /Mac/i.test(navigator.platform);
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod || e.shiftKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (sc.toggleLeft && k === sc.toggleLeft) {
        e.preventDefault();
        togglePanel(leftRef);
      } else if (sc.toggleCenter && k === sc.toggleCenter) {
        e.preventDefault();
        togglePanel(centerRef);
      } else if (sc.toggleRight && k === sc.toggleRight) {
        e.preventDefault();
        togglePanel(rightRef);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sc.toggleLeft, sc.toggleCenter, sc.toggleRight, togglePanel]);

  // Auto-expand declenchés par les parents.
  useEffect(() => {
    if (expandRightSignal === undefined) return;
    const p = rightRef.current;
    if (p?.isCollapsed()) p.expand();
  }, [expandRightSignal]);
  useEffect(() => {
    if (expandLeftSignal === undefined) return;
    const p = leftRef.current;
    if (p?.isCollapsed()) p.expand();
  }, [expandLeftSignal]);

  return (
    <div style={{ flex: 1, display: "flex", minHeight: 0, position: "relative" }}>
      {/* Sliver toggle gauche — visible UNIQUEMENT quand leftPanel est collapsed */}
      {leftCollapsed && (
        <CollapsedSliver
          side="left"
          title="Afficher le panneau gauche (Cmd+B)"
          onClick={() => leftRef.current?.expand()}
        />
      )}

      <PanelGroup
        direction="horizontal"
        autoSaveId={autoSaveId}
        style={{ flex: 1 }}
      >
        <Panel
          ref={leftRef}
          defaultSize={defaultSizes[0]}
          minSize={minSizes[0]}
          collapsible
          collapsedSize={0}
          onCollapse={() => setLeftCollapsed(true)}
          onExpand={() => setLeftCollapsed(false)}
          style={{ display: "flex", flexDirection: "column", minWidth: 0 }}
        >
          {leftPanel}
        </Panel>
        <ResizeHandle />
        <Panel
          ref={centerRef}
          defaultSize={defaultSizes[1]}
          minSize={minSizes[1]}
          style={{ display: "flex", flexDirection: "column", minWidth: 0 }}
        >
          {centerPanel}
        </Panel>
        <ResizeHandle />
        <Panel
          ref={rightRef}
          defaultSize={defaultSizes[2]}
          minSize={minSizes[2]}
          collapsible
          collapsedSize={0}
          onCollapse={() => setRightCollapsed(true)}
          onExpand={() => setRightCollapsed(false)}
          style={{ display: "flex", flexDirection: "column", minWidth: 0 }}
        >
          {rightPanel}
        </Panel>
      </PanelGroup>

      {/* Sliver toggle droit — visible UNIQUEMENT quand rightPanel est collapsed */}
      {rightCollapsed && (
        <CollapsedSliver
          side="right"
          title="Afficher le panneau droit (Cmd+J)"
          onClick={() => rightRef.current?.expand()}
        />
      )}
    </div>
  );
}

/**
 * Sliver vertical 32 px ancré au bord du layout, affiché UNIQUEMENT quand
 * un panneau collapsible est replié. Garantit qu'on peut TOUJOURS rouvrir
 * un panneau caché (pas de "panel disparu = bloqué").
 *
 * Style pure tokens TF — pas d'hex hardcodé, transition 120 ms.
 */
function CollapsedSliver({
  side,
  title,
  onClick,
}: {
  side: "left" | "right";
  title: string;
  onClick: () => void;
}) {
  const iconName = side === "left" ? "panel-left-open" : "panel-right-open";
  return (
    <div
      style={{
        flexShrink: 0,
        width: 32,
        background: "var(--surface)",
        borderRight: side === "left" ? "1px solid var(--border)" : undefined,
        borderLeft: side === "right" ? "1px solid var(--border)" : undefined,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "8px 0",
      }}
    >
      <button
        type="button"
        onClick={onClick}
        aria-label={title}
        title={title}
        style={{
          width: 26,
          height: 26,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          background: "transparent",
          border: "1px solid transparent",
          borderRadius: "var(--radius-sm, 6px)",
          color: "var(--muted)",
          cursor: "pointer",
          transition: "background 120ms ease, color 120ms ease, border-color 120ms ease",
          padding: 0,
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "var(--subtle)";
          e.currentTarget.style.color = "var(--fg-strong)";
          e.currentTarget.style.borderColor = "var(--border)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "transparent";
          e.currentTarget.style.color = "var(--muted)";
          e.currentTarget.style.borderColor = "transparent";
        }}
      >
        <Icon name={iconName} size={16} />
      </button>
    </div>
  );
}
