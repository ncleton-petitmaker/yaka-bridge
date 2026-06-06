# Supabase VPS Architecture

This template targets a repeatable Bridge + Supabase self-hosted architecture for modular ERP projects.

## Reference Shape

- One VPS hosts Supabase self-hosted in `/opt/supabase`.
- Coolify and Traefik provide the generic ingress layer.
- Kong exposes the Supabase HTTP API publicly through Traefik.
- Postgres is bound only to `127.0.0.1:5432` on the VPS.
- Supabase secrets live only in `/opt/supabase/.env`.
- The database starts with the shared Bridge and ERP foundation:
  - `bridge_*`: organizations, profiles, memberships, services, entitlements, devices, jobs, job events, launch tickets, bus permissions, bus events, audit log.
  - `erp_*`: module registry, module instances, dependencies, shared records, record links.
  - Seeded modules: `crm`, `purchasing`.

The public Supabase URL must be a real DNS name, for example:

```text
https://supabase.example.com
```

Do not rely on the server IP as a browser Supabase URL. Traefik routes by host, TLS certificates are host-bound, and Supabase Auth redirects need stable domains.

## Data Model

Each ERP module chooses one data strategy:

- `erp-core`: reads and writes shared canonical records.
- `service-supabase`: owns its own Supabase tables but communicates through the shared Bridge bus.
- `external-api`: delegates data to a third-party system and mirrors only events or references.

Services do not read each other's databases directly. They communicate through typed actions, typed events, or published views authorized by organization, role, and scope.

## App Deployment Modes

### Local Crash Test

Use an SSH tunnel when DNS is not ready:

```bash
ssh -N -L 18100:127.0.0.1:8100 root@<vps-ip>
```

Then point the generated app to:

```dotenv
SUPABASE_URL=http://127.0.0.1:18100
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:18100
SUPABASE_ANON_KEY=<from /opt/supabase/.env>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<same anon key>
SUPABASE_SERVICE_ROLE_KEY=<from /opt/supabase/.env>
```

These values belong in `.env.local`; never commit them.

### VPS Web App

For a Next.js app hosted next to Supabase:

- Set `NEXT_PUBLIC_SUPABASE_URL` to the public Supabase HTTPS domain.
- Set server-side `SUPABASE_URL` either to the public domain or to Kong on the Docker network.
- Keep `SUPABASE_SERVICE_ROLE_KEY` server-only.
- Add the app domain to Supabase Auth redirect URLs.
- If the app uses Next route handlers as its API, disable any local daemon rewrite in production.
- If long-running Codex work is needed, execute it through Bridge jobs rather than inside the web container.

## Verification

From the VPS:

```bash
cd /opt/supabase
docker compose ps
source /opt/supabase/.env
curl -H "apikey: $ANON_KEY" \
  -H "Authorization: Bearer $ANON_KEY" \
  "http://127.0.0.1:8100/rest/v1/erp_modules?select=module_key,name"
```

Expected foundation modules:

```json
[
  { "module_key": "crm", "name": "CRM" },
  { "module_key": "purchasing", "name": "Achats" }
]
```

From outside the VPS, first verify DNS:

```bash
dig +short supabase.example.com
```

If DNS is not ready, a temporary `curl --resolve` check can prove Traefik/Kong routing, but browser auth will still need real DNS or a local hosts entry.
