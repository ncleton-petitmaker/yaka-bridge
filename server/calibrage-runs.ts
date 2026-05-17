/**
 * Lancement et suivi des calibrages depuis l'UI.
 *
 * Spawn `tsx scripts/calibrer.ts` en background, capture stdout et stderr
 * ligne par ligne, expose les events via SSE et garantit qu'un seul calibrage
 * tourne à la fois (verrou en mémoire + verrou sur disque pour survivre à un
 * redémarrage du daemon).
 *
 * Le script imprime des lignes "PROGRESS <json>" parsées ici en évents
 * structurés `progress` poussés au client.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { listRuns, cancelRun } from "./runs.js";
import type { CalibrageProgress } from "../lib/calibrage-import-types.js";

/** Un évènement émis pendant un calibrage (stdout, stderr, progression, fin). */
export interface CalibrageEvent {
  ts: number;
  kind: "stdout" | "stderr" | "end" | "error" | "progress";
  text?: string;
  exitCode?: number | null;
  /** Présent uniquement quand kind === "progress". */
  progress?: CalibrageProgress;
}

interface ActiveCalibrage {
  id: string;
  /** Bundle d'origine (importId) pour reconstruire l'état UI à la reprise. */
  importId?: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  /** Buffer pour les nouveaux SSE qui se branchent en cours de route. */
  events: CalibrageEvent[];
  /** Nombre d'évaluations terminées détectées dans le stdout. */
  evaluationsDone: number;
  /** Nombre total d'évaluations attendues (parsé depuis stdout, défaut 20). */
  evaluationsTotal: number;
  /** Dernière progression structurée reçue du script (pour replay rapide). */
  lastProgress?: CalibrageProgress;
  child?: ChildProcessByStdio<null, Readable, Readable>;
  listeners: Set<(ev: CalibrageEvent) => void>;
  done: Promise<void>;
  resolveDone?: () => void;
}

const runs = new Map<string, ActiveCalibrage>();

/** Le verrou en mémoire : id du run actuellement en cours, ou null. */
let currentRunId: string | null = null;

function lockFile(dataDir: string): string {
  return resolve(dataDir, "calibrage", ".running.lock");
}

function readLock(dataDir: string): { runId: string; pid: number; startedAt: number } | null {
  const f = lockFile(dataDir);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    // signal 0 = test seulement (ne tue pas)
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function clearLock(dataDir: string): void {
  const f = lockFile(dataDir);
  if (existsSync(f)) {
    try {
      unlinkSync(f);
    } catch {
      // best-effort
    }
  }
}

function writeLock(dataDir: string, runId: string, pid: number): void {
  const dir = dirname(lockFile(dataDir));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    lockFile(dataDir),
    JSON.stringify({ runId, pid, startedAt: Date.now() }, null, 2)
  );
}

/**
 * Vérifie si un calibrage est actuellement en cours. Si un fichier de lock
 * existe mais que le PID est mort (daemon redémarré entre-temps), nettoie
 * le lock et retourne false.
 */
export function isCalibrageRunning(dataDir: string): boolean {
  if (currentRunId) {
    const r = runs.get(currentRunId);
    if (r && r.status === "running") return true;
  }
  const lock = readLock(dataDir);
  if (!lock) return false;
  if (!isPidAlive(lock.pid)) {
    clearLock(dataDir);
    return false;
  }
  return true;
}

export function getCalibrageRun(id: string): {
  id: string;
  status: ActiveCalibrage["status"];
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  evaluationsDone: number;
  evaluationsTotal: number;
  lastProgress?: CalibrageProgress;
} | null {
  const r = runs.get(id);
  if (!r) return null;
  return {
    id: r.id,
    status: r.status,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    exitCode: r.exitCode,
    evaluationsDone: r.evaluationsDone,
    evaluationsTotal: r.evaluationsTotal,
    lastProgress: r.lastProgress,
  };
}

/**
 * Renvoie le run de calibrage courant s'il y en a un en `running`,
 * sinon null. Permet à l'UI de récupérer un calibrage en cours après reload
 * de la page, changement d'onglet, ou redémarrage Electron.
 */
