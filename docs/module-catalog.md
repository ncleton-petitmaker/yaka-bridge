# ERP module catalog

The template uses a small module catalog to compose ERP projects.

When creating a new module, start with
`skills-template/_global/yaka-bridge-version-modules.skill.md`, then use
`skills-template/_global/yaka-bridge-create-module.skill.md`. The versioning
skill chooses the correct repo and release path before implementation starts.

## Module shape

A module lives in `modules/<moduleId>/` and must include:

- `module.config.json`: canonical manifest used by the factory and docs.
- `version`: SemVer module contract version inside the manifest.
- UI components/routes that use the shared design system.
- Server actions exposed through `server/actions.ts` and MCP parity.
- Supabase migrations with `organization_id` and RLS.
- Demo seeds with anonymized data only.

Technical ids are English (`purchasing`, `stock`, `crm`). UI labels can be
localized in the manifest.

Customer-specific modules should be developed in private
`<clientSlug>-module-<moduleId>` repositories and promoted into customer ERP
repos through `modules.lock.json`. Only anonymized reusable structure belongs in
this public catalog. See [repository-governance.md](repository-governance.md).

## Security model

Business tables are prefixed by module, for example
`purchasing_suppliers` and `purchasing_quotes`.

Every table must:

- include `organization_id`;
- enable RLS;
- allow reads only through `bridge_has_scope(..., service:<module>:read)`,
  write scope or module admin scope;
- allow writes only through write/admin scope and server-controlled actions.

Bridge jobs are filtered by service id and scopes. Sensitive agentic execution
must keep `codex:run` separate from ordinary module read/write scopes.

## Current catalog

- `purchasing`: generic purchasing module with suppliers, quotes, comparison
  workflows and demo data.
