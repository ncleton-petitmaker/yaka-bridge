# Factory Invariants

## Vue d'ensemble

Mapping de ce que le template (`claude-electron-app-template`) fournit en
standard vs ce qu'une app domain-specific doit ajouter, et **quel agent factory
génère chaque morceau** (cf. plan `noble-scribbling-candy.md`, Phase F.2).

Référence d'audit : comparaison `claude-electron-app-template/` (post Part T,
state au 2026-05-17) vs `/tmp/oif-base/oif-eval/` (clone full, base de
référence). oif-eval est le seul exemple d'app cible existante au moment de la
conception : la factory est dimensionnée pour ne pas sur-abstraire ces patterns
avant validation par marcelle-calibre (Part M) et marcelle-prompts (Phase F.4).

---

## 1. Invariants (déjà dans le template)

Le template fournit, par construction, ce qui est commun à 100 % des apps
desktop "Electron + daemon Hono + subprocess + skills".

### 1.1 Electron + bootstrap
- `electron/main.cjs` — spawn des sidecars Next + daemon, BrowserWindow, log
  routing, port detection, IPC, quit cleanup, onboarding Claude.
- `electron/preload.cjs`, `electron/setup-preload.cjs`,
  `electron/claude-dialog-preload.cjs` — bridges IPC.
- `scripts/start.js` — fallback non-Electron (lance daemon + Next + ouvre
  browser).
- `scripts/build-server.mjs` — bundling esbuild `server/index.ts → dist/server.cjs`.
- `scripts/prepare-pack.mjs`, `scripts/electron-builder-after-pack.cjs` —
  packaging.
- `scripts/postinstall.js` — déploiement `data-template/` → `data/`.

### 1.2 Daemon Hono — orchestration générique
- `server/index.ts` — Hono boot, CORS, audit middleware, routes
  `/api/health`, `/api/agents`, `/api/app-config`, `/api/runs*`, `/api/skills`,
  `/api/audit*`.
- `server/runs.ts` — UUID, listeners SSE, replay, dédup tokens, cleanup
  zombies, agrégation `UsageTotals`.
- `server/agents.ts` — `findClaudeBin()` + `buildClaudeArgs()` + détection
  binaire `claude` cross-platform (~/.local/bin, Homebrew, …).
- `server/agents-status.ts` — probe `claude --version` + statut login.
- `server/parse-stream.ts` — parser `claude-stream-json` → `AgentEvent` typé.
- `server/audit-log.ts` — journal chaîné SHA-256 par user/jour.
- `server/pricing.ts` — tarifs Anthropic + `computeCostUsd`.
- `server/run-history.ts` — persistance `.events.jsonl` (tag-based).
- `server/skills.ts` — CRUD skills global / perso / propositions.
- `server/app-config.ts` — persistance `app-config.json`.
- `server/types.ts` — types canoniques `AgentEvent`, `RunRecord`, `UsageInfo`,
  `RunStatus`, `ChatRequest`. **Étendu (jamais réécrit) par l'app métier.**

### 1.3 Next.js — UI invariante
- `app/layout.tsx`, `app/globals.css`, `app/page.tsx` (redirect serveur vers
  `/runs` — pas de landing intermédiaire, voir §1.4 Règles UX).
- `app/runs/page.tsx`, `app/runs/[id]/page.tsx` — liste + détail SSE des
  runs Claude (pattern de référence pour `app/<entities>/`).
- `app/skills/page.tsx` — éditeur skills YAML.
- `app/logs/page.tsx` — audit log viewer.
- `app/settings/page.tsx` — édition `app-config`.
- `lib/client.ts` — fetch helpers vers `/api/*`.
- `lib/sse.ts` — parser SSE côté client.
- `lib/types.ts` — miroir compact de `server/types.ts`.

### 1.4 Data-template + skills
- `data-template/.claude/CLAUDE.md` — posture + conventions.
- `data-template/.claude/settings.json` — `permissions.deny` Bash/WebFetch +
  hook `PreToolUse`.
- `data-template/.claude/hooks/restrict-write-paths.mjs` — validation paths.
- `data-template/.claude/skills/_global/.gitkeep` — emplacement vide.
- `skills-template/_global/.gitkeep` — emplacement vide.

