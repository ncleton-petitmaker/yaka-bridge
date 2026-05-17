"use client";
import { useEffect, useRef, useState } from "react";
import { startRun, streamRun } from "@/lib/client";
import type { AgentEvent } from "@/lib/types";
import { Mark } from "@/components/Mark";
import { Icon } from "@/components/Icon";

function renderMd(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const pattern = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`)/g;
  let lastIdx = 0;
  let key = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIdx) parts.push(text.slice(lastIdx, match.index));
    const raw = match[0];
    if (raw.startsWith("**")) {
      parts.push(<strong key={key++}>{raw.slice(2, -2)}</strong>);
    } else if (raw.startsWith("`")) {
      parts.push(<code key={key++} style={{ fontFamily: "var(--mono)", fontSize: "0.9em", background: "var(--bg-inset)", padding: "1px 4px", borderRadius: 3 }}>{raw.slice(1, -1)}</code>);
    } else {
      parts.push(<em key={key++}>{raw.slice(1, -1)}</em>);
    }
    lastIdx = match.index + raw.length;
  }
  if (lastIdx < text.length) parts.push(text.slice(lastIdx));
  return parts;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  events?: AgentEvent[];
}

interface Attachment {
  filename: string;
  originalPath: string;
  textPath: string | null;
  ext: string;
  size: number;
  warnings: string[];
}