export function getCurrentCalibrageRun(): {
  runId: string;
  importId: string | null;
  status: ActiveCalibrage["status"];
  startedAt: number;
  evaluationsDone: number;
  evaluationsTotal: number;
  lastProgress?: CalibrageProgress;
} | null {
  if (!currentRunId) return null;
  const r = runs.get(currentRunId);
  if (!r) return null;
  if (r.status !== "running") return null;
  return {
    runId: r.id,
    importId: r.importId ?? null,
    status: r.status,
    startedAt: r.startedAt,
    evaluationsDone: r.evaluationsDone,
    evaluationsTotal: r.evaluationsTotal,
    lastProgress: r.lastProgress,
  };
}

export function attachCalibrageListener(
  runId: string,
  listener: (ev: CalibrageEvent) => void
): { detach: () => void; replay: CalibrageEvent[] } | null {
  const r = runs.get(runId);
  if (!r) return null;
  r.listeners.add(listener);
  return {
    detach: () => r.listeners.delete(listener),
    replay: [...r.events],
  };
}

export async function waitForCalibrage(runId: string): Promise<void> {
  const r = runs.get(runId);
  if (!r) return;
  await r.done;
}

/**
 * Annule un calibrage en cours en tuant le processus enfant.
 */
export function cancelCalibrage(runId: string): boolean {
  const r = runs.get(runId);
  if (!r || r.status !== "running") return false;

  // 1. Tuer le tsx parent (script calibrer.ts)
  let killed = false;
  if (r.child && !r.child.killed) {
    try {
      r.child.kill("SIGTERM");
      // Au cas où SIGTERM ne suffit pas (script qui ignore le signal),
      // SIGKILL après 2s.
      setTimeout(() => {
        try {
          if (r.child && !r.child.killed) r.child.kill("SIGKILL");
        } catch {
          /* déjà mort */
        }
      }, 2000);
      killed = true;
    } catch {
      // ignore
    }
  }

  // 2. CRUCIAL : tuer aussi tous les child Claude que le script a spawnés
  // via POST /api/runs. Ils sont enregistrés côté daemon comme runs séparés
  // avec un prompt commençant par "# Évaluation FAE 7e - dossier <ref>".
  // Sans ça, ils continueraient à tourner après l'annulation et bloqueraient
  // les slots MAX_CONCURRENT_EVALUATIONS.
  let claudeKilled = 0;
  for (const cr of listRuns()) {
    if (cr.status !== "running") continue;
    if (!cr.prompt.startsWith("# Évaluation FAE 7e - dossier")) continue;
    try {
      if (cancelRun(cr.id)) claudeKilled++;
    } catch {
      /* ignore */
    }
  }
  if (claudeKilled > 0) {
    console.log(`[calibrage] cancel: ${claudeKilled} run(s) Claude tués en plus du tsx parent`);
  }

  return killed || claudeKilled > 0;
}

function broadcast(run: ActiveCalibrage, ev: CalibrageEvent) {
  run.events.push(ev);
  // On garde au plus 1000 events en mémoire pour éviter de gonfler.
  if (run.events.length > 1000) run.events.splice(0, run.events.length - 1000);
  for (const l of run.listeners) {
    try {
      l(ev);
    } catch {
      // listener cassé : on ignore
    }
  }
}

/**
 * Parse une ligne de stdout du script calibrer.ts pour incrémenter le
 * compteur d'évaluations terminées et émettre un event progress structuré
 * quand le script imprime "PROGRESS <json>".
 */
function parseProgress(run: ActiveCalibrage, line: string): CalibrageEvent | null {
  const trimmed = line.trim();
  // Event de progression structuré : "PROGRESS {...}"
  const progMatch = trimmed.match(/^PROGRESS\s+(\{.+\})$/);
  if (progMatch) {
    try {
      const data = JSON.parse(progMatch[1]) as CalibrageProgress;
      run.evaluationsDone = data.done;
      run.evaluationsTotal = data.total;
      run.lastProgress = data;
      return { ts: Date.now(), kind: "progress", progress: data };
    } catch {
      // ignore : malformé
    }
  }
  if (/^Total sélectionné\s*:\s*(\d+)/u.test(trimmed)) {
    const m = trimmed.match(/^Total sélectionné\s*:\s*(\d+)/u);
    if (m) run.evaluationsTotal = Number(m[1]);
  }
  // Une évaluation terminée (succès ou échec) commence par ✓ ou ✗ après indent.
  if (/^[✓✗]\s/.test(trimmed)) {
    run.evaluationsDone++;
  }
  return null;
}