### 1.5 Tooling + scaffolding
- `package.json` (placeholders `{{APP_NAME}}`, `{{APP_ID}}`, ports).
- `template.config.json` — manifeste placeholders.
- `scripts/init-from-template.mjs` — rebrand CLI (placeholders → valeurs).
- `tsconfig.json`, `tailwind.config.ts`, `postcss.config.js`.
- `public/icon-*` — icônes par défaut (à remplacer par l'app).
- `docs/architecture.md`, `customization-guide.md`, `gotchas.md`,
  `subprocess-patterns.md`.

**Total invariants** : ~12 fichiers `server/`, 6 pages `app/`, 4 fichiers
`electron/`, 7 scripts, infra config. Tout cela est **immuable** côté factory ;
les agents ne le touchent pas (sauf placeholders rebrandés via
`init-from-template.mjs`).

### 1.6 Règles UX invariantes (toute app scaffoldée doit les respecter)

Ces règles s'imposent à `ui-page-generator`, `runner-author`, et tout agent
qui produit de l'UI ou de l'API d'orchestration. Elles ne sont pas
négociables — un brief métier qui demanderait l'inverse doit être interprété
comme une demande à clarifier, pas une dérogation.

#### UX-R1 · Pas de landing intermédiaire
La route `/` est **toujours** un `redirect("/runs")` (server component). On
n'introduit aucun écran "Hero + cliquez pour démarrer" entre l'ouverture de
l'app et l'interface de travail. Si une app veut une vraie home agrégée,
elle crée une route dédiée (`/home`, `/overview`) — jamais sur `/`.

#### UX-R2 · Tout run/batch long doit être stoppable à tout moment
Toute opération asynchrone (batch, run Claude Code, calibration, export
long…) DOIT :
1. Exposer un endpoint `POST /api/<entité>/:id/cancel` côté daemon (déjà
   présent pour `runs` et `batches` ; ajouter pour toute nouvelle entité
   longue) qui interrompt proprement le worker (kill subprocess, abort
   stream, marque `status=cancelled`).
2. Afficher un bouton "Annuler" / "Stopper" **visible en permanence** dans
   l'UI tant que `status === "running"` — pas caché derrière un menu, pas
   désactivé en attendant un event SSE. Le clic envoie le POST, met
   l'état local en "cancelling…", et laisse le SSE confirmer par
   `batch_done`/`run_done` avec status final.
3. Le bouton DOIT être présent à la fois sur la liste (sidebar/table) et
   sur la vue détail (page `/runs/[id]`, drawer, panel center quand un
   run est en cours).

#### UX-R3 · Live progress toujours visible
Pendant l'exécution d'un run/batch :
1. Le centre de l'UI affiche **toujours** le stream live (events SSE,
   barre de progression, ligne par étape ou question, dernier message).
   Aucun écran statique "le batch tourne, revenez plus tard".
2. Si l'utilisateur navigue ailleurs puis revient sur la page, le stream
   reprend automatiquement (re-souscription SSE via `subscribeXxx` du
   `lib/client.ts`).
