# Factory Guide - yaka-bridge

## 1. Vue d'ensemble

La **factory** est un méta-outil bâti au-dessus du template
`yaka-bridge`. Le template fournit les invariants techniques d'un ERP
modulaire cloud/Bridge : Next.js, Hono, Supabase, Bridge local, skills,
actions agentic-first, audit, packaging et module catalog. La factory automatise
la spécialisation de ce template pour un ERP client ou un service métier précis.
On part d'un **brief markdown**, on lance un orchestrateur, et on obtient une
app fonctionnelle prête à typer + booter, avec modules, routes, skills et
contrats métier déjà scaffoldés.

La cible : **passer d'un brief à un scaffold cohérent en quelques minutes**
plutôt qu'en plusieurs jours de copier-coller depuis une app de référence
(historiquement, `oif-eval` côté template maintainers, et `marcelle-calibre` côté plan
`noble-scribbling-candy.md`). Le scaffold n'est pas l'app finie — il reste
typiquement 20 à 40 % de logique métier à coder à la main (import XLSX,
parsing dev.log spécifique, règles d'hallucination par catégorie, MCP custom,
…) — mais le squelette typé, les conventions et les invariants critiques
(SSE, audit log, asar pack, parse-stream dédup, etc.) sont posés
correctement du premier coup.

Invariant ajouté : **agentic-first**. Toute action faisable dans l'interface
doit être disponible par MCP via une action serveur typée partagée par l'UI,
les routes Hono et le serveur MCP. Voir [`docs/agentic-first.md`](agentic-first.md).

Utilisateurs visés : mainteneurs du template et agents qui construisent un ERP
client ou un nouveau module yaka-bridge. Anti-cible : prototypes jetables,
services sans authZ stricte, modules qui ne respectent pas la parité UI/MCP.

## 2. Workflow en un coup d'œil

```
┌──────────────┐
│   brief.md   │  (rédigé à la main ou via /electron-claude-app)
│              │  PROJECT_MODE=new ou adapt-existing
└──────┬───────┘
       │
       ▼
┌────────────────────────────────────┐
│ scripts/new-app-from-brief.mjs     │  1. parse + valide (zod)
│   (orchestrateur)                  │  2. confirme interactivement
└──────┬─────────────────────────────┘  3. clone template → output-dir
       │
       ▼
┌────────────────────────────────────┐
│ scripts/init-from-template.mjs     │  remplace les placeholders
│   (rebrand)                        │  app name, ports, modules
└──────┬─────────────────────────────┘
       │
       ▼  séquentiel, un agent à la fois
┌────────────────────────────────────┐
│  0. existing-project-auditor        │  seulement si PROJECT_MODE=adapt-existing
│  1. app-scaffolder                 │  README, factory-journal, .factory-meta
│  2. brand-identity-designer        │  nom court + logo minimal + icônes
│  3. domain-modeler                 │  server/types.ts + JSON schemas
│  4. subprocess-driver              │  <domain>-driver.ts + runner + routes
│  5. ui-page-generator              │  pages liste/détail + composants
│  6. skill-author                   │  skills-template/_global/*.skill.md
└──────┬─────────────────────────────┘
       │
       ▼
┌────────────────────────────────────┐
│  npm install + npx tsc --noEmit    │  vérifications finales
│  git init + premier commit         │
└──────┬─────────────────────────────┘
       │
       ▼
   App fonctionnelle, prête au `npm run electron`
```

Chaque agent reçoit un prompt construit depuis le brief, écrit ses fichiers,
append un bloc dans `factory-journal.md`, puis renvoie un objet JSON sur
stdout. L'orchestrateur lit ce JSON pour décider si l'on continue ou non.

## 3. Format du brief

Le brief est un fichier `.md` formé de paires `KEY: value` au top-level (ordre
libre, syntaxe YAML imbriquée acceptée). Détail complet et schéma Zod dans
[`docs/brief-format.md`](brief-format.md).

Exemple minimal (10 lignes) :

