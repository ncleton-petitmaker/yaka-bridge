#!/usr/bin/env node
/**
 * Orchestrateur Factory — passe un `brief.md` à travers l'équipe d'agents
 * (Phase F.2) pour scaffolder une nouvelle app métier au-dessus du template.
 *
 * Usage :
 *   node scripts/new-app-from-brief.mjs \
 *     --brief examples/brief-hello-app.md \
 *     --output-dir /tmp/hello-app \
 *     [--template-dir <path>] \
 *     [--skip-install] \
 *     [--skip-typecheck] \
 *     [--dry-run] \
 *     [--yes] \
 *     [--force]
 *
 * Flow :
 *   1. Parse + valide le brief (Zod).
 *   2. Confirmation interactive (sauf --yes ou --dry-run).
 *   3. Clone template-dir → output-dir, supprime .git, lance init-from-template.mjs.
 *   4. Spawn agents séquentiellement :
 *        app-scaffolder → brand-identity-designer → domain-modeler
 *        → subprocess-driver → ui-page-generator → skill-author
 *      Chaque agent reçoit un prompt dérivé du brief ; sa sortie est appendée
 *      à output-dir/factory-journal.md.
 *   5. npm install + npx tsc --noEmit (sauf --skip-*).
 *   6. git init + commit "scaffold via factory@<version> from brief <name>".
 *   7. Rapport final stdout + factory-journal.md.
 *
 * En cas d'erreur, écrit output-dir/.factory-error.json pour debug.
 *
 * Voir docs/brief-format.md pour la syntaxe du brief.
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  readdirSync,
  appendFileSync,
} from "node:fs";
import { resolve, join, dirname, basename, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_TEMPLATE_DIR = resolve(__dirname, "..");
const AGENT_TIMEOUT_MS = 5 * 60 * 1000; // 5 min per agent

// ----- Brief schema -----

const BriefSchema = z.object({
  APP_NAME: z.string().min(1),
  APP_ID: z.string().regex(/^[a-z][a-z0-9.-]*$/, {
    message: "APP_ID must match /^[a-z][a-z0-9.-]*$/ (reverse domain).",
  }),
  NEXT_PORT: z.coerce.number().int().min(1024).max(65535),
  DAEMON_PORT: z.coerce.number().int().min(1024).max(65535),
  DATA_DIR_NAME: z.string().min(1),
  PROJECT_MODE: z.enum(["new", "adapt-existing"]).optional().default("new"),
  SOURCE_PROJECT_DIR: z.string().optional(),
  ADAPTATION_BRIEF: z.string().optional(),
  ENTITY: z.string().min(1),
  ENTITY_PLURAL: z.string().optional(),
  SUBPROCESS: z.string().min(1),
  DOMAIN_BRIEF: z.string().min(10),
  ENTITIES: z
    .array(
      z.object({
        name: z.string().min(1),
        description: z.string().optional(),
      })
    )
    .optional(),
  METRICS: z.array(z.string()).optional(),
  GIT_BINDING: z.string().optional(),
  EXTRA_ROUTES: z.array(z.string()).optional(),
  SKILLS: z.array(z.string()).optional(),
  MODULES: z.array(z.string()).optional().default([]),
  AGENTIC_FIRST: z.coerce.boolean().optional().default(true),
  MCP_ACTIONS: z.array(z.string()).optional(),
});

const CANONICAL_SUBPROCESS = [
  "codex-cli",
  "claude-cli",
  "maestro",
  "http-api",
  "cli-custom",
];

// ----- CLI args -----

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function requireArg(args, key) {
  const v = args[key];
  if (!v || v === true) {
    console.error(`[factory] --${key} requis`);
    process.exit(1);
  }
  return v;
}

// ----- Brief parsing -----

function readBrief(briefPath) {
  if (!existsSync(briefPath)) {
    throw new Error(`brief introuvable: ${briefPath}`);
  }
  const raw = readFileSync(briefPath, "utf8");
  // Strip frontmatter fences if present
  let body = raw;
  if (raw.startsWith("---\n")) {
    const end = raw.indexOf("\n---", 4);
    if (end !== -1) body = raw.slice(4, end);
  }
  // Strip leading markdown headings (lines starting with #) — preserve YAML.
  const cleaned = body
    .split("\n")
    .filter((l) => !/^#\s+/.test(l))
    .join("\n");
  let doc;
  try {
    doc = parseYaml(cleaned);
  } catch (err) {
    throw new Error(`brief YAML parse error: ${err.message}`);
  }
  if (!doc || typeof doc !== "object") {
    throw new Error("brief vide ou format invalide (attendu : objet YAML).");
  }
  // Normalise ENTITIES forme courte ("- batch" → "{ name: 'batch' }")
  if (Array.isArray(doc.ENTITIES)) {
    doc.ENTITIES = doc.ENTITIES.map((e) =>
      typeof e === "string" ? { name: e } : e
    );
  }
  if (typeof doc.MODULES === "string") {
    doc.MODULES = doc.MODULES.split(",").map((moduleId) => moduleId.trim()).filter(Boolean);
  }
  return doc;
}

function deducePlural(singular) {
  if (!singular) return singular;
  if (singular.endsWith("s")) return singular;
  if (singular.endsWith("y") && !/[aeiou]y$/.test(singular)) {
    return singular.slice(0, -1) + "ies";
  }
  return singular + "s";
}

function validateBrief(raw, templateDir = DEFAULT_TEMPLATE_DIR, options = {}) {
  const parsed = BriefSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (i) => `  - ${i.path.join(".") || "<root>"}: ${i.message}`
    );
    throw new Error(
      `brief invalide :\n${issues.join("\n")}`
    );
  }
  const brief = parsed.data;
  const warnings = [];
  if (brief.NEXT_PORT === brief.DAEMON_PORT) {
    throw new Error(
      `NEXT_PORT et DAEMON_PORT doivent différer (les deux valent ${brief.NEXT_PORT}).`
    );
  }
  if (!brief.ENTITY_PLURAL) {
    brief.ENTITY_PLURAL = deducePlural(brief.ENTITY);
    warnings.push(
      `ENTITY_PLURAL déduit automatiquement : "${brief.ENTITY_PLURAL}"`
    );
  }
  const subTokens = brief.SUBPROCESS.split(/[+,]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const hasCanonical = subTokens.some((t) =>
    CANONICAL_SUBPROCESS.includes(t)
  );
  if (!hasCanonical) {
    warnings.push(
      `SUBPROCESS="${brief.SUBPROCESS}" ne contient aucun token canonique (${CANONICAL_SUBPROCESS.join(", ")}). OK si volontaire.`
    );
  }
  if (Array.isArray(brief.EXTRA_ROUTES) && Array.isArray(brief.ENTITIES)) {
    const entityNames = [brief.ENTITY, brief.ENTITY_PLURAL, ...brief.ENTITIES.flatMap((e) => [e.name, deducePlural(e.name)])].filter(Boolean);
    const knownEntities = new Set(entityNames.map((n) => n.toLowerCase()));
    for (const route of brief.EXTRA_ROUTES) {
      const m = route.match(/\/api\/([a-z][a-z0-9_-]*)/i);
      if (
        m &&
        !knownEntities.has(m[1].toLowerCase()) &&
        !["git", "services", "skills", "audit-log", "runs", "health", "preferences", "qa-bank", "actions", "agents", "app-config"].includes(
          m[1].toLowerCase()
        ) &&
        !knownEntities.has(m[1].toLowerCase().replace(/-/g, "_"))
      ) {
        warnings.push(
          `EXTRA_ROUTES: "${route}" mentionne une ressource "${m[1]}" non listée dans ENTITIES.`
        );
      }
    }
  }
  const knownModules = availableModuleIds(templateDir);
  const unknownModules = brief.MODULES.filter((moduleId) => !knownModules.includes(moduleId));
  if (unknownModules.length) {
    throw new Error(`MODULES contient des modules inconnus: ${unknownModules.join(", ")}`);
  }
  if (!options.legacyEntity && brief.MODULES.length === 0) {
    throw new Error("MODULES doit contenir au moins un module catalogue. Utilise --legacy-entity pour un ancien scaffold ENTITY.");
  }
  return { brief, warnings };
}

function availableModuleIds(templateDir) {
  const modulesDir = resolve(templateDir, "modules");
  if (!existsSync(modulesDir)) return [];
  return readdirSync(modulesDir)
    .filter((entry) => {
      const configPath = join(modulesDir, entry, "module.config.json");
      return existsSync(configPath) && statSync(configPath).isFile();
    })
    .sort();
}

// ----- Interactive helpers -----

function ask(rl, question) {
  return new Promise((res) => rl.question(question, (a) => res(a)));
}

async function confirmInteractive(message) {
  if (!process.stdin.isTTY) {
    console.error(
      "[factory] stdin n'est pas un TTY — utilise --yes pour bypasser la confirmation."
    );
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = await ask(rl, `${message} [y/N] `);
    return /^y(es)?$/i.test(a.trim());
  } finally {
    rl.close();
  }
}

// ----- Filesystem helpers -----

function copyDirSync(src, dst, ignore) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src)) {
    if (ignore.includes(entry)) continue;
    const s = join(src, entry);
    const d = join(dst, entry);
    const st = statSync(s);
    if (st.isDirectory()) {
      copyDirSync(s, d, ignore);
    } else if (st.isFile()) {
      const buf = readFileSync(s);
      writeFileSync(d, buf);
    }
  }
}

// ----- Subprocess helpers -----

function checkCodexCli() {
  const r = spawnSync("codex", ["--version"], { encoding: "utf8" });
  if (r.error || r.status !== 0) return null;
  return r.stdout.trim() || "codex (version unknown)";
}

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: opts.stdio ?? "inherit",
      cwd: opts.cwd,
      env: opts.env ?? process.env,
    });
    let stdout = "";
    let stderr = "";
    if (opts.stdio !== "inherit") {
      child.stdout?.on("data", (d) => (stdout += d.toString()));
      child.stderr?.on("data", (d) => (stderr += d.toString()));
    }
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGTERM");
          reject(
            new Error(
              `${cmd} a dépassé le timeout (${opts.timeoutMs}ms) — killed`
            )
          );
        }, opts.timeoutMs)
      : null;
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr, code });
      } else {
        reject(
          new Error(
            `${cmd} exit code ${code}\nstdout: ${stdout.slice(0, 2000)}\nstderr: ${stderr.slice(0, 2000)}`
          )
        );
      }
    });
  });
}

// ----- Agents -----

const BASE_AGENTS = [
  {
    name: "app-scaffolder",
    description:
      "Finalise le scaffold (package.json, README, .gitignore) et initialise factory-journal.md.",
  },
  {
    name: "brand-identity-designer",
    description:
      "Trouve le nom court et génère le logo minimal de l'app en respectant le design system.",
  },
  {
    name: "domain-modeler",
    description:
      "Écrit server/types.ts à partir des ENTITIES et METRICS du brief.",
  },
  {
    name: "subprocess-driver",
    description:
      "Écrit server/<domain>-driver.ts + server/<domain>-runner.ts à partir de SUBPROCESS et types.",
  },
  {
    name: "ui-page-generator",
    description:
      "Génère les pages Next.js /<entities>, /<entities>/[id], /run.",
  },
  {
    name: "skill-author",
    description:
      "Génère 3-5 skills YAML dans skills-template/_global/ à partir de SKILLS et DOMAIN_BRIEF.",
  },
];

const ADAPTATION_PRE_AGENTS = [
  { name: "existing-project-auditor", description: "Audite le projet source en lecture seule et cartographie le portage." },
  { name: "migration-planner", description: "Planifie le portage par lots sûrs." },
  { name: "api-surface-mapper", description: "Mappe API/routes/services existants vers actions serveur typées." },
];

const ADAPTATION_POST_AGENTS = [
  { name: "data-migration-agent", description: "Prépare imports/migrations de données si nécessaires." },
  { name: "subprocess-adapter", description: "Adapte scripts/CLI/drivers existants en drivers Hono/Electron." },
  { name: "ui-migration-agent", description: "Porte l'UI existante vers le shell TeamFactory." },
];

const AGENTIC_FINAL_AGENTS = [
  { name: "mcp-parity-mapper", description: "Vérifie et complète la parité UI ↔ HTTP ↔ MCP." },
  { name: "security-config-auditor", description: "Audite secrets, permissions, MCP, paths et packaging." },
];

function buildAgentPlan(brief) {
  const isAdaptation = brief.PROJECT_MODE === "adapt-existing";
  return [
    ...(isAdaptation ? ADAPTATION_PRE_AGENTS : []),
    ...BASE_AGENTS,
    ...(isAdaptation ? ADAPTATION_POST_AGENTS : []),
    ...(brief.AGENTIC_FIRST === false ? [] : AGENTIC_FINAL_AGENTS),
  ];
}

function readAgentDescriptor(agentName, outputDir) {
  const candidates = [
    resolve(outputDir, "pi-electron-app-factory", "claude-agents", `${agentName}.md`),
    resolve(outputDir, ".claude", "agents", `${agentName}.md`),
    resolve(process.env.HOME || "", ".claude", "agents", `${agentName}.md`),
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) return { path: p, content: readFileSync(p, "utf8") };
    } catch {}
  }
  return { path: null, content: `# ${agentName}\n\nNo descriptor found. Execute the agent scope from the factory prompt.` };
}

function buildAgentPrompt(agentName, brief, outputDir) {
  const descriptor = readAgentDescriptor(agentName, outputDir);
  const header = [
    `# Agent: ${agentName}`,
    "",
    `## Agent descriptor (${descriptor.path ?? "inline descriptor"})`,
    "",
    "```markdown",
    descriptor.content,
    "```",
    "",
    "",
    `## App context`,
    `- APP_NAME: ${brief.APP_NAME}`,
    `- APP_ID: ${brief.APP_ID}`,
    `- NEXT_PORT: ${brief.NEXT_PORT}`,
    `- DAEMON_PORT: ${brief.DAEMON_PORT}`,
    `- DATA_DIR_NAME: ${brief.DATA_DIR_NAME}`,
    `- PROJECT_MODE: ${brief.PROJECT_MODE ?? "new"}`,
    ...(brief.SOURCE_PROJECT_DIR ? [`- SOURCE_PROJECT_DIR: ${brief.SOURCE_PROJECT_DIR}`] : []),
    `- AGENTIC_FIRST: ${brief.AGENTIC_FIRST !== false}`,
    `- MODULES: ${brief.MODULES.join(", ")}`,
    `- ENTITY: ${brief.ENTITY} (plural: ${brief.ENTITY_PLURAL})`,
    `- SUBPROCESS: ${brief.SUBPROCESS}`,
    `- OUTPUT_DIR: ${outputDir}`,
    "",
    `## Domain brief`,
    brief.DOMAIN_BRIEF,
    "",
  ];
  if (brief.ENTITIES?.length) {
    header.push("## Entities");
    for (const e of brief.ENTITIES) {
      header.push(`- ${e.name}: ${e.description ?? ""}`);
    }
    header.push("");
  }
  if (brief.METRICS?.length) {
    header.push("## Metrics");
    for (const m of brief.METRICS) header.push(`- ${m}`);
    header.push("");
  }
  if (brief.GIT_BINDING) {
    header.push("## Git binding");
    header.push(brief.GIT_BINDING);
    header.push("");
  }
  if (brief.ADAPTATION_BRIEF) {
    header.push("## Adaptation brief");
    header.push(brief.ADAPTATION_BRIEF);
    header.push("");
  }
  if (brief.EXTRA_ROUTES?.length) {
    header.push("## Extra routes");
    for (const r of brief.EXTRA_ROUTES) header.push(`- ${r}`);
    header.push("");
  }
  if (brief.MCP_ACTIONS?.length) {
    header.push("## MCP actions required");
    for (const a of brief.MCP_ACTIONS) header.push(`- ${a}`);
    header.push("");
  }
  if (brief.SKILLS?.length) {
    header.push("## Skills to author");
    for (const s of brief.SKILLS) header.push(`- ${s}`);
    header.push("");
  }
  header.push(
    "## Mission",
    `Read the embedded agent descriptor above and execute its scope.`,
    `When done, append your report to ${outputDir}/factory-journal.md as "## ${agentName} <ISO timestamp>".`,
    `Leave TODOs in code as "// TODO(factory):" so the orchestrator can grep them.`,
    ""
  );
  return header.join("\n");
}

async function spawnAgent(agent, brief, outputDir, opts) {
  const prompt = buildAgentPrompt(agent.name, brief, outputDir);
  const promptPath = join(outputDir, `.factory-prompt-${agent.name}.md`);
  writeFileSync(promptPath, prompt, "utf8");

  const journalPath = join(outputDir, "factory-journal.md");
  appendFileSync(
    journalPath,
    `\n---\n## ${agent.name} ${new Date().toISOString()}\n\n` +
      `(prompt written to ${basename(promptPath)})\n\n`,
    "utf8"
  );

  if (opts.dryRun) {
    appendFileSync(
      journalPath,
      `DRY-RUN: would spawn \`codex exec\` with prompt above.\n`,
      "utf8"
    );
    return { ok: true, skipped: "dry-run" };
  }

  if (!opts.codexAvailable) {
    appendFileSync(
      journalPath,
      `SKIPPED: codex CLI introuvable. Prompt préparé dans ${basename(promptPath)} ; relance manuellement quand codex est dispo.\n`,
      "utf8"
    );
    return { ok: false, skipped: "no-codex-cli" };
  }

  try {
    const result = await runCmd(
      "codex",
      [
        "exec",
        "--cd", outputDir,
        "--add-dir", outputDir,
        "--sandbox", "workspace-write",
        "--skip-git-repo-check",
        "--color", "never",
        prompt,
      ],
      {
        cwd: outputDir,
        stdio: ["ignore", "pipe", "pipe"],
        timeoutMs: AGENT_TIMEOUT_MS,
      }
    );
    appendFileSync(
      journalPath,
      `### stdout\n\n\`\`\`\n${result.stdout.slice(0, 8000)}\n\`\`\`\n`,
      "utf8"
    );
    return { ok: true };
  } catch (err) {
    appendFileSync(
      journalPath,
      `ERROR: ${err.message}\n`,
      "utf8"
    );
    return { ok: false, error: err.message };
  }
}

// ----- Step: clone template -----

async function cloneTemplate(templateDir, outputDir, opts) {
  if (opts.dryRun) {
    console.log(
      `[dry-run] copierait ${templateDir} → ${outputDir} (sans artefacts locaux lourds)`
    );
    return;
  }
  const ignore = [
    ".git",
    "node_modules",
    ".next",
    "out",
    "build",
    "dist",
    "release",
    "release-bridge",
    "data",
    "Projets",
    ".pi",
    ".cache",
    ".temp",
    "vendor",
    "evaluations",
    ".branches",
    ".factory-meta.json",
    ".factory-error.json",
    "brief.generated.md",
    "electron-main.cjs",
    "mcp.cjs",
    "runtime.cjs",
  ];
  copyDirSync(templateDir, outputDir, ignore);
}

// ----- Step: run init-from-template inside outputDir -----

async function runInitFromTemplate(brief, outputDir, opts) {
  const args = [
    "scripts/init-from-template.mjs",
    "--app-name",
    brief.APP_NAME,
    "--app-id",
    brief.APP_ID,
    "--next-port",
    String(brief.NEXT_PORT),
    "--daemon-port",
    String(brief.DAEMON_PORT),
    "--data-dir",
    brief.DATA_DIR_NAME,
    "--entity-name",
    brief.ENTITY,
    "--entity-name-plural",
    brief.ENTITY_PLURAL,
    "--domain-brief",
    brief.DOMAIN_BRIEF.trim().split("\n").join(" "),
  ];
  if (opts.dryRun) {
    console.log(
      `[dry-run] aurait lancé : (cd ${outputDir} && node ${args.join(" ")})`
    );
    return;
  }
  await runCmd("node", args, { cwd: outputDir });
}

// ----- Step: configure selected ERP modules -----

function configureModules(brief, outputDir, opts) {
  const selected = Array.from(new Set(brief.MODULES ?? []));
  if (opts.dryRun) {
    console.log(`[dry-run] modules selection: ${selected.join(", ")}`);
    return { selected, mode: "dry-run" };
  }
  const modulesDir = join(outputDir, "modules");
  if (!existsSync(modulesDir)) return { selected, mode: "no-modules-dir" };
  const available = availableModuleIds(outputDir);
  if (selected.length) {
    for (const moduleId of available) {
      if (!selected.includes(moduleId)) {
        rmSync(join(modulesDir, moduleId), { recursive: true, force: true });
      }
    }
    writeModuleRegistry(modulesDir, selected);
  }
  const manifests = selected.map((moduleId) => {
    const manifestPath = join(modulesDir, moduleId, "module.config.json");
    return JSON.parse(readFileSync(manifestPath, "utf8"));
  });
  writeFileSync(
    join(outputDir, ".factory-modules.json"),
    `${JSON.stringify({
      selectedModules: selected,
      manifests,
      generatedAt: new Date().toISOString(),
    }, null, 2)}\n`,
    "utf8"
  );
  return { selected, mode: "selected" };
}

function writeModuleRegistry(modulesDir, selected) {
  const imports = selected
    .map((moduleId) => `import { ${moduleIdToExportName(moduleId)} } from "./${moduleId}";`)
    .join("\n");
  const entries = selected.map(moduleIdToExportName).join(", ");
  const body = `${imports}\nimport type { ErpModuleManifest } from "./types";\n\n` +
    `export const erpModules = [${entries}] satisfies ErpModuleManifest[];\n\n` +
    `export function getErpModule(moduleId: string): ErpModuleManifest | undefined {\n` +
    `  return erpModules.find((module) => module.id === moduleId);\n` +
    `}\n\n` +
    `export function assertKnownModules(moduleIds: string[]): void {\n` +
    `  const known = new Set(erpModules.map((module) => module.id));\n` +
    `  const unknown = moduleIds.filter((moduleId) => !known.has(moduleId));\n` +
    `  if (unknown.length) throw new Error(\`Unknown ERP module(s): \${unknown.join(", ")}\`);\n` +
    `}\n`;
  writeFileSync(join(modulesDir, "registry.ts"), body, "utf8");
}

function moduleIdToExportName(moduleId) {
  return `${moduleId.replace(/(^|[-_])([a-z])/g, (_m, _sep, chr) => chr.toUpperCase())}Module`.replace(/^([A-Z])/, (m) => m.toLowerCase());
}

// ----- Step: post-scaffold (install + typecheck + git) -----

async function runValidation(outputDir, opts) {
  const results = { install: null, typecheck: null, git: null };
  if (!opts.skipInstall) {
    if (opts.dryRun) {
      console.log("[dry-run] aurait lancé : npm install");
      results.install = "skipped:dry-run";
    } else {
      try {
        await runCmd("npm", ["install"], { cwd: outputDir });
        results.install = "ok";
      } catch (err) {
        results.install = `error: ${err.message}`;
      }
    }
  } else {
    results.install = "skipped";
  }

  if (!opts.skipTypecheck) {
    if (opts.dryRun) {
      console.log("[dry-run] aurait lancé : npx tsc --noEmit");
      results.typecheck = "skipped:dry-run";
    } else {
      try {
        await runCmd("npx", ["tsc", "--noEmit"], { cwd: outputDir });
        results.typecheck = "ok";
      } catch (err) {
        results.typecheck = `error: ${err.message}`;
      }
    }
  } else {
    results.typecheck = "skipped";
  }

  if (opts.dryRun) {
    results.git = "skipped:dry-run";
  } else {
    try {
      await runCmd("git", ["init"], { cwd: outputDir });
      await runCmd("git", ["add", "-A"], { cwd: outputDir });
      await runCmd(
        "git",
        [
          "commit",
          "-m",
          `scaffold via factory@${opts.templateVersion} from brief ${opts.briefName}`,
        ],
        { cwd: outputDir }
      );
      results.git = "ok";
    } catch (err) {
      results.git = `error: ${err.message}`;
    }
  }
  return results;
}

// ----- Step: gather TODOs -----

function gatherTodos(outputDir) {
  if (!existsSync(outputDir)) return [];
  const todos = [];
  function walk(dir) {
    const rel = relative(outputDir, dir);
    if (
      [
        "node_modules",
        ".git",
        ".next",
        "dist",
        "release",
      ].some((ig) => rel === ig || rel.startsWith(ig + "/"))
    ) {
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (st.isFile() && /\.(ts|tsx|js|cjs|mjs|md|yaml|yml)$/.test(entry)) {
        let content;
        try {
          content = readFileSync(full, "utf8");
        } catch {
          continue;
        }
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes("TODO(factory)")) {
            todos.push(
              `${relative(outputDir, full)}:${i + 1}: ${lines[i].trim()}`
            );
          }
        }
      }
    }
  }
  walk(outputDir);
  return todos;
}

// ----- Main -----

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || args.h) {
    console.log(
      `Usage: node scripts/new-app-from-brief.mjs --brief <path> --output-dir <path> [options]\n` +
        `\nOptions :\n` +
        `  --template-dir <path>   default: parent dir of this script\n` +
        `  --skip-install          ne pas faire npm install\n` +
        `  --skip-typecheck        ne pas faire npx tsc --noEmit\n` +
        `  --dry-run               affiche les actions, n'exécute rien\n` +
        `  --skip-agents           configure sans lancer Codex, pour CI\n` +
        `  --legacy-entity         autorise un brief sans MODULES\n` +
        `  --yes                   bypass confirmation interactive\n` +
        `  --force                 overwrite output-dir s'il existe déjà\n`
    );
    process.exit(0);
  }

  const briefPath = resolve(requireArg(args, "brief"));
  const outputDir = resolve(requireArg(args, "output-dir"));
  const templateDir = resolve(
    args["template-dir"] && args["template-dir"] !== true
      ? args["template-dir"]
      : DEFAULT_TEMPLATE_DIR
  );
  const opts = {
    dryRun: !!args["dry-run"],
    skipInstall: !!args["skip-install"],
    skipTypecheck: !!args["skip-typecheck"],
    skipAgents: !!args["skip-agents"],
    legacyEntity: !!args["legacy-entity"],
    yes: !!args.yes,
    force: !!args.force,
    briefName: basename(briefPath, ".md"),
  };

  console.log("=== Factory orchestrator ===");
  console.log(`  brief        : ${briefPath}`);
  console.log(`  output-dir   : ${outputDir}`);
  console.log(`  template-dir : ${templateDir}`);
  if (opts.dryRun) console.log("  mode         : DRY-RUN");

  // 1. Parse + validate brief
  let brief;
  let warnings;
  try {
    const raw = readBrief(briefPath);
    const v = validateBrief(raw, templateDir, opts);
    brief = v.brief;
    warnings = v.warnings;
  } catch (err) {
    console.error(`\n[factory] ${err.message}`);
    process.exit(1);
  }

  // Load template version from template.config.json
  let templateVersion = "unknown";
  try {
    const cfg = JSON.parse(
      readFileSync(resolve(templateDir, "template.config.json"), "utf8")
    );
    templateVersion = cfg.templateVersion ?? "unknown";
  } catch {
    /* tolérant */
  }
  opts.templateVersion = templateVersion;

  console.log("\n--- Brief validé ---");
  for (const [k, v] of Object.entries(brief)) {
    const s =
      typeof v === "string"
        ? v.length > 80
          ? v.slice(0, 80) + "…"
          : v
        : JSON.stringify(v);
    console.log(`  ${k} = ${s}`);
  }
  if (warnings.length) {
    console.log("\n--- Warnings ---");
    for (const w of warnings) console.log(`  ! ${w}`);
  }

  // 2. Check Codex CLI (agent runner)
  const codexVersion = opts.skipAgents ? null : checkCodexCli();
  if (!codexVersion && !opts.dryRun && !opts.skipAgents) {
    console.log(
      `\n[factory] WARNING: \`codex\` CLI introuvable dans le PATH.`
    );
    console.log(
      `         Install/login: codex login`
    );
    console.log(
      `         Les agents seront skipped (prompts écrits dans .factory-prompt-*.md).`
    );
  } else if (opts.skipAgents) {
    console.log("\n[factory] agents: skipped by --skip-agents");
  } else if (codexVersion) {
    console.log(`\n[factory] codex CLI: ${codexVersion}`);
  }

  // 3. Check output-dir
  const outputExists = existsSync(outputDir);
  if (outputExists && !opts.force) {
    if (opts.dryRun) {
      console.log(
        `\n[dry-run] output-dir existe déjà : ${outputDir} (force requis pour overwrite).`
      );
    } else {
      const ok = opts.yes
        ? false
        : await confirmInteractive(
            `output-dir existe déjà : ${outputDir}. Overwrite (rm -rf puis recréer) ?`
          );
      if (!ok) {
        console.error(
          "[factory] abort. Utilise --force pour skip cette question."
        );
        process.exit(1);
      }
      rmSync(outputDir, { recursive: true, force: true });
    }
  } else if (outputExists && opts.force && !opts.dryRun) {
    rmSync(outputDir, { recursive: true, force: true });
  }

  const parentDir = dirname(outputDir);
  if (!existsSync(parentDir)) {
    console.error(`[factory] parent dir n'existe pas : ${parentDir}`);
    process.exit(1);
  }

  // 4. Confirmation
  if (!opts.yes && !opts.dryRun) {
    const ok = await confirmInteractive(
      `Scaffolder ${brief.APP_NAME} dans ${outputDir} ?`
    );
    if (!ok) {
      console.log("[factory] abort par l'utilisateur.");
      process.exit(0);
    }
  }

  // 5. Execute
  const report = {
    brief: opts.briefName,
    outputDir,
    templateVersion,
    startedAt: new Date().toISOString(),
    steps: {},
    agents: {},
    todos: [],
    finishedAt: null,
  };

  try {
    // Step 1: clone
    console.log("\n[factory] Step 1 — clone template");
    await cloneTemplate(templateDir, outputDir, opts);
    report.steps.clone = "ok";

    // Step 2: init-from-template
    console.log("[factory] Step 2 — init-from-template (placeholders)");
    await runInitFromTemplate(brief, outputDir, opts);
    report.steps.init = "ok";

    console.log("[factory] Step 2b — configure ERP modules");
    report.steps.modules = configureModules(brief, outputDir, opts);

    // Initialise factory-journal.md
    if (!opts.dryRun) {
      const journalPath = join(outputDir, "factory-journal.md");
      writeFileSync(
        journalPath,
        `# Factory journal — ${brief.APP_NAME}\n\n` +
          `- Brief: ${opts.briefName}\n` +
          `- Template version: ${templateVersion}\n` +
          `- Started: ${report.startedAt}\n`,
        "utf8"
      );
    }

    // Step 3: spawn agents
    console.log("[factory] Step 3 — spawn agents");
    const agentOpts = {
      ...opts,
      codexAvailable: !!codexVersion,
    };
    const agentPlan = buildAgentPlan(brief);
    report.agentPlan = agentPlan.map((a) => a.name);
    for (const agent of agentPlan) {
      console.log(`  - ${agent.name}`);
      if (opts.skipAgents) {
        report.agents[agent.name] = "skipped:skip-agents";
        continue;
      }
      if (opts.dryRun) {
        // In dry-run we don't have an output dir to write to, skip prompt write
        report.agents[agent.name] = "dry-run";
        continue;
      }
      const r = await spawnAgent(agent, brief, outputDir, agentOpts);
      report.agents[agent.name] = r.ok ? "ok" : r.skipped ?? r.error;
    }

    // Step 4: validation
    console.log("[factory] Step 4 — validation (install + typecheck + git)");
    const v = await runValidation(outputDir, opts);
    Object.assign(report.steps, v);

    // Step 5: gather TODOs
    if (!opts.dryRun) {
      report.todos = gatherTodos(outputDir);
    }

    report.finishedAt = new Date().toISOString();

    // Final report
    console.log("\n=== Rapport final ===");
    console.log(JSON.stringify(report, null, 2));
    if (!opts.dryRun) {
      const journalPath = join(outputDir, "factory-journal.md");
      appendFileSync(
        journalPath,
        `\n---\n## Final report ${report.finishedAt}\n\n` +
          "```json\n" +
          JSON.stringify(report, null, 2) +
          "\n```\n\n" +
          `### TODOs (${report.todos.length})\n\n` +
          (report.todos.length
            ? report.todos.map((t) => `- ${t}`).join("\n")
            : "_aucun_") +
          "\n\n### Next steps\n\n" +
          `\`\`\`bash\ncd ${outputDir}\nnpm run electron\n\`\`\`\n`,
        "utf8"
      );
      console.log(`\nJournal: ${journalPath}`);
    }
    console.log(`\nNext: cd ${outputDir} && npm run electron`);
  } catch (err) {
    report.finishedAt = new Date().toISOString();
    report.error = err.message;
    console.error(`\n[factory] ERROR: ${err.message}`);
    try {
      if (existsSync(outputDir)) {
        writeFileSync(
          join(outputDir, ".factory-error.json"),
          JSON.stringify(report, null, 2),
          "utf8"
        );
        console.error(
          `[factory] contexte écrit dans ${outputDir}/.factory-error.json`
        );
      }
    } catch {
      /* ignore */
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\n[factory] uncaught: ${err?.stack || err}`);
  process.exit(1);
});
