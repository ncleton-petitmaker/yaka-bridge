/**
 * Gestion des runs Codex CLI : spawn `codex exec --json`, parsing du stream
 * JSONL, mémoire des events, fan-out vers les listeners SSE.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { findCodexBin, buildCodexArgs, type BuildArgsOptions } from "./agents.js";
import { CodexStreamParser } from "./parse-stream.js";
import { saveRunEvents } from "./run-history.js";
import {
  emptyTotals,
  type UsageTotals,
} from "./pricing.js";
import type { AgentEvent, RunRecord, RunStatus } from "./types.js";

interface ActiveRun extends RunRecord {
  child?: ChildProcessWithoutNullStreams;
  parser?: CodexStreamParser;
  /** Listeners SSE attachés à ce run */
  listeners: Set<(ev: AgentEvent) => void>;
  /** Promesse de fin (résolue quand le child exit) */
  done: Promise<void>;
  resolveDone?: () => void;
  /** Agrégat tokens + coût USD, mis à jour à chaque event `usage`. */
  totals: UsageTotals;
  /**
   * Snapshot des tokens déjà comptés pour chaque message Anthropic vu
   * (dédup : `message_start` puis `assistant` portent le même message_id ;
   * sans dédup on doublerait input + cache). On stocke les valeurs déjà
   * intégrées, pour pouvoir soustraire et réinjecter quand l'usage final
   * arrive (output_tokens cumulé plus précis).
   */
  usageByMessageId: Map<
    string,
    {
      input_tokens: number;
      output_tokens: number;
      cache_read: number;
      cache_create_5m: number;
      cache_create_1h: number;
    }
  >;
}

const runs = new Map<string, ActiveRun>();

export interface StartRunOptions extends BuildArgsOptions {
  /** Prompt envoyé via stdin */
  prompt: string;
  /** Dossier de travail du subprocess */
  cwd: string;
  /**
   * Tag libre. Si fourni, les events seront persistés dans
   * `<cwd>/runs/<tag>.events.jsonl` à la fin du run (succès, échec ou annulation).
   */
  tag?: string;
}

export function getRun(id: string): RunRecord | null {
  const r = runs.get(id);
  if (!r) return null;
  return {
    id: r.id,
    prompt: r.prompt,
    status: r.status,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    exitCode: r.exitCode,
    cwd: r.cwd,
    events: r.events,
    tag: r.tag,
  };
}

/**
 * Renvoie les totaux tokens + coût USD agrégés sur le run, plus la liste des
 * events `usage` détaillés (utile pour debugger un breakdown par tour Claude).
 * Renvoie null si le run est inconnu.
 */
export function getRunUsage(
  id: string
): { totals: UsageTotals; events: AgentEvent[] } | null {
  const r = runs.get(id);
  if (!r) return null;
  return {
    totals: { ...r.totals },
    events: r.events.filter((ev) => ev.kind === "usage"),
  };
}

export function listRuns(): RunRecord[] {
  return Array.from(runs.values()).map((r) => ({
    id: r.id,
    prompt: r.prompt,
    status: r.status,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    exitCode: r.exitCode,
    cwd: r.cwd,
    events: r.events,
    tag: r.tag,
  }));
}

/**
 * Délai au-delà duquel un run en `running` sans aucun event reçu est considéré
 * mort (le subprocess Claude a probablement crashé sans `child.on("close")`).
 * 30 min : un dossier complet prend max ~15 min, on garde du marge.
 */
const RUN_STALE_TIMEOUT_MS = 30 * 60_000;

/**
 * Détecte et "tue" les runs zombies : ceux dont le PID enfant n'est plus
 * vivant côté OS (process killé externement, OOM, daemon redémarré sans
 * tuer ses enfants, etc.) ou ceux qui n'ont reçu aucun event depuis plus de
 * RUN_STALE_TIMEOUT_MS. Marque ces runs comme "failed" et libère leur slot.
 *
 * Doit être appelée à chaque check de concurrence (countRunningEvaluations)
 * pour ne pas bloquer indéfiniment de nouveaux runs derrière des fantômes.
 *
 * Renvoie le nombre de zombies cleanupés (utile pour les logs).
 */