```markdown
APP_NAME: Hello-App
APP_ID: fr.test.hello-app
NEXT_PORT: 3300
DAEMON_PORT: 7600
DATA_DIR_NAME: Hello-App
ENTITY: greeting
ENTITY_PLURAL: greetings
SUBPROCESS: http-api
DOMAIN_BRIEF: |
  Test app for the factory: stocke et liste des hello-world greetings.
```

Champs obligatoires : `APP_NAME`, `APP_ID`, `NEXT_PORT`, `DAEMON_PORT`,
`DATA_DIR_NAME`, `ENTITY`, `SUBPROCESS`, `DOMAIN_BRIEF`. Champs optionnels :
`ENTITY_PLURAL`, `ENTITIES`, `METRICS`, `GIT_BINDING`, `EXTRA_ROUTES`,
`SKILLS`.

## 4. Les agents

Les agents vivent dans `pi-electron-app-factory/claude-agents/<name>.md`
(et sont copiés dans `~/.claude/agents/` au chargement du plugin pour compatibilité).
Chaque descripteur contient frontmatter `name`, `description`, `tools`.
L'orchestrateur les invoque séquentiellement via **Codex CLI** (`codex exec`) en
injectant le descripteur dans le prompt. Chaque agent est **strictement borné**
à ses fichiers : tout débordement = bug remonté dans le journal.

### 4.0 existing-project-auditor (adaptation seulement)

- **Scope** : si `PROJECT_MODE=adapt-existing`, audite `SOURCE_PROJECT_DIR` en lecture seule, cartographie ce qui est à reprendre, à wrapper, à migrer ou à ignorer, puis recommande la team d'agents spécialisée.
- **Outputs** : `factory-existing-audit.md`, table de parité agentic-first, risques secrets/config, stratégie de migration.
- **Outils autorisés** : Read, Bash, Write.
- **Fiche complète** : [`.claude/agents/existing-project-auditor.md`](../.claude/agents/existing-project-auditor.md)

### 4.1 app-scaffolder

- **Scope** : finalise le scaffolding post-`init-from-template.mjs`. Vérifie
  qu'il n'y a plus de placeholders résiduels `{{...}}`, finalise
  `package.json` (`name`, `version`, `description`), écrit le `README.md`
  initial depuis le brief, et crée les fichiers de traçabilité.
- **Outputs** : `package.json` (rebrand), `README.md`, `factory-journal.md`
  (en-tête + son propre bloc), `.factory-meta.json`.
- **Outils autorisés** : Bash, Read, Write, Edit.
- **Fiche complète** :
  [`.claude/agents/app-scaffolder.md`](../.claude/agents/app-scaffolder.md)

### 4.2 brand-identity-designer

- **Scope** : choisit ou confirme le nom produit, le nom court affiché dans le
  header et une tagline opérationnelle. Génère `public/app-mark.svg` avec un
  logo volontairement minimal (monogramme 1-2 lettres ou symbole géométrique
  très simple), écrit `brand.config.json`, régénère les icônes packagées via
  `npm run brand:icons` si l'environnement le permet, puis met à jour
  `Mark.tsx` et le header.
- **Outputs** : `brand.config.json`, `public/app-mark.svg`, éventuellement
  `public/icon-*`, patch ciblé `components/Mark.tsx` et
  `components/AppChromeHeader.tsx`, append au `factory-journal.md`.
- **Outils autorisés** : Bash, Read, Write, Edit.
- **Invariant** : logo le plus simple possible ; pas d'illustration métier, pas
  de dégradé décoratif, pas de mascotte, pas de palette hors design system. Si
  l'app expose plusieurs modules, leurs icônes doivent former une famille
  cohérente : tuiles façon Odoo en structure, mais charte Claude/TeamFactory
  en couleurs, formes et sobriété.
- **Fiche complète** :
  [`pi-electron-app-factory/claude-agents/brand-identity-designer.md`](../pi-electron-app-factory/claude-agents/brand-identity-designer.md)

### 4.3 domain-modeler

