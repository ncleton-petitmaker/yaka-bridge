"use client";
import { useMemo, useState } from "react";
import { diffLines } from "diff";

type Side = "left" | "right";

interface RowCell {
  text: string | null;
  num: number | null;
  kind: "added" | "removed" | "context" | "empty";
}

interface Row {
  left: RowCell;
  right: RowCell;
  isElision?: boolean;
}

function buildRows(before: string, after: string, contextLines = 3): Row[] {
  const parts = diffLines(before, after);
  const rows: Row[] = [];
  let oldNum = 1;
  let newNum = 1;

  // Buffer pour aligner removed et added consécutifs sur la même ligne
  let pendingRemoved: { text: string; num: number }[] = [];
  let pendingAdded: { text: string; num: number }[] = [];

  function flushPending() {
    const max = Math.max(pendingRemoved.length, pendingAdded.length);
    for (let i = 0; i < max; i++) {
      const r = pendingRemoved[i];
      const a = pendingAdded[i];
      rows.push({
        left: r
          ? { text: r.text, num: r.num, kind: "removed" }
          : { text: null, num: null, kind: "empty" },
        right: a
          ? { text: a.text, num: a.num, kind: "added" }
          : { text: null, num: null, kind: "empty" },
      });
    }
    pendingRemoved = [];
    pendingAdded = [];
  }

  for (const part of parts) {
    const lines = part.value.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    if (part.added) {
      for (const l of lines) {
        pendingAdded.push({ text: l, num: newNum });
        newNum += 1;
      }
    } else if (part.removed) {
      for (const l of lines) {
        pendingRemoved.push({ text: l, num: oldNum });
        oldNum += 1;
      }
    } else {
      flushPending();
      for (const l of lines) {
        rows.push({
          left: { text: l, num: oldNum, kind: "context" },
          right: { text: l, num: newNum, kind: "context" },
        });
        oldNum += 1;
        newNum += 1;
      }
    }
  }
  flushPending();

  // Élision : on garde `contextLines` autour de chaque changement
  const isChange = (r: Row) =>
    r.left.kind !== "context" || r.right.kind !== "context";
  const out: Row[] = [];
  let elidedSinceLast = false;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (isChange(row)) {
      out.push(row);
      elidedSinceLast = false;
      continue;
    }
    let prevDist = Infinity;
    for (let k = i - 1; k >= 0; k--) {
      if (isChange(rows[k])) {
        prevDist = i - k;
        break;
      }
    }
    let nextDist = Infinity;
    for (let k = i + 1; k < rows.length; k++) {
      if (isChange(rows[k])) {
        nextDist = k - i;
        break;
      }
    }
    if (prevDist <= contextLines || nextDist <= contextLines) {
      out.push(row);
      elidedSinceLast = false;
    } else if (!elidedSinceLast) {
      out.push({
        left: { text: null, num: null, kind: "empty" },
        right: { text: null, num: null, kind: "empty" },
        isElision: true,
      });
      elidedSinceLast = true;
    }
  }
  return out;
}

function buildUnifiedRows(before: string, after: string, contextLines = 3) {
  const parts = diffLines(before, after);
  const lines: { text: string; oldNum: number | null; newNum: number | null; kind: "added" | "removed" | "context" }[] = [];
  let oldNum = 1;
  let newNum = 1;
  for (const part of parts) {
    const ls = part.value.split("\n");
    if (ls[ls.length - 1] === "") ls.pop();
    for (const l of ls) {
      if (part.added) {
        lines.push({ text: l, oldNum: null, newNum, kind: "added" });
        newNum += 1;
      } else if (part.removed) {
        lines.push({ text: l, oldNum, newNum: null, kind: "removed" });
        oldNum += 1;
      } else {
        lines.push({ text: l, oldNum, newNum, kind: "context" });
        oldNum += 1;
        newNum += 1;
      }
    }
  }
  const out: typeof lines = [];
  let elided = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.kind !== "context") {
      out.push(l);
      elided = false;
      continue;
    }
    let prev = Infinity, next = Infinity;
    for (let k = i - 1; k >= 0; k--) if (lines[k].kind !== "context") { prev = i - k; break; }
    for (let k = i + 1; k < lines.length; k++) if (lines[k].kind !== "context") { next = k - i; break; }
    if (prev <= contextLines || next <= contextLines) {
      out.push(l);
      elided = false;
    } else if (!elided) {
      out.push({ text: "@@ELIDED@@", oldNum: null, newNum: null, kind: "context" });
      elided = true;
    }
  }
  return out;
}