export function cleanupZombies(): number {
  let cleaned = 0;
  const now = Date.now();
  for (const run of runs.values()) {
    if (run.status !== "running") continue;
    let dead = false;
    let reason = "";
    // 1. PID mort côté OS ?
    const pid = run.child?.pid;
    if (pid != null) {
      try {
        // signal 0 = juste check si le process existe sans l'affecter
        process.kill(pid, 0);
      } catch {
        dead = true;
        reason = `process Codex PID ${pid} introuvable côté OS`;
      }
    } else if (!run.child) {
      // Pas de child référencé du tout : le run est orphelin
      dead = true;
      reason = "aucun process enfant attaché";
    }
    // 2. Pas d'event depuis trop longtemps ?
    if (!dead) {
      const lastEvent = run.events[run.events.length - 1];
      const lastTs = lastEvent?.ts ?? run.startedAt;
      if (now - lastTs > RUN_STALE_TIMEOUT_MS) {
        dead = true;
        reason = `aucun event depuis ${Math.round((now - lastTs) / 60_000)} min, run considéré mort`;
        // On essaie de tuer le child si on a un PID au cas où il serait stuck
        if (pid != null) {
          try {
            process.kill(pid, "SIGTERM");
          } catch {
            // déjà mort
          }
        }
      }
    }
    if (dead) {
      console.warn(`[runs] zombie détecté ${run.id} : ${reason}`);
      run.events.push({
        kind: "error",
        error: `Run nettoyé automatiquement : ${reason}`,
        ts: now,
      });
      run.status = "failed";
      run.endedAt = now;
      run.exitCode = null;
      run.resolveDone?.();
      cleaned++;
    }
  }
  return cleaned;
}

export function attachListener(
  runId: string,
  listener: (ev: AgentEvent) => void
): { detach: () => void; replay: AgentEvent[] } | null {
  const run = runs.get(runId);
  if (!run) return null;
  run.listeners.add(listener);
  return {
    detach: () => run.listeners.delete(listener),
    replay: [...run.events],
  };
}

export async function waitForRun(runId: string): Promise<RunRecord | null> {
  const run = runs.get(runId);
  if (!run) return null;
  await run.done;
  return getRun(runId);
}

export function cancelRun(runId: string): boolean {
  const run = runs.get(runId);
  if (!run || !run.child) return false;
  if (run.status !== "running") return false;
  run.child.kill("SIGTERM");
  run.status = "cancelled";
  return true;
}

function broadcast(run: ActiveRun, ev: AgentEvent) {
  // Agrégation tokens + recalcul du coût à chaque event `usage`. Stratégie
  // de dédup : Claude Code émet usage à `message_start` (input + cache,
  // output_tokens placeholder) puis à `assistant` (mêmes input/cache,
  // output_tokens final cumulé). Si message_id match, on REMPLACE l'ancien
  // snapshot par le nouveau (qui a l'output final). Sans message_id, on
  // additionne (cas rare de versions Claude Code sans id).
  if (ev.kind === "usage" && ev.usage) {
    const u = ev.usage;
    if (u.message_id) {
      const prev = run.usageByMessageId.get(u.message_id);
      if (prev) {
        // On retire l'ancien snapshot avant d'ajouter le nouveau, pour ne
        // pas doubler input + cache (qui sont identiques entre les deux
        // émissions).
        run.totals.input_tokens -= prev.input_tokens;
        run.totals.output_tokens -= prev.output_tokens;
        run.totals.cache_read -= prev.cache_read;
        run.totals.cache_create_5m -= prev.cache_create_5m;
        run.totals.cache_create_1h -= prev.cache_create_1h;
      }
      run.usageByMessageId.set(u.message_id, {
        input_tokens: u.input_tokens,
        output_tokens: u.output_tokens,
        cache_read: u.cache_read,
        cache_create_5m: u.cache_create_5m,
        cache_create_1h: u.cache_create_1h,
      });
    }
    run.totals.input_tokens += u.input_tokens;
    run.totals.output_tokens += u.output_tokens;
    run.totals.cache_read += u.cache_read;
    run.totals.cache_create_5m += u.cache_create_5m;
    run.totals.cache_create_1h += u.cache_create_1h;
    if (u.model) run.totals.last_model = u.model;
    // Codex en OAuth ChatGPT : l'usage est inclus dans l'abonnement, il n'y a
    // pas de facturation par token. On garde l'agrégat de tokens (utile pour
    // suivre la consommation de quota) mais le coût USD reste à 0.
    run.totals.cost_usd = 0;
  }
  run.events.push(ev);
  for (const l of run.listeners) {
    try {
      l(ev);
    } catch {
      // listener cassé : on l'ignore
    }
  }
}

