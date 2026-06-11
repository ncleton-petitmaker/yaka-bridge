# Brief format (`brief.md`)

Le **brief** est un fichier markdown structuré (paires `KEY: value` + blocs YAML
imbriqués) que l'utilisateur écrit pour décrire la nouvelle app à scaffolder.
L'orchestrateur [`scripts/new-app-from-brief.mjs`](../scripts/new-app-from-brief.mjs)
le parse, le valide via un schéma Zod, puis appelle séquentiellement les agents
de la Factory.

Voir [`examples/brief-hello-app.md`](../examples/brief-hello-app.md) pour le
plus petit brief possible, et l'exemple complet ci-dessous pour un cas
représentatif (marcelle-calibre).

---

## Syntaxe

Le brief est un fichier `.md` formé de lignes `KEY: value` au top-level (ordre
libre). Les valeurs multi-lignes utilisent la syntaxe YAML `|` (bloc littéral)
ou `>` (bloc replié). Les listes utilisent `-` YAML standard.

Le parser interne convertit ces lignes en objet YAML (donc tout brief valide
**est** un document YAML — on accepte aussi un frontmatter `---` mais ce n'est
pas obligatoire).

```markdown
APP_NAME: Demo-Calibre
APP_ID: com.example.demo-erp
NEXT_PORT: 3200
DAEMON_PORT: 7556
DATA_DIR_NAME: Demo-Calibre
PROJECT_MODE: adapt-existing
DESIGN_SYSTEM: claude
SOURCE_PROJECT_DIR: /Users/nicolascleton/Documents/marcelle-calibre-prototype
ADAPTATION_BRIEF: |
  Reprendre les drivers Maestro et les règles de scoring déjà codés, mais migrer
  l'interface vers le shell Electron agentic-first. Ne pas toucher aux secrets.
ENTITY: batch
ENTITY_PLURAL: batches
SUBPROCESS: maestro + http-api
DOMAIN_BRIEF: |
  Calibrer Marcelle (bot EHPAD) en lançant des batches de questions sur
  Maestro Android + API HTTP, mesurer latence/route/hallucination, indexer
  les batches par commit Git pour comparer avant/après.
ENTITIES:
  - name: batch
    description: un lancement de N questions sur 1 config x 1 commit
  - name: question
    description: une question de référence avec gold standard
  - name: question_result
    description: résultat d'une question dans un batch
METRICS:
  - latency: avgApiLatencyMs, p95ApiLatencyMs, avgUiLatencyMs
  - routing: route_correct boolean, semantic_score
  - quality: hallucination_flag, faithfulness_score, gold_diff
  - artifacts: screenshot per question
GIT_BINDING: |
  capture marcelle-app/ HEAD per batch ; checkout API ;
  diff between batches
EXTRA_ROUTES:
  - GET /api/git/log marcelle-app
  - POST /api/git/checkout marcelle-app
  - POST /api/services/restart (whitelist services)
SKILLS:
  - system-prompt-staff-default
  - hallucination-rules
  - rubric-transmission
AGENTIC_FIRST: true
MCP_ACTIONS:
  - batch.create
  - batch.cancel
  - git.log
  - git.checkout
```

---

## Champs

### Obligatoires

