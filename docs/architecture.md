# Architecture

## Vue d'ensemble

```
┌──────────────────────────────────────────────────────────────────────┐
│  Electron BrowserWindow ou navigateur cloud                          │
│  └─ http://localhost:3307/   ← Next.js sidecar / web app cloud        │
│                                                                      │
│  Next.js (app/) ────────────── apiFetch /api/* ───────┐              │
│                                                       │              │
│                 local                                ▼              │
│  Hono daemon (server/index.ts) sur :7707                  │
│   ├─ /api/health                                                     │
│   ├─ /api/actions    registry agentic-first UI ↔ HTTP ↔ MCP          │
│   ├─ /api/runs       POST  spawn subprocess                          │
│   ├─ /api/runs/:id/events  SSE                                       │
│   ├─ /api/skills     GET/PUT  YAML CRUD                              │
│   ├─ /api/audit/*    journal chaîné                                  │
│   └─ /api/app-config GET/PUT                                         │
│                                                                      │
│  MCP stdio (server/mcp.ts → dist/mcp.cjs)                            │
│   └─ expose les mêmes actions serveur en tools `<app>__...`          │
│                                                                      │
│  Supabase                                                            │
│   ├─ base métier par défaut, appelée côté daemon                      │
│   │  via `server/supabase.ts`                                         │
│   └─ Auth + Edge Functions en mode cloud                              │
│                                                                      │
│  Bridge local (bridge/index.ts)                                       │
│   ├─ poll `bridge-poll` côté cloud                                    │
│   ├─ exécute les jobs avec `server/runs.ts`                           │
│   └─ renvoie les events via `run-event-batch`                         │
│                                                                      │
│  Subprocess(es) orchestrés par le daemon :                           │
│   ├─ Claude Code CLI   spawn `claude -p --output-format stream-json` │
│   ├─ ou Maestro / HTTP / cli custom (cf. subprocess-patterns.md)     │
│                                                                      │
│  Données runtime locales :                                           │
│  ~/Library/Application Support/Bridge ERP Demo/data/                    │
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

## Base de données Supabase

Le template impose Supabase comme provider de base de données métier. Le daemon
reste la frontière applicative : l'UI et les tools MCP appellent les actions
serveur, puis ces actions lisent/écrivent Supabase via `server/supabase.ts`.

- Config publique : `SUPABASE_URL` / `SUPABASE_ANON_KEY` ou `/settings`.
- Secret serveur : `SUPABASE_SERVICE_ROLE_KEY`, uniquement en variable
  d'environnement du daemon, jamais saisi dans l'UI.
- Les fichiers locaux restent utiles pour le runtime Claude Code
  (`.claude/`, skills, logs de runs, audit local), mais les entités métier et
  workflows persistants doivent être modélisés dans Supabase.

## Mode cloud + bridge

Le template sait tourner en deux modes :

- `NEXT_PUBLIC_APP_API_MODE=local` : comportement Electron classique. Next.js
  rewrite `/api/*` vers le daemon Hono local ; les SSE tapent directement le
  daemon.
- `NEXT_PUBLIC_APP_API_MODE=cloud` : le navigateur appelle l'API web du service
  sur le meme domaine, ou `NEXT_PUBLIC_CLOUD_API_URL` si elle est séparée, et
  `CloudAuthGate` impose une session Supabase.

Dans le mode cloud, les traitements agentiques longs sont exécutés par un
bridge local installé sur un poste autorisé. Le bridge est un petit runtime
Node/Electron indépendant :

- `npm run bridge:install` écrit `~/.<app>-bridge/config.json`.
- `npm run bridge -- run` s'enregistre auprès du cloud, poll les jobs, lance le
  même moteur local que l'app Electron (`server/runs.ts`), puis remonte les
  événements et le statut final.
- `npm run bridge:build` bundle `bridge/index.ts` dans `dist/bridge/index.cjs`.
- `npm run bridge:pack:mac` / `bridge:pack:win` produisent un installateur
  séparé pour les postes opérateurs.

Contrat Edge Functions minimal :

- `POST /bridge-register`
- `POST /bridge-poll`
- `POST /run-event-batch`
- `POST /bridge-job-complete`

Chaque appel bridge envoie les headers `x-app-organization-id`,
`x-app-bridge-id`, `x-app-install-id`, `x-app-bridge-token` et un body JSON
contenant `organizationId`, `bridgeId`, `installId`, `sentAt`, `payload`.

## Agentic-first / MCP

Le template inclut un registry d'actions canonique dans `server/actions.ts`.
Toute mutation métier doit y vivre. Les routes Hono, l'UI Next.js et le serveur
MCP appellent les mêmes handlers.

- HTTP : `GET /api/actions`, `POST /api/actions/:id`.
- MCP stdio : `server/mcp.ts` en dev, `dist/mcp.cjs` en packagé.
- Claude Code : `server/agents.ts` génère automatiquement
  `<dataDir>/.claude/mcp.json` si absent et ajoute `--mcp-config` aux runs.
- Préfixe tools : `demo-erp__runs__start`,
  `demo-erp__runs__cancel`, `demo-erp__skills__list`, etc.

Invariant : si une action est visible dans l'UI, elle doit avoir une action
serveur et un tool MCP équivalent. Voir [`agentic-first.md`](agentic-first.md).

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

Le runtime agentique réel est **Codex CLI** (`codex exec --json`), pas Claude
Code. Les couches de sécurité effectives sont donc :

1. **Bind loopback** : le daemon Hono n'écoute que sur `127.0.0.1`
   (`serve({ ..., hostname: "127.0.0.1" })`). Aucune exposition réseau (LAN).
2. **Token de session daemon** : l'hôte Electron génère un token aléatoire par
   lancement, l'injecte au daemon (`APP_DAEMON_TOKEN`) et au renderer (preload).
   Toutes les routes `/api/*` (sauf `/api/health`) exigent ce token
   (`Authorization: Bearer` ou `?daemon_token=` pour le SSE), comparé en
   constant-time. Défense anti-CSRF depuis un navigateur tiers + anti-process
   local.
3. **Sandbox Codex** : `--sandbox read-only` par défaut. Les mutations métier
   passent par les outils MCP du daemon (validés + audités), pas par le shell.
   `workspace-write` / `danger-full-access` ne sont accordés que sur des chemins
   déjà confinés (et, côté bridge, sur scope explicite).
4. **Confinement des chemins (`server/path-guard.ts`)** : `cwd` et chaque
   `--add-dir` d'un run doivent résoudre SOUS une racine autorisée (dataDir +
   inputDir/outputDir/auditLogDir). `realpathSync.native`, anti-`..`,
   anti-symlink, fail-closed. C'est la barrière qui contient réellement les
   écritures sous Codex.
5. **Audit log chaîné** : voir section dédiée.

> Note runtime : les fichiers `.claude/settings.json` (`permissions.deny`) et le
> hook `.claude/hooks/restrict-write-paths.mjs` sont des constructs **Claude
> Code**. Ils ne s'exécutent PAS sous Codex et ne doivent donc pas être comptés
> comme une protection du runtime actuel ; ils restent utiles uniquement si
> l'app est branchée sur le runtime Claude Code. Le confinement effectif sous
> Codex est assuré par le point 4 ci-dessus.

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
