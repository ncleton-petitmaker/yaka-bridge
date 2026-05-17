/**
 * Journal de traçabilité OIF-Eval.
 *
 * Format : un fichier JSONL par utilisateur par jour
 *   audit-log/<user_slug>/YYYY-MM-DD.jsonl
 *
 * Chaque fichier est une chaîne SHA-256 isolée (un seul writer = un user
 * sur sa journée). Pas de race d'append concurrent entre utilisateurs ou
 * machines, car deux daemons n'écrivent jamais dans le même fichier.
 *
 * L'OIF étant une OIG, le RGPD ne s'applique pas stricto sensu : ce journal
 * sert à la traçabilité interne, pas à la conformité réglementaire.
 *
 * Compatibilité ascendante : l'ancien fichier mono `audit-log.jsonl` à la
 * racine du dossier est encore lu en lecture (legacy), mais plus jamais
 * écrit. Pour migration manuelle, voir `migrateLegacyLog` plus bas.
 *
 * À NE JAMAIS LOGGER ICI : mots de passe, tokens, contenu intégral des
 * dossiers candidats, prompts IA bruts. On référence par identifiant.
 */
import {
  existsSync,
  appendFileSync,
  readFileSync,
  readdirSync,
  statSync,
  mkdirSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { slugifyUser } from "./skills.js";

export interface AuditEvent {
  event_id: string;
  timestamp: string;
  actor_id: string;
  actor_role?: string;
  action: string;
  resource_type: string;
  resource_id?: string;
  resource_label?: string;
  result: "success" | "failure" | "denied";
  reason?: string;
  client_ip?: string;
  session_id?: string;
  app_version?: string;
  metadata?: Record<string, unknown>;
  prev_hash: string;
  hash: string;
}

export type AuditEventInput = Omit<
  AuditEvent,
  "event_id" | "timestamp" | "prev_hash" | "hash"
> & {
  metadata?: Record<string, unknown>;
};

const GENESIS_HASH =
  "0000000000000000000000000000000000000000000000000000000000000000";

/** Racine du journal (mode shared ou local).
 *  `sharedDir` est ici l'AUDITLOGDIR de la config (déjà résolu vers
 *  `<root>/audit-log` par setup-shared-dir ou par le user). On ne ré-ajoute
 *  donc PAS de sous-segment "audit-log" sinon on a un double nesting du genre
 *  `<root>/audit-log/audit-log/<user>/<date>.jsonl`. */
function logRoot(dataDir: string, sharedDir?: string): string {
  return sharedDir
    ? resolve(sharedDir)
    : resolve(dataDir, ".claude", "audit-log");
}

/** Chemin du fichier journal pour un utilisateur et une date donnée. */
function userDayPath(
  dataDir: string,
  actor: string,
  isoDate: string,
  sharedDir?: string
): string {
  const slug = slugifyUser(actor) || "anonyme";
  const day = isoDate.slice(0, 10); // YYYY-MM-DD
  return resolve(logRoot(dataDir, sharedDir), slug, `${day}.jsonl`);
}

/** Chemin de l'ancien journal mono (lecture seule, legacy). */
function legacyLogPath(dataDir: string, sharedDir?: string): string {
  // sharedDir = auditLogDir (déjà résolu vers `<root>/audit-log`).
  return sharedDir
    ? resolve(sharedDir, "..", "audit-log.jsonl")
    : resolve(dataDir, ".claude", "audit-log.jsonl");
}

function canonicalize(o: Record<string, unknown>): string {
  return JSON.stringify(o, Object.keys(o).sort());
}

function computeHash(entry: Omit<AuditEvent, "hash">): string {
  return createHash("sha256").update(canonicalize(entry)).digest("hex");
}

function readLastEntry(path: string): AuditEvent | null {
  if (!existsSync(path)) return null;
  if (statSync(path).size === 0) return null;
  const content = readFileSync(path, "utf8").trimEnd();
  if (!content) return null;
  const lastNewline = content.lastIndexOf("\n");
  const lastLine = lastNewline >= 0 ? content.slice(lastNewline + 1) : content;
  try {
    return JSON.parse(lastLine) as AuditEvent;
  } catch {
    return null;
  }
}

export function appendAuditEvent(
  dataDir: string,
  input: AuditEventInput,
  sharedDir?: string
): AuditEvent {
  const now = new Date();
  const path = userDayPath(dataDir, input.actor_id, now.toISOString(), sharedDir);
  mkdirSync(dirname(path), { recursive: true });
  const last = readLastEntry(path);
  const prev_hash = last?.hash ?? GENESIS_HASH;
  const partial: Omit<AuditEvent, "hash"> = {
    event_id: randomUUID(),
    timestamp: now.toISOString(),
    actor_id: input.actor_id,
    actor_role: input.actor_role,
    action: input.action,
    resource_type: input.resource_type,
    resource_id: input.resource_id,
    resource_label: input.resource_label,
    result: input.result,
    reason: input.reason,
    client_ip: input.client_ip,
    session_id: input.session_id,
    app_version: input.app_version,
    metadata: input.metadata,
    prev_hash,
  };
  const hash = computeHash(partial);
  const full: AuditEvent = { ...partial, hash };
  appendFileSync(path, JSON.stringify(full) + "\n", "utf8");
  return full;
}

export interface AuditFilters {
  from?: string;
  to?: string;
  actor_id?: string;
  action?: string;
  action_prefix?: string;
  resource_type?: string;
  resource_id?: string;
  result?: AuditEvent["result"];
  limit?: number;
}

export interface AuditQueryResult {
  events: AuditEvent[];
  total: number;
  truncated: boolean;
}

/**
 * Liste tous les fichiers journaux (tous utilisateurs, toutes dates) +
 * éventuellement le fichier legacy.
 */
function listAllLogFiles(dataDir: string, sharedDir?: string): string[] {
  const root = logRoot(dataDir, sharedDir);
  const out: string[] = [];
  if (existsSync(root)) {
    for (const userDir of readdirSync(root)) {
      const sub = resolve(root, userDir);
      try {
        if (!statSync(sub).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const f of readdirSync(sub)) {
        if (f.endsWith(".jsonl")) out.push(resolve(sub, f));
      }
    }
  }
  const legacy = legacyLogPath(dataDir, sharedDir);
  if (existsSync(legacy)) out.push(legacy);
  return out;
}

function loadEventsFromFile(path: string): AuditEvent[] {
  if (!existsSync(path)) return [];
  const content = readFileSync(path, "utf8");
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  const events: AuditEvent[] = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line) as AuditEvent);
    } catch {
      // skip corrupt line
    }
  }
  return events;
}