- **Scope** : depuis `ENTITIES`, `METRICS`, `GIT_BINDING` du brief, génère
  `server/types.ts` complet (préserve mot pour mot les types invariants
  `AgentEventKind`, `UsageInfo`, `AgentEvent`, `RunStatus`, `RunRecord`,
  `ChatRequest`, `ChatRunCreated` ; ajoute les `interface <Entity>`,
  `<Entity>Summary`, `<Domain>Event` discriminated union). Génère
  optionnellement des JSON Schemas si le brief mentionne de la validation.
- **Outputs** : `server/types.ts`, optionnellement `lib/types.ts` (miroir),
  `data-template/.claude/schemas/<entity>.schema.json`, append au
  `factory-journal.md`.
- **Outils autorisés** : Read, Write.
- **Fiche complète** :
  [`.claude/agents/domain-modeler.md`](../.claude/agents/domain-modeler.md)

### 4.4 subprocess-driver

- **Scope** : depuis `SUBPROCESS`, `ENTITIES`, `EXTRA_ROUTES`, `GIT_BINDING`,
  génère le driver bas-niveau, le runner haut-niveau, les routes Hono
  CRUD + SSE, et — si `GIT_BINDING` — un helper sécurisé `git-binding.ts`
  avec whitelist `allowedPaths`. Sait composer plusieurs patterns
  (`maestro + http-api`). Vérifie `npx tsc --noEmit` avant de rendre la main.
- **Outputs** : `server/<domain>-driver.ts`, `server/<domain>-runner.ts`,
  édits chirurgicaux dans `server/index.ts` (routes ajoutées),
  éventuellement `server/git-binding.ts`, append au `factory-journal.md`.
- **Outils autorisés** : Read, Write, Edit, Bash.
- **Fiche complète** :
  [`.claude/agents/subprocess-driver.md`](../.claude/agents/subprocess-driver.md)

### 4.5 ui-page-generator

- **Scope** : `<en cours>` — depuis les entités générées par `domain-modeler`
  et les routes posées par `subprocess-driver`, scaffolde les pages
  Next.js (liste + détail SSE) et les composants `<Entity>Table`,
  `<Entity>Drawer`, `<Entity>Form`. Réutilise les helpers `lib/client.ts`
  et `lib/sse.ts` du template. Édite `app/page.tsx` pour ajouter le nav
  vers les nouvelles pages et `app/settings/page.tsx` pour les nouveaux
  champs `AppConfig`.
