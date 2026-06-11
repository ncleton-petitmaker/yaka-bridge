# VPS Provisioning Runbook

Use this runbook when starting a new modular ERP customer stack based on Bridge + Supabase self-hosted.

## Inputs

Collect these values before touching the server:

- VPS IPv4 and SSH user.
- Public Supabase API domain, for example `api.customer.example`.
- Public app/admin domains, for example `erp.customer.example` and `admin.customer.example`.
- Public service domains, for example `purchasing.customer.example`.
- Email for TLS certificates.
- Organization name and first Bridge admin email.
- Initial module list, for example `MODULES: ["purchasing"]`.

Do not put secrets in the repo. Secrets belong in `/opt/supabase/.env`, Coolify secret storage, or the customer's CI/CD vault.

## DNS

Create DNS records before testing browser flows:

```text
api.customer.example       A     <vps-ipv4>
erp.customer.example       A     <vps-ipv4>
admin.customer.example     A     <vps-ipv4>
purchasing.customer.example A    <vps-ipv4>
bridge-updates.customer.example A <vps-ipv4>
```

Without DNS, server-side checks can still use SSH tunnels or `curl --resolve`, but Supabase Auth and browser sessions are not production-valid.

## Server Baseline

On the VPS:

```bash
apt update
apt install -y ca-certificates curl git jq
```

Install Docker and keep Postgres private. The expected runtime shape is:

```text
/opt/supabase/docker-compose.yml
/opt/supabase/.env
coolify-proxy / Traefik
supabase-kong on Traefik + local 127.0.0.1:8100
supabase-db on 127.0.0.1:5432 only
```

## Supabase Foundation

After Supabase is running, apply every template migration in lexical order:

```bash
for migration in supabase/migrations/*.sql; do
  echo "Applying $migration"
  docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
    < "$migration"
done
```

This includes shared `bridge_*`, `erp_*` tables and catalog module migrations
such as `purchasing_*`. Do not skip module migrations: the catalog entry alone
is not enough for production.

Verify the shared ERP modules:

```bash
cd /opt/supabase
source .env
curl -H "apikey: $ANON_KEY" \
  -H "Authorization: Bearer $ANON_KEY" \
  "http://127.0.0.1:8100/rest/v1/erp_modules?select=module_key,name"
```

Expected modules:

```text
crm
purchasing
```

## Production Auth Defaults

For customer ERP stacks, Bridge accounts are created by an organization admin.
Do not leave public signups open on a customer VPS.

In `/opt/supabase/.env`, set:

```dotenv
GOTRUE_DISABLE_SIGNUP=true
GOTRUE_MAILER_AUTOCONFIRM=false
GOTRUE_SMTP_HOST=<smtp host>
GOTRUE_SMTP_PORT=587
GOTRUE_SMTP_USER=<smtp user>
GOTRUE_SMTP_PASS=<smtp password>
GOTRUE_SMTP_ADMIN_EMAIL=<no-reply or admin email>
GOTRUE_SMTP_SENDER_NAME=Bridge
STORAGE_FILE_SIZE_LIMIT=268435456
```

Then restart Auth and Storage:

```bash
cd /opt/supabase
docker compose up -d auth storage
```

The first admin can be created through the Control Plane admin bootstrap, but
normal users must be invited or created by an existing `owner`/`admin`.

## App-Specific Migrations

Each generated service owns its app migrations. Apply them after the shared foundation:

```bash
docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  < supabase/migrations/<service-migration>.sql
```

Migrations should be idempotent where practical (`create table if not exists`, `add column if not exists`) so crash tests can be rerun safely.

## Generated App Runtime

For local smoke tests before DNS:

```bash
ssh -N -L 18100:127.0.0.1:8100 root@<vps-ipv4>
```

Then use an ignored `.env.local` in the generated app:

```dotenv
SUPABASE_URL=http://127.0.0.1:18100
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:18100
SUPABASE_ANON_KEY=<anon key from /opt/supabase/.env>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<same anon key>
SUPABASE_SERVICE_ROLE_KEY=<service role key from /opt/supabase/.env>
```

