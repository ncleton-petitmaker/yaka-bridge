/**
 * Persistance des events des runs sur disque.
 *
 * Format : un event par ligne JSON dans
 *   `<dataDir>/runs/<tag>.events.jsonl`
 *
 * Le `tag` est libre : peut être un ID de run, un slug métier, etc.
 * Le caller (cf. server/runs.ts) décide quoi utiliser comme tag pour persister
 * les events. Sans tag, les events restent uniquement en mémoire.
 *
 * Utilisé pour replay l'historique du travail de Claude après redémarrage.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { AgentEvent } from "./types.js";

function eventsPath(dataDir: string, tag: string): string {
  return resolve(dataDir, "runs", `${tag}.events.jsonl`);
}

export function saveRunEvents(
  dataDir: string,
  tag: string,
  events: AgentEvent[]
): void {
  const p = eventsPath(dataDir, tag);
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
  let input = 0,
    output = 0,
    cr = 0,
    c5m = 0,
    c1h = 0;
  let model = "";

  for (const ev of events) {
    if (ev.kind !== "usage" || !ev.usage) continue;
    const u = ev.usage;
    const mid = u.message_id;
    if (mid) {
      const prev = seen.get(mid);
      if (prev) {
        input -= prev.i;
        output -= prev.o;
        cr -= prev.cr;
        c5m -= prev.c5m;
        c1h -= prev.c1h;
      }
      seen.set(mid, {
        i: u.input_tokens,
        o: u.output_tokens,
        cr: u.cache_read,
        c5m: u.cache_create_5m,
        c1h: u.cache_create_1h,
      });
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

export function loadRunEvents(dataDir: string, tag: string): AgentEvent[] {
  const p = eventsPath(dataDir, tag);
  return loadRunEventsFromPath(p);
}

/**
 * Charge les events depuis un chemin .events.jsonl arbitraire. Utile quand
 * on veut lire les events depuis un dossier custom plutôt que `<dataDir>/runs/`.
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
