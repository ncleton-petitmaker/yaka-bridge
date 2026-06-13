# Yaka platform/client sync

## Decision

`yaka-bridge` remains the single source repository for the Yaka platform. Client
ERP repositories must not copy the platform runtime. They consume versioned
`@ncleton-petitmaker/yaka-*` packages and keep only customer-specific code, configuration, modules
and deployment state.

## Repository roles

- `yaka-bridge`: platform monorepo, public template, package source, examples and
  generic documentation.
- `@ncleton-petitmaker/yaka-*`: GitHub Packages names published from `yaka-bridge`.
  This is not a separate repository.
- `templates/client-erp`: scaffold only. It is not a long-lived dependency.
- `Projets/<Company>/<client>-erp`: private client repo, pinned to `@ncleton-petitmaker/yaka-*`
  versions through `yaka.project.json` and `package-lock.json`.
- Client module repos: private module workspaces pinned in `modules.lock.json`.

## Required client contract

Every client repo must contain:

- `yaka.project.json` with schema `yaka/project.v1` and kind `client-erp`.
- `modules.lock.json` with schema `yaka-bridge/modules-lock.v1`.
- `package.json` dependencies for `@ncleton-petitmaker/yaka-bridge-desktop`, `@ncleton-petitmaker/yaka-erp-shell` and
  `@ncleton-petitmaker/yaka-module-sdk`.
- CI running `yaka doctor --strict`.

Client repos must not contain copied platform files:

- `bridge/electron-main.cjs`
- `bridge/provider-setup.cjs`
- `bridge/runtime.ts` or `bridge/runtime.cjs`
- `bridge-voice/src/main.rs`
- `electron-builder.bridge.cjs`
- Bridge build scripts copied from the platform

## Guardrails

Use:

```bash
npm run yaka:doctor
npm run yaka:clients
```

`yaka doctor --strict` is authoritative before packaging or release. It fails
when a client is stale, lacks its project contract, vendors platform core files
or has local Bridge artifacts in `release-bridge`.

Bridge artifacts for clients must be produced by CI from the pinned platform
package versions. Local DMGs are debug outputs only.

## Release flow

1. Change platform code in `yaka-bridge`.
2. Run `npm run yaka:doctor`, `npm test`, `npm run typecheck` and Bridge asset
   verification.
3. Publish a GitHub release or run `Publish Yaka packages` manually.
4. Client repos receive Renovate PRs for `@ncleton-petitmaker/yaka-*` updates.
5. Client CI runs `yaka doctor --strict` before any build or Bridge package.

Use `npm run yaka:pack:packages` locally to dry-run package publication.

## Migration rule

When a legacy client has copied Bridge files, migrate by removing the copied
platform core and adding `@ncleton-petitmaker/yaka-*` package dependencies. Do not patch the copied
Bridge in place except for emergency production recovery, and always promote the
generic fix back to `yaka-bridge`.
