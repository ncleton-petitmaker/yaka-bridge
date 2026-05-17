"use client";
import { useEffect, useState } from "react";
import { fileUrl } from "@/lib/client";
import type { FileEntry } from "@/lib/types";
import { Icon } from "@/components/Icon";

const KIND_EMOJI: Record<string, string> = {
  pdf: "📄",
  xlsx: "📊",
  docx: "📝",
  image: "🖼",
  other: "📎",
};

function formatSize(n: number): string {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} Ko`;
  return `${(n / 1024 / 1024).toFixed(1)} Mo`;
}

export function DossierFileViewer({
  dossierId,
  file,
  initialPage,
  initialSearch,
  initialQuote,
}: {
  dossierId: string;
  file: FileEntry | null;
  /** Page initiale du PDF à afficher (1-based). Ignoré si pas PDF. */
  initialPage?: number;
  /** Terme à pré-rechercher dans le PDF (ex: "Q1", "Q23"). Ignoré si pas PDF. */
  initialSearch?: string;
  /** Citation exacte du passage à surligner (PDF.js highlightAll). */
  initialQuote?: string;
}) {
  if (!file) {
    return (
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--text-muted)",
          fontSize: 13,
          background: "var(--bg)",
        }}
      >
        Sélectionnez un fichier dans la liste à gauche.
      </div>
    );
  }

  if (file.kind === "pdf") {
    return (
      <PdfPane
        dossierId={dossierId}
        file={file}
        initialPage={initialPage}
        initialSearch={initialSearch}
        initialQuote={initialQuote}
      />
    );
  }

  if (file.kind === "image") {
    return <ImagePane dossierId={dossierId} file={file} />;
  }

  // xlsx, docx, other
  return (
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
          {KIND_EMOJI[file.kind] ?? "📎"}
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
            {file.name}
          </div>
          <div
            style={{
              fontSize: 11,
              color: "var(--text-muted)",
              marginTop: 4,
            }}
          >
            {formatSize(file.size)} · {file.kind.toUpperCase()}
          </div>
        </div>
        <FileActions file={file} dossierId={dossierId} />
        <div
          style={{
            fontSize: 12,
            color: "var(--text-muted)",
            maxWidth: 300,
            lineHeight: 1.5,
          }}
        >
          Les fichiers Excel et Word ne sont pas prévisualisables ici. Cliquez
          sur <strong>Ouvrir le fichier</strong> pour le lancer dans
          Excel/Numbers ou Word/Pages.
        </div>
      </div>
    </div>
  );
}

/**
 * Affiche une image avec overlay de chargement (idem PDF, pour NAS lent).
 */
function ImagePane({
  dossierId,
  file,
}: {
  dossierId: string;
  file: FileEntry;
}) {
  const [loaded, setLoaded] = useState(false);
  const key = `${dossierId}/${file.name}`;
  useEffect(() => {
    setLoaded(false);
  }, [key]);
  return (
    <div
      style={{
        flex: 1,
        overflowY: "auto",
        padding: 24,
        background: "var(--bg-subtle)",
        position: "relative",
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        key={key}
        src={fileUrl(dossierId, file.name)}
        alt={file.name}
        onLoad={() => setLoaded(true)}
        style={{
          maxWidth: "100%",
          margin: "0 auto",
          display: "block",
          borderRadius: "var(--radius)",
          boxShadow: "var(--shadow-sm)",
          opacity: loaded ? 1 : 0,
          transition: "opacity 0.2s",
        }}
      />
      {!loaded && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
            pointerEvents: "none",
          }}
        >
          <div className="fae-file-spinner" />
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
            Chargement de {file.name}... ({formatSize(file.size)})
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Affiche un PDF dans une iframe avec un overlay de chargement.
 * Sans cet overlay, les PDFs sur NAS / serveur distant produisent un grand
 * écran blanc le temps que le navigateur télécharge le fichier (peut être
 * plusieurs secondes pour 5-10 Mo).
 */
function PdfPane({
  dossierId,
  file,
  initialPage,
  initialSearch,
  initialQuote,
}: {
  dossierId: string;
  file: FileEntry;
  initialPage?: number;
  /** Terme à pré-rechercher (ex: "Q1"). Fallback si pas de quote. */
  initialSearch?: string;
  /** Citation exacte à surligner. PDF.js highlightAll + phrase=true. */
  initialQuote?: string;
}) {
  const [loaded, setLoaded] = useState(false);
  const [quoteBannerDismissed, setQuoteBannerDismissed] = useState(false);

  // On utilise le viewer PDF.js embarqué (servi par le daemon sous /pdfjs/)
  // au lieu du PDFium natif Chromium. PDF.js supporte :
  // - #search=<phrase>&phrase=true → highlightAll automatique avec matchDiacritics
  // - #page=N pour la page
  // - #pagemode=none pour cacher la sidebar des miniatures
  // Stratégie : si on a un quote, l'utiliser comme search (highlight visuel).
  //            sinon fallback sur initialSearch (la section type "Q23").
  function normalizeForSearch(t: string): string {
    return t.replace(/\s+/g, " ").trim();
  }
  const searchTerm = initialQuote
    ? normalizeForSearch(initialQuote).slice(0, 80)
    : initialSearch;
  // Important : on construit une URL absolue (avec origin) pour le param file=.
  // PDF.js viewer.mjs fait `new URL(file).href` en premier. Si l'URL est relative,
  // il throw et tombe dans un catch qui ré-encode `%` en `%25`, ce qui double-encode
  // les caractères non-ASCII (accents français → `Pr%C3%A9sentation` → `Pr%25C3%25A9sentation` → 404).
  // En passant une URL absolue, `new URL` réussit et l'URL est préservée telle quelle.
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  // Si on a un quote, on demande au daemon le PDF avec annotations /Highlight
  // injectées sur les passages cités (cf. server/pdf-highlight.ts). Sinon on
  // sert le PDF original.
  const fileBaseURL = `${origin}${fileUrl(dossierId, file.name)}`;
  const fileURL = initialQuote
    ? `${fileBaseURL}?highlight=${encodeURIComponent(initialQuote)}`
    : fileBaseURL;
  const hashParts: string[] = [];
  if (initialPage && initialPage > 1) hashParts.push(`page=${initialPage}`);
  if (searchTerm) {
    hashParts.push(`search=${encodeURIComponent(searchTerm)}`);
    hashParts.push("phrase=true");
  }
  hashParts.push("pagemode=none");
  const pdfSrc = `/pdfjs/web/viewer.html?file=${encodeURIComponent(fileURL)}#${hashParts.join("&")}`;
  const key = `${dossierId}/${file.name}#p=${initialPage ?? 1}#s=${searchTerm ?? ""}`;

  // Reset l'état loaded + banner quand le fichier/source change
  useEffect(() => {
    setLoaded(false);
    setQuoteBannerDismissed(false);
  }, [key]);

  const showQuoteBanner = Boolean(initialQuote) && !quoteBannerDismissed;

  return (
    <div
      style={{
        flex: 1,
        padding: 12,
        background: "var(--bg-subtle)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        minHeight: 0,
        position: "relative",
      }}
    >
      {showQuoteBanner && (
        <div
          style={{
            padding: "10px 14px",
            background: "rgba(255, 235, 59, 0.22)",
            borderLeft: "3px solid #fbc02d",
            borderRadius: "var(--radius-sm)",
            fontSize: 12,
            color: "var(--text-strong)",
            display: "flex",
            alignItems: "flex-start",
            gap: 10,
            boxShadow: "var(--shadow-sm)",
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 10,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                color: "var(--text-muted)",
                marginBottom: 4,
              }}
            >
              Source citée
              {initialPage ? ` · p.${initialPage}` : ""}
              {initialSearch ? ` · ${initialSearch}` : ""}
            </div>
            <div style={{ fontStyle: "italic", lineHeight: 1.45 }}>
              « {initialQuote} »
            </div>
            {searchTerm && searchTerm !== initialQuote && (
              <div
                style={{
                  marginTop: 4,
                  fontSize: 10,
                  color: "var(--text-muted)",
                  fontFamily: "var(--mono)",
                }}
                title="Terme tronqué à 80 caractères pour la recherche PDF"
              >
                Recherche : « {searchTerm}… »
              </div>
            )}
          </div>
          <button
            onClick={() => setQuoteBannerDismissed(true)}
            aria-label="Masquer la citation"
            title="Masquer la citation"
            style={{
              background: "transparent",
              border: "none",
              padding: 4,
              cursor: "pointer",
              color: "var(--text-muted)",
              fontSize: 16,
              lineHeight: 1,
              flexShrink: 0,
            }}
          >
            ×
          </button>
        </div>
      )}
      <div style={{ flex: 1, position: "relative", minHeight: 0 }}>
      <iframe
        key={key}
        src={pdfSrc}
        title={file.name}
        onLoad={() => setLoaded(true)}
        style={{
          width: "100%",
          height: "100%",
          border: "none",
          borderRadius: "var(--radius)",
          background: "var(--bg-panel)",
          boxShadow: "var(--shadow-sm)",
          opacity: loaded ? 1 : 0,
          transition: "opacity 0.2s",
        }}
      />
      {!loaded && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
            background: "var(--bg-panel)",
            borderRadius: "var(--radius)",
            boxShadow: "var(--shadow-sm)",
            pointerEvents: "none",
          }}
        >
          <div className="fae-file-spinner" />
          <div
            style={{
              fontSize: 12,
              color: "var(--text-muted)",
              textAlign: "center",
            }}
          >
            Chargement de {file.name}...
            <br />
            <span style={{ fontSize: 11 }}>
              {formatSize(file.size)} depuis le serveur partagé
            </span>
          </div>
        </div>
      )}
      </div>
    </div>
  );
}

function FileActions({
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
  async function revealIt() {
    if (!file.absPath || !electron?.revealFile) return;
    try {
      await electron.revealFile(file.absPath);
    } catch {
      // pas bloquant
    }
  }

  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      {canOpen ? (
        <>
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
          <button
            onClick={revealIt}
            className="ghost"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              cursor: "pointer",
              fontSize: 12,
            }}
            title="Afficher dans le Finder"
          >
            <Icon name="folder" size={14} />
            Afficher dans le Finder
          </button>
        </>
      ) : (
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
      )}
      {error && (
        <span style={{ fontSize: 11, color: "var(--red)" }}>{error}</span>
      )}
    </div>
  );
}