- **Outputs (prévus)** : `app/<entities>/page.tsx`,
  `app/<entities>/[id]/page.tsx`, `app/run/page.tsx` (si distinct de
  l'entité), `app/dashboard/page.tsx` (si demandé), composants associés,
  append au `factory-journal.md`.
- **Outils autorisés (prévus)** : Read, Write, Edit, Bash.
- **Fiche complète** : `<en cours>` — descripteur pas encore écrit au
  moment de la rédaction de ce guide ; sera à
  `.claude/agents/ui-page-generator.md`.

### 4.6 skill-author

- **Scope** : `<en cours>` — depuis `SKILLS` du brief (ou 3 skills "starter"
  par défaut si absent : `domain-rules`, `quality-checks`, `output-format`),
  génère 3 à 5 fichiers `<slug>.skill.md` avec frontmatter YAML
  (`name`, `description`, `version`) + corps markdown procédural préparé
  depuis `DOMAIN_BRIEF`. Optionnellement : slash commands dans
  `data-template/.claude/commands/`, hooks de validation
  `data-template/.claude/hooks/validate-<x>.mjs`, JSON Schemas
  coordonnés avec `domain-modeler`.
- **Outputs (prévus)** : `skills-template/_global/<slug>.skill.md` (×3-5),
  fichiers optionnels ci-dessus, append au `factory-journal.md`.
- **Outils autorisés (prévus)** : Read, Write.
- **Fiche complète** : `<en cours>` — descripteur pas encore écrit au
  moment de la rédaction de ce guide ; sera à
  `.claude/agents/skill-author.md`.

## 5. Subprocess patterns supportés

Détail dans [`docs/subprocess-patterns.md`](subprocess-patterns.md). Résumé :

| Pattern        | Quand l'utiliser                                           | Driver généré par `subprocess-driver`                                        | Gotchas critiques                                                                 |
| -------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `claude-cli`   | Spawn Claude Code en sous-processus avec stream-json       | Réutilise `server/runs.ts` du template — pas de driver custom                | `--effort low` + `CLAUDE_CODE_DISABLE_THINKING=1`, dédup `usage` par `message_id` |
| `maestro`      | Piloter un émulateur Android (ou iOS) via flows YAML       | `server/<domain>-driver.ts` custom (spawn + parse `~/.maestro/tests/.../maestro.log`) | Bug 2.5.1 : `--env` n'override pas defaults YAML, et `inputText` refuse Unicode (`stripAccents` obligatoire) |
| `http-api`     | Appeler une API HTTP locale (LLM, service métier, …)       | Fetch loop avec `AbortSignal` explicite, parse JSON ou SSE chunked          | `headersTimeout` undici = 5min par défaut → toujours `AbortSignal.timeout(N)` explicite |
| `cli-custom`   | Piloter un binaire CLI quelconque (ffmpeg, pandoc, …)      | `spawn` générique + parser ad-hoc (NDJSON via `parse-stream.ts` si possible) | Définir un format stdout stable ; mocker facilement pour les tests                 |

**Combinaisons** (`A + B`, ex : `maestro + http-api`) : le runner instancie
les deux drivers, les compose dans sa boucle, émet des sous-events
(`event: "ui-result"`, `event: "api-result"`) puis un event final
`result`. Pattern observé sur marcelle-calibre.

## 6. Comment invoquer la factory

### 6.1 Via le skill Claude Code (recommandé)

```
/electron-claude-app
```

Le skill `electron-claude-app` (à `~/.claude/skills/electron-claude-app/SKILL.md`)
collecte le brief via questions interactives (nom, entités, type de
subprocess, métriques, skills voulues, …), propose un brief.md généré pour
revue, puis appelle l'orchestrateur. C'est la voie privilégiée quand on
démarre une nouvelle app : on ne risque pas d'oublier un champ obligatoire,
et le brief produit est cohérent avec le format attendu.

### 6.2 En CLI direct

```bash
cd /path/to/yaka-bridge
node scripts/new-app-from-brief.mjs \
  --brief /path/to/brief.md \
  --output-dir /path/to/new-app
```

Options disponibles :

| Option              | Effet                                                                            |
| ------------------- | -------------------------------------------------------------------------------- |
| `--brief <path>`    | Fichier brief.md à parser (obligatoire).                                         |
| `--output-dir <p>`  | Répertoire où scaffolder la nouvelle app (obligatoire).                          |
| `--template-dir <p>`| Source du template (défaut : `..` relatif au script).                            |
| `--skip-install`    | Ne lance pas `npm install` à la fin.                                             |
| `--skip-typecheck`  | Ne lance pas `npx tsc --noEmit` à la fin.                                        |
| `--dry-run`         | Affiche le plan + prompts d'agents sans toucher le filesystem.                   |
| `--yes`             | Ne demande pas de confirmation interactive (pour les scripts CI).                |
| `--force`           | Autorise l'écriture dans un `--output-dir` non vide.                             |

En cas d'erreur, l'orchestrateur écrit `output-dir/.factory-error.json` pour
faciliter le debug.

## 7. Exemples

### 7.1 Demo-Calibre (référence historique)

Brief : `maestro + http-api` + `GIT_BINDING` (calibration EHPAD).

- Entités : `batch`, `question`, `question_result`.
- Subprocess : Maestro Android (UI) + HTTP API (latence backend) ; runner
  compose les deux par question.
- Skills attendus : `system-prompt-staff-default`, `hallucination-rules`,
  `rubric-transmission`.
- Fichiers générés par la factory :
  - `server/types.ts` étendu (Question, Batch, QuestionResult,
    BatchSummary, CalibreEvent)
  - `server/calibre-driver.ts` + `server/calibre-runner.ts`
  - `server/git-binding.ts` (helpers SHA / branch / dirty / log / diff /
    checkout, whitelist `app-config.json#git.allowedPaths`)
  - `server/index.ts` étendu (routes `/api/batches*`, `/api/git/*`)
  - `app/batches/page.tsx`, `app/batches/[id]/page.tsx`
  - 3 skills `skills-template/_global/*.skill.md`
- Temps wall scaffolding : ~7 jours focus humain pré-factory ; après
  factory : quelques heures pour scaffolder + ~3 jours pour finaliser
  la logique business spécifique.
- TODOs typiques restant à coder à la main : templating Maestro YAML
  spécifique au flow Marcelle, parser regex de `dev.log` pour extraire
  les timings backend, règles d'hallucination par catégorie, gold-standards
  par question, MCP custom le cas échéant.

### 7.2 Marcelle-Prompts (2e exemple, à venir Phase F.4)

Brief : `http-api` seul, compare variantes de prompts.

- Entités : `variant`, `prompt_run`, `prompt_result`.
- Subprocess : `http-api` uniquement (pas de Maestro, pas de Git binding).
- Fichiers générés : équivalent simplifié de Demo-Calibre — pas de
  `git-binding.ts`, pas de driver Maestro. App "plus simple" qui sert
  surtout à valider la factory sur un 2e cas.
- Temps wall : ~1 jour focus.

### 7.3 Hello-App (smoke test)

Brief : voir [`examples/brief-hello-app.md`](../examples/brief-hello-app.md).
`http-api` minimal sans entités secondaires, sans métriques, sans
skills. Sert à valider la chaîne factory bout-en-bout (parsing brief →
init → 5 agents → typecheck OK).

## 8. Ajouter un nouveau pattern de subprocess

Si la factory doit gérer un type de subprocess inédit (WebSocket subscriber,
gRPC, MQTT, …) :

1. Documenter le pattern dans `docs/subprocess-patterns.md` (signature
   driver suggérée, gotchas, exemple parse).
2. Étendre le prompt système de l'agent `subprocess-driver`
   (`.claude/agents/subprocess-driver.md`) avec le nouveau cas dans la
   table "Choix du pattern" + un exemple de driver.
3. Étendre la liste autorisée dans `docs/brief-format.md` (section
   "Valeurs SUBPROCESS") **et** le schema Zod inline de
   `scripts/new-app-from-brief.mjs` (si la validation devient plus
   stricte).
4. Tester via un brief minimal qui utilise le nouveau pattern.

À garder en tête : la factory est délibérément peu abstraite tant qu'on n'a
pas 3-4 apps cibles. Mieux vaut documenter + dupliquer que pré-abstraire.

## 9. Gotchas connus

Détails dans [`docs/gotchas.md`](gotchas.md). Les plus critiques au moment
du scaffolding :

- **Maestro 2.5.1** : `--env` n'override pas les defaults YAML → templater
  le YAML directement avant `spawn` ; `inputText` refuse Unicode → strip
  accents (`s.normalize("NFD").replace(/[̀-ͯ]/g, "")`).
- **Node `fetch` (undici)** : `headersTimeout` 5min par défaut → toujours
  `AbortSignal.timeout(N)` explicite pour les LLMs longs (cf. mlx-lm 24B).
- **Electron asar pack** : `asarUnpack` obligatoire pour `**/*.node`,
  `dist/**`, `.next/standalone/**`, `skills-template/**`,
  `data-template/**`. Sinon le daemon plante au boot prod sur
  `fs.readFileSync`.
- **Claude CLI** : doit être dans le PATH (`findClaudeBin()` cherche
  `~/.local/bin`, Homebrew, …) **avant** de lancer la factory. Sinon
  `app-scaffolder` peut booter, mais les autres agents échouent au
  spawn `claude --agent`.
- **Claude CLI usage dédup** : émis 2× par tour (`message_start` puis
  `assistant`) → dédup par `message_id` côté `server/runs.ts::broadcast`.
  Ne pas casser cette logique.
- **Hooks Claude Code** : `exit 2` = blocage (avec stderr explicatif),
  `exit 0` = ok, autres codes = ignorés avec warning.
- **Coût** : un scaffold complet via la factory consomme typiquement
  ~5-10 USD de tokens API Claude (5 agents × prompts détaillés × fichiers
  produits). À considérer avant de la lancer en boucle sur 20 briefs.

## 10. Limitations connues

La factory **ne fait pas** :

- **Logique métier spécifique** : pas de `process-message.ts` Marcelle, pas
  de parsing XLSX OIF custom, pas d'intégrations très spécifiques (MCP
  custom, PDF.js vendoring, hooks de validation métier).
