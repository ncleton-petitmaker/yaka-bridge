# VPS Provisioning Runbook

Use this runbook when starting a new modular ERP customer stack based on Bridge + Supabase self-hosted.

## Inputs

Collect these values before touching the server:

- VPS IPv4 and SSH user.
- Public Supabase API domain, for example `api.customer.example`.
- Public app/admin domains, for example `erp.customer.example` and `admin.customer.example`.
- Email for TLS certificates.
- Organization name and first Bridge admin email.

Do not put secrets in the repo. Secrets belong in `/opt/supabase/.env`, Coolify secret storage, or the customer's CI/CD vault.

## DNS

Create DNS records before testing browser flows:

```text
api.customer.example       A     <vps-ipv4>
erp.customer.example       A     <vps-ipv4>
admin.customer.example     A     <vps-ipv4>
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

After Supabase is running, apply the template migrations:

```bash
docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  < supabase/migrations/20260606120000_bridge_control_plane.sql

docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  < supabase/migrations/20260606123000_modular_erp_core.sql
```

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
```

If the app uses Next route handlers as its cloud API, disable local daemon rewrites in production. Long-running Codex jobs should go through Bridge jobs, not through the web container.

## Bridge Installers Storage

Bridge installers belong on the customer VPS, not on Vercel or a generated app host. Use the self-hosted Supabase Storage service:

```sql
insert into storage.buckets (id, name, public, file_size_limit)
values ('bridge-installers', 'bridge-installers', true, 268435456)
on conflict (id) do update set public = true, file_size_limit = 268435456;
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

## Supabase Auth

Update `/opt/supabase/.env`:

```dotenv
SITE_URL=https://erp.customer.example
ADDITIONAL_REDIRECT_URLS=https://erp.customer.example/**,https://admin.customer.example/**
```

Then restart Auth:

```bash
cd /opt/supabase
docker compose restart auth
```

## Acceptance Checks

- `docker compose ps` shows Supabase services healthy.
- Public `https://api.customer.example/rest/v1/` reaches Kong.
- Public `https://api.customer.example/storage/v1/object/public/bridge-installers/SHA256SUMS` returns installer checksums.
- `erp_modules` returns `crm` and `purchasing`.
- App-specific health route returns Supabase configured.
- A browser login succeeds against the customer app domain.
- Bridge can register, sync services, receive a job, and emit job events.
