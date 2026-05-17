"use client";
import { PanelResizeHandle } from "react-resizable-panels";

/**
 * Handle de redimensionnement style opendesign : trait fin var(--border)
 * en horizontal, qui devient accent au hover/drag, curseur col-resize.
 *
 * Hérité d'oif-eval. La classe `.app-resize-handle` est ciblée par
 * globals.css pour le hover state.
 */
export function ResizeHandle({
  direction = "horizontal",
}: {
  direction?: "horizontal" | "vertical";
}) {
  const isH = direction === "horizontal";
  return (
    <PanelResizeHandle
      style={{
        position: "relative",
        flexShrink: 0,
        width: isH ? 6 : "100%",
        height: isH ? "100%" : 6,
        background: "transparent",
        cursor: isH ? "col-resize" : "row-resize",
      }}
      className="app-resize-handle"
    >
      {/* 1px hairline at center — gets stronger on hover via globals.css */}
      <span
        style={{
          position: "absolute",
          inset: isH ? "0 50% 0 50%" : "50% 0 50% 0",
          width: isH ? 1 : "auto",
          height: isH ? "auto" : 1,
          transform: isH ? "translateX(-50%)" : "translateY(-50%)",
          pointerEvents: "none",
        }}
      />
    </PanelResizeHandle>
  );
}