export function ChatDrawer({
  open,
  onClose,
  user,
  initialPrompt,
  contextHint,
  slashCommand,
  title,
  dossierId,
  placeholder,
  campaignId,
  campaignLabel,
}: {
  open: boolean;
  onClose: () => void;
  user: string;
  initialPrompt?: string;
  contextHint?: string;
  slashCommand?: string;
  title?: string;
  dossierId?: string;
  placeholder?: string;
  /** Si fourni : mode régénération de campagne. Inclut le campaignId dans
   * tous les prompts pour que Claude active le skill regenerer-skills-depuis-referentiel. */
  campaignId?: string;
  campaignLabel?: string;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open && initialPrompt) {
      setInput(initialPrompt);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [open, initialPrompt]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  async function uploadFile(file: File) {
    setUploading(true);
    setUploadError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch("/api/chat/upload", { method: "POST", body: fd });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ error: r.statusText }));
        throw new Error(err.error ?? "upload échoué");
      }
      const j = (await r.json()) as {
        originalPath: string;
        textPath: string | null;
        textPreview: string | null;
        size: number;
        ext: string;
        filename: string;
        conversionWarnings: string[];
      };
      setAttachments((a) => [
        ...a,
        {
          filename: j.filename,
          originalPath: j.originalPath,
          textPath: j.textPath,
          ext: j.ext,
          size: j.size,
          warnings: j.conversionWarnings,
        },
      ]);
    } catch (e) {
      setUploadError((e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  function removeAttachment(idx: number) {
    setAttachments((a) => a.filter((_, i) => i !== idx));
  }

  async function send() {
    const trimmed = input.trim();
    if ((!trimmed && attachments.length === 0) || running) return;
    const displayText =
      trimmed +
      (attachments.length > 0
        ? `\n\n📎 ${attachments.length} fichier${attachments.length > 1 ? "s" : ""} joint${attachments.length > 1 ? "s" : ""} : ${attachments.map((a) => a.filename).join(", ")}`
        : "");
    const userMsg: Message = {
      id: `u-${Date.now()}`,
      role: "user",
      text: displayText,
    };
    const asstId = `a-${Date.now()}`;
    setMessages((m) => [...m, userMsg, { id: asstId, role: "assistant", text: "", events: [] }]);
    const sentAttachments = attachments;
    setInput("");
    setAttachments([]);
    setRunning(true);
    const history = messages
      .filter((m) => m.text)
      .map((m) => `${m.role === "user" ? "Utilisateur" : "Claude"} : ${m.text}`)
      .join("\n\n");
    // Le contexte dossier est désormais injecté côté serveur (paths absolus +
    // JSON d'évaluation inliné) via scope:{type:"dossier", id}. On garde juste
    // le contexte campagne en clair ici car il est lié au skill regen.
    const campaignContext = campaignId
      ? `Contexte : l'admin travaille sur la campagne **${campaignId}**${campaignLabel ? ` (« ${campaignLabel} »)` : ""}, qui est en statut brouillon. Toute régénération de skill (ELG, Q) doit cibler cette campagne via le skill 'regenerer-skills-depuis-referentiel'. Le path absolu de la campagne est \`data/.claude/skills/campaigns/${campaignId}/\`. Refuse poliment toute action sur une autre campagne.\n\n`
      : "";
    const attachmentsBlock = sentAttachments.length > 0
      ? "Fichiers joints disponibles via Read :\n" +
        sentAttachments
          .map(
            (a, i) =>
              `${i + 1}. ${a.filename} (${a.ext}, ${(a.size / 1024).toFixed(1)} ko)\n   - Original : ${a.originalPath}\n` +
              (a.textPath && a.textPath !== a.originalPath
                ? `   - Texte converti (utilise celui-ci pour Read) : ${a.textPath}\n`
                : "")
          )
          .join("") +
        "\n"
      : "";
    const conversationContext = history ? `Conversation précédente :\n${history}\n\nNouveau message :\n` : "";
    const fullMessage = `${campaignContext}${attachmentsBlock}${conversationContext}${trimmed || "(voir fichiers joints)"}`;
    try {
      const runId = await startRun({
        message: fullMessage,
        slashCommand,
        user,
        ...(dossierId ? { scope: { type: "dossier" as const, id: dossierId } } : {}),
      });
      await streamRun(runId, {
        onEvent: (ev) => {
          setMessages((prev) =>
            prev.map((m) => {
              if (m.id !== asstId) return m;
              const events = [...(m.events ?? []), ev];
              const text = events
                .filter((e) => e.kind === "text_delta")
                .map((e) => e.text ?? "")
                .join("");
              return { ...m, text, events };
            })
          );
        },
        onEnd: () => setRunning(false),
        onError: () => setRunning(false),
      });
    } catch (e) {
      console.error(e);
      setRunning(false);
    }
  }

  if (!open) return null;

  const lastMsg = messages[messages.length - 1];
  const placeholderText =
    placeholder ??
    (slashCommand === "/ameliorer-regle"
      ? "Décris à Claude ce qui devrait changer dans tes règles persos."
      : dossierId
      ? `Posez votre question à Claude sur le dossier ${dossierId}. Ex : « Pourquoi as-tu mis NON à ELG-3 ? », « Quels documents manquent ? »`
      : "Pose ta question ou décris ce que tu veux changer.");

  return (
    <>
      <style>{`
        @keyframes chatDrawerSlideIn {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
      `}</style>
      <div
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          bottom: 0,
          width: 420,
          background: "var(--bg-panel)",
          borderLeft: "1px solid var(--border)",
          boxShadow: "var(--shadow-lg)",
          zIndex: 50,
          display: "flex",
          flexDirection: "column",
          animation: "chatDrawerSlideIn 220ms cubic-bezier(0.21, 1.02, 0.73, 1)",
        }}
      >
        <header
          style={{
            padding: "10px 14px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Mark size={18} />
            <div style={{ fontWeight: 600, fontSize: 13, color: "var(--text-strong)" }}>
              {title ?? "Parler à Claude"}
            </div>
            <button
              onClick={onClose}
              className="ghost"
              aria-label="Fermer"
              style={{
                marginLeft: "auto",
                padding: "4px 8px",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Icon name="close" size={14} />
            </button>
          </div>
          {contextHint && (
            <div
              style={{
                fontSize: 11,
                color: "var(--text-muted)",
                lineHeight: 1.5,
              }}
            >
              {contextHint}
            </div>
          )}
        </header>

        <div
          ref={scrollRef}
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "14px 14px 8px 14px",
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          {messages.length === 0 && (
            <div
              style={{
                color: "var(--text-muted)",
                fontSize: 12,
                lineHeight: 1.5,
              }}
            >
              {placeholderText}
            </div>
          )}

          {messages.map((m) => {
            const isUser = m.role === "user";
            const isLast = m.id === lastMsg?.id;
            const isStreamingEmpty = !isUser && running && isLast && !m.text;
            const tools = (m.events ?? []).filter((e) => e.kind === "tool_use_end");
            return (
              <div
                key={m.id}
                style={
                  isUser
                    ? {
                        alignSelf: "flex-end",
                        maxWidth: "82%",
                        padding: "8px 12px",
                        background: "var(--accent-tint)",
                        border: "1px solid var(--accent-soft)",
                        borderRadius: "var(--radius)",
                        color: "var(--text-strong)",
                        fontSize: 13,
                        lineHeight: 1.5,
                        whiteSpace: "pre-wrap",
                      }
                    : {
                        alignSelf: "flex-start",
                        maxWidth: "95%",
                        padding: "8px 12px",
                        background: "var(--bg-panel)",
                        border: "1px solid var(--border)",
                        borderRadius: "var(--radius)",
                        color: "var(--text)",
                        fontSize: 13,
                        lineHeight: 1.55,
                        whiteSpace: "pre-wrap",
                        boxShadow: "var(--shadow-xs)",
                      }
                }
              >
                <div
                  style={{
                    fontSize: 10,
                    color: "var(--text-muted)",
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                    marginBottom: 4,
                  }}
                >
                  {isUser ? "Vous" : "Claude"}
                </div>
                <div>
                  {m.text ? (isUser ? m.text : renderMd(m.text)) : (isStreamingEmpty ? "…" : "")}
                </div>
                {tools.length > 0 && (
                  <details style={{ marginTop: 8 }}>
                    <summary
                      style={{
                        fontSize: 11,
                        color: "var(--text-muted)",
                        cursor: "pointer",
                      }}
                    >
                      Outils utilisés ({tools.length})
                    </summary>
                    <ul
                      style={{
                        margin: "6px 0 0 0",
                        padding: 0,
                        listStyle: "none",
                        display: "flex",
                        flexDirection: "column",
                        gap: 2,
                      }}
                    >
                      {tools.map((e, i) => (
                        <li
                          key={i}
                          style={{
                            fontSize: 11,
                            fontFamily: "var(--mono)",
                            color: "var(--text-muted)",
                          }}
                        >
                          🔧 {e.tool?.name}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            );
          })}

          {running && lastMsg?.role === "user" && (
            <div
              style={{
                fontSize: 11,
                color: "var(--text-muted)",
                padding: "4px 12px",
                display: "flex",
                alignItems: "center",
              }}
            >
              <span
                style={{
                  display: "inline-block",
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: "var(--accent)",
                  animation: "pulse 1.2s ease-in-out infinite",
                  marginRight: 6,
                }}
              />
              Claude réfléchit…
            </div>
          )}
        </div>

        <div
          style={{
            padding: "10px 12px",
            borderTop: "1px solid var(--border)",
            background: "var(--bg-panel)",
          }}
        >
          {attachments.length > 0 && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 6,
                marginBottom: 8,
              }}
            >
              {attachments.map((a, i) => (
                <span
                  key={i}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 11,
                    padding: "3px 6px 3px 8px",
                    background: "var(--accent-tint)",
                    border: "1px solid color-mix(in srgb, var(--accent) 30%, transparent)",
                    borderRadius: "var(--radius-pill)",
                    color: "var(--text-strong)",
                    maxWidth: "100%",
                    minWidth: 0,
                  }}
                  title={a.originalPath}
                >
                  <Icon name="file" size={11} />
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      maxWidth: 220,
                    }}
                  >
                    {a.filename}
                  </span>
                  <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
                    {(a.size / 1024).toFixed(1)}ko
                  </span>
                  <button
                    onClick={() => removeAttachment(i)}
                    disabled={running}
                    aria-label="Retirer"
                    style={{
                      width: 16,
                      height: 16,
                      padding: 0,
                      background: "transparent",
                      border: "none",
                      cursor: "pointer",
                      color: "var(--text-muted)",
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Icon name="close" size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}
          {uploadError && (
            <div
              style={{
                fontSize: 11,
                color: "var(--red)",
                marginBottom: 6,
                padding: "4px 8px",
                background: "var(--red-bg)",
                borderRadius: "var(--radius-sm)",
              }}
            >
              {uploadError}
            </div>
          )}
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={
              attachments.length > 0
                ? "Optionnel : décrivez ce que vous voulez faire avec le fichier joint…"
                : "Écris ici… (Cmd+Entrée pour envoyer)"
            }
            rows={3}
            disabled={running}
            style={{
              width: "100%",
              minHeight: 64,
              resize: "none",
              fontSize: 13,
              padding: "8px 10px",
              borderRadius: "var(--radius-sm)",
            }}
          />
          <input
            ref={fileInputRef}
            type="file"
            accept=".docx,.md,.txt,.pdf,.xlsx,.xls"
            disabled={uploading || running}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) uploadFile(f);
              e.target.value = "";
            }}
            style={{ display: "none" }}
          />
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginTop: 6,
              gap: 6,
            }}
          >
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading || running}
              className="ghost"
              style={{
                fontSize: 11,
                padding: "5px 10px",
                cursor: uploading || running ? "not-allowed" : "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
              }}
              title="Joindre un référentiel (.docx, .md, .txt, .pdf, .xlsx)"
            >
              <Icon name="attach" size={12} />
              {uploading ? "Upload..." : "Joindre"}
            </button>
            <span style={{ fontSize: 10, color: "var(--text-faint)", marginLeft: "auto" }}>
              Cmd/Ctrl + Entrée
            </span>
            <button
              onClick={send}
              disabled={(!input.trim() && attachments.length === 0) || running}
              className="primary"
            >
              {running ? "..." : "Envoyer"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
