# Support

This repository is a public template, not a hosted support desk.

## Good public issues

Open a GitHub issue for:

- reproducible bugs in the template;
- documentation gaps;
- module catalog improvements;
- CI or factory failures;
- non-sensitive security hardening discussions.

## Do not open public issues for

- vulnerabilities;
- secrets or tokens;
- private customer names, domains, prompts or documents;
- production incidents involving customer data.

Use [SECURITY.md](SECURITY.md) for vulnerabilities.

## Before asking for help

Run:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run security:grep
npm run factory:check
```

Include command output, OS, Node version and the exact commit hash when opening
a public issue.