- **Gestion multi-utilisateur / auth** : les apps cibles sont desktop
  locales mono-utilisateur. Pour du multi-user, à coder à la main.
- **Déploiement** : pas de signing / notarization Electron automatique,
  pas de CI release. À configurer dans `package.json::build` par l'app.
- **Migrations de schémas** : chaque app gère sa donnée. Pas de migration
  framework injecté.
- **Imports / exports XLSX / PDF** : trop spécifique (colonnes Excel
  custom, formats PDF métier). À coder à la main.
- **Storage multi-poste / sync bundles** : observé sur oif-eval (~1000
  lignes) mais pas un pattern récurrent à généraliser.
- **Logo / branding visuel** : icônes par défaut posées par le template ;
  régénération via `scripts/make-icon.mjs` reste manuelle.
- **Tests** : pas de framework imposé. Chaque app choisit (vitest,
  node:test, jest, …).

Voir [`docs/factory-invariants.md`](factory-invariants.md) section 3
"Non-automatisable" pour la liste complète.

## 11. Roadmap factory

Pistes d'évolution (cf. plan `noble-scribbling-candy.md`) :

- **Phase F.4** : valider la factory sur un 2e cas (marcelle-prompts) pour
  réviser les hypothèses figées par marcelle-calibre.
- **Promouvoir des composants** : `StreamingPanel.tsx` (620 l), `DiffViewer`,
  `ChatDrawer`, `ResizeHandle`, `ProgressBar` sont des patterns génériques
  identifiés dans l'audit invariants — les déplacer dans
  `<template>/components/` partagés (gain ×N pour les apps suivantes).
