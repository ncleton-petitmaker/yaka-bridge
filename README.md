# yaka-bridge

Template cloud/Bridge pour créer des ERP métier modulaires avec Next.js,
Supabase, services web par module, Bridge local et workflows agentiques.

Le repo public `yaka-bridge` ne contient aucun cas client réel. Les modules
fournis ici utilisent uniquement des données demo anonymisées.

yaka-bridge est un ERP en ligne évolutif pensé pour fonctionner avec
l'abonnement ChatGPT de chaque collaborateur plutôt qu'avec une dépendance
exclusive aux appels API. L'application Bridge installée localement orchestre
les échanges entre les services ERP, ChatGPT, les MCP et les jobs autorisés, au
bon moment et avec audit.

## What is included

- Next.js App Router UI with a shared ERP workspace design system.
- Hono API daemon for local/Electron mode.
- Supabase foundation for organizations, services, entitlements, ERP modules,
  jobs, events and audit.
- Bridge runtime for local machine execution of cloud jobs.
- Agentic-first action registry with HTTP and MCP parity.
- Module catalog starting with `purchasing`.
- Factory script for generating new ERP projects from briefs.
- Global skills for creating new modules and provisioning new clients.
- Production maintenance guardrails: auth, audit, CI, dependency automation.

## Quick start

```bash
npm install
npm run typecheck
npm run build
```

Local daemon routes require `APP_DAEMON_TOKEN`. In desktop mode the Electron
preload passes that token to the UI. Plain browser development should target a
cloud API with Supabase auth instead of an unauthenticated local daemon.

Generate a demo ERP from the catalog:

```bash
node scripts/new-app-from-brief.mjs \
  --brief briefs/demo-erp-purchasing.md \
  --output-dir ../demo-erp \
  --yes \
  --skip-agents
```

## Production posture

For cloud deployments, set `REQUIRE_AUTH=1`, explicit CORS origins, Supabase
server secrets, `NEXT_PUBLIC_BRIDGE_ORGANIZATION_ID` and a Bridge token secret. See
[docs/cloud-security.md](docs/cloud-security.md).

CI/security checks:

```bash
npm run typecheck
npm test
npm run build
npm audit --audit-level=high
npm run security:grep
npm run factory:check
```

## Module catalog

Modules live in `modules/<moduleId>/` and include a manifest, UI, server
actions, migrations and demo seeds. See
[docs/module-catalog.md](docs/module-catalog.md).

Current module:

- `purchasing` / Achats: suppliers, quotes, comparison and decision workflows.

## Operator skills

Two global skills are shipped in `skills-template/_global/` and copied to
`data/.claude/skills/_global/` by `npm install`:

- `yaka-bridge-create-module`: create a new ERP module in the template and, when
  a client is selected, apply it in the private client repo.
- `yaka-bridge-new-client-vps`: create a new client ERP on a VPS, including
  DNS, Supabase, services, Bridge, backups and production checks.

For novice-friendly operating instructions, see
[docs/yaka-bridge-operator-guide.md](docs/yaka-bridge-operator-guide.md).

## Client workflow

Real customer implementations live in private repositories. Stable generic
modules can be anonymized and copied back into this template. See
[docs/client-template-workflow.md](docs/client-template-workflow.md).

## Docs

- [docs/architecture.md](docs/architecture.md)
- [docs/bridge-multiservices.md](docs/bridge-multiservices.md)
- [docs/supabase-vps-architecture.md](docs/supabase-vps-architecture.md)
- [docs/vps-provisioning-runbook.md](docs/vps-provisioning-runbook.md)
- [docs/cloud-security.md](docs/cloud-security.md)
- [docs/module-catalog.md](docs/module-catalog.md)
- [docs/yaka-bridge-operator-guide.md](docs/yaka-bridge-operator-guide.md)

## License

MIT
