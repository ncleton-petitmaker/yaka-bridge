"use client";
import { useCallback, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import {
  Panel,
  PanelGroup,
  type ImperativePanelHandle,
} from "react-resizable-panels";
import { ResizeHandle } from "@/components/ResizeHandle";

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
}

/**
 * Layout 3 panneaux générique, extrait du shell d'oif-eval (page /evaluation).
 *
 * - Panneaux gauche et droit collapsibles (collapsedSize=0).
 * - Raccourcis clavier : Cmd+B (toggle gauche), Cmd+J (toggle droite) par défaut.
 * - Tailles persistées via `autoSaveId` (localStorage).
 *
 * Les apps métier remplissent les 3 slots avec leurs composants spécifiques
 * (par exemple ItemList / ItemDetail / StreamingPanel).
 */
export function PanelLayout3({
  leftPanel,
  centerPanel,
  rightPanel,
  autoSaveId = "{{APP_NAME_KEBAB}}:panel-layout-v1",
  defaultSizes = [22, 56, 22],
  minSizes = [12, 30, 12],
  keyboardShortcuts,
}: PanelLayout3Props) {
  const leftRef = useRef<ImperativePanelHandle>(null);
  const centerRef = useRef<ImperativePanelHandle>(null);
  const rightRef = useRef<ImperativePanelHandle>(null);

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

  return (
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
        style={{ display: "flex", flexDirection: "column", minWidth: 0 }}
      >
        {rightPanel}
      </Panel>
    </PanelGroup>
  );
}