| Champ              | Type     | Description                                                                                       | Exemple                          |
| ------------------ | -------- | ------------------------------------------------------------------------------------------------- | -------------------------------- |
| `APP_NAME`         | string   | Nom d'affichage (Dock, menus, titre fenêtre, DMG/NSIS).                                           | `Demo-Calibre`               |
| `APP_ID`           | string   | Reverse-domain bundle ID. Regex `^[a-z][a-z0-9.-]*$`.                                             | `com.example.demo-erp` |
| `NEXT_PORT`        | integer  | Port du sidecar Next.js. 1024-65535.                                                              | `3200`                           |
| `DAEMON_PORT`      | integer  | Port du sidecar Hono. 1024-65535. Doit différer de `NEXT_PORT`.                                   | `7556`                           |
| `DATA_DIR_NAME`    | string   | Nom du dossier `~/Library/Application Support/<DATA_DIR_NAME>`.                                   | `Demo-Calibre`               |
| `ENTITY`           | string   | Entité métier principale, lowercase singular.                                                     | `batch`                          |
| `SUBPROCESS`       | string   | Type de subprocess principal. Voir [Valeurs SUBPROCESS](#valeurs-subprocess).                     | `maestro + http-api`             |
| `DOMAIN_BRIEF`     | string   | 1-2 phrases. Minimum 10 caractères. Apparaît dans `package.json` et `metadata`.                   | _(bloc YAML `\|`)_                |

### Optionnels

| Champ            | Type                | Description                                                                                                | Exemple                                                |
| ---------------- | ------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `PROJECT_MODE`   | `new` \| `adapt-existing` | `new` pour un projet neuf ; `adapt-existing` si on part d'un repo/prototype existant. Défaut : `new`. | `adapt-existing`                                      |
| `DESIGN_SYSTEM`  | string              | Design system appliqué au premier setup. Défaut : `claude`. Voir [`docs/design-systems.md`](design-systems.md). | `claude` |
| `DESIGN_SYSTEM_SOURCE` | string        | Dossier externe d'un design system importé, déjà adapté au contrat yaka-bridge.                     | `/Users/.../design-system` |
| `SOURCE_PROJECT_DIR` | string          | Dossier du projet existant à auditer si `PROJECT_MODE=adapt-existing`.                                    | `/Users/.../mon-projet`                                |
| `ADAPTATION_BRIEF` | string            | Ce qu'il faut reprendre, migrer, préserver ou éviter dans le projet existant.                              | _(bloc YAML `\|`)_                                    |
| `ENTITY_PLURAL`  | string              | Pluriel de `ENTITY`. Si absent, déduit par ajout de `s` (sauf si singular finit déjà par `s` → identique). | `batches`                                              |
| `ENTITIES`       | array               | Liste des entités secondaires. Format : `- name: <slug>` + `description: <text>` (optionnel).              | voir exemple                                           |
| `METRICS`        | array of string     | Catégories de métriques (texte libre). Chaque ligne est `- <category>: <details>`.                         | `- latency: avgApiLatencyMs, p95ApiLatencyMs`          |
| `GIT_BINDING`    | string              | Description du binding avec un repo Git externe (capture SHA, checkout, etc.).                             | `capture marcelle-app/ HEAD per batch`                 |
| `EXTRA_ROUTES`   | array of string     | Signatures HTTP des routes additionnelles à scaffolder, format libre `<METHOD> <path> <comment>`.          | `- GET /api/git/log marcelle-app`                      |
| `SKILLS`         | array of string     | Liste de slugs de skills à générer dans `skills-template/_global/`. L'agent `skill-author` les remplit.    | `- system-prompt-staff-default`                        |
| `MODULES`        | array of string     | Modules catalogue à conserver/activer dans le projet généré. Chaque manifest doit avoir une version SemVer. | `- purchasing`                                         |
| `AGENTIC_FIRST`  | boolean             | Si `true` (défaut), impose la parité UI ↔ serveur ↔ MCP pour toutes les actions métier.                    | `true`                                                 |
| `MCP_ACTIONS`    | array of string     | Actions MCP explicitement attendues en plus des actions CRUD/run/cancel déduites des entités/routes.       | `- batch.create`                                       |

---

## Agentic-first / MCP

Par défaut, la factory considère `AGENTIC_FIRST: true` même si le champ est absent.
Cela signifie que toute action visible dans l'interface doit être implémentée
comme une action serveur typée, exposée en HTTP et en tool MCP. Voir
[`docs/agentic-first.md`](agentic-first.md).

`MCP_ACTIONS` permet de lister des actions explicitement attendues, notamment
celles qui ne se déduisent pas facilement d'une entité CRUD ou d'une route
standard.

---

## Valeurs `SUBPROCESS`

Le champ `SUBPROCESS` décrit ce que le daemon Hono va spawner pour exécuter
l'unité de travail métier (un "run" / "batch" / "evaluation"). Valeurs simples
reconnues :

| Valeur         | Pattern                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------- |
| `claude-cli`   | Spawn `claude --agent X --print` avec stream JSON ; cf `server/parse-stream.ts`.                     |
| `maestro`      | Spawn `maestro test <generated.yaml>` ; capture exit code + screenshots.                             |
| `http-api`     | `fetch` vers un service HTTP local (ex: `/api/mobile-chat`) ; pas de subprocess réel.                |
| `cli-custom`   | Spawn un binaire CLI quelconque (`ffmpeg`, `pandoc`, etc.) ; le driver gère le parsing.              |

**Combinaisons** : on accepte la syntaxe `X + Y` (ex: `maestro + http-api`)
quand un run lance plusieurs subprocess en parallèle. L'agent
`subprocess-driver` (Phase F.2) génère alors un orchestrateur composite.

**Validation Zod** : `z.string()` non vide. Le schéma vérifie qu'au moins l'une
des 4 valeurs canoniques apparaît dans la chaîne (split sur `+` ou `,`). Tout
autre token est warning, pas erreur.

---

## Format `ENTITIES`

Liste YAML d'objets. Chaque objet a un `name` (slug lowercase) et optionnellement
une `description`. L'agent `domain-modeler` génère un interface TypeScript par
entité dans `server/types.ts`.

```yaml
ENTITIES:
  - name: batch
    description: un lancement de N questions
  - name: question
    description: une question de référence
```

Forme courte tolérée (parsée comme `name`) :

```yaml
ENTITIES:
  - batch
  - question
```

---

## Format `METRICS`

Liste de chaînes libres. Chaque chaîne est `<category>: <comma-separated fields>`
ou n'importe quoi d'utile pour orienter le scaffolding. L'agent
`domain-modeler` les utilise pour générer les champs métriques dans
`server/types.ts` (ex: une interface `BatchMetrics`).

```yaml
METRICS:
  - latency: avgApiLatencyMs, p95ApiLatencyMs, avgUiLatencyMs
  - routing: route_correct boolean, semantic_score
  - quality: hallucination_flag, faithfulness_score, gold_diff
```

Pas de structure stricte — c'est volontairement souple, parce que les métriques
varient énormément d'une app à l'autre. La factory ne valide que la présence /
absence du champ, pas son contenu.

---

## Format `EXTRA_ROUTES`

Liste de signatures HTTP en texte libre. Format conseillé :
`<METHOD> <path> [<comment>]`. L'agent `subprocess-driver` (ou un futur
`route-scaffolder`) lit ces lignes et crée les handlers Hono squelettes dans
`server/<domain>-routes.ts`.

