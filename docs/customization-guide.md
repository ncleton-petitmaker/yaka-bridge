# Customization guide

Où poser le code domain quand on étend le template pour une app métier.

## Règle générale

Le template fournit **les invariants** :

- pipeline daemon Hono + Next.js + spawn Claude + parser stream-json,
- skills YAML + audit log + app-config,
- packaging Electron,
- placeholders rebrandables.

Le template **n'a pas** :

- de types domain (Dossier, Batch, Question, …)
- de subprocess métier (Maestro, MCP custom, …)
- de routes métier
- de pages métier
- de skills par défaut

C'est le rôle de la **factory** (cf. Part F du plan) — ou du dev si on
scaffolde à la main — de remplir ces blancs.

## Types domain

Fichier : **`server/types.ts`** (déjà présent, contient juste `AgentEvent`,
`RunRecord`, `UsageInfo`).

Y ajouter les interfaces métier :

```ts
// server/types.ts
// … types template existants …

export interface Batch {
  id: string;
  createdAt: number;
  commitSha: string;
  questionIds: string[];
  status: "running" | "succeeded" | "failed";
}

export interface QuestionResult {
  batchId: string;
  questionId: string;
  apiLatencyMs: number;
  uiLatencyMs: number;
  hallucination: boolean;
  reply: string;
  goldDiff: string;
}
```

Optionnel : mirror les types côté UI dans `lib/types.ts`.

## Subprocess driver

Le template ne sait spawner que `claude` (cf. `server/agents.ts` +
`server/runs.ts` + `server/parse-stream.ts`). Pour un subprocess métier
(Maestro, HTTP, CLI custom), créer un fichier dédié :

- **`server/<domain>-driver.ts`** : wrapper de bas niveau (spawn, parser,
  émission d'events typés).
- **`server/<domain>-runner.ts`** : orchestration (séquence de runs,
  agrégation des résultats, reset entre runs).

Voir [subprocess-patterns.md](subprocess-patterns.md) pour 4 exemples.

Pattern standard : ton driver émet des events qui implémentent ou étendent
`AgentEvent`. Le runner les fan-out via le mécanisme existant de
`server/runs.ts` (listeners + SSE), ou crée son propre canal SSE si la
sémantique est différente.

## Routes API

Ajouter dans **`server/index.ts`** après les routes génériques :

```ts
// server/index.ts (extrait)
import { listBatches, startBatch } from "./batch-runner.js";

app.get("/api/batches", (c) => c.json({ batches: listBatches() }));
app.post("/api/batches", async (c) => {
  const body = await c.req.json();
  const batchId = await startBatch(body);
  audit(c, { action: "batch.start", resource_type: "batch", resource_id: batchId, result: "success" });
  return c.json({ batchId });
});
```

Réutilise toujours `audit()` pour tracer les opérations sensibles.

## Pages UI

Layout standard : une page liste + une page detail.

```
app/<entities>/
  page.tsx       liste + bouton "+ Nouveau"
  [id]/page.tsx  detail (souvent avec SSE live)
```

Réutilise les helpers de `lib/client.ts` (ou étends-les) pour fetch vers tes
nouvelles routes daemon. Pour le SSE, copie le pattern de
`app/runs/[id]/page.tsx` (EventSource direct vers `daemonOrigin()`).

## Skills par défaut

`skills-template/_global/` reçoit les fichiers `<name>.skill.md`.
`scripts/postinstall.js` les déploie vers `data/.claude/skills/_global/`
au premier `npm install` puis à chaque réinstall (override pour rester en
phase avec l'app packagée).

Format :

```markdown
---
name: ma-skill
description: Ce que fait la skill, quand Claude doit l'utiliser
version: 1
---

Le corps markdown est lu par Claude quand il invoque la skill via
`Skill("ma-skill")` (résolution par filename sans `.skill.md`).
```

## Scripts one-shot

Pour les migrations ou imports ponctuels (ex : importer une base existante),
poser dans **`scripts/import-<truc>.mjs`**. Le pattern du template pour
écrire dans `<dataDir>` est :

```js
const dataDir = process.env["{{DATA_DIR_ENV_VAR}}"] || resolve(process.cwd(), "data");
```

(Le placeholder `{{DATA_DIR_ENV_VAR}}` est remplacé au scaffolding par le
nom réel de la variable, ex `CALIBRE_DATA_DIR`.)

## App-config

Le template définit `AppConfig` minimal dans `server/app-config.ts`. Pour
ajouter des settings métier, **étendre l'interface** :

```ts
// server/app-config.ts
export interface AppConfig {
  // … champs template …
  marcelleAppPath?: string;
  emulatorAvdName?: string;
}
```

Les nouvelles clés seront automatiquement persistées par `saveAppConfig()`
et exposées par `GET /api/app-config`. L'UI les édite via
`app/settings/page.tsx` (à étendre avec les nouveaux champs).

## Tests

Le template n'embarque pas de framework de test. À chaque app de décider
(vitest, node:test, jest, …). Pour de la validation rapide, le pattern
"smoke test = curl `/api/health`" suffit souvent pour vérifier que
l'orchestrateur boot.

## Bumper la version

Bump `package.json::version` avant chaque `npm run electron:pack:*`. Le
script `prepare-pack.mjs` ne le fait pas automatiquement (geste conscient).

## Récap : ordre typique pour une nouvelle app

1. Cloner + scaffolder (`init-from-template.mjs`).
2. Étendre `server/types.ts` avec les entités domain.
3. Écrire `server/<domain>-driver.ts` (+ `<domain>-runner.ts` si besoin).
4. Ajouter les routes dans `server/index.ts`.
5. Étendre `lib/client.ts` avec les fetch helpers correspondants.
6. Écrire `app/<entities>/page.tsx` (+ `[id]/page.tsx`).
7. Poser les skills par défaut dans `skills-template/_global/`.
8. `npm run typecheck` puis `npm run electron`.
