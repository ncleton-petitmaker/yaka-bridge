# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev              # daemon (port 7456) + Next.js (port 3100) en parallèle
npm run typecheck        # tsc --noEmit, à lancer avant tout commit
npm run build            # next build (production)
node scripts/start.js   # démarre le bundle prod (post-build)
npm run electron         # lance l'app Electron en dev
npm run electron:pack:mac   # build DMG mac (bumper version dans package.json avant)
npm run electron:pack:win   # build NSIS windows
npm run calibrer         # pipeline calibrage IA vs humain (tsx scripts/calibrer.ts)
```

Toujours bumper `version` dans `package.json` (+1 patch) avant `electron:pack:*`.

## Architecture

### Vue d'ensemble

Application Electron (desktop) composée de deux processus :
- **Daemon Hono** (`server/index.ts`, port 7456) : orchestre les runs Claude Code, gère l'état, expose une API REST + SSE.
- **UI Next.js** (`app/`, port 3100) : interface évaluateurs, communique avec le daemon via `lib/client.ts`.

En mode Electron, `electron/main.cjs` lance les deux processus et affiche l'UI dans une BrowserWindow. En mode serveur nu, `scripts/start.js` fait la même chose sans Chrome.

### Flux d'évaluation

1. UI POST `/api/runs` → daemon crée un `RunRecord` et spawne `claude -p --output-format stream-json` via `server/agents.ts::buildClaudeArgs()`.
2. Le daemon pipe le stdout du CLI dans `server/parse-stream.ts::StreamParser` qui émet des `AgentEvent` typés.
3. `server/runs.ts::broadcast()` agrège les events en mémoire + cumule les tokens dans `UsageTotals` (dédup par `message_id` pour éviter le double-compte input/cache entre `message_start` et `assistant`).
4. L'UI SSE-stream les events via GET `/api/runs/:id/stream` → `StreamingPanel.tsx` les affiche en temps réel.
5. À la fin du run, les events sont persistés dans `data/evaluations/<id>.events.jsonl` pour replay après redémarrage.

### Fichiers clés

| Fichier | Rôle |
|---------|------|
| `server/agents.ts` | Localise le binaire `claude`, construit les args CLI (`-p`, `stream-json`, `--effort low`, `--max-turns 30`, MCP config) |
| `server/runs.ts` | Cycle de vie des runs, agrégation `UsageTotals`, fan-out SSE, cleanup zombies |
| `server/parse-stream.ts` | Parse le format `stream-json` Claude Code → `AgentEvent` (inclut extraction usage avec détail cache 5m/1h) |
| `server/pricing.ts` | Tarifs Anthropic ($/M tokens), `computeCostUsd()`, `UsageTotals` |
| `server/run-history.ts` | Persistance `.events.jsonl`, extraction dossier_id depuis le prompt |
| `server/dossiers.ts` | Liste les dossiers candidatures, déduit le statut depuis le JSON d'évaluation |
| `server/skills.ts` | CRUD skills YAML (global/perso/proposition) avec frontmatter |
| `server/calibrage-runs.ts` | Pipeline calibrage (runs batch sur corpus 6e pour comparer IA/humain) |
| `server/audit-log.ts` | Journal d'audit chaîné (hash HMAC pour intégrité) |
| `server/campaigns.ts` | Campagnes d'évaluation (regroupement, activation) |
| `components/StreamingPanel.tsx` | Affichage temps réel des events, agrégation en blocs visuels |
| `components/CriteresGrid.tsx` | Grille des critères d'évaluation FAE |
| `app/evaluation/page.tsx` | Page principale : liste dossiers + streaming + review form |
| `app/logs/page.tsx` | Visualisation audit log |

### Données runtime

```
data/
  candidatures-7e/      # PDFs en lecture seule (input_dir configurable)
  evaluations/          # JSONs résultats + .events.jsonl (replay)
  calibrage/            # rapports de calibrage JSON
  .claude/
    skills/             # skills YAML globaux/perso/propositions
    mcp.json            # config MCP serveur xlsx-reader (généré au boot)
    settings.json       # hooks PreToolUse + deny rules sécurité
```

`data-template/` contient la structure vierge déployée par `scripts/postinstall.js` au premier lancement.

### Coût des runs

Coût réel mesuré sur les runs 7e (Sonnet 4.6) : **~4,65 USD/dossier** en moyenne, dominé à ~82% par le cache_create_1h (lecture PDFs). Les tokens de sortie sont négligeables (~107/dossier). `getRunUsage(runId)` dans `runs.ts` expose les totaux en temps réel.

### Skills

Les skills sont des fichiers YAML avec frontmatter chargés par Claude au démarrage d'un run. La hiérarchie de résolution : perso > global > skills-template embarqués. Les propositions de règles (améliorations suggérées par Claude lors des évaluations) passent par un workflow de review admin avant promotion.

### Sécurité

- Claude tourne en `bypassPermissions` mais les paths Write/Edit sont validés par un hook `PreToolUse` dans `data/.claude/settings.json`.
- Les deny rules dans `settings.json` bloquent l'accès hors des dossiers autorisés via `--add-dir`.
- L'audit log est chaîné (chaque entrée hash la précédente) : `server/audit-log.ts`.

### MCP

Un serveur MCP local (`electron/mcp-xlsx.cjs`, bundlé dans `dist/mcp-xlsx.cjs`) expose `mcp__office__read_xlsx` et `mcp__office__read_docx` (server name = "office" dans mcp.json). La config est générée au boot dans `data/.claude/mcp.json` et passée à Claude via `--mcp-config`.

## Conventions

- Daemon : TypeScript ESM compilé à la volée avec `tsx`. Pas de bundling côté serveur en dev.
- UI : Next.js App Router, pas de `use server`, tout le fetch passe par `lib/client.ts` vers le daemon.
- Les events `usage` Claude Code peuvent arriver en double (message_start + assistant avec le même `message_id`) : toujours dédupliquer via `usageByMessageId` comme dans `runs.ts::broadcast()`.
- Tiret normal (-) uniquement, jamais tiret cadratin (—).
