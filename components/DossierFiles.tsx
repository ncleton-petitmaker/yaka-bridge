"use client";
import { useEffect, useState } from "react";
import { listDossierFiles, fileUrl } from "@/lib/client";
import type { FileEntry, FileKind } from "@/lib/types";
import { Icon } from "@/components/Icon";

const KIND_EMOJI: Record<string, string> = {
  pdf: "📄",
  xlsx: "📊",
  docx: "📝",
  image: "🖼",
  other: "📎",
};

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

export function DossierFiles({ dossierId }: { dossierId: string }) {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [selected, setSelected] = useState<FileEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    setLoading(true);
    setSelected(null);
    listDossierFiles(dossierId)
      .then((list) => {
        setFiles(list);
        const firstPdf = list.find((f) => f.kind === "pdf");
        if (firstPdf) setSelected(firstPdf);
      })
      .finally(() => setLoading(false));
  }, [dossierId]);

  return (
    <div style={{ display: "flex", height: "100%", background: "var(--bg)" }}>
      {collapsed ? (
        <button
          onClick={() => setCollapsed(false)}
          aria-label="Afficher la liste des fichiers"
          title="Afficher la liste des fichiers"
          style={{
            width: 32,
            flexShrink: 0,
            borderRight: "1px solid var(--border)",
            background: "var(--bg-panel)",
            color: "var(--text-muted)",
            cursor: "pointer",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "center",
            padding: "10px 0",
            border: "none",
            transition: "background 120ms ease, color 120ms ease",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--bg-subtle)";
            e.currentTarget.style.color = "var(--text-strong)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "var(--bg-panel)";
            e.currentTarget.style.color = "var(--text-muted)";
          }}
        >
          <Icon name="panel-left-open" size={16} />
        </button>
      ) : (
      <aside
        style={{
          width: 240,
          flexShrink: 0,
          borderRight: "1px solid var(--border)",
          overflowY: "auto",
          background: "var(--bg-panel)",
        }}
      >
        <div
          style={{
            padding: "12px 14px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
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
          <button
            onClick={() => setCollapsed(true)}
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
        </div>

        {loading && (
          <div
            style={{
              padding: 16,
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
          }}
        >
          {files.map((f) => {
            const active = selected?.name === f.name;
            return (
              <li key={f.name}>
                <FileButton
                  file={f}
                  active={active}
                  onSelect={() => setSelected(f)}
                />
              </li>
            );
          })}
        </ul>
      </aside>
      )}

      <div
        style={{
          flex: 1,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          background: "var(--bg)",
        }}
      >
        {!selected ? (
          <div
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--text-muted)",
              fontSize: 13,
            }}
          >
            Sélectionnez un fichier à gauche.
          </div>
        ) : selected.kind === "pdf" ? (
          <div
            style={{
              flex: 1,
              padding: 12,
              background: "var(--bg-subtle)",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <iframe
              key={selected.name}
              src={fileUrl(dossierId, selected.name)}
              title={selected.name}
              style={{
                flex: 1,
                border: "none",
                borderRadius: "var(--radius)",
                background: "var(--bg-panel)",
                boxShadow: "var(--shadow-sm)",
              }}
            />
          </div>
        ) : selected.kind === "image" ? (
          <div
            style={{
              flex: 1,
              overflowY: "auto",
              padding: 24,
              background: "var(--bg-subtle)",
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={fileUrl(dossierId, selected.name)}
              alt={selected.name}
              style={{
                maxWidth: "100%",
                margin: "0 auto",
                display: "block",
                borderRadius: "var(--radius)",
                boxShadow: "var(--shadow-sm)",
              }}
            />
          </div>
        ) : (
          <div
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 24,
              background: "var(--bg-subtle)",
            }}
          >
            <div
              className="pane"
              style={{
                padding: 32,
                borderRadius: "var(--radius-lg)",
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                boxShadow: "var(--shadow-sm)",
                textAlign: "center",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 14,
                maxWidth: 380,
              }}
            >
              <div style={{ fontSize: 48, lineHeight: 1 }}>
                {KIND_EMOJI[selected.kind] ?? "📎"}
              </div>
              <div>
                <div
                  style={{
                    fontWeight: 600,
                    fontSize: 14,
                    color: "var(--text-strong)",
                    wordBreak: "break-all",
                  }}
                >
                  {selected.name}
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--text-muted)",
                    marginTop: 4,
                  }}
                >
                  {formatSize(selected.size)} · {selected.kind.toUpperCase()}
                </div>
              </div>
              <FileOpenButton file={selected} dossierId={dossierId} />
              <div
                style={{
                  fontSize: 12,
                  color: "var(--text-muted)",
                  maxWidth: 300,
                  lineHeight: 1.5,
                }}
              >
                Les fichiers Excel et Word ne sont pas prévisualisables dans le
                navigateur. Ouvrez-les dans Excel/Numbers ou Word/Pages après
                téléchargement.
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
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

  const background = active
    ? "var(--bg-subtle)"
    : hover
    ? "color-mix(in srgb, var(--bg-subtle) 65%, transparent)"
    : "transparent";
  const borderColor = active
    ? "color-mix(in srgb, var(--accent) 50%, var(--border))"
    : "transparent";

  return (
    <button
      onClick={onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="settings-nav-item"
      style={{
        width: "calc(100% - 16px)",
        textAlign: "left",
        padding: "10px 12px",
        border: `1px solid ${borderColor}`,
        borderRadius: 10,
        margin: "2px 8px",
        cursor: "pointer",
        transition: "background 120ms, border-color 120ms",
        display: "flex",
        flexDirection: "column",
        gap: 2,
        background,
        color: "var(--text)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          minWidth: 0,
        }}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            color: "var(--text-muted)",
            flexShrink: 0,
          }}
        >
          {kindIconNode(file.kind, 14)}
        </span>
        <span
          title={file.name}
          style={{
            fontSize: 12,
            color: "var(--text)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
            minWidth: 0,
          }}
        >
          {file.name}
        </span>
      </div>
      <div
        style={{
          fontSize: 10,
          color: "var(--text-muted)",
          marginLeft: 20,
        }}
      >
        {formatSize(file.size)} · {file.kind}
      </div>
    </button>
  );
}

function FileOpenButton({
  file,
  dossierId,
}: {
  file: FileEntry;
  dossierId: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const electron = (window as unknown as {
    oifEval?: {
      openFile?: (p: string) => Promise<{ ok: boolean; error?: string }>;
      revealFile?: (p: string) => Promise<{ ok: boolean; error?: string }>;
    };
  }).oifEval;
  const canOpen = Boolean(electron?.openFile && file.absPath);

  async function openIt() {
    if (!file.absPath || !electron?.openFile) return;
    setBusy(true);
    setError(null);
    try {
      const r = await electron.openFile(file.absPath);
      if (!r.ok) setError(r.error ?? "ouverture impossible");
    } finally {
      setBusy(false);
    }
  }

  if (!canOpen) {
    return (
      <a
        className="primary"
        download={file.name}
        href={fileUrl(dossierId, file.name)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          textDecoration: "none",
        }}
      >
        <Icon name="download" size={14} />
        Télécharger
      </a>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-start" }}>
      <button
        onClick={openIt}
        disabled={busy}
        className="primary"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          cursor: busy ? "not-allowed" : "pointer",
        }}
      >
        <Icon name="external-link" size={14} />
        {busy ? "Ouverture..." : "Ouvrir le fichier"}
      </button>
      {error && (
        <span style={{ fontSize: 11, color: "var(--red)" }}>{error}</span>
      )}
    </div>
  );
}