const ROW_BG = {
  added: "color-mix(in srgb, var(--green) 18%, var(--bg-panel))",
  removed: "color-mix(in srgb, var(--red) 18%, var(--bg-panel))",
  context: "var(--bg-panel)",
  empty: "color-mix(in srgb, var(--text-faint) 6%, var(--bg-panel))",
} as const;
const NUM_BG = {
  added: "color-mix(in srgb, var(--green) 28%, var(--bg-panel))",
  removed: "color-mix(in srgb, var(--red) 28%, var(--bg-panel))",
  context: "var(--bg-subtle)",
  empty: "color-mix(in srgb, var(--text-faint) 12%, var(--bg-panel))",
} as const;
const SIGN: Record<RowCell["kind"], string> = {
  added: "+",
  removed: "−",
  context: " ",
  empty: " ",
};

function CellText({ cell, side }: { cell: RowCell; side: Side }) {
  const numBg = NUM_BG[cell.kind];
  const rowBg = ROW_BG[cell.kind];
  return (
    <>
      <span
        style={{
          padding: "1px 8px 1px 6px",
          background: numBg,
          color: "var(--text-faint)",
          textAlign: "right",
          userSelect: "none",
          fontSize: 11,
          fontFamily: "var(--mono)",
          minWidth: 36,
          borderRight:
            side === "left"
              ? "1px solid var(--border-soft)"
              : "1px solid var(--border-soft)",
        }}
      >
        {cell.num ?? ""}
      </span>
      <span
        style={{
          padding: "1px 4px 1px 6px",
          background: rowBg,
          color:
            cell.kind === "added"
              ? "var(--green)"
              : cell.kind === "removed"
              ? "var(--red)"
              : "var(--text-faint)",
          textAlign: "center",
          userSelect: "none",
          fontFamily: "var(--mono)",
          fontWeight: 600,
          fontSize: 12,
        }}
      >
        {SIGN[cell.kind]}
      </span>
      <span
        style={{
          padding: "1px 10px 1px 4px",
          background: rowBg,
          color: cell.kind === "removed" ? "var(--text)" : "var(--text)",
          fontFamily: "var(--mono)",
          fontSize: 12,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          minHeight: 18,
          textDecoration: cell.kind === "removed" ? "line-through" : "none",
          textDecorationColor: "color-mix(in srgb, var(--red) 50%, transparent)",
        }}
      >
        {cell.text ?? " "}
      </span>
    </>
  );
}

