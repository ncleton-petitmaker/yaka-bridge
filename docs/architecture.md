# Architecture

## Vue d'ensemble

```
┌──────────────────────────────────────────────────────────────────────┐
│  Electron BrowserWindow                                              │
│  └─ http://localhost:{{NEXT_PORT}}/   ← Next.js sidecar              │
│                                                                      │
│  Next.js (app/) ────────────── fetch /api/* ──────────┐              │
│                                                       │              │
│                                                       ▼              │
│  Hono daemon (server/index.ts) sur :{{DAEMON_PORT}}                  │
│   ├─ /api/health                                                     │
│   ├─ /api/runs       POST  spawn subprocess                          │
│   ├─ /api/runs/:id/events  SSE                                       │
│   ├─ /api/skills     GET/PUT  YAML CRUD                              │
│   ├─ /api/audit/*    journal chaîné                                  │
│   └─ /api/app-config GET/PUT                                         │
│                                                                      │
│  Subprocess(es) orchestrés par le daemon :                           │
│   ├─ Claude Code CLI   spawn `claude -p --output-format stream-json` │
│   ├─ ou Maestro / HTTP / cli custom (cf. subprocess-patterns.md)     │
│                                                                      │
│  Données runtime :                                                   │
│  ~/Library/Application Support/{{APP_NAME}}/data/                    │
│  ├── .claude/                                                        │
│  │   ├── app-config.json    config persistante                       │
│  │   ├── CLAUDE.md          posture envoyée à Claude                 │
│  │   ├── settings.json      permissions.deny + hooks                 │
│  │   ├── audit-log/<user>/YYYY-MM-DD.jsonl   chaîne SHA-256          │
│  │   └── skills/_global/    skills YAML                              │
│  ├── runs/<tag>.events.jsonl  events persistés (replay)              │
│  └── …                                                               │
└──────────────────────────────────────────────────────────────────────┘
```

## Flux d'un run

1. **UI envoie** `POST /api/runs { prompt, tag?, model?, addDirs?, ... }`
2. **Daemon** (`server/index.ts`) charge `loadAppConfig(DATA_DIR)`, construit la
   whitelist `addDirs` (dataDir + inputDir/outputDir/auditLogDir),
   appelle `startRun()` dans `server/runs.ts`.
3. **`startRun`** spawn `claude` avec :
   - `-p --output-format stream-json --verbose --include-partial-messages`
   - `--effort low` (Sonnet 4.6+ default = high → thinking adaptatif long)
   - `--max-turns 30` (circuit breaker)
   - `--allowedTools Read,Write,Glob,Skill` (whitelist conservatrice)
   - `--add-dir <addDirs>`
   - `--permission-mode bypassPermissions`
   - `--mcp-config <dataDir>/.claude/mcp.json` si présent
   - env `CLAUDE_CODE_DISABLE_THINKING=1` + `CI=1` + `NO_COLOR=1`
4. **`StreamParser`** (`server/parse-stream.ts`) parse chaque ligne JSON et
   émet des `AgentEvent` typés : `text_delta`, `tool_use_start/end`, `usage`,
   `result`, etc.
5. **`broadcast()`** agrège les `usage` events dans `UsageTotals` avec dédup
   par `message_id` (input/cache identiques entre `message_start` et `assistant`,
   output_tokens final dans `assistant`), recalcule `cost_usd` via `pricing.ts`.
6. **SSE GET /api/runs/:id/events** : un listener est attaché ; on rejoue
   d'abord les events accumulés (replay) puis on streame en live jusqu'à
   `succeeded` / `failed` / `cancelled`.
7. **À la fin** : si `run.tag` est défini, persiste les events dans
   `<cwd>/runs/<tag>.events.jsonl`.

## Sécurité

Trois couches :

1. **Claude CLI** : `--add-dir` whitelist (pas une sandbox stricte d'après la doc).
2. **`.claude/settings.json`** : `permissions.deny = ["Bash", "WebFetch", "WebSearch"]`.
3. **Hook PreToolUse `restrict-write-paths.mjs`** : exit 2 si le path d'écriture
   n'est pas dans la whitelist construite depuis app-config.json. Anti-`..` et
   anti-symlinks (resolve + realpath).

## Audit log

`server/audit-log.ts` : un fichier JSONL par utilisateur par jour
(`<user-slug>/YYYY-MM-DD.jsonl`). Chaque entrée contient `prev_hash` (SHA-256
de l'entrée précédente, canonicalisée) et `hash` (SHA-256 de l'entrée elle-même
avec son prev_hash). `verifyAuditLogIntegrity()` revalide la chaîne.

Schéma minimal d'une entrée :

```json
{
  "event_id": "uuid",
  "timestamp": "2026-05-17T09:23:45.123Z",
  "actor_id": "alice",
  "actor_role": "admin",
  "action": "run.start",
  "resource_type": "run",
  "resource_id": "<runId>",
  "result": "success",
  "app_version": "0.0.1",
  "client_ip": "local",
  "metadata": { "tag": "batch-42", "model": "sonnet" },
  "prev_hash": "0000…",
  "hash": "a1b2c3…"
}
```

## Skills

Layout (déployé à `<dataDir>/.claude/skills/`) :

```
_global/                skills par défaut (versionnés avec l'app, écrasés au boot)
_perso/<user-slug>/     surcharges personnelles
_propositions/          propositions en review
_snapshots/             snapshots pris avant promotion (revert)
```

Résolution Claude Code : `_perso/<user>/` > `_global/`. Les propositions ne
sont pas chargées automatiquement par Claude, elles passent par un workflow
admin (à implémenter au niveau app si besoin).

Format : YAML frontmatter + corps markdown.

```yaml
---
name: ma-règle
description: Ce que fait la règle
version: 1
---

Corps markdown lu par Claude quand il invoque la skill.
```

## Packaging

`scripts/prepare-pack.mjs` orchestre :

1. Clean `.next/` + `dist/`
2. `scripts/build-server.mjs` : esbuild bundle `server/index.ts` → `dist/server.cjs`
3. `next build` (output `standalone`)
4. Copie `.next/static/` et `public/` dans `.next/standalone/` (le standalone
   ne les inclut pas automatiquement, sinon le HTML servi a des 404 sur CSS/JS).

Puis `electron-builder --mac` ou `--win --x64` :

- `asar: true` ; **`asarUnpack`** :
  - `**/*.node` (binaires natifs)
  - `dist/**` (server.cjs)
  - `.next/standalone/**` (le runtime Next ne sait pas lire dans un asar)
  - `skills-template/**` (`fs.readFileSync` au boot du daemon)
  - `data-template/**` (idem)
- `afterPack` : `scripts/electron-builder-after-pack.cjs` re-copie
  `.next/standalone/.next/static` (electron-builder le filtre mystérieusement).