- **Nouveau pattern subprocess** `websocket-subscriber` (si demande
  émerge — bots IRC/Slack, streams, …).
- **Versionner les agents** : SemVer par agent (`app-scaffolder@1.2.0`),
  permettre à un brief d'épingler une version.
- **Agent `metric-designer`** : automatiser plus finement la génération
  des métriques agrégées (actuellement fait par `domain-modeler` en mode
  heuristique).
- **Agent `route-scaffolder`** dédié aux `EXTRA_ROUTES` (actuellement
  intégré à `subprocess-driver`) si la complexité grossit.
- **Mode `--update`** : appliquer un nouveau brief sur une app existante
  (re-générer types, ajouter une entité, etc.). Aujourd'hui scaffolding
  *initial* uniquement.

## 12. Liens

- Repo template : <https://github.com/example/yaka-bridge>
- Plan de référence : `/Users/marcelle/.claude/plans/noble-scribbling-candy.md`
- Audit invariants : [`docs/factory-invariants.md`](factory-invariants.md)
- Format brief : [`docs/brief-format.md`](brief-format.md)
- Architecture template : [`docs/architecture.md`](architecture.md)
- Customization guide : [`docs/customization-guide.md`](customization-guide.md)
- Gotchas : [`docs/gotchas.md`](gotchas.md)
- Subprocess patterns : [`docs/subprocess-patterns.md`](subprocess-patterns.md)
- Orchestrateur : [`scripts/new-app-from-brief.mjs`](../scripts/new-app-from-brief.mjs)
- Rebrand : [`scripts/init-from-template.mjs`](../scripts/init-from-template.mjs)
- Descripteurs d'agents : [`.claude/agents/`](../.claude/agents/)
- Brief exemple : [`examples/brief-hello-app.md`](../examples/brief-hello-app.md)
