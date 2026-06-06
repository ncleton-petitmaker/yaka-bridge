# Bridge Observability Standard

Every Bridge ERP service must expose the same support and observability surface:

- browser support sessions;
- optional OpenReplay session replay;
- client-side error and console capture;
- server-side aggregated observability events;
- admin page at `/admin/observability`;
- Supabase tables scoped by `organization_id`.

This mirrors the FAE/OIF cloud pattern but uses neutral Bridge names.

## Supabase Tables

Apply the standard migration:

```bash
docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  < supabase/migrations/20260606150000_bridge_observability.sql
```

It creates:

- `bridge_support_sessions`
- `bridge_observability_events`

Rows are scoped by Bridge organization and protected by RLS. Browser clients do
not write directly to those tables; they call the service API, which validates
the Supabase session and writes through the server-side Supabase client.

## Browser Capture

The template includes:

- `components/OpenReplayProvider.tsx`
- `components/RuntimeHealthGuard.tsx`
- `lib/openreplay.ts`
- `lib/observability.ts`
- `app/admin/observability/page.tsx`

The provider is mounted in `app/layout.tsx` inside `CloudAuthGate`.

Captured data:

- route changes;
- support heartbeat every 10 seconds;
- page views;
- `console.warn` and `console.error`;
- runtime JS errors and unhandled promises;
- OpenReplay replay id/url when configured.

Privacy defaults:

- network capture disabled;
- payload capture disabled;
- inputs/textareas/contenteditable hidden;
- emails and numbers obscured;
- OpenReplay private mode enabled unless explicitly disabled.

## Environment Variables

Required for cloud API calls:

```dotenv
NEXT_PUBLIC_APP_API_MODE=cloud
NEXT_PUBLIC_CLOUD_API_URL=https://<service-domain-or-functions-domain>
NEXT_PUBLIC_SUPABASE_URL=https://api.customer.example
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
SUPABASE_URL=http://supabase-kong:8000
SUPABASE_SERVICE_ROLE_KEY=<service role key>
```

OpenReplay is optional but recommended in production support environments:

```dotenv
NEXT_PUBLIC_OPENREPLAY_ENABLED=true
NEXT_PUBLIC_OPENREPLAY_PROJECT_KEY=<project key>
NEXT_PUBLIC_OPENREPLAY_INGEST_POINT=https://replay.customer-support.example/ingest
NEXT_PUBLIC_OPENREPLAY_PRIVATE_MODE=true
NEXT_PUBLIC_OPENREPLAY_CAPTURE_IFRAMES=false
NEXT_PUBLIC_APP_VERSION=<release version>
NEXT_PUBLIC_APP_NAME=<service name>
```

If OpenReplay is disabled or unavailable, Bridge still records support sessions
and observability events without replay video.

## Admin Workflow

Open `/admin/observability` as an organization `owner` or `admin`.

Use it to see:

- recent users and current routes;
- whether a session is live;
- replay links;
- repeated errors grouped by fingerprint;
- redacted payload context;
- unresolved/resolved state.

## OpenReplay Instance

The template does not force one OpenReplay per customer. Recommended options:

- one Yaka-operated OpenReplay support VPS with separate projects per customer;
- one customer-operated OpenReplay if contractual/security constraints require it.

Never store customer documents or API payloads in OpenReplay. Keep the browser
tracker in private mode and keep network capture disabled.

## Acceptance Checks

- Login as a user and open a service page.
- `/admin/observability` shows the user route within 10 seconds.
- Trigger a harmless `console.warn`; an event appears and is grouped by
  fingerprint.
- With OpenReplay enabled, a replay URL appears on the session row.
- With OpenReplay disabled, the session still appears as `Trace`.
- A member cannot call admin observability endpoints.
- An admin from another organization cannot read these rows.
