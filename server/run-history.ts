/**
 * Persistance des events des runs liés à une évaluation de dossier.
 * Format : 1 event par ligne JSON dans data/evaluations/<id>.events.jsonl
 * Utilisé pour replay l'historique du travail de Claude après redémarrage.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { AgentEvent } from "./types.js";

/**
 * Extrait le dossier_id depuis un prompt d'évaluation.
 * Supporte 2 formats :
 *   1. Slash command : `/evaluer <id>` (depuis le chat / UI)
 *   2. Prompt expansé : `# Évaluation FAE 7e - dossier <id>` (depuis batch endpoint)
 */
export function extractDossierId(prompt: string): string | null {
  const slash = prompt.match(/^\s*\/evaluer(?:-eligibilite|-notation)?\s+([A-Za-z0-9_\-]+)/);
  if (slash) return slash[1];
  const expanded = prompt.match(/^#\s*Évaluation\s+FAE\s+\S+\s+-\s+dossier\s+([A-Za-z0-9_\-]+)/m);
  if (expanded) return expanded[1];
  return null;
}

function eventsPath(dataDir: string, dossierId: string): string {
  return resolve(dataDir, "evaluations", `${dossierId}.events.jsonl`);
}

export function saveRunEvents(
  dataDir: string,
  dossierId: string,
  events: AgentEvent[]
): void {
  const p = eventsPath(dataDir, dossierId);
  mkdirSync(dirname(p), { recursive: true });
  const lines = events.map((ev) => JSON.stringify(ev)).join("\n");
  writeFileSync(p, lines + "\n", "utf8");
}

export interface RunCostSummary {
  costUsd: number;
  durationMs: number;
  success: boolean;
  model: string;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreate5m: number;
    cacheCreate1h: number;
  };
  ts: number;
}

/**
 * Extrait le résumé de coût depuis une liste d'events (in-memory ou chargés
 * depuis .events.jsonl). Source de vérité pour le coût total : l'event
 * `result` émis par le CLI Claude (calcul côté client à partir des vrais
 * tarifs Anthropic). Tokens : recalculés depuis les events `usage` avec dédup
 * par message_id (même logique que runs.ts::broadcast).
 */
export function extractCostFromEvents(events: AgentEvent[]): RunCostSummary | null {
  const resultEv = [...events].reverse().find((e) => e.kind === "result");
  if (!resultEv?.result) return null;

  type Snap = { i: number; o: number; cr: number; c5m: number; c1h: number };
  const seen = new Map<string, Snap>();
  let input = 0, output = 0, cr = 0, c5m = 0, c1h = 0;
  let model = "";

  for (const ev of events) {
    if (ev.kind !== "usage" || !ev.usage) continue;
    const u = ev.usage;
    const mid = u.message_id;
    if (mid) {
      const prev = seen.get(mid);
      if (prev) {
        input -= prev.i; output -= prev.o; cr -= prev.cr; c5m -= prev.c5m; c1h -= prev.c1h;
      }
      seen.set(mid, { i: u.input_tokens, o: u.output_tokens, cr: u.cache_read, c5m: u.cache_create_5m, c1h: u.cache_create_1h });
    }
    input += u.input_tokens;
    output += u.output_tokens;
    cr += u.cache_read;
    c5m += u.cache_create_5m;
    c1h += u.cache_create_1h;
    if (u.model) model = u.model;
  }

  return {
    costUsd: resultEv.result.costUsd ?? 0,
    durationMs: resultEv.result.durationMs ?? 0,
    success: resultEv.result.success,
    model,
    tokens: { input, output, cacheRead: cr, cacheCreate5m: c5m, cacheCreate1h: c1h },
    ts: resultEv.ts,
  };
}

export function loadRunEvents(dataDir: string, dossierId: string): AgentEvent[] {
  const p = eventsPath(dataDir, dossierId);
  return loadRunEventsFromPath(p);
}

/**
 * Charge les events depuis un chemin .events.jsonl arbitraire. Utile quand
 * on lit les events depuis un outputDir distant (NAS partagé) plutôt que
 * depuis DATA_DIR/evaluations.
 */
export function loadRunEventsFromPath(path: string): AgentEvent[] {
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, "utf8");
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as AgentEvent;
        } catch {
          return null;
        }
      })
      .filter((x): x is AgentEvent => x !== null);
  } catch {
    return [];
  }
}
