/**
 * Daemon générique : Hono + spawn Claude Code + SSE.
 *
 * Port par défaut : 7456 (override via env `{{DATA_DIR_ENV_VAR}}_DAEMON_PORT`).
 * Pour le template on garde un nom d'env neutre qui sera remplacé au
 * scaffolding.
 *
 * Routes exposées :
 *   GET    /api/health
 *   POST   /api/runs                  { prompt, tag?, model?, addDirs?, ... }
 *   GET    /api/runs                  liste mémoire
 *   GET    /api/runs/:id
 *   GET    /api/runs/:id/events       SSE
 *   POST   /api/runs/:id/cancel
 *   GET    /api/agents                statut du binaire claude
 *   GET    /api/skills                { global, perso }
 *   PUT    /api/skills/:slug          écriture skill global
 *   GET    /api/audit/logs?since=&user=
 *   GET    /api/audit/stats?windowDays=
 *   GET    /api/app-config
 *   PUT    /api/app-config
 *
 * Les apps métier étendent ce daemon en ajoutant leurs propres routes
 * (voir `docs/customization-guide.md`).
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { serve } from "@hono/node-server";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { findClaudeBin } from "./agents.js";
import { getAgentStatus } from "./agents-status.js";
import {
  loadAppConfig,
  saveAppConfig,
  AVAILABLE_MODELS,
  type AppConfig,
} from "./app-config.js";
import { setPricingDataDir, getPricingMetadata } from "./pricing.js";
import {
  startRun,
  getRun,
  getRunUsage,
  listRuns,
  attachListener,
  cancelRun,
} from "./runs.js";
import {
  listGlobalSkills,
  listPersoSkills,
  writeGlobalSkill,
} from "./skills.js";
import {
  appendAuditEvent,
  readAuditEvents,
  computeAuditStats,
  verifyAuditLogIntegrity,
  type AuditEventInput,
} from "./audit-log.js";
import { callAction, listActions, type ActionContext } from "./actions.js";
import { getSupabasePublicConfig } from "./supabase.js";
import { getBridgeStatusPayload } from "./bridge-status.js";
import { registerBridgeControlPlaneRoutes } from "./bridge-control-plane.js";
import {
  ingestObservabilityEvent,
  observabilityOverview,
  resolveObservabilityEvent,
  supportSessionDetail,
  supportSessionsOverview,
  updateSupportSession,
  upsertSupportSession,
} from "./observability.js";

// Version pseudo-templating : remplacée au scaffolding ; en attendant `0.0.1`.
const APP_VERSION = "{{VERSION}}";

/**
 * Nom de la variable d'environnement par laquelle l'hôte (Electron, script
 * `start.js`, etc.) injecte le `dataDir`. Le placeholder est remplacé à
 * scaffolding (cf. `scripts/init-from-template.mjs`).
 */
const DATA_DIR_ENV_VAR = "{{DATA_DIR_ENV_VAR}}";

const DATA_DIR = resolve(process.env[DATA_DIR_ENV_VAR] ?? "./data");
setPricingDataDir(DATA_DIR);

// Placeholders remplacés par `scripts/init-from-template.mjs`. En attendant le
// scaffolding, on garde une valeur numérique pour ne pas casser `npm run dev`.
const NEXT_PORT_DEFAULT = Number("{{NEXT_PORT}}") || 3100;
const DAEMON_PORT_DEFAULT = Number("{{DAEMON_PORT}}") || 7456;

function getActor(): { actor_id: string; actor_role: string } {
  return {
    actor_id: "local-agent",
    actor_role: "agent",
  };
}

function audit(
  c: { req: { header: (k: string) => string | undefined } },
  partial: Omit<
    AuditEventInput,
    "actor_id" | "actor_role" | "app_version" | "client_ip"
  > & {
    actor_id?: string;
    actor_role?: string;
  }
): void {
  try {
    const cfg = loadAppConfig(DATA_DIR);
    const actor_id = partial.actor_id ?? "local-agent";
    const actor_role = partial.actor_role ?? "agent";
    appendAuditEvent(
      DATA_DIR,
      {
        actor_id,
        actor_role,
        app_version: APP_VERSION,
        client_ip:
          c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "local",
        ...partial,
      },
      cfg.auditLogDir
    );
  } catch (err) {
    console.warn("[audit] échec écriture log:", err);
  }
}

