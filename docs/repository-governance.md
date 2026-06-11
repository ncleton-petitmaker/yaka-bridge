# Repository governance

yaka-bridge uses a multi-repository model. This is a production rule, not a
preference.

The goal is to let non-developer operators build or adapt modules with agentic
tools while limiting the blast radius of mistakes. GitHub permissions and
branch protections are useful gates, but a folder inside one large repository
is not a security boundary.

## Repository topology

| Repository | Visibility | Purpose | Who can write |
| --- | --- | --- | --- |
| `yaka-bridge` | Public | Reusable template, generic modules, docs, skills and anonymized examples. | Template maintainers only. |
| `<clientSlug>-erp` | Private | Production control repo for one customer ERP: deployment config, DNS runbooks, module registry, entitlements and version locks. | Platform maintainers and approved senior reviewers. |
| `<clientSlug>-module-<moduleId>` | Private | Customer-specific module development repo. Required for new, risky, private or non-developer-built modules. | Module contributors, including trained operators, with limited scope. |

## Mandatory decisions

- A new ERP customer always gets a new private `<clientSlug>-erp` repository.
- A new customer-specific module gets a private
  `<clientSlug>-module-<moduleId>` repository by default.
- A module built by a trained non-developer must live in its own module
  repository until reviewed and released.
- A customer ERP repo consumes modules through explicit version locks. It must
  not be used as the day-to-day coding workspace for experimental module work.
- The public template receives only generic, anonymized module structure after a
  customer implementation proves useful.
- Activating an existing catalog module with configuration only does not require
  a new module repository.

## Decision table

| Situation | Repository to use |
| --- | --- |
| Create a new customer ERP | Create `<clientSlug>-erp`. |
| Activate a stable catalog module | Edit `<clientSlug>-erp` config and lock. |
| Build a new module for one customer | Create `<clientSlug>-module-<moduleId>`. |
| Let a trained operator modify a module | Use only that module repository. |
| Extract a reusable pattern from production | Add an anonymized version to `yaka-bridge/modules/<moduleId>`. |
| Change shared architecture, security or factory behavior | Change `yaka-bridge` first, then port into customer repos. |

## Client module lock

Each customer ERP repo should keep a `modules.lock.json` file. It records the
module versions that are allowed in production.

```json
{
  "schema": "yaka-bridge/modules-lock.v1",
  "template": {
    "repository": "github.com/<owner>/yaka-bridge",
    "ref": "main"
  },
  "modules": [
    {
      "id": "purchasing",
      "source": "catalog",
      "repository": "github.com/<owner>/yaka-bridge",
      "ref": "purchasing-v0.1.0",
      "version": "0.1.0"
    },
    {
      "id": "stock",
      "source": "client-module",
      "repository": "github.com/<owner>/<clientSlug>-module-stock",
      "ref": "v0.1.0",
      "version": "0.1.0"
    }
  ]
}
```

Rules:

- `modules.lock.json` is reviewed like production code.
- Module refs are immutable tags or commit SHAs, never floating feature
  branches.
- A module version cannot be promoted to a customer ERP until its own CI has
  passed and a release note exists.
- Database migrations are append-only. A released migration is never edited in
  place.

## Module versioning

Module manifests include `version`.

Use SemVer:

- `MAJOR`: breaking manifest, route, scope, migration or action contract change.
- `MINOR`: backward-compatible workflow, action, UI or table addition.
- `PATCH`: bug fix, security hardening or internal maintenance with no contract
  change.

Tag rules:

- In a one-module customer module repo, tag releases as `vX.Y.Z`.
- In the public template, tag reusable module snapshots as
  `<moduleId>-vX.Y.Z` when needed.
- Customer ERP repos reference module tags through `modules.lock.json`.

## GitHub administration baseline

Every production or module repository must have:

- private visibility for customer and module repos;
- protected `main`;
- pull requests required before merge;
- required CI status checks;
- force-push and branch deletion blocked;
- linear history enabled where possible;
- CODEOWNERS or an equivalent ruleset for sensitive paths;
- no non-developer admin access;
- deployment environments protected by maintainers;
- secrets stored in GitHub Environments, the VPS, or a vault, never in git.

Recommended role split:

- Platform owner: repository admin.
- Senior reviewer: maintainer or write access with review responsibility.
- Trained operator: write access only to the relevant module repo.
- Customer business user: read or triage access only unless explicitly trained.
- Deployment bot: minimum permissions required for CI/CD.

## Required skill

Before creating, modifying, releasing or promoting a module, run:

```text
Use the yaka-bridge-version-modules skill to verify the repository topology,
permissions, protections, version bump and promotion path.
```

That skill must run before `yaka-bridge-create-module` writes code for a
customer-specific module.
