# Contributing to yaka-bridge

Thanks for helping improve yaka-bridge. This project is a production-oriented
ERP template, so contributions are reviewed with security, maintainability and
reproducibility first.

## Before you start

Read:

- [README.md](README.md)
- [docs/yaka-bridge-operator-guide.md](docs/yaka-bridge-operator-guide.md)
- [docs/module-catalog.md](docs/module-catalog.md)
- [docs/cloud-security.md](docs/cloud-security.md)
- [SECURITY.md](SECURITY.md)

## Non-negotiable rules

- Do not add real customer names, domains, prompts, documents or data.
- Do not commit secrets, tokens, dumps or private `.env` files.
- Do not add unauthenticated production routes.
- Do not add CORS wildcards for production.
- Do not let UI code bypass server actions for business mutations.
- Do not hardcode a module-specific visual language; use the active design
  system tokens and shared components.
- Do not let clients provide arbitrary `organizationId` to business actions.
- Do not weaken RLS, scopes, token validation or audit.

## Development workflow

1. Create a branch:

   ```bash
   git checkout -b codex/my-change
   ```

2. Install and verify:

   ```bash
   npm ci
   npm run typecheck
   npm test
   npm run build
   npm audit --audit-level=high
   npm run security:grep
   npm run factory:check
   ```

3. Keep changes focused. Separate documentation, security, module and refactor
   work into different commits when practical.

4. Open a pull request with:
   - what changed;
   - why it changed;
   - security impact;
   - tests run;
   - migration impact, if any.

## Adding a module

Use `skills-template/_global/yaka-bridge-create-module.skill.md` as the process
contract.

A module contribution must include:

- `modules/<moduleId>/module.config.json`;
- UI using the shared design system;
- typed server actions;
- HTTP/MCP parity for business operations;
- Supabase migration with RLS;
- demo seeds only;
- tests for organization/scopes/entitlements;
- docs.

Technical ids are English. UI labels may be bilingual.

Module UI must consume the active design system. If the customer changes design
system later, the module should migrate through
`yaka-bridge-refactor-design-system` without business rewrites.

## Changing cloud or Bridge security

Security-sensitive changes require tests. At minimum, cover:

- unauthenticated request rejection;
- wrong organization rejection;
- missing scope rejection;
- Bridge token expiration/revocation;
- entitlement removal.

If the change affects a production runbook, update the relevant doc in `docs/`.

## Commit style

Use concise imperative commits:

```text
Add stock module manifest
Harden Bridge token validation
Document VPS DNS setup
```

## Pull request checklist

Before requesting review:

- [ ] I ran the full verification suite.
- [ ] I did not add real customer data.
- [ ] I updated docs for user-visible or operational changes.
- [ ] I added or updated tests for security-sensitive behavior.
- [ ] I documented migration or deployment impact.
