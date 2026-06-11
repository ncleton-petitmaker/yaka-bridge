# Onboarding

This is the first command path for someone who has just imported yaka-bridge.

## One-command start

```bash
git clone https://github.com/<owner>/yaka-bridge.git
cd yaka-bridge
npm ci
npm run codex:onboard
```

`npm run codex:onboard` verifies the repo-local Codex skills and launches Codex
with the `yaka-bridge-onboard` skill.

If you use Codex Desktop instead of the CLI:

```bash
npm --silent run codex:onboard:prompt
```

Copy the printed prompt into Codex while this repository is the active project.

## What the assistant does

The onboarding assistant asks for:

- local demo, new customer, or existing customer;
- local company folder under `Projets/<CompanyFolder>/`;
- GitHub owner or organization;
- customer name and technical slug;
- module list and design system;
- OVH VPS creation or existing VPS connection;
- domain and DNS provider;
- Supabase, Bridge, backup and observability choices.

It then routes the work to the specialized skills:

- `yaka-bridge-version-modules`;
- `yaka-bridge-new-client-vps`;
- `yaka-bridge-create-module`;
- `yaka-bridge-refactor-design-system`.

## Safety rules

- Customer folders under `Projets/<CompanyFolder>/` are private and ignored by
  git.
- Do not paste secrets, passwords, private keys or Supabase service role keys
  into chat.
- Customer repos and customer module repos stay private.
- DNS, CORS and Supabase redirect URLs must be explicit in production.
- Postgres must not be exposed publicly.
- Production readiness requires CI, audit, security grep, DNS/TLS checks,
  Bridge token checks and a restore drill.