```yaml
EXTRA_ROUTES:
  - GET /api/git/log marcelle-app
  - POST /api/git/checkout marcelle-app
  - POST /api/services/restart (whitelist services)
```

Routes implicites (toujours scaffoldées par le template) : `/api/runs`,
`/api/skills`, `/api/audit-log`. Ne pas les répéter ici.

---

## Format `SKILLS`

Liste de slugs (lowercase, kebab-case). L'agent `skill-author` (Phase F.2)
génère un fichier YAML markdown par slug dans
`skills-template/_global/<slug>.skill.md`, avec frontmatter standard
(`name`, `description`, `triggers`, `examples`) prérempli depuis le
`DOMAIN_BRIEF`.

```yaml
SKILLS:
  - system-prompt-staff-default
  - hallucination-rules
  - rubric-transmission
```

Si `SKILLS` est absent, l'agent `skill-author` génère 3 skills par défaut
("starter" : `domain-rules`, `quality-checks`, `output-format`).

---

## Validation

Le brief est validé par un schéma Zod inline dans
`scripts/new-app-from-brief.mjs` (voir constante `BriefSchema`) :

```ts
const BriefSchema = z.object({
  APP_NAME: z.string().min(1),
  APP_ID: z.string().regex(/^[a-z][a-z0-9.-]*$/),
  NEXT_PORT: z.coerce.number().int().min(1024).max(65535),
  DAEMON_PORT: z.coerce.number().int().min(1024).max(65535),
  DATA_DIR_NAME: z.string().min(1),
  ENTITY: z.string().min(1),
  ENTITY_PLURAL: z.string().optional(), // déduit si absent
  SUBPROCESS: z.string().min(1),
  DOMAIN_BRIEF: z.string().min(10),
  ENTITIES: z
    .array(z.object({ name: z.string(), description: z.string().optional() }))
    .optional(),
  METRICS: z.array(z.string()).optional(),
  GIT_BINDING: z.string().optional(),
  EXTRA_ROUTES: z.array(z.string()).optional(),
  SKILLS: z.array(z.string()).optional(),
  MODULES: z.array(z.string()).optional().default(["purchasing"]),
  DESIGN_SYSTEM: z.string().optional().default("claude"),
  DESIGN_SYSTEM_SOURCE: z.string().optional(),
});
```

Règles supplémentaires (vérifiées hors schéma) :

1. `NEXT_PORT !== DAEMON_PORT`.
2. Si `SUBPROCESS` ne contient aucun token canonique (`claude-cli`, `maestro`,
   `http-api`, `cli-custom`), un **warning** est loggé mais le brief reste
   valide (cas custom autorisé).
3. Si un `ENTITY` non listé apparaît dans `EXTRA_ROUTES`, warning aussi.
4. Si `DESIGN_SYSTEM_SOURCE` est absent, `DESIGN_SYSTEM` doit exister dans
   `design-systems/<id>/`.
5. Chaque entrée `MODULES` doit exister dans `modules/<id>/module.config.json`
   et définir une version SemVer.

En cas d'erreur de validation, l'orchestrateur affiche les `.issues` Zod
formatés (champ + raison) puis exit `1`. Aucun scaffolding n'est lancé.

---

## Workflow complet

1. L'utilisateur écrit `brief.md` (peut partir de
   [`examples/brief-hello-app.md`](../examples/brief-hello-app.md) ou de
   l'exemple complet ci-dessus).
2. `node scripts/new-app-from-brief.mjs --brief brief.md --output-dir /path/to/new-app`
3. L'orchestrateur :
   - parse + valide le brief
   - demande confirmation interactive
   - clone le template dans `output-dir`
   - lance `init-from-template.mjs` avec les valeurs du brief
   - applique `DESIGN_SYSTEM`
   - conserve seulement les modules `MODULES` et écrit `.factory-modules.json`
   - spawne les agents F.2 séquentiellement avec des prompts construits depuis
     le brief (`app-scaffolder` → `domain-modeler` → `subprocess-driver` →
     `ui-page-generator` → `skill-author`)
   - lance `npm install` + `npx tsc --noEmit`
   - `git init` + premier commit
4. Lit `factory-journal.md` pour voir ce que chaque agent a fait et quels
   TODOs restent.

Voir Phase F.2 et F.3 de
[`/Users/marcelle/.claude/plans/noble-scribbling-candy.md`](../../../.claude/plans/noble-scribbling-candy.md)
pour le détail des agents.
