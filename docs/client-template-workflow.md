# Client/template workflow

This public template must stay client-neutral. Real customer implementations
belong in private repositories.

Use `skills-template/_global/yaka-bridge-create-module.skill.md` when creating
or extracting a module. Use
`skills-template/_global/yaka-bridge-new-client-vps.skill.md` when creating a
new customer ERP or provisioning a VPS.

## Create a new ERP client

1. Write a brief with `MODULES`, for example:

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
   DOMAIN_BRIEF: Customer ERP using the purchasing module.
   ```

2. Run:

   ```bash
node scripts/new-app-from-brief.mjs \
  --brief briefs/demo-erp-purchasing.md \
  --output-dir ../customer-erp \
  --yes \
  --skip-agents
```

3. Run `npm ci`, `npm run typecheck`, `npm run build` in the generated app.
4. Configure Supabase, auth origins and Bridge deployment secrets outside git.

## Add a module to an existing client ERP

1. If the module depends on customer-specific rules, build it first inside the
   private client repo.
2. Keep customer prompts, names, domains and data in that private repo.
3. When the module is stable, extract only the generic structure into
   `modules/<moduleId>/` in this template.
4. Replace all customer records with demo/anonymized data.
5. Add or update migrations, actions, manifest, seeds and docs.
6. Run the template CI checks before considering the module reusable.

If the module is already generic, create it in this template first and install
it in the private client repo through configuration and client-only overrides.

`MODULES` is required for catalog-based projects. Use `--legacy-entity` only
for an old ENTITY-only scaffold that is not backed by a catalog module.

## Private production cases

Private customer repositories are production implementations of this template.
Structural improvements discovered there should be ported back here. Customer
specific data must never be copied back.
