"use client";
import { useEffect, useRef, useState } from "react";
import type { AgentEvent } from "@/lib/types";

const STATUS_META: Record<string, { label: string; color: string; pulse: boolean }> = {
  idle: { label: "En attente", color: "var(--text-faint)", pulse: false },
  running: { label: "Évaluation en cours", color: "var(--accent)", pulse: true },
  succeeded: { label: "Évaluation terminée", color: "var(--green)", pulse: false },
  failed: { label: "Échec", color: "var(--red)", pulse: false },
};

const TOOL_LABEL: Record<string, string> = {
  Glob: "Recherche de fichiers",
  Read: "Lecture",
  Write: "Écriture",
  Edit: "Modification",
  Bash: "Commande système",
  Grep: "Recherche dans le contenu",
  Skill: "Activation d'un skill",
  Task: "Sous-tâche",
  WebFetch: "Récupération web",
  WebSearch: "Recherche web",
  TodoWrite: "Mise à jour de la liste",
  AskUserQuestion: "Question au membre de l'équipe",
  "(reply)": "Résultat outil",
};

function toolLabel(name: string | undefined): string {
  if (!name) return "Outil";
  return TOOL_LABEL[name] ?? name;
}

function summarizeToolInputForLabel(toolName: string | undefined, input: unknown): string {
  if (typeof input !== "object" || !input) return "";
  const obj = input as Record<string, unknown>;
  if (toolName === "Read" && obj.file_path) {
    const path = String(obj.file_path);
    return path.split("/").slice(-1)[0]; // juste le filename
  }
  if (toolName === "Write" && obj.file_path) {
    return String(obj.file_path).split("/").slice(-1)[0];
  }
  if (toolName === "Edit" && obj.file_path) {
    return String(obj.file_path).split("/").slice(-1)[0];
  }
  if ((toolName === "Glob" || toolName === "Grep") && obj.pattern) {
    return String(obj.pattern);
  }
  if (toolName === "Bash" && obj.command) {
    const cmd = String(obj.command);
    return cmd.length > 80 ? cmd.slice(0, 80) + "…" : cmd;
  }
  if (toolName === "Skill" && obj.name) {
    return String(obj.name);
  }
  if (obj.file_path) return String(obj.file_path);
  if (obj.pattern) return String(obj.pattern);
  if (obj.path) return String(obj.path);
  return "";
}