function buildAddDirs(dataDir: string, cfg: AppConfig): string[] {
  const dirs = new Set<string>();
  dirs.add(dataDir);
  if (cfg.auditLogDir) dirs.add(resolve(cfg.auditLogDir));
  if (cfg.outputDir) dirs.add(resolve(cfg.outputDir));
  if (cfg.inputDir) dirs.add(resolve(cfg.inputDir));
  return Array.from(dirs);
}

function actionContext(c: { req: { header: (k: string) => string | undefined; raw: { signal: AbortSignal } } }): ActionContext {
  const a = getActor();
  return {
    dataDir: DATA_DIR,
    actorId: a.actor_id,
    actorRole: a.actor_role,
    appVersion: APP_VERSION,
    clientIp: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "local",
    signal: c.req.raw.signal,
  };
}

const app = new Hono();
registerBridgeControlPlaneRoutes(app, DATA_DIR);

app.use("*", async (c, next) => {
  await next();
  c.header("Access-Control-Allow-Private-Network", "true");
});

app.use(
  "*",
  cors({
    origin: [
      `http://localhost:${NEXT_PORT_DEFAULT}`,
      `http://127.0.0.1:${NEXT_PORT_DEFAULT}`,
      ...(process.env["APP_ALLOWED_ORIGINS"]?.split(",").map((s) => s.trim()).filter(Boolean) ?? []),
      ...(process.env["NEXT_PUBLIC_APP_ORIGIN"]?.split(",").map((s) => s.trim()).filter(Boolean) ?? []),
    ],
    credentials: true,
  })
);

// ---------------------------------------------------------------------------
// /api/health
// ---------------------------------------------------------------------------
app.get("/api/health", (c) =>
  c.json({
    ok: true,
    ts: new Date().toISOString(),
    version: APP_VERSION,
    claude: findClaudeBin(),
    dataDir: DATA_DIR,
    dataDirExists: existsSync(DATA_DIR),
    database: getSupabasePublicConfig(DATA_DIR),
    pricing: getPricingMetadata(),
  })
);

app.get("/api/bridge/status", (c) => c.json(getBridgeStatusPayload("local-daemon")));

// ---------------------------------------------------------------------------
// /api/observability : support sessions + OpenReplay correlation
// ---------------------------------------------------------------------------
app.post("/api/observability/events", (c) => ingestObservabilityEvent(DATA_DIR, c));
app.post("/api/support-sessions", (c) => upsertSupportSession(DATA_DIR, c));
app.patch("/api/support-sessions/:id", (c) => updateSupportSession(DATA_DIR, c));
app.get("/api/admin/observability", (c) => observabilityOverview(DATA_DIR, c));
app.get("/api/admin/support-sessions", (c) => supportSessionsOverview(DATA_DIR, c));
app.get("/api/admin/support-sessions/:id", (c) => supportSessionDetail(DATA_DIR, c));
app.post("/api/admin/observability/:id/resolve", (c) => resolveObservabilityEvent(DATA_DIR, c));

// ---------------------------------------------------------------------------
// /api/agents
// ---------------------------------------------------------------------------
app.get("/api/agents", async (c) => {
  const status = await getAgentStatus();
  return c.json({ agents: [status] });
});

// ---------------------------------------------------------------------------
// /api/app-config
// ---------------------------------------------------------------------------
app.get("/api/app-config", (c) => {
  const cfg = loadAppConfig(DATA_DIR);
  return c.json({
    config: cfg,
    availableModels: AVAILABLE_MODELS,
    database: getSupabasePublicConfig(DATA_DIR),
  });
});

app.put("/api/app-config", async (c) => {
  const body = (await c.req.json()) as Partial<AppConfig>;
  const next = saveAppConfig(DATA_DIR, body);
  audit(c, {
    action: "app-config.update",
    resource_type: "app-config",
    result: "success",
    metadata: { keys: Object.keys(body) },
  });
  return c.json({ config: next });
});

