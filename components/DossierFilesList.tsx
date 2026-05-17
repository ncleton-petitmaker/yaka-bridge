"use client";
import { useEffect, useState } from "react";
import { listDossierFiles } from "@/lib/client";
import type { FileEntry, FileKind } from "@/lib/types";
import { Icon } from "@/components/Icon";

function kindIconNode(kind: FileKind, size = 14) {
  if (kind === "pdf" || kind === "docx") return <Icon name="file" size={size} />;
  if (kind === "image") return <Icon name="image" size={size} />;
  if (kind === "xlsx") return <Icon name="grid" size={size} />;
  return <Icon name="file" size={size} />;
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} Ko`;
  return `${(n / 1024 / 1024).toFixed(1)} Mo`;
}

export function DossierFilesList({
  dossierId,
  selectedFile,
  onSelect,
  onCollapse,
}: {
  dossierId: string;
  selectedFile: FileEntry | null;
  onSelect: (f: FileEntry) => void;
  onCollapse?: () => void;
}) {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    listDossierFiles(dossierId)
      .then((list) => {
        setFiles(list);
        const firstPdf = list.find((f) => f.kind === "pdf") ?? list[0];
        if (firstPdf && (!selectedFile || !list.find((f) => f.name === selectedFile.name))) {
          onSelect(firstPdf);
        }
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dossierId]);

  return (
    <aside
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        overflow: "hidden",
        background: "var(--bg-panel)",
      }}
    >
      <div
        style={{
          padding: "10px 12px",
          borderBottom: "1px solid var(--border-soft)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          flexShrink: 0,
        }}
      >
        <div
          style={{
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "var(--text-muted)",
            fontWeight: 600,
          }}
        >
          Fichiers · {files.length}
        </div>
        {onCollapse && (
          <button
            onClick={onCollapse}
            aria-label="Réduire la liste des fichiers"
            title="Réduire la liste des fichiers"
            style={{
              width: 22,
              height: 22,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              background: "transparent",
              border: "1px solid transparent",
              borderRadius: "var(--radius-sm)",
              color: "var(--text-muted)",
              cursor: "pointer",
              transition: "background 120ms ease, color 120ms ease",
              padding: 0,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--bg-subtle)";
              e.currentTarget.style.color = "var(--text-strong)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
              e.currentTarget.style.color = "var(--text-muted)";
            }}
          >
            <Icon name="panel-left-close" size={14} />
          </button>
        )}
      </div>

      {loading && (
        <div
          style={{
            padding: 14,
            fontSize: 12,
            color: "var(--text-muted)",
          }}
        >
          Chargement…
        </div>
      )}

      <ul
        style={{
          listStyle: "none",
          margin: 0,
          padding: "6px 0",
          flex: 1,
          overflowY: "auto",
        }}
      >
        {files.map((f) => {
          const active = selectedFile?.name === f.name;
          return (
            <li key={f.name}>
              <FileButton
                file={f}
                active={active}
                onSelect={() => onSelect(f)}
              />
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

function FileButton({
  file,
  active,
  onSelect,
}: {
  file: FileEntry;
  active: boolean;
  onSelect: () => void;
}) {
  const [hover, setHover] = useState(false);
  const bg = active
    ? "var(--bg-subtle)"
    : hover
    ? "color-mix(in srgb, var(--bg-subtle) 60%, transparent)"
    : "transparent";
  const borderColor = active
    ? "color-mix(in srgb, var(--accent) 50%, var(--border))"
    : "transparent";
  return (
    <button
      onClick={onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: "calc(100% - 12px)",
        margin: "2px 6px",
        padding: "8px 10px",
        textAlign: "left",
        background: bg,
        border: `1px solid ${borderColor}`,
        borderRadius: 10,
        color: "var(--text)",
        cursor: "pointer",
        transition: "background 120ms ease, border-color 120ms ease",
        display: "flex",
        flexDirection: "column",
        gap: 3,
      }}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          fontSize: 12,
          fontWeight: 500,
          color: "var(--text-strong)",
          minWidth: 0,
        }}
      >
        <span style={{ flexShrink: 0, color: "var(--text-muted)" }}>
          {kindIconNode(file.kind, 14)}
        </span>
        <span
          style={{
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            flex: 1,
            minWidth: 0,
          }}
          title={file.name}
        >
          {file.name}
        </span>
      </span>
      <span
        style={{
          fontSize: 10.5,
          color: "var(--text-muted)",
          marginLeft: 22,
        }}
      >
        {formatSize(file.size)} · {file.kind}
      </span>
    </button>
  );
}