function setStatus(run: ActiveRun, status: RunStatus, exitCode?: number | null) {
  run.status = status;
  if (status === "succeeded" || status === "failed" || status === "cancelled") {
    run.endedAt = Date.now();
    run.exitCode = exitCode ?? null;
    // Persiste les events sur disque si un tag a été fourni par le caller.
    // Sinon les events restent uniquement en mémoire (utile pour les runs
    // éphémères qu'on n'a pas besoin de rejouer après redémarrage).
    if (run.tag) {
      try {
        saveRunEvents(run.cwd, run.tag, run.events);
      } catch (err) {
        console.warn(`[runs] échec sauvegarde events ${run.tag}:`, (err as Error).message);
      }
    }
    run.resolveDone?.();
  }
}

export function startRun(opts: StartRunOptions): RunRecord {
  const bin = findCodexBin();
  if (!bin) {
    throw new Error(
      "Codex CLI introuvable sur le PATH. Installez-le (npm i -g @openai/codex) puis faites `codex login`."
    );
  }

  const id = randomUUID();
  const args = buildCodexArgs(opts);
  const parser = new CodexStreamParser();

  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const run: ActiveRun = {
    id,
    prompt: opts.prompt,
    status: "queued",
    startedAt: Date.now(),
    cwd: opts.cwd,
    events: [],
    tag: opts.tag,
    listeners: new Set(),
    parser,
    done,
    resolveDone,
    totals: emptyTotals(),
    usageByMessageId: new Map(),
  };

  runs.set(id, run);

  const child = spawn(bin, args, {
    cwd: opts.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    env: {
      ...process.env,
      // Sortie sobre : pas de couleurs ANSI dans le flux JSONL ni sur stderr.
      NO_COLOR: "1",
    },
  });

  run.child = child;
  setStatus(run, "running");

  child.stdin.write(opts.prompt, "utf8");
  child.stdin.end();

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  child.stdout.on("data", (chunk: string) => {
    const events = parser.feed(chunk);
    for (const ev of events) broadcast(run, ev);
  });

  child.stderr.on("data", (chunk: string) => {
    broadcast(run, { kind: "stderr", text: chunk, ts: Date.now() });
  });

  child.on("error", (err) => {
    broadcast(run, { kind: "error", error: err.message, ts: Date.now() });
    setStatus(run, "failed", null);
  });

  child.on("close", (code) => {
    const tail = parser.flush();
    for (const ev of tail) broadcast(run, ev);
    // codex exec n'émet pas d'événement "result" dans son flux JSONL
    // (contrairement à claude --output-format stream-json) : on le synthétise
    // pour conserver le contrat AgentEvent du template (l'UI affiche la
    // réponse finale + le statut succès/échec à partir de cet event).
    if (!run.events.some((e) => e.kind === "result")) {
      const lastText = [...run.events].reverse().find((e) => e.kind === "text_delta")?.text;
      broadcast(run, {
        kind: "result",
        result: {
          success: code === 0 && run.status !== "cancelled",
          output: lastText,
          durationMs: Date.now() - run.startedAt,
        },
        ts: Date.now(),
      });
    }
    if (run.status === "cancelled") {
      // déjà marqué
      run.endedAt = Date.now();
      run.exitCode = code;
      run.resolveDone?.();
      return;
    }
    setStatus(run, code === 0 ? "succeeded" : "failed", code);
  });

  return getRun(id)!;
}
