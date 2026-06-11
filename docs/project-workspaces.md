# Project workspaces

yaka-bridge keeps the public template and private customer work clearly
separated on disk.

The repository root is the reusable template. Private customer work lives under
`Projets/<CompanyFolder>/`.

```text
Yaka-Bridge/
  app/
  modules/
  skills-template/
  Projets/
    README.md              tracked public guidance
    _template/             tracked public empty shape
    <CompanyFolder>/       ignored private local workspace
      <clientSlug>-erp/
      <clientSlug>-module-<moduleId>/
      vps/
      legacy/
```

## Rules

- `Projets/<CompanyFolder>/` is private and ignored by git.
- The public template must never contain customer names, domains, documents,
  prompts, secrets or deployment state.
- A new customer gets a local company folder and a private GitHub repo.
- A new customer-specific module gets its own private repo by default.
- Human-readable local subproject names are allowed, but repo names, manifests
  and module ids must stay stable and technical.

## Commands

List local customer folders:

```bash
npm run projects:list
```

Verify that private customer content is ignored by git:

```bash
npm run projects:check
```

Create a new local customer folder:

```bash
npm run projects:init -- --company "Example Company" --slug example-company
```

Use `--folder` when the local folder name should differ from the technical slug:

```bash
npm run projects:init -- --company "Example Company" --slug example-company --folder ExampleCompany
```

## Relationship with GitHub

The local folder is only organization on disk. GitHub remains the source of
truth for versioning and collaboration:

- `<clientSlug>-erp`: private customer ERP control repo;
- `<clientSlug>-module-<moduleId>`: private customer module repo;
- `yaka-bridge`: public template repo.

Run `yaka-bridge-version-modules` before creating or promoting a customer repo
or module.