For VPS/Coolify deployment:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://api.customer.example
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
SUPABASE_URL=http://supabase-kong:8000
SUPABASE_ANON_KEY=<anon key>
SUPABASE_SERVICE_ROLE_KEY=<service role key>
NEXT_PUBLIC_BRIDGE_INSTALLER_BASE_URL=https://api.customer.example/storage/v1/object/public/bridge-installers
NEXT_PUBLIC_OPENREPLAY_ENABLED=false
NEXT_PUBLIC_OPENREPLAY_PRIVATE_MODE=true
```

If the app uses Next route handlers as its cloud API, disable local daemon rewrites in production. Long-running Codex jobs should go through Bridge jobs, not through the web container.

## Bridge Installers Storage

Bridge installers belong on the customer VPS, not on Vercel or a generated app host. Use the self-hosted Supabase Storage service:

```sql
insert into storage.buckets (id, name, public, file_size_limit)
values ('bridge-installers', 'bridge-installers', true, 268435456)
on conflict (id) do update set public = true, file_size_limit = 268435456;

insert into storage.buckets (id, name, public, file_size_limit)
values ('bridge-updates', 'bridge-updates', true, 536870912)
on conflict (id) do update set public = true, file_size_limit = 536870912;
```

Upload stable object names after packaging Bridge. For production, macOS builds
must be signed with a Developer ID certificate and notarized before upload; see
[`bridge-release-signing.md`](bridge-release-signing.md).

```text
Bridge-Setup.exe
Bridge.dmg
SHA256SUMS
```

The generated service reads `NEXT_PUBLIC_BRIDGE_INSTALLER_BASE_URL` and exposes those URLs through `/api/bridge/status`.

The Bridge desktop app reads its automatic update feed from
`BRIDGE_UPDATE_BASE_URL`, `cfg.updateBaseUrl`, or by default:

```text
https://api.customer.example/storage/v1/object/public/bridge-updates
```

See [`bridge-auto-update.md`](bridge-auto-update.md) for the required
`latest*.yml`, blockmap and versioned artifact files.

## Supabase Auth

Update `/opt/supabase/.env`:

```dotenv
SITE_URL=https://erp.customer.example
ADDITIONAL_REDIRECT_URLS=https://erp.customer.example/**,https://admin.customer.example/**,https://purchasing.customer.example/**
```

Then restart Auth:

```bash
cd /opt/supabase
docker compose restart auth
```

## Backups And Restore

Self-hosted Supabase means the customer stack owns its own disaster recovery.
Before production data lands on the VPS, create a backup job for Postgres and
Storage and run a restore drill.

Minimum baseline:

```bash
mkdir -p /opt/backups/supabase
docker exec supabase-db pg_dump -U postgres -d postgres --format=custom \
  > /opt/backups/supabase/postgres-$(date +%Y%m%d-%H%M%S).dump
docker run --rm \
  -v supabase_supabase-storage:/storage:ro \
  -v /opt/backups/supabase:/backup \
  alpine tar -czf /backup/storage-$(date +%Y%m%d-%H%M%S).tar.gz /storage
```

Keep backups outside the VPS as well, for example encrypted object storage.
Document the restore command used for each customer and test it after the
first deployment and after major migrations.

## Traefik Security Baseline

Public routers must redirect HTTP to HTTPS and attach security headers. Protect
Traefik/Coolify dashboards with their own authentication and never expose the
raw Docker socket publicly.

Expected headers for app/admin/API routers:

```text
Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=()
```

Use the same middleware names across customer stacks so generated projects can
attach labels consistently.

## Acceptance Checks

Use [`bridge-security-test-matrix.md`](bridge-security-test-matrix.md) before
promoting a stack to production. Minimum smoke checks:

- `docker compose ps` shows Supabase services healthy.
- Public `https://api.customer.example/rest/v1/` reaches Kong.
- Public `https://api.customer.example/storage/v1/object/public/bridge-installers/SHA256SUMS` returns installer checksums.
- Public `https://api.customer.example/storage/v1/object/public/bridge-updates/latest.yml` returns update metadata after the first release.
- `erp_modules` returns `crm` and `purchasing`.
- App-specific health route returns Supabase configured.
- A browser login succeeds against the customer app domain.
- Bridge can register, sync services, receive a job, and emit job events.
- `/admin/observability` shows the current support session after a browser login.
- A restore drill succeeds from the latest Postgres and Storage backups.
- Public signup is refused unless the customer explicitly opted into it.