export function readAuditEvents(
  dataDir: string,
  filters: AuditFilters = {},
  sharedDir?: string
): AuditQueryResult {
  const files = listAllLogFiles(dataDir, sharedDir);
  const all: AuditEvent[] = [];
  for (const f of files) {
    all.push(...loadEventsFromFile(f));
  }
  const filtered = all.filter((e) => {
    if (filters.from && e.timestamp < filters.from) return false;
    if (filters.to && e.timestamp > filters.to) return false;
    if (filters.actor_id && e.actor_id !== filters.actor_id) return false;
    if (filters.action && e.action !== filters.action) return false;
    if (filters.action_prefix && !e.action.startsWith(filters.action_prefix))
      return false;
    if (filters.resource_type && e.resource_type !== filters.resource_type)
      return false;
    if (filters.resource_id && e.resource_id !== filters.resource_id)
      return false;
    if (filters.result && e.result !== filters.result) return false;
    return true;
  });
  filtered.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const limit = filters.limit ?? 200;
  const limited = filtered.slice(0, limit);
  return {
    events: limited,
    total: filtered.length,
    truncated: filtered.length > limit,
  };
}

export interface IntegrityResult {
  valid: boolean;
  totalChecked: number;
  brokenAt?: number;
  reason?: string;
  /** Détail par fichier si on a vérifié plusieurs sources */
  perFile?: { path: string; valid: boolean; reason?: string; lines: number }[];
}

/**
 * Vérifie l'intégrité de la chaîne SHA-256 de chaque fichier journal.
 * Comme chaque fichier est sa propre chaîne, on les vérifie indépendamment.
 */
