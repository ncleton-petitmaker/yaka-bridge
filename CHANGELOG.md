# Changelog

All notable template changes should be documented here.

This project follows a pragmatic pre-1.0 changelog: entries are grouped by date
and focus on operationally relevant changes.

## 2026-06-11

### Added

- Public `yaka-bridge` repository identity.
- Production-hardening baseline for auth, Bridge tokens, Supabase RLS, CI and
  dependency audit.
- Generic `purchasing` module with manifest, demo seeds and Supabase migration.
- Operator skills:
  - `yaka-bridge-create-module`
  - `yaka-bridge-new-client-vps`
- Operator guide for novice-friendly module and VPS/client workflows.
- GitHub community profile files: license, contributing guide, security policy,
  code of conduct, support guide, issue templates and pull request template.

### Changed

- Factory check now generates a demo ERP and runs install, typecheck, build and
  security grep inside the generated project.
- Repository README now documents architecture, security model, workflows and
  production checklist.