export function DiffViewer({
  before,
  after,
  className,
}: {
  before: string;
  after: string;
  className?: string;
}) {
  const [mode, setMode] = useState<"split" | "unified">("split");
  const splitRows = useMemo(() => buildRows(before, after, 3), [before, after]);
  const unifiedLines = useMemo(
    () => buildUnifiedRows(before, after, 3),
    [before, after]
  );

  const stats = useMemo(() => {
    let added = 0, removed = 0;
    for (const part of diffLines(before, after)) {
      const lines = part.value.split("\n").filter((l, i, arr) => !(i === arr.length - 1 && l === "")).length;
      if (part.added) added += lines;
      else if (part.removed) removed += lines;
    }
    return { added, removed };
  }, [before, after]);

  return (
    <div
      className={className}
      style={{
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-sm)",
        overflow: "hidden",
        background: "var(--bg-panel)",
      }}
    >
      {/* Toolbar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "6px 10px",
          background: "var(--bg-subtle)",
          borderBottom: "1px solid var(--border)",
          fontSize: 11,
          color: "var(--text-muted)",
        }}
      >
        <span
          style={{
            color: "var(--green)",
            fontFamily: "var(--mono)",
            fontWeight: 600,
          }}
        >
          +{stats.added}
        </span>
        <span
          style={{
            color: "var(--red)",
            fontFamily: "var(--mono)",
            fontWeight: 600,
          }}
        >
          −{stats.removed}
        </span>
        <span style={{ flex: 1 }} />
        <div
          style={{
            display: "inline-flex",
            background: "var(--bg-panel)",
            border: "1px solid var(--border-soft)",
            borderRadius: "var(--radius-sm)",
            padding: 2,
            gap: 2,
          }}
        >
          {(
            [
              ["split", "Côte à côte"],
              ["unified", "Unifié"],
            ] as const
          ).map(([k, label]) => {
            const active = mode === k;
            return (
              <button
                key={k}
                onClick={() => setMode(k)}
                style={{
                  fontSize: 11,
                  padding: "2px 8px",
                  borderRadius: 4,
                  background: active ? "var(--accent-tint)" : "transparent",
                  color: active ? "var(--accent-strong)" : "var(--text-muted)",
                  border: "none",
                  cursor: "pointer",
                  fontWeight: active ? 600 : 400,
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {mode === "split" ? (
        <div style={{ overflowX: "auto" }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(0,1fr) 1px minmax(0,1fr)",
              minWidth: 600,
            }}
          >
            {/* Header colonnes */}
            <div
              style={{
                padding: "4px 10px",
                background: "var(--bg-subtle)",
                borderBottom: "1px solid var(--border)",
                fontSize: 11,
                fontWeight: 600,
                color: "var(--text-muted)",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 999,
                  background: "var(--red)",
                  display: "inline-block",
                }}
              />
              Avant (skill global actuel)
            </div>
            <div style={{ background: "var(--border)" }} />
            <div
              style={{
                padding: "4px 10px",
                background: "var(--bg-subtle)",
                borderBottom: "1px solid var(--border)",
                fontSize: 11,
                fontWeight: 600,
                color: "var(--text-muted)",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 999,
                  background: "var(--green)",
                  display: "inline-block",
                }}
              />
              Après promotion
            </div>

            {/* Lignes */}
            {splitRows.map((row, i) => {
              if (row.isElision) {
                return (
                  <ElisionRow key={i} cols={3} />
                );
              }
              return (
                <SplitRowFragment key={i} row={row} />
              );
            })}
          </div>
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "44px 44px 18px 1fr",
              minWidth: 600,
            }}
          >
            {unifiedLines.map((line, i) => {
              const isElide = line.text === "@@ELIDED@@";
              if (isElide) {
                return (
                  <div
                    key={i}
                    style={{
                      gridColumn: "1 / -1",
                      padding: "3px 12px",
                      background: "var(--bg-subtle)",
                      color: "var(--text-faint)",
                      fontSize: 11,
                      borderTop: "1px dashed var(--border-soft)",
                      borderBottom: "1px dashed var(--border-soft)",
                      textAlign: "center",
                    }}
                  >
                    ⋯
                  </div>
                );
              }
              const rowBg = ROW_BG[line.kind];
              const numBg = NUM_BG[line.kind];
              const sign = line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " ";
              const signColor =
                line.kind === "added"
                  ? "var(--green)"
                  : line.kind === "removed"
                  ? "var(--red)"
                  : "var(--text-faint)";
              return (
                <div key={i} style={{ display: "contents" }}>
                  <span
                    style={{
                      padding: "1px 6px",
                      background: numBg,
                      color: "var(--text-faint)",
                      textAlign: "right",
                      userSelect: "none",
                      fontSize: 11,
                      fontFamily: "var(--mono)",
                    }}
                  >
                    {line.oldNum ?? ""}
                  </span>
                  <span
                    style={{
                      padding: "1px 6px",
                      background: numBg,
                      color: "var(--text-faint)",
                      textAlign: "right",
                      userSelect: "none",
                      fontSize: 11,
                      fontFamily: "var(--mono)",
                      borderRight: "1px solid var(--border-soft)",
                    }}
                  >
                    {line.newNum ?? ""}
                  </span>
                  <span
                    style={{
                      padding: "1px 4px",
                      background: rowBg,
                      color: signColor,
                      textAlign: "center",
                      userSelect: "none",
                      fontWeight: 600,
                      fontFamily: "var(--mono)",
                      fontSize: 12,
                    }}
                  >
                    {sign}
                  </span>
                  <span
                    style={{
                      padding: "1px 10px",
                      background: rowBg,
                      color: "var(--text)",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      fontFamily: "var(--mono)",
                      fontSize: 12,
                      textDecoration: line.kind === "removed" ? "line-through" : "none",
                      textDecorationColor: "color-mix(in srgb, var(--red) 50%, transparent)",
                    }}
                  >
                    {line.text || " "}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function SplitRowFragment({ row }: { row: Row }) {
  return (
    <div style={{ display: "contents" }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "36px 14px 1fr",
          alignItems: "stretch",
        }}
      >
        <CellText cell={row.left} side="left" />
      </div>
      <div style={{ background: "var(--border)" }} />
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "36px 14px 1fr",
          alignItems: "stretch",
        }}
      >
        <CellText cell={row.right} side="right" />
      </div>
    </div>
  );
}

function ElisionRow({ cols }: { cols: number }) {
  return (
    <div
      style={{
        gridColumn: `1 / span ${cols}`,
        padding: "3px 12px",
        background: "var(--bg-subtle)",
        color: "var(--text-faint)",
        fontSize: 11,
        borderTop: "1px dashed var(--border-soft)",
        borderBottom: "1px dashed var(--border-soft)",
        textAlign: "center",
      }}
    >
      ⋯
    </div>
  );
}
