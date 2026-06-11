# Security policy

Security issues are handled privately. Do not open a public issue for a
vulnerability.

## Supported versions

yaka-bridge is currently pre-1.0. Security fixes target the default branch
`main`.

| Version | Supported |
| --- | --- |
| `main` | Yes |
| older commits | No |

## Reporting a vulnerability

Use GitHub private vulnerability reporting or contact the repository owner
privately through an agreed secure channel.

Include:

- affected commit or release;
- affected route, script, migration or module;
- reproduction steps;
- expected impact;
- whether customer data, secrets or tokens may be exposed;
- suggested fix if known.

Do not include secrets or real customer data in the report. If a secret was
exposed, rotate it before sharing details.

## Security expectations

This project expects:

- no committed secrets;
- no real customer data in the public template;
- Supabase service role keys only on the server;
- Supabase bearer auth for cloud private routes;
- RLS on module tables;
- explicit organization, role and scope checks;
- signed, expiring and revocable Bridge tokens;
- explicit CORS origins in production;
- CI blocking `high` and `critical` npm audit findings.

## Disclosure

Security fixes are prioritized. Public disclosure should wait until a fix is
available on `main` and downstream private customer implementations have had a
reasonable chance to apply it.