export function verifyAuditLogIntegrity(
  dataDir: string,
  sharedDir?: string
): IntegrityResult {
  const files = listAllLogFiles(dataDir, sharedDir);
  if (files.length === 0) return { valid: true, totalChecked: 0 };

  const perFile: NonNullable<IntegrityResult["perFile"]> = [];
  let totalLines = 0;
  let firstBroken: { path: string; line: number; reason: string } | null = null;

  for (const path of files) {
    const result = verifySingleFile(path);
    perFile.push({
      path,
      valid: result.valid,
      reason: result.reason,
      lines: result.lines,
    });
    totalLines += result.lines;
    if (!result.valid && !firstBroken && result.brokenAt) {
      firstBroken = {
        path,
        line: result.brokenAt,
        reason: result.reason ?? "intégrité",
      };
    }
  }

  if (firstBroken) {
    return {
      valid: false,
      totalChecked: totalLines,
      brokenAt: firstBroken.line,
      reason: `${firstBroken.reason} dans ${firstBroken.path}`,
      perFile,
    };
  }
  return { valid: true, totalChecked: totalLines, perFile };
}

function verifySingleFile(path: string): {
  valid: boolean;
  lines: number;
  brokenAt?: number;
  reason?: string;
} {
  if (!existsSync(path)) return { valid: true, lines: 0 };
  const content = readFileSync(path, "utf8");
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  let prevHash = GENESIS_HASH;
  for (let i = 0; i < lines.length; i++) {
    let entry: AuditEvent;
    try {
      entry = JSON.parse(lines[i]) as AuditEvent;
    } catch {
      return {
        valid: false,
        lines: i,
        brokenAt: i + 1,
        reason: `JSON invalide à la ligne ${i + 1}`,
      };
    }
    if (entry.prev_hash !== prevHash) {
      return {
        valid: false,
        lines: i,
        brokenAt: i + 1,
        reason: `prev_hash incohérent à la ligne ${i + 1} (attendu ${prevHash.slice(0, 12)}…, vu ${entry.prev_hash.slice(0, 12)}…)`,
      };
    }
    const { hash, ...rest } = entry;
    const expected = computeHash(rest);
    if (hash !== expected) {
      return {
        valid: false,
        lines: i,
        brokenAt: i + 1,
        reason: `hash recalculé ne correspond pas à la ligne ${i + 1}`,
      };
    }
    prevHash = hash;
  }
  return { valid: true, lines: lines.length };
}

export interface AuditStats {
  total: number;
  windowDays: number;
  byAction: { action: string; count: number }[];
  byActor: { actor_id: string; count: number }[];
  failureCount: number;
  topResources: { resource_type: string; resource_id?: string; count: number }[];
}

export function computeAuditStats(
  dataDir: string,
  windowDays = 30,
  sharedDir?: string
): AuditStats {
  const fromIso = new Date(Date.now() - windowDays * 86400000).toISOString();
  const { events: all } = readAuditEvents(
    dataDir,
    { from: fromIso, limit: 100000 },
    sharedDir
  );
  const actionCounts = new Map<string, number>();
  const actorCounts = new Map<string, number>();
  const resourceCounts = new Map<string, number>();
  let failures = 0;
  for (const ev of all) {
    actionCounts.set(ev.action, (actionCounts.get(ev.action) ?? 0) + 1);
    actorCounts.set(ev.actor_id, (actorCounts.get(ev.actor_id) ?? 0) + 1);
    if (ev.result !== "success") failures += 1;
    if (ev.resource_type && ev.resource_id) {
      const k = `${ev.resource_type}:${ev.resource_id}`;
      resourceCounts.set(k, (resourceCounts.get(k) ?? 0) + 1);
    }
  }
  return {
    total: all.length,
    windowDays,
    byAction: Array.from(actionCounts.entries())
      .map(([action, count]) => ({ action, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),
    byActor: Array.from(actorCounts.entries())
      .map(([actor_id, count]) => ({ actor_id, count }))
      .sort((a, b) => b.count - a.count),
    failureCount: failures,
    topResources: Array.from(resourceCounts.entries())
      .map(([k, count]) => {
        const [resource_type, resource_id] = k.split(":");
        return { resource_type, resource_id, count };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),
  };
}