export function StreamingPanel({
  events,
  status,
}: {
  events: AgentEvent[];
  status: "idle" | "running" | "succeeded" | "failed";
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [events.length]);

  const blocks = aggregateEvents(events);
  const meta = STATUS_META[status];

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "var(--bg-panel)",
      }}
    >
      <div
        style={{
          padding: "10px 14px",
          borderBottom: "1px solid var(--border-soft)",
          display: "flex",
          alignItems: "center",
          gap: 10,
          background: "var(--bg-panel)",
        }}
      >
        <span
          style={{
            display: "inline-block",
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: meta.color,
            animation: meta.pulse ? "pulse 1.2s ease-in-out infinite" : "none",
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontSize: 12,
            fontWeight: 500,
            color: "var(--text-strong)",
          }}
        >
          {meta.label}
        </span>
        <span
          style={{
            fontSize: 11,
            color: "var(--text-muted)",
            marginLeft: "auto",
            fontFamily: "var(--mono)",
          }}
        >
          {events.length} events
        </span>
        <CopyLogsButton events={events} status={status} />
      </div>
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "12px 14px 18px 14px",
          fontSize: 12.5,
          lineHeight: 1.55,
          fontFamily: "var(--mono)",
          color: "var(--text)",
        }}
      >
        {blocks.length === 0 && status === "idle" && (
          <div
            style={{
              color: "var(--text-muted)",
              fontFamily: "var(--sans)",
              fontSize: 13,
              lineHeight: 1.6,
            }}
          >
            Cliquez sur
            <strong style={{ color: "var(--text-strong)", margin: "0 4px" }}>
              Évaluer
            </strong>
            en haut à droite pour démarrer le travail de Claude. Vous verrez ici en
            temps réel les fichiers qu&apos;il lit, les outils qu&apos;il utilise et
            les conclusions qu&apos;il tire.
          </div>
        )}
        {blocks.length === 0 && status === "running" && (
          <div
            style={{
              color: "var(--text-muted)",
              fontFamily: "var(--sans)",
              fontSize: 13,
              lineHeight: 1.6,
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: "var(--accent)",
                animation: "pulse 1.2s ease-in-out infinite",
                flexShrink: 0,
              }}
            />
            <span>
              Démarrage de Claude Code… L&apos;évaluation prend habituellement entre
              5 et 8 minutes selon la taille du dossier. Les premières lignes
              apparaîtront dans 20-40 secondes.
            </span>
          </div>
        )}
        {blocks.length === 0 && status === "failed" && (
          <div
            style={{
              padding: "10px 12px",
              borderRadius: "var(--radius-sm)",
              background: "var(--red-bg)",
              border: "1px solid var(--red-border)",
              color: "var(--red)",
              fontSize: 12.5,
              fontFamily: "var(--sans)",
            }}
          >
            ✗ L&apos;évaluation a échoué avant le moindre événement. Vérifiez la
            connexion à Claude Code dans <strong>Paramètres</strong>.
          </div>
        )}
        {blocks.map((b, i) => (
          <BlockView key={i} block={b} />
        ))}
        {blocks.length > 0 && status === "running" && (
          <div
            style={{
              marginTop: 8,
              padding: "10px 12px",
              borderRadius: "var(--radius-sm)",
              background: "var(--bg-subtle)",
              border: "1px dashed var(--border-soft)",
              display: "flex",
              alignItems: "center",
              gap: 10,
              fontFamily: "var(--sans)",
              fontSize: 12.5,
              color: "var(--text-muted)",
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "var(--accent)",
                animation: "pulse 1.2s ease-in-out infinite",
                flexShrink: 0,
              }}
            />
            <span>
              Évaluation en cours… Claude finalise l&apos;écriture du JSON.
              Tu peux naviguer librement - ne ferme pas l&apos;app.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate5m: number;
  cacheCreate1h: number;
  model: string;
}

interface AggregatedBlock {
  kind: "text" | "thinking" | "tool" | "status" | "result" | "error";
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  status?: string;
  result?: { success: boolean; output?: string; durationMs?: number; costUsd?: number };
  usageTotals?: UsageTotals;
  error?: string;
}

function computeUsageTotals(events: AgentEvent[]): UsageTotals {
  type Snap = { i: number; o: number; cr: number; c5m: number; c1h: number };
  const seen = new Map<string, Snap>();
  let input = 0, output = 0, cr = 0, c5m = 0, c1h = 0, model = "";
  for (const ev of events) {
    if (ev.kind !== "usage" || !ev.usage) continue;
    const u = ev.usage;
    const mid = u.message_id;
    if (mid) {
      const prev = seen.get(mid);
      if (prev) { input -= prev.i; output -= prev.o; cr -= prev.cr; c5m -= prev.c5m; c1h -= prev.c1h; }
      seen.set(mid, { i: u.input_tokens, o: u.output_tokens, cr: u.cache_read, c5m: u.cache_create_5m, c1h: u.cache_create_1h });
    }
    input += u.input_tokens; output += u.output_tokens; cr += u.cache_read; c5m += u.cache_create_5m; c1h += u.cache_create_1h;
    if (u.model) model = u.model;
  }
  return { input, output, cacheRead: cr, cacheCreate5m: c5m, cacheCreate1h: c1h, model };
}

function aggregateEvents(events: AgentEvent[]): AggregatedBlock[] {
  const blocks: AggregatedBlock[] = [];
  let textBuf = "";
  let thinkBuf = "";

  const flushText = () => {
    if (textBuf) {
      blocks.push({ kind: "text", text: textBuf });
      textBuf = "";
    }
  };
  const flushThink = () => {
    if (thinkBuf) {
      blocks.push({ kind: "thinking", text: thinkBuf });
      thinkBuf = "";
    }
  };

  for (const ev of events) {
    if (ev.kind === "text_delta") {
      flushThink();
      textBuf += ev.text ?? "";
    } else if (ev.kind === "thinking_delta") {
      flushText();
      thinkBuf += ev.text ?? "";
    } else if (ev.kind === "tool_use_start" || ev.kind === "tool_use_end") {
      flushText();
      flushThink();
      if (ev.kind === "tool_use_end") {
        blocks.push({ kind: "tool", toolName: ev.tool?.name, toolInput: ev.tool?.input });
      }
    } else if (ev.kind === "status") {
      flushText();
      flushThink();
      blocks.push({ kind: "status", status: ev.status });
    } else if (ev.kind === "result") {
      flushText();
      flushThink();
      blocks.push({ kind: "result", result: ev.result, usageTotals: computeUsageTotals(events) });
    } else if (ev.kind === "error" || ev.kind === "stderr") {
      flushText();
      flushThink();
      blocks.push({ kind: "error", error: ev.error || ev.text });
    }
  }
  flushText();
  flushThink();
  return blocks;
}

function CostRow({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", color: "var(--text-muted)", fontSize: 11 }}>
      <span>{label}</span>
      <span style={{ fontFamily: "var(--mono)", color: "var(--text)" }}>{value} <span style={{ color: "var(--text-faint)" }}>{unit}</span></span>
    </div>
  );
}

function renderInlineMarkdown(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  // Matches **bold**, *italic*, `code` — in that priority order
  const regex = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`)/g;
  let lastIndex = 0;
  let key = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    const token = match[0];
    if (token.startsWith("**")) {
      parts.push(<strong key={key++} style={{ fontWeight: 700 }}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("*")) {
      parts.push(<em key={key++}>{token.slice(1, -1)}</em>);
    } else {
      parts.push(
        <code key={key++} style={{ fontFamily: "var(--mono)", fontSize: "0.88em", background: "rgba(0,0,0,0.06)", padding: "1px 4px", borderRadius: 3 }}>
          {token.slice(1, -1)}
        </code>
      );
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return <>{parts}</>;
}

function BlockView({ block }: { block: AggregatedBlock }) {
  if (block.kind === "text") {
    return (
      <div
        style={{
          whiteSpace: "pre-wrap",
          marginBottom: 12,
          color: "var(--text)",
          fontFamily: "var(--sans)",
          fontSize: 13,
          lineHeight: 1.6,
        }}
      >
        {renderInlineMarkdown(block.text ?? "")}
      </div>
    );
  }
  if (block.kind === "thinking") {
    return (
      <details
        style={{
          marginBottom: 10,
          color: "var(--purple)",
        }}
      >
        <summary
          style={{
            cursor: "pointer",
            fontSize: 11,
            color: "var(--purple)",
            fontFamily: "var(--sans)",
            fontWeight: 500,
          }}
        >
          Réflexion…
        </summary>
        <div
          style={{
            whiteSpace: "pre-wrap",
            marginTop: 6,
            fontStyle: "italic",
            color: "var(--text-muted)",
            fontSize: 12,
            fontFamily: "var(--sans)",
            paddingLeft: 12,
            borderLeft: "2px solid var(--purple-border)",
          }}
        >
          {renderInlineMarkdown(block.text ?? "")}
        </div>
      </details>
    );
  }
  if (block.kind === "tool") {
    const label = toolLabel(block.toolName);
    const detail = summarizeToolInputForLabel(block.toolName, block.toolInput);
    return (
      <div
        style={{
          marginBottom: 8,
          padding: "8px 12px",
          borderRadius: "var(--radius-sm)",
          background: "var(--blue-bg)",
          border: "1px solid var(--blue-border)",
          maxWidth: "100%",
          display: "flex",
          flexDirection: "column",
          gap: 3,
        }}
      >
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: "var(--blue)",
            display: "flex",
            alignItems: "baseline",
            gap: 6,
            fontFamily: "var(--sans)",
          }}
        >
          <span>›</span>
          <span>{label}</span>
        </div>
        {detail && (
          <div
            style={{
              fontSize: 11,
              fontFamily: "var(--mono)",
              color: "var(--text-muted)",
              wordBreak: "break-all",
              paddingLeft: 14,
            }}
          >
            {detail}
          </div>
        )}
      </div>
    );
  }
  if (block.kind === "status") {
    return (
      <div
        style={{
          marginBottom: 6,
          fontSize: 11,
          color: "var(--text-faint)",
          fontFamily: "var(--sans)",
          textAlign: "center",
        }}
      >
        — {block.status} —
      </div>
    );
  }
  if (block.kind === "result") {
    const dur = block.result?.durationMs ?? 0;
    const durMin = Math.floor(dur / 60000);
    const durSec = Math.round((dur % 60000) / 1000);
    const durLabel = durMin > 0 ? `${durMin} min ${durSec} s` : `${durSec} s`;
    const cost = block.result?.costUsd ?? 0;
    const t = block.usageTotals;
    const totalTok = (t?.input ?? 0) + (t?.output ?? 0) + (t?.cacheRead ?? 0) + (t?.cacheCreate5m ?? 0) + (t?.cacheCreate1h ?? 0);
    const fmt = (n: number) => n.toLocaleString("fr-FR");
    return (
      <div
        style={{
          marginTop: 12,
          borderRadius: "var(--radius-sm)",
          background: "var(--green-bg)",
          border: "1px solid var(--green-border)",
          overflow: "hidden",
          fontFamily: "var(--sans)",
          fontSize: 12,
        }}
      >
        <div style={{ padding: "8px 12px", display: "flex", alignItems: "center", gap: 8, borderBottom: t ? "1px solid var(--green-border)" : "none" }}>
          <span style={{ color: "var(--green)", fontWeight: 600 }}>✓ Terminé</span>
          <span style={{ color: "var(--text-muted)" }}>{durLabel}</span>
          {cost > 0 && (
            <span style={{ marginLeft: "auto", fontWeight: 700, color: "var(--green)", fontFamily: "var(--mono)", fontSize: 13 }}>
              ${cost.toFixed(4)}
            </span>
          )}
        </div>
        {t && totalTok > 0 && (
          <div style={{ padding: "8px 12px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 16px" }}>
            {t.cacheCreate1h > 0 && (
              <CostRow label="Cache PDF (1h)" value={fmt(t.cacheCreate1h)} unit="tok" />
            )}
            {t.cacheCreate5m > 0 && (
              <CostRow label="Cache (5m)" value={fmt(t.cacheCreate5m)} unit="tok" />
            )}
            {t.cacheRead > 0 && (
              <CostRow label="Cache lu" value={fmt(t.cacheRead)} unit="tok" />
            )}
            {t.output > 0 && (
              <CostRow label="Génération" value={fmt(t.output)} unit="tok" />
            )}
            {t.input > 0 && (
              <CostRow label="Input direct" value={fmt(t.input)} unit="tok" />
            )}
            {t.model && (
              <div style={{ gridColumn: "1 / -1", marginTop: 2, color: "var(--text-faint)", fontSize: 11, fontFamily: "var(--mono)" }}>
                {t.model} - estimation Claude CLI
              </div>
            )}
          </div>
        )}
      </div>
    );
  }
  if (block.kind === "error") {
    return (
      <div
        style={{
          marginBottom: 8,
          padding: "8px 12px",
          borderRadius: "var(--radius-sm)",
          background: "var(--red-bg)",
          border: "1px solid var(--red-border)",
          color: "var(--red)",
          fontSize: 12,
          fontFamily: "var(--sans)",
        }}
      >
        {block.error}
      </div>
    );
  }
  return null;
}

/**
 * Bouton discret "copier les logs" pour le debug.
 * Copie dans le presse-papier un dump JSON complet :
 *  - status final
 *  - tous les events bruts
 *  - timestamp
 *  - user agent (utile pour distinguer Mac/Windows)
 */
function CopyLogsButton({
  events,
  status,
}: {
  events: AgentEvent[];
  status: "idle" | "running" | "succeeded" | "failed";
}) {
  const [copied, setCopied] = useState(false);
  async function copyAll() {
    const payload = {
      timestamp: new Date().toISOString(),
      status,
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "?",
      url: typeof window !== "undefined" ? window.location.href : "?",
      eventsCount: events.length,
      events,
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // pas bloquant
    }
  }
  if (events.length === 0) return null;
  return (
    <button
      type="button"
      onClick={copyAll}
      title="Copier les logs (debug)"
      style={{
        marginLeft: 8,
        fontSize: 10,
        padding: "2px 8px",
        background: copied ? "var(--green-bg)" : "transparent",
        border: "1px solid var(--border-soft)",
        borderRadius: "var(--radius-sm)",
        color: copied ? "var(--green)" : "var(--text-muted)",
        cursor: "pointer",
        fontFamily: "var(--mono)",
      }}
    >
      {copied ? "✓ copié" : "copier logs"}
    </button>
  );
}

