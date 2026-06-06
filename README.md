# claude-electron-app-template

Template Electron + Hono daemon + Next.js + Claude Code subprocess + skills YAML.

Base structurelle pour scaffolder rapidement des apps desktop **mono-utilisateur, locales**
qui orchestrent Claude Code (ou un autre subprocess) avec :

- Live streaming d'events via SSE,
- Skills YAML résolus selon une hiérarchie perso > global,
- Journal d'audit chaîné SHA-256,
- Sécurité (deny rules Bash/WebFetch/WebSearch + hook PreToolUse qui valide les paths).

## Stack

- **Electron** (`electron/main.cjs`) : process main qui spawn les sidecars et embarque la BrowserWindow.
- **Hono daemon** (`server/index.ts`) : orchestrateur de subprocess + REST/SSE.
- **Next.js** (`app/`) : UI (App Router, pas de Server Actions ; tout passe par `lib/client.ts` -> daemon).
- **Claude Code subprocess** : spawn `claude -p --output-format stream-json`, parsing du stream JSON.
- **Skills YAML** : frontmatter + workflow propositions/promotion.
- **Audit log** : un fichier JSONL par user par jour, chaîné en SHA-256.

## Forker pour une nouvelle app

```bash
gh repo clone ncleton-petitmaker/claude-electron-app-template my-app
cd my-app
rm -rf .git
git init
node scripts/init-from-template.mjs \
  --app-name "My-App" \
  --app-id "fr.example.my-app" \
  --next-port 3300 \
  --daemon-port 7600 \
  --data-dir "My-App" \
  --entity-name "thing" \
  --entity-name-plural "things" \
  --domain-brief "Mon app qui …"
npm install
npm run typecheck
npm run electron
```

Tous les placeholders `{{...}}` sont remplacés en place ; un `.factory-meta.json` est écrit
au root pour traçabilité.

## Layout

```
app/                Next.js App Router (UI)
  page.tsx          home + nav vers /runs /skills /logs /settings
  runs/             liste + detail (SSE live) des runs Claude
  skills/           éditeur skills YAML
  logs/             audit log viewer
  settings/         app-config (modèle, paths, user, …)

components/         composants UI partagés (vide dans le template ; à enrichir)
lib/
  client.ts         fetch helpers vers /api/*
  types.ts          mirroir compact de server/types.ts
  sse.ts            parser SSE

server/             daemon Hono (TypeScript ESM)
  index.ts          routes /api/health, /api/runs, /api/skills, /api/audit, /api/app-config
  runs.ts           cycle de vie des runs Claude, dédup tokens, SSE fan-out
  agents.ts         findClaudeBin + buildClaudeArgs
  parse-stream.ts   parser claude-stream-json -> AgentEvent typé
  pricing.ts        tarifs Anthropic, computeCostUsd
  run-history.ts    persistance .events.jsonl (tag-based)
  skills.ts         CRUD skills global/perso/propositions
  audit-log.ts      journal chaîné SHA-256
  app-config.ts     persistance app-config.json
  agents-status.ts  probe `claude --version` + login

electron/
  main.cjs          spawn daemon + next, BrowserWindow, onboarding Claude
  preload.cjs       bridge IPC minimal
  setup-preload.cjs setup wizard

skills-template/    skills par défaut empaquetés avec l'app
  _global/          (vide dans le template ; les apps y posent leurs skills)

data-template/      template du dossier de données runtime
  .claude/
    CLAUDE.md       posture, sécurité, conventions de sortie
    settings.json   permissions.deny + hook PreToolUse
    hooks/          restrict-write-paths.mjs
    skills/_global/ skills déployés au premier lancement

scripts/
  init-from-template.mjs    rebrand CLI (placeholders -> valeurs)
  postinstall.js            déploie data-template/ -> data/
  build-server.mjs          esbuild server/index.ts -> dist/server.cjs
  prepare-pack.mjs          orchestre le pack electron-builder
  start.js                  fallback non-Electron (daemon + next + open browser)

template.config.json    manifeste des placeholders (lu par init-from-template.mjs)
```

## Docs

- [docs/architecture.md](docs/architecture.md) : flux UI -> daemon -> subprocess -> SSE -> UI.
- [docs/customization-guide.md](docs/customization-guide.md) : où poser le code domain.
- [docs/gotchas.md](docs/gotchas.md) : pièges connus (Maestro unicode, undici timeout, Kong, asar).
- [docs/subprocess-patterns.md](docs/subprocess-patterns.md) : 4 modèles de drivers (claude-cli, maestro, http-api, cli-custom).
- [docs/supabase-vps-architecture.md](docs/supabase-vps-architecture.md) : architecture Bridge + Supabase self-hosted.
- [docs/vps-provisioning-runbook.md](docs/vps-provisioning-runbook.md) : checklist pour provisionner un VPS client.

## License

MIT.
