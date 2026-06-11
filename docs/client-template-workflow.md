# Client/template workflow

This public template must stay client-neutral. Real customer implementations
belong in private repositories.

Use `skills-template/_global/yaka-bridge-create-module.skill.md` when creating
or extracting a module. Use
`skills-template/_global/yaka-bridge-new-client-vps.skill.md` when creating a
new customer ERP or provisioning a VPS. Use
`skills-template/_global/yaka-bridge-refactor-design-system.skill.md` when a
client changes the design system for all modules and Bridge. Use
`skills-template/_global/yaka-bridge-version-modules.skill.md` before any
module creation, release or promotion.

## Repository rule

The repository topology is fixed:

- a new customer ERP always gets a private `<clientSlug>-erp` repo;
- a new customer-specific module gets a private
  `<clientSlug>-module-<moduleId>` repo by default;
- a module touched by a trained non-developer must stay in its own module repo
  until reviewed and released;
- the customer ERP repo consumes modules through `modules.lock.json`;
- reusable structure is anonymized before entering the public template.

See [repository-governance.md](repository-governance.md).

## Create a new ERP client

1. Create or verify the private `<clientSlug>-erp` repo through
   `yaka-bridge-version-modules`.
2. Write a brief with `MODULES`, for example:

   ```yaml
   APP_NAME: Customer ERP
   APP_ID: com.customer.erp
   NEXT_PORT: 3307
   DAEMON_PORT: 7707
   DATA_DIR_NAME: Customer ERP
   ENTITY: purchase_request
   ENTITY_PLURAL: purchase_requests
   SUBPROCESS: codex-cli
   MODULES:
     - purchasing
   DESIGN_SYSTEM: claude
   DOMAIN_BRIEF: Customer ERP using the purchasing module.
   ```

3. Run:

   ```bash
node scripts/new-app-from-brief.mjs \
  --brief briefs/demo-erp-purchasing.md \
  --output-dir ../customer-erp \
  --yes \
  --skip-agents
```

4. Run `npm ci`, `npm run typecheck`, `npm run build` in the generated app.
5. Configure Supabase, auth origins and Bridge deployment secrets outside git.

Choose the design system during this first setup. `claude` is the default. A
client-specific design system must stay in the private client repo unless it is
generic enough to anonymize and promote back into the template.

## Add a module to an existing client ERP

1. Run `yaka-bridge-version-modules` to classify the work.
2. If the module depends on customer-specific rules, build it first in a
   private `<clientSlug>-module-<moduleId>` repo.
3. Keep customer prompts, names, domains and data in private repos only.
4. When the module is released, update the customer ERP repo
   `modules.lock.json`.
5. When the module is stable, extract only the generic structure into
   `modules/<moduleId>/` in this template.
6. Replace all customer records with demo/anonymized data.
7. Add or update migrations, actions, manifest, seeds and docs.
8. Run the template CI checks before considering the module reusable.

If the module is already generic, create it in this template first and install
it in the private client repo through configuration and client-only overrides.

`MODULES` is required for catalog-based projects. Use `--legacy-entity` only
for an old ENTITY-only scaffold that is not backed by a catalog module.

## Private production cases

Private customer repositories are production implementations of this template.
Structural improvements discovered there should be ported back here. Customer
specific data must never be copied back.
