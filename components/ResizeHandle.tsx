"use client";
import { PanelResizeHandle } from "react-resizable-panels";

/**
 * Handle de redimensionnement style opendesign : trait fin var(--border)
 * en horizontal, qui devient accent au hover/drag, curseur col-resize.
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
        background: "var(--bg)",
        cursor: isH ? "col-resize" : "row-resize",
        transition: "background 120ms ease",
      }}
      className="fae-resize-handle"
    >
      {/* trait visible au centre */}
      <span
        style={{
          position: "absolute",
          inset: isH ? "0 50% 0 50%" : "50% 0 50% 0",
          width: isH ? 1 : "auto",
          height: isH ? "auto" : 1,
          background: "var(--border)",
          transform: isH ? "translateX(-50%)" : "translateY(-50%)",
          pointerEvents: "none",
          transition: "background 120ms ease",
        }}
      />
    </PanelResizeHandle>
  );
}
