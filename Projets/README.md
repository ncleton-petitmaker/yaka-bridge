# Local customer workspaces

This directory is the local parent for private customer/company workspaces.

The public template keeps only this README, `.gitkeep`, and `_template/`.
Real customer folders are ignored by git.

Recommended shape:

```text
Projets/
  <CompanyFolder>/
    <clientSlug>-erp/                 private customer ERP control repo
    <clientSlug>-module-<moduleId>/   private customer module repo
    vps/                              private VPS/runbook/deployment files
    legacy/                           private source/import references
```

Existing customer folders can use human-readable names, but scripts and skills
should ask for the company folder explicitly and keep all private content out of
the public template.

Useful commands from the repository root:

```bash
npm run projects:list
npm run projects:check
npm run projects:init -- --company "Example Company" --slug example-company
```
