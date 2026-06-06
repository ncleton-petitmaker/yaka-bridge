create table if not exists public.bridge_support_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.bridge_organizations(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  service_id text,
  job_id uuid references public.bridge_jobs(id) on delete set null,
  replay_session_id text,
  replay_session_url text,
  current_route text,
  app_version text,
  user_agent text,
  viewport text,
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  ended_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.bridge_observability_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.bridge_organizations(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  service_id text,
  job_id uuid references public.bridge_jobs(id) on delete set null,
  device_id text,
  support_session_id uuid references public.bridge_support_sessions(id) on delete set null,
  replay_session_id text,
  replay_session_url text,
  severity text not null default 'info',
  source text not null default 'api',
  category text not null default 'general',
  message text not null,
  route text,
  app_version text,
  fingerprint text not null,
  count integer not null default 1,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id) on delete set null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bridge_observability_severity_check check (severity in ('info', 'warning', 'error', 'critical')),
  constraint bridge_observability_source_check check (source in ('web', 'api', 'bridge', 'run', 'auth'))
);

create unique index if not exists bridge_observability_org_fingerprint_idx
  on public.bridge_observability_events(organization_id, fingerprint);
create index if not exists bridge_observability_org_last_seen_idx
  on public.bridge_observability_events(organization_id, last_seen_at desc);
create index if not exists bridge_observability_org_severity_idx
  on public.bridge_observability_events(organization_id, severity, resolved_at, last_seen_at desc);
create index if not exists bridge_observability_org_service_idx
  on public.bridge_observability_events(organization_id, service_id, last_seen_at desc)
  where service_id is not null;
create index if not exists bridge_observability_org_job_idx
  on public.bridge_observability_events(organization_id, job_id, last_seen_at desc)
  where job_id is not null;
create index if not exists bridge_observability_org_support_idx
  on public.bridge_observability_events(organization_id, support_session_id, last_seen_at desc)
  where support_session_id is not null;

create index if not exists bridge_support_sessions_org_last_seen_idx
  on public.bridge_support_sessions(organization_id, last_seen_at desc);
create index if not exists bridge_support_sessions_org_user_idx
  on public.bridge_support_sessions(organization_id, user_id, last_seen_at desc)
  where user_id is not null;
create index if not exists bridge_support_sessions_org_route_idx
  on public.bridge_support_sessions(organization_id, current_route, last_seen_at desc)
  where current_route is not null;

alter table public.bridge_support_sessions enable row level security;
alter table public.bridge_observability_events enable row level security;

drop policy if exists "service role all bridge support sessions" on public.bridge_support_sessions;
create policy "service role all bridge support sessions"
  on public.bridge_support_sessions
  as permissive for all to service_role
  using (true)
  with check (true);

drop policy if exists "members read bridge support sessions" on public.bridge_support_sessions;
create policy "members read bridge support sessions"
  on public.bridge_support_sessions for select
  using (public.bridge_is_member(organization_id));

drop policy if exists "service role all bridge observability events" on public.bridge_observability_events;
create policy "service role all bridge observability events"
  on public.bridge_observability_events
  as permissive for all to service_role
  using (true)
  with check (true);

drop policy if exists "members read bridge observability events" on public.bridge_observability_events;
create policy "members read bridge observability events"
  on public.bridge_observability_events for select
  using (public.bridge_is_member(organization_id));
