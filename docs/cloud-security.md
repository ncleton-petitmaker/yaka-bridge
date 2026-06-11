# Cloud security checklist

Production cloud deployments must set:

```dotenv
REQUIRE_AUTH=1
APP_ALLOWED_ORIGINS=https://erp.customer.example
SUPABASE_URL=https://api.customer.example
SUPABASE_SERVICE_ROLE_KEY=<server-only>
BRIDGE_TOKEN_SECRET=<long-random-secret>
NEXT_PUBLIC_BRIDGE_ORGANIZATION_ID=<org-uuid>
```

Rules:

- Browser calls to private `/api/*` routes require a valid Supabase bearer token.
- Browser calls must send `x-bridge-organization-id`; the server validates the
  Supabase user membership before route handlers run.
- `/api/health` stays public but only returns minimal status in cloud mode.
- CORS never allows `*`; configure explicit app origins.
- Bridge calls to `/bridge/*` require either a Supabase session or a bridge
  token signed with `BRIDGE_TOKEN_SECRET`.
- Bridge tokens must include `jti`, organization, bridge, device, service ids,
  scopes and expiry. The full token hash must exist in `bridge_device_tokens`;
  revocation is performed by setting `revoked_at`.
- `SUPABASE_SERVICE_ROLE_KEY` is server-only and must never be exposed through
  UI config, logs or public env variables.
- Local daemon mode requires `APP_DAEMON_TOKEN` for every private `/api/*`
  request. The daemon refuses to start without it outside tests.

Create a signed Bridge token:

```bash
BRIDGE_TOKEN_SECRET=<long-random-secret> npm run bridge:token -- \
  --organization-id <org-uuid> \
  --bridge-id <bridge-id> \
  --device-id <device-id> \
  --service-ids purchasing \
  --scopes service:purchasing:read,service:purchasing:write,codex:run \
  --register
```

Without `--register`, the script prints the token plus an SQL insert statement;
the token is unusable until its hash is stored in Supabase.

CI runs install, typecheck, tests, build, `npm audit --audit-level=high`,
`npm run security:grep` and `npm run factory:check`.

Known policy: moderate upstream advisories may be documented temporarily only
when no stable fixed release exists.