3. Si un `LiveScreenshotPanel` ou équivalent existe pour le domaine
   (capture d'app pilotée, preview render…), il s'affiche en
   panel-right systématiquement pendant le run — pas seulement à la
   fin.
4. Les events SSE qui doivent être streamés au minimum : `<entity>_start`,
   `<step>_done` (un par étape granulaire), `<entity>_done`, `error`.
   Pas de "tout d'un coup à la fin".

#### UX-R4 · Pas de double-clic mort
Aucun parcours utilisateur ne doit avoir une étape "intermédiaire" qui ne
fait que rediriger ou afficher un CTA vers la vraie action. Si la seule
action sur un écran est "passer à l'écran suivant", on supprime l'écran.

#### UX-R5 · Storage picker natif (pattern OIF-eval)
Toute app scaffoldée doit exposer dans `/settings` un **sélecteur natif de
dossier** pour chaque chemin requis, **pas un input texte**. Pattern
OIF-eval : l'utilisateur choisit la racine, l'app crée automatiquement les
sous-dossiers requis.

1. `electron/main.cjs` expose `ipcMain.handle("select-directory", ...)`
   qui retourne `{ ok, path | cancelled | error }` et accepte `opts.subdirs:
   string[]` pour créer les sous-dossiers automatiquement (path traversal
   et chemins absolus rejetés).
2. `lib/electron.ts` (invariant) expose `selectDirectory(opts)` typé +
   `isElectron()` + `revealFile(absPath)` ; tombe sur
   `{ ok: false, unavailable: true }` hors Electron.
3. `app/settings/page.tsx` utilise `<DirField>` pour chaque entrée de
   `config.requiredDirs` : input texte (édition manuelle possible) + bouton
   **Parcourir** (picker natif) + bouton **Ouvrir** (reveal in Finder).
   Sous-dossiers requis affichés en dessous (mono, gris) avec la mention
   "↳ sous-dossiers auto : a, b, c".
4. `server/app-config.ts` : type `requiredDirs: Array<{ key, label,
   subdirs?: string[] }>`. L'agent `domain-modeler` ou `app-scaffolder`
   remplit ce tableau dans `DEFAULT_CONFIG` selon les besoins du métier
   (ex marcelle-calibre : `[{ key: "dataDir", label: "Dossier de
   données", subdirs: ["batches", "questions", "samples", ".claude"] }]`).

Ne pas exposer un champ texte sans bouton Parcourir. Ne pas demander à
l'utilisateur de saisir 3 sous-dossiers à la main si une racine + subdirs
auto fait l'affaire.

---

## 2. Domain-specific (ajoutés par l'app)

### 2.1 Entités domain → agent `domain-modeler`

Pattern observé dans oif-eval : `lib/types.ts` étendu avec entités métier
(`DossierEntry`, `DossierStatus`, `Evaluation`, `CritereEligibilite`,
`QuestionNotation`, `EligibiliteStatut`, `NotationStatut`, `FileEntry`,
`VeriteSummary`, `PropositionEntry`, …) + fichiers séparés pour les modules
volumineux : `lib/campaign-types.ts`, `lib/calibrage-types.ts`,
`lib/calibrage-import-types.ts`.

**Ce que l'agent `domain-modeler` génère** :
- `server/types.ts` étendu (jamais réécrit) : ajout des `interface Entity {…}`
  + `type EntityStatus = …` pour chaque entité du brief.
- `lib/types.ts` étendu en miroir compact (pour UI).
- Optionnel : `lib/<sub>-types.ts` si un sous-domaine pèse > 100 lignes
  (ex. campagnes, calibrage).
- Optionnel : `data-template/.claude/schemas/<entity>.schema.json` quand
  l'entité a un format de sortie strict que Claude doit respecter
  (cf. oif-eval `evaluation-7e.schema.json` + hook `validate-evaluation-json.mjs`).

**Conventions** :
- Suivre exactement le style des types template (`RunRecord`, `AgentEvent`).
- Toujours nullable ce qui peut l'être ; éviter `any`.
- Pour les statuts : `type X = "a" | "b" | "c"` (string union, pas enum).
- Test sortie : `npx tsc --noEmit` passe.

### 2.2 Subprocess principal → agent `subprocess-driver`

Pattern oif-eval : un seul subprocess (Claude CLI) via le pipeline générique
`server/runs.ts`. Les fichiers `server/calibrage-runs.ts` (446 l),
`server/dossiers.ts`, `server/verite.ts` sont des **wrappers métier**
au-dessus, pas un driver subprocess distinct.

Pattern marcelle-calibre (Part M) : **multi-subprocess** — Maestro pour
Android + HTTP API + ADB.

**Ce que l'agent `subprocess-driver` génère** :
- `server/<domain>-driver.ts` — wrapper bas-niveau : spawn, parser stdout,
  émission d'`AgentEvent` (ou variante typée). Une fonction `startX()` qui
  retourne un `RunRecord`-like, `attachXListener()`, `cancelX()`.
- `server/<domain>-runner.ts` — orchestration : séquence de runs, agrégation
  résultats, reset entre runs, persistance `.jsonl`.
- Adapter ou extension de `server/parse-stream.ts` si le subprocess émet un
  format non-JSON-stream (ex. logs Maestro texte → events typés).
- Extension de `server/index.ts` : ajouter les routes Hono dédiées (cf. 2.5).

**Patterns supportés** (cf. `docs/subprocess-patterns.md`) :
1. `claude-cli` — déjà géré par le template, l'agent ne fait rien.
2. `maestro` — spawn `~/.maestro/bin/maestro test`, parsing logs, templating
   YAML, fix unicode 2.5.1.
3. `http-api` — fetch en boucle vers HTTP local, timeout long, retry.
4. `cli-custom` — spawn arbitraire + parser custom.
5. `multi` — composition de plusieurs subprocess (marcelle-calibre = Maestro
   + HTTP en parallèle).

**Fonctions standard que tout driver expose** :
- `start<X>(opts): <X>Record`
- `get<X>(id): <X>Record | null`
- `list<X>(): <X>Record[]`
- `cancel<X>(id): boolean`
- `attach<X>Listener(id, fn): { detach, replay } | null`

### 2.3 Pages métier → agent `ui-page-generator`

Pattern oif-eval (10 pages totales, dont 4 invariantes du template) :
- `/evaluation/page.tsx` (1130 l) — page principale "voir un dossier + sa
  grille d'évaluation". Équivalent app future : `/run` ou
  `/<entities>/[id]` (page principale de travail).
- `/dashboard/page.tsx` (702 l) — métriques agrégées par opérateur.
- `/parametres/page.tsx` (2543 l) — settings étendus (campagnes, calibrage,
  storage, …). **Cas particulier** : oif-eval surcharge énormément la page
  settings ; pour les futures apps, mieux vaut splitter en sous-pages.
- `/propositions/page.tsx` (740 l) — workflow de promotion skills.
- `/export/page.tsx` (227 l) — export XLSX par campagne.
- `/admin/page.tsx` (5 l) — placeholder.

**Ce que l'agent `ui-page-generator` génère** pour une app moyenne :
- `app/<entities>/page.tsx` — liste + filtre + bouton "Nouveau".
- `app/<entities>/[id]/page.tsx` — détail avec SSE live (pattern de
  `app/runs/[id]/page.tsx`).
- `app/run/page.tsx` — page "lancer un run" avec live streaming
  (si différent de `<entities>`).
- `app/dashboard/page.tsx` — métriques agrégées (si demandé dans le brief).
- `components/<Entity>Table.tsx`, `components/<Entity>Drawer.tsx`,
  `components/<Entity>Form.tsx`.
- Réutilisation des helpers `lib/client.ts` + `lib/sse.ts`.

**Pages que l'agent NE génère PAS** (gardées telles quelles du template) :
`/runs`, `/skills`, `/logs`, `/settings` (champs étendus via
`server/app-config.ts` + agent peut éditer `app/settings/page.tsx` pour
ajouter les inputs des nouveaux champs).

### 2.4 Skills par défaut → agent `skill-author`

oif-eval embarque 5 skills dans `skills-template/_global/` :
- `evaluer-eligibilite.skill.md`
- `evaluer-notation.skill.md`
- `ameliorer-mes-regles.skill.md`
- `promouvoir-regle.skill.md`
- `regenerer-skills-depuis-referentiel.skill.md`

Format : frontmatter YAML (`name`, `description`, `version`) + corps markdown
procédural lu par Claude quand il invoque la skill via `Skill("<name>")`.

**Ce que l'agent `skill-author` génère** :
- 3 à 5 fichiers `skills-template/_global/<slug>.skill.md` selon le brief.
- Optionnel : `data-template/.claude/commands/<slug>.md` (slash commands).
- Optionnel : `data-template/.claude/hooks/<validate-X>.mjs` si la skill
  produit un JSON à valider.
- Optionnel : `data-template/.claude/schemas/<entity>.schema.json` (en sync
  avec `domain-modeler` 2.1).

**Convention frontmatter** :
```yaml
---
name: <slug-kebab>
description: <quand l'invoquer + ce qu'elle fait, 1-2 phrases>
version: "<semver ou semver-suffix>"
---
```

### 2.5 Routes API métier → agent `subprocess-driver` (extension `server/index.ts`)

Compte oif-eval : **70 routes API** dans `server/index.ts` (3229 lignes) +
fichiers domain. Catégorisation :

| Groupe | Routes | Pattern | Génération auto possible ? |
|---|---|---|---|
| `/api/runs*` | 7 (runs, /:id, /events, /cancel, /usage, /concurrency, /batch) | invariant template | déjà dans template |
| `/api/health`, `/api/agents`, `/api/app-config` | 4 | invariant template | déjà dans template |
| `/api/skills` | 1 | invariant template | déjà dans template |
| `/api/audit*` | 3 | invariant template | déjà dans template |
| CRUD entity (`/api/dossiers`, `/api/evaluations`, `/api/campaigns`, `/api/propositions`) | ~25 | régulier (GET liste, GET :id, POST, PUT, DELETE) | **OUI** — l'agent génère depuis les types domain |
| Subprocess métier (`/api/calibrage/*`, `/api/runs/batch-notation`, etc.) | ~15 | spawn + SSE | **OUI** — l'agent applique pattern `runs.ts` |
| Imports/exports XLSX/PDF (`/api/export-xlsx`, `/api/calibrage/imports`) | ~10 | métier pur | **NON** — code à la main |
| Storage/sync bundles (`/api/storage/*`, `/api/sync-bundles/*`, `/api/setup-shared-dir`) | ~8 | métier pur (multi-poste OIF) | **NON** — pas réutilisable |
| Debug bundle, PDF.js | 3 | utilitaire | **NON** — opt-in |

**Pattern à automatiser** : pour chaque entité `X` du brief, l'agent
`subprocess-driver` génère :
- `GET /api/<entities>` → `list<X>()`
- `GET /api/<entities>/:id` → `get<X>(id)`
- `POST /api/<entities>` → `start<X>(body)` ou `create<X>(body)`
- `POST /api/<entities>/:id/cancel` → `cancel<X>(id)` (si subprocess)
- `GET /api/<entities>/:id/events` → SSE via `attach<X>Listener`

Chacune append `audit()` pour les opérations sensibles.

### 2.6 Composants React métier → agent `ui-page-generator`

Composants oif-eval (33 fichiers, ~20 500 lignes) :

| Composant | Statut | Génération auto |
|---|---|---|
| `StreamingPanel.tsx` (620 l) | **Pattern générique** — porter dans le template à terme | gardé tel quel par l'agent, type-events adapté |
| `ChatDrawer.tsx`, `ResizeHandle.tsx`, `Icon.tsx`, `Mark.tsx`, `ClaudeMark.tsx`, `ProgressBar.tsx` | génériques | candidats à intégrer au template (Phase F.4) |
| `CriteresGrid.tsx` (1078 l), `DossierFiles.tsx`, `DossierList.tsx`, `ReviewForm.tsx`, `VeriteBadge.tsx`, `SourceLink.tsx`, `DossierFileViewer.tsx` | OIF-pur | régénéré par `ui-page-generator` depuis les types |
| `CampaignWizard.tsx`, `OnboardingWizard.tsx`, `StorageModeSelector.tsx`, `StorageGuard.tsx`, `ConflictBanner.tsx`, `AppChromeHeader.tsx` | OIF storage multi-poste | **non réutilisable** — pas de génération |
| `CalibrageSection.tsx` (3553 l), `CostsDashboard.tsx` (1342 l), `DiffViewer.tsx`, `SkillEditor.tsx`, `RuleProposalForm.tsx` | métier + générique mêlés | candidats à splitter avant Phase F.4 |

**Génériques (gardés)** : composants liés au flux SSE / streaming / chat /
icônes / progress bar.
**Métier (régénérés)** : tout ce qui touche à une entité domain (`Dossier*`,
`Critere*`, `Campaign*`, etc.).

---

## 3. Non-automatisable

Les agents factory ne génèrent **pas** :

- **Logique business spécifique** : `server/calibrage-imports.ts` (1216 l) =
  parsing XLSX OIF avec colonnes Excel custom. Marcelle aura
  `process-message.ts` analogue, mais non générique.
- **Intégrations très custom** : Maestro YAML templating
  (marcelle-calibre), MCP servers spécifiques (`electron/mcp-xlsx.cjs`
  d'oif-eval), PDF.js vendoring (`scripts/vendor-pdfjs.mjs`).
- **Migrations one-shot / scripts utilitaires** : `scripts/calibrer.ts`,
  `scripts/calibrage-loop.ts`, `scripts/seed-dashboard.mjs`,
  `scripts/inspect-oif-xlsx.mjs`, `scripts/test-*.ts`,
  `scripts/import-bench.mjs` (côté marcelle). À coder à la main par l'app.
- **Données de référence** : `data-template/.claude/schemas/*` quand le
  schéma vient d'un référentiel externe ; `questions.json`, `gold-standards/`
  côté marcelle-calibre.
- **Storage multi-poste / sync bundles** (~1000 lignes oif-eval) — pas un
  pattern récurrent.
- **PDF highlighting** (`server/pdf-highlight.ts`) — opt-in domain-specific.
- **Logo / branding visuel** — icônes générées une fois via
  `scripts/make-icon.mjs`, restent à la main de l'app.

---

## 4. Conventions à respecter par tous les agents

- **`factory-journal.md`** (à la racine de l'app générée) : chaque agent
  append un bloc `## <agent-name> <ISO-timestamp>` listant fichiers
  créés/modifiés, hypothèses prises, TODOs laissés, warnings. Sert à la
  review post-scaffold (cf. Phase F.3).
- **Test sortie** : chaque agent vérifie que `npx tsc --noEmit` passe avant
  de rendre la main. Si erreur, le journal documente.
- **Scope strict** : un agent ne touche **jamais** les fichiers hors de son
  scope (cf. prompt système de chaque agent, Phase F.2). Si un fichier
  invariant doit être patché, l'agent le signale dans le journal et stoppe.
- **Placeholders** : `{{ENTITY}}`, `{{ENTITY_PLURAL}}`, `{{APP_NAME}}`,
  `{{DAEMON_PORT}}`, `{{NEXT_PORT}}`, `{{DATA_DIR_ENV_VAR}}` — utilisés par
  les agents pour rester génériques tant que `init-from-template.mjs` n'a
  pas tourné.
- **Pas de dépendances ajoutées sans raison** : si l'agent veut ajouter un
  package npm, il l'écrit dans le journal pour validation humaine, ne
  modifie pas `package.json` automatiquement (à valider Phase F.3).
- **Audit log** : toute nouvelle route Hono sensible doit appeler `audit(c, {…})`.

---

## 5. Liste des fichiers exacts qu'une app génère (récap)

Par agent, fichiers produits dans l'app cible :

### `app-scaffolder`
- `package.json` (rebrand : `name`, `version`, `productName`, `build.appId`,
  `build.productName`, scripts avec ports)
- `README.md` (rebrand titre + brief domain)
- `.factory-meta.json` (traçabilité : version factory, date, brief, agents
  invoqués)
- `factory-journal.md` (création initiale)
- `data-template/.claude/CLAUDE.md` (rebrand placeholders)
- Icônes : `public/icon-*` régénérées via `scripts/make-icon.mjs` si logo
  fourni dans le brief

### `domain-modeler`
- `server/types.ts` (étendu)
- `lib/types.ts` (étendu)
- `lib/<sub-domain>-types.ts` (optionnel, > 100 l)
- `data-template/.claude/schemas/<entity>.schema.json` (optionnel)

### `subprocess-driver`
- `server/<domain>-driver.ts`
- `server/<domain>-runner.ts`
- `server/index.ts` (routes Hono ajoutées : CRUD entity + subprocess
  routes + SSE)
- `lib/client.ts` (fetch helpers ajoutés pour les nouvelles routes)
- Optionnel : extension de `server/parse-stream.ts` ou nouveau
  `server/<domain>-parse-stream.ts`

### `ui-page-generator`
- `app/<entities>/page.tsx`
- `app/<entities>/[id]/page.tsx`
- `app/run/page.tsx` (si distinct de `<entities>`)
- `app/dashboard/page.tsx` (si brief le demande)
- `components/<Entity>Table.tsx`
- `components/<Entity>Drawer.tsx`
- `components/<Entity>Form.tsx`
- `app/settings/page.tsx` (édité pour ajouter les inputs `AppConfig` étendus)
- `app/page.tsx` : NE PAS toucher — c'est un redirect serveur invariant
  vers `/runs`. La nav passe par `<AppChromeHeader />` (tabs domain).

### `skill-author`
- `skills-template/_global/<slug>.skill.md` (3-5 fichiers)
- `data-template/.claude/commands/<slug>.md` (optionnel : slash commands)
- `data-template/.claude/hooks/validate-<x>.mjs` (optionnel : hook validation)
- `data-template/.claude/schemas/<x>.schema.json` (optionnel ; coordonné
  avec `domain-modeler`)

---

## Annexe — Statistiques d'audit

- oif-eval : 75 fichiers code/types (hors `node_modules`, `.next`, `.git`,
  screenshots), ~32 000 lignes TS+TSX.
- template post Part T : ~25 fichiers code, ~3 500 lignes TS+TSX.
- Ratio domain-specific OIF / invariants template : **environ 10×**
  (oif-eval = template + un gros bloc métier de ~28 500 lignes).
- Sur ces 28 500 lignes oif-eval, l'estimation factory : ~40 % génériquement
  automatisable par les agents (types + routes CRUD + pages standard +
  composants entity-table/drawer/form + skills), ~30 % non-réutilisable
  (storage multi-poste, sync bundles, XLSX/PDF, MCP custom), ~30 % à
  rédiger humainement (logique business spécifique).