/**
 * Trouve la racine du projet (où se trouvent package.json + scripts/).
 * Le daemon est lancé depuis ROOT/server/, donc ROOT = ../<this file>/..
 */
function projectRoot(): string {
  // server/calibrage-runs.ts -> server/ -> ROOT
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

/**
 * Démarre un calibrage en background. Si `importId` est fourni, le script
 * lit data/calibrage/imports/<importId>/ pour charger les dossiers et scores
 * humains. Sinon, le mode legacy --stratified est utilisé (debug).
 *
 * Lève si un calibrage tourne déjà ou si tsx n'est pas trouvable.
 */
export function startCalibrage(
  dataDir: string,
  opts: { importId?: string; modeCompat?: boolean } = {} // DEBUG modeCompat à retirer avant livraison
): { runId: string } {
  if (isCalibrageRunning(dataDir)) {
    throw new Error("already_running");
  }

  // Résout tsx via require.resolve (fonctionne en dev et en production
  // packagée tant que node_modules est embarqué).
  let tsxCli: string;
  try {
    const { createRequire } = require("node:module") as typeof import("node:module");
    const req = createRequire(import.meta.url);
    tsxCli = req.resolve("tsx/cli");
  } catch (err) {
    throw new Error(
      "Outil tsx introuvable. Vérifier que les dépendances sont installées."
    );
  }

  const root = projectRoot();
  const scriptPath = resolve(root, "scripts", "calibrer.ts");
  if (!existsSync(scriptPath)) {
    throw new Error(`Script calibrer.ts introuvable : ${scriptPath}`);
  }

  const id = randomUUID();
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });

  const run: ActiveCalibrage = {
    id,
    importId: opts.importId,
    status: "running",
    startedAt: Date.now(),
    events: [],
    evaluationsDone: 0,
    evaluationsTotal: 20, // valeur par défaut, ajustée si stdout dit autrement
    listeners: new Set(),
    done,
    resolveDone,
  };
  runs.set(id, run);
  currentRunId = id;

  // Construit les arguments du script
  const scriptArgs = opts.importId
    ? ["--import", opts.importId]
    : ["--stratified"];
  if (opts.modeCompat) scriptArgs.push("--compat"); // DEBUG à retirer avant livraison

  const child = spawn(
    process.execPath,
    [tsxCli, scriptPath, ...scriptArgs],
    {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      env: {
        ...process.env,
        // Force UTF-8 pour les caractères français
        LANG: process.env.LANG ?? "fr_FR.UTF-8",
      },
    }
  );

  run.child = child;
  writeLock(dataDir, id, child.pid ?? -1);

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let stdoutBuf = "";
  child.stdout.on("data", (chunk: string) => {
    stdoutBuf += chunk;
    let nl: number;
    while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      const progressEvent = parseProgress(run, line);
      if (progressEvent) {
        broadcast(run, progressEvent);
      } else {
        broadcast(run, { ts: Date.now(), kind: "stdout", text: line });
      }
    }
  });

  child.stderr.on("data", (chunk: string) => {
    broadcast(run, { ts: Date.now(), kind: "stderr", text: chunk });
  });

  child.on("error", (err) => {
    broadcast(run, { ts: Date.now(), kind: "error", text: err.message });
    run.status = "failed";
    run.endedAt = Date.now();
    run.exitCode = null;
    if (currentRunId === id) currentRunId = null;
    clearLock(dataDir);
    run.resolveDone?.();
  });

  child.on("close", (code) => {
    if (stdoutBuf.length > 0) {
      const progressEvent = parseProgress(run, stdoutBuf);
      if (progressEvent) {
        broadcast(run, progressEvent);
      } else {
        broadcast(run, { ts: Date.now(), kind: "stdout", text: stdoutBuf });
      }
      stdoutBuf = "";
    }
    run.endedAt = Date.now();
    run.exitCode = code;
    if (run.status !== "cancelled") {
      run.status = code === 0 ? "succeeded" : "failed";
    }
    broadcast(run, {
      ts: Date.now(),
      kind: "end",
      exitCode: code,
    });
    if (currentRunId === id) currentRunId = null;
    clearLock(dataDir);
    run.resolveDone?.();
  });

  // Marque cancelled si on tue le process
  child.on("exit", (code, signal) => {
    if (signal === "SIGTERM" || signal === "SIGKILL") {
      run.status = "cancelled";
    }
  });

  return { runId: id };
}