// ---------------------------------------------------------------------------
// /api/actions : registry canonique agentic-first (UI ↔ HTTP ↔ MCP)
// ---------------------------------------------------------------------------
app.get("/api/actions", (c) =>
  c.json({
    actions: listActions().map((a) => ({
      id: a.id,
      description: a.description,
      inputSchema: a.inputJsonSchema,
      audit: a.audit,
    })),
  })
);

app.post("/api/actions/:id", async (c) => {
  const id = c.req.param("id");
  let input: unknown = {};
  try {
    input = await c.req.json();
  } catch {
    input = {};
  }
  try {
    const output = await callAction(id, actionContext(c), input);
    return c.json({ ok: true, output });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: message }, 400);
  }
});

// ---------------------------------------------------------------------------
// /api/runs : routes génériques pour spawn Claude Code
// ---------------------------------------------------------------------------
interface StartRunBody {
  prompt: string;
  tag?: string;
  model?: string;
  addDirs?: string[];
  allowedTools?: string[];
  maxTurns?: number;
  /** Dossier de travail, par défaut DATA_DIR. */
  cwd?: string;
}

app.post("/api/runs", async (c) => {
  let body: StartRunBody;
  try {
    body = (await c.req.json()) as StartRunBody;
  } catch {
    return c.json({ error: "JSON invalide" }, 400);
  }
  if (!body?.prompt || typeof body.prompt !== "string") {
    return c.json({ error: "champ `prompt` manquant" }, 400);
  }
  const cfg = loadAppConfig(DATA_DIR);
  const cwd = body.cwd ? resolve(body.cwd) : DATA_DIR;
  const addDirs = body.addDirs ?? buildAddDirs(DATA_DIR, cfg);
  try {
    const run = startRun({
      prompt: body.prompt,
      cwd,
      tag: body.tag,
      model: body.model ?? cfg.model,
      addDirs,
      allowedTools: body.allowedTools,
      maxTurns: body.maxTurns,
    });
    audit(c, {
      action: "run.start",
      resource_type: "run",
      resource_id: run.id,
      result: "success",
      metadata: { tag: body.tag, model: body.model ?? cfg.model },
    });
    return c.json({ runId: run.id });
  } catch (err) {
    audit(c, {
      action: "run.start",
      resource_type: "run",
      result: "failure",
      reason: (err as Error).message,
    });
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.get("/api/runs", (c) => c.json({ runs: listRuns() }));

app.get("/api/runs/:id", (c) => {
  const id = c.req.param("id");
  const r = getRun(id);
  if (!r) return c.json({ error: "run introuvable" }, 404);
  const usage = getRunUsage(id);
  return c.json({ run: r, usage });
});

app.get("/api/runs/:id/events", async (c) => {
  const id = c.req.param("id");
  const r = getRun(id);
  if (!r) return c.json({ error: "run introuvable" }, 404);
  return streamSSE(c, async (stream) => {
    const handle = attachListener(id, async (ev) => {
      try {
        await stream.writeSSE({
          event: "agent",
          data: JSON.stringify(ev),
        });
      } catch {
        // socket fermé
      }
    });
    if (!handle) return;
    // Replay
    for (const ev of handle.replay) {
      await stream.writeSSE({ event: "agent", data: JSON.stringify(ev) });
    }
    // Si déjà terminé, ferme tout de suite
    const cur = getRun(id);
    if (
      cur &&
      (cur.status === "succeeded" ||
        cur.status === "failed" ||
        cur.status === "cancelled")
    ) {
      await stream.writeSSE({ event: "end", data: "{}" });
      handle.detach();
      return;
    }
    // Sinon attend la fin
    stream.onAbort(() => handle.detach());
    await new Promise<void>((resolveDone) => {
      const interval = setInterval(() => {
        const r2 = getRun(id);
        if (
          !r2 ||
          r2.status === "succeeded" ||
          r2.status === "failed" ||
          r2.status === "cancelled"
        ) {
          clearInterval(interval);
          resolveDone();
        }
      }, 500);
    });
    await stream.writeSSE({ event: "end", data: "{}" });
    handle.detach();
  });
});

app.post("/api/runs/:id/cancel", (c) => {
  const id = c.req.param("id");
  const ok = cancelRun(id);
  audit(c, {
    action: "run.cancel",
    resource_type: "run",
    resource_id: id,
    result: ok ? "success" : "failure",
  });
  return c.json({ ok });
});

// ---------------------------------------------------------------------------
// /api/skills
// ---------------------------------------------------------------------------
app.get("/api/skills", (c) => {
  const user = c.req.query("user");
  const global = listGlobalSkills(DATA_DIR);
  const perso = user ? listPersoSkills(DATA_DIR, user) : [];
  return c.json({ global, perso });
});

app.put("/api/skills/:slug", async (c) => {
  const slug = c.req.param("slug");
  let body: { content?: string };
  try {
    body = (await c.req.json()) as { content?: string };
  } catch {
    return c.json({ error: "JSON invalide" }, 400);
  }
  if (typeof body.content !== "string") {
    return c.json({ error: "champ `content` manquant" }, 400);
  }
  try {
    const filename = slug.endsWith(".md") ? slug : `${slug}.skill.md`;
    const entry = writeGlobalSkill(DATA_DIR, filename, body.content);
    audit(c, {
      action: "skill.update",
      resource_type: "skill",
      resource_id: slug,
      result: "success",
    });
    return c.json({ skill: entry });
  } catch (err) {
    audit(c, {
      action: "skill.update",
      resource_type: "skill",
      resource_id: slug,
      result: "failure",
      reason: (err as Error).message,
    });
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ---------------------------------------------------------------------------
// /api/audit
// ---------------------------------------------------------------------------
app.get("/api/audit/logs", (c) => {
  const url = c.req.url;
  const search = new URL(url).searchParams;
  const cfg = loadAppConfig(DATA_DIR);
  const events = readAuditEvents(
    DATA_DIR,
    {
      from: search.get("since") ?? undefined,
      to: search.get("to") ?? undefined,
      actor_id: search.get("user") ?? undefined,
      action: search.get("action") ?? undefined,
      limit: search.get("limit") ? Number(search.get("limit")) : 500,
    },
    cfg.auditLogDir
  );
  return c.json(events);
});

app.get("/api/audit/stats", (c) => {
  const cfg = loadAppConfig(DATA_DIR);
  const windowDays = Number(c.req.query("windowDays") ?? "30");
  return c.json(computeAuditStats(DATA_DIR, windowDays, cfg.auditLogDir));
});

app.get("/api/audit/integrity", (c) => {
  const cfg = loadAppConfig(DATA_DIR);
  return c.json(verifyAuditLogIntegrity(DATA_DIR, cfg.auditLogDir));
});

// ---------------------------------------------------------------------------
// /api/storage : stubs neutres pour ConflictBanner + StorageGuard
// ---------------------------------------------------------------------------
// Les apps métier surchargent ces routes si elles utilisent un dossier partagé
// synchronisé (OneDrive/Dropbox) avec détection de conflict copies. Par défaut
// le template renvoie une liste vide, ce qui désactive simplement le banner.
app.get("/api/storage/conflicts", (c) => {
  return c.json({ conflicts: [] });
});

// ---------------------------------------------------------------------------
// /api/onboarding-status : stub. Le template n'impose plus de wizard profil.
// ---------------------------------------------------------------------------
app.get("/api/onboarding-status", (c) => {
  return c.json({
    done: true,
  });
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
const port =
  Number(process.env["{{APP_NAME_KEBAB_UPPER}}_DAEMON_PORT"]) ||
  DAEMON_PORT_DEFAULT;

if (!findClaudeBin()) {
  console.warn(
    "[daemon] Claude Code CLI introuvable. Les routes /api/runs renverront 500 tant que le binaire `claude` n'est pas sur le PATH."
  );
}

serve({ fetch: app.fetch, port }, ({ port: p }) => {
  console.log(
    `[daemon] up on http://localhost:${p}  (dataDir=${DATA_DIR}, version=${APP_VERSION})`
  );
});
