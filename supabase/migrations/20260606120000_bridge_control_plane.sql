create extension if not exists pgcrypto;

create table if not exists public.bridge_organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.bridge_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.bridge_memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.bridge_organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member', 'operator')),
  created_at timestamptz not null default now(),
  unique (organization_id, user_id)
);

create table if not exists public.bridge_services (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.bridge_organizations(id) on delete cascade,
  service_id text not null,
  service_instance_id text not null,
  name text not null,
  description text,
  base_url text not null,
  health_url text,
  launch_callback_url text,
  admin_url text,
  icon_url text,
  data_strategy text not null default 'erp-core' check (data_strategy in ('erp-core', 'service-supabase', 'external-api')),
  supabase_project_ref text,
  manifest jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, service_id),
  unique (organization_id, service_instance_id)
);

create table if not exists public.bridge_entitlements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.bridge_organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  service_id text not null,
  scopes text[] not null default array[]::text[],
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, user_id, service_id),
  foreign key (organization_id, service_id)
    references public.bridge_services(organization_id, service_id)
    on delete cascade
);

create table if not exists public.bridge_devices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.bridge_organizations(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  install_id text not null,
  device_id text not null,
  bridge_id text,
  label text,
  platform text,
  protocol_version integer not null default 2,
  capabilities jsonb not null default '{}'::jsonb,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (device_id)
);

create table if not exists public.bridge_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.bridge_organizations(id) on delete cascade,
  service_id text not null,
  service_instance_id text,
  user_id uuid references auth.users(id) on delete set null,
  device_id text,
  lease_id uuid not null default gen_random_uuid(),
  status text not null default 'queued' check (status in ('queued', 'leased', 'running', 'succeeded', 'failed', 'cancelled')),
  scopes text[] not null default array[]::text[],
  payload jsonb not null,
  local_run_id text,
  error text,
  leased_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  foreign key (organization_id, service_id)
    references public.bridge_services(organization_id, service_id)
    on delete cascade
);

create table if not exists public.bridge_job_events (
  id bigserial primary key,
  organization_id uuid not null references public.bridge_organizations(id) on delete cascade,
  service_id text not null,
  job_id uuid not null references public.bridge_jobs(id) on delete cascade,
  lease_id uuid not null,
  local_run_id text,
  seq integer not null,
  status text,
  event jsonb not null default '{}'::jsonb,
  usage jsonb,
  error text,
  created_at timestamptz not null default now(),
  unique (job_id, seq)
);

create table if not exists public.bridge_bus_permissions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.bridge_organizations(id) on delete cascade,
  from_service_id text not null,
  to_service_id text not null,
  action_id text,
  event_type text,
  scopes text[] not null default array[]::text[],
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  foreign key (organization_id, from_service_id)
    references public.bridge_services(organization_id, service_id)
    on delete cascade,
  foreign key (organization_id, to_service_id)
    references public.bridge_services(organization_id, service_id)
    on delete cascade,
  check (action_id is not null or event_type is not null)
);

create table if not exists public.bridge_bus_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.bridge_organizations(id) on delete cascade,
  source_service_id text not null,
  type text not null,
  resource_type text,
  resource_id text,
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  foreign key (organization_id, source_service_id)
    references public.bridge_services(organization_id, service_id)
    on delete cascade
);

create table if not exists public.bridge_launch_tickets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.bridge_organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  service_id text not null,
  service_instance_id text,
  device_id text,
  ticket_hash text not null unique,
  return_to text,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (organization_id, service_id)
    references public.bridge_services(organization_id, service_id)
    on delete cascade
);

create table if not exists public.bridge_audit_log (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.bridge_organizations(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_device_id text,
  action text not null,
  resource_type text not null,
  resource_id text,
  result text not null check (result in ('success', 'failure')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists bridge_memberships_user_idx on public.bridge_memberships(user_id);
create index if not exists bridge_entitlements_user_idx on public.bridge_entitlements(user_id, organization_id);
create index if not exists bridge_jobs_poll_idx on public.bridge_jobs(organization_id, service_id, status, created_at);
create index if not exists bridge_job_events_job_idx on public.bridge_job_events(job_id, seq);
create index if not exists bridge_bus_events_org_type_idx on public.bridge_bus_events(organization_id, type, occurred_at desc);
create index if not exists bridge_audit_org_idx on public.bridge_audit_log(organization_id, created_at desc);

create or replace function public.bridge_is_member(target_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.bridge_memberships m
    where m.organization_id = target_org
      and m.user_id = auth.uid()
  );
$$;

create or replace function public.bridge_is_admin(target_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.bridge_memberships m
    where m.organization_id = target_org
      and m.user_id = auth.uid()
      and m.role in ('owner', 'admin')
  );
$$;

create or replace function public.bridge_has_service_access(target_org uuid, target_service_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.bridge_entitlements e
    where e.organization_id = target_org
      and e.user_id = auth.uid()
      and e.service_id = target_service_id
      and e.enabled = true
  );
$$;

alter table public.bridge_organizations enable row level security;
alter table public.bridge_profiles enable row level security;
alter table public.bridge_memberships enable row level security;
alter table public.bridge_services enable row level security;
alter table public.bridge_entitlements enable row level security;
alter table public.bridge_devices enable row level security;
alter table public.bridge_jobs enable row level security;
alter table public.bridge_job_events enable row level security;
alter table public.bridge_bus_permissions enable row level security;
alter table public.bridge_bus_events enable row level security;
alter table public.bridge_launch_tickets enable row level security;
alter table public.bridge_audit_log enable row level security;

drop policy if exists "members can read organizations" on public.bridge_organizations;
create policy "members can read organizations"
  on public.bridge_organizations for select
  using (public.bridge_is_member(id));

drop policy if exists "users can read own profile" on public.bridge_profiles;
create policy "users can read own profile"
  on public.bridge_profiles for select
  using (user_id = auth.uid());

drop policy if exists "users can update own profile" on public.bridge_profiles;
create policy "users can update own profile"
  on public.bridge_profiles for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "members can read memberships" on public.bridge_memberships;
create policy "members can read memberships"
  on public.bridge_memberships for select
  using (public.bridge_is_member(organization_id));

drop policy if exists "members can read enabled services" on public.bridge_services;
create policy "members can read enabled services"
  on public.bridge_services for select
  using (enabled = true and public.bridge_is_member(organization_id));

drop policy if exists "admins manage services" on public.bridge_services;
create policy "admins manage services"
  on public.bridge_services for all
  using (public.bridge_is_admin(organization_id))
  with check (public.bridge_is_admin(organization_id));

drop policy if exists "users read own entitlements" on public.bridge_entitlements;
create policy "users read own entitlements"
  on public.bridge_entitlements for select
  using (user_id = auth.uid() or public.bridge_is_admin(organization_id));

drop policy if exists "admins manage entitlements" on public.bridge_entitlements;
create policy "admins manage entitlements"
  on public.bridge_entitlements for all
  using (public.bridge_is_admin(organization_id))
  with check (public.bridge_is_admin(organization_id));

drop policy if exists "users read own devices" on public.bridge_devices;
create policy "users read own devices"
  on public.bridge_devices for select
  using (user_id = auth.uid() or public.bridge_is_admin(organization_id));

drop policy if exists "users read accessible jobs" on public.bridge_jobs;
create policy "users read accessible jobs"
  on public.bridge_jobs for select
  using (
    user_id = auth.uid()
    or public.bridge_is_admin(organization_id)
    or public.bridge_has_service_access(organization_id, service_id)
  );

drop policy if exists "users read accessible job events" on public.bridge_job_events;
create policy "users read accessible job events"
  on public.bridge_job_events for select
  using (public.bridge_has_service_access(organization_id, service_id) or public.bridge_is_admin(organization_id));

drop policy if exists "members read bus permissions" on public.bridge_bus_permissions;
create policy "members read bus permissions"
  on public.bridge_bus_permissions for select
  using (public.bridge_is_member(organization_id));

drop policy if exists "admins manage bus permissions" on public.bridge_bus_permissions;
create policy "admins manage bus permissions"
  on public.bridge_bus_permissions for all
  using (public.bridge_is_admin(organization_id))
  with check (public.bridge_is_admin(organization_id));

drop policy if exists "members read bus events" on public.bridge_bus_events;
create policy "members read bus events"
  on public.bridge_bus_events for select
  using (public.bridge_is_member(organization_id));

drop policy if exists "users read own launch tickets" on public.bridge_launch_tickets;
create policy "users read own launch tickets"
  on public.bridge_launch_tickets for select
  using (user_id = auth.uid() or public.bridge_is_admin(organization_id));

drop policy if exists "admins read audit" on public.bridge_audit_log;
create policy "admins read audit"
  on public.bridge_audit_log for select
  using (public.bridge_is_admin(organization_id));

create table if not exists public.bridge_device_tokens (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.bridge_organizations(id) on delete cascade,
  bridge_id text not null,
  device_id text not null,
  user_id uuid references auth.users(id) on delete set null,
  token_hash text not null unique,
  token_jti_hash text not null unique,
  service_ids text[] not null default array[]::text[],
  scopes text[] not null default array[]::text[],
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists bridge_device_tokens_device_idx
  on public.bridge_device_tokens(organization_id, device_id, revoked_at, expires_at);

alter table public.bridge_device_tokens enable row level security;

drop policy if exists "admins manage bridge device tokens" on public.bridge_device_tokens;
create policy "admins manage bridge device tokens"
  on public.bridge_device_tokens for all
  using (public.bridge_is_admin(organization_id))
  with check (public.bridge_is_admin(organization_id));

create or replace function public.bridge_has_scope(target_org uuid, target_service_id text, required_scope text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    public.bridge_is_admin(target_org)
    or exists (
      select 1
      from public.bridge_entitlements e
      where e.organization_id = target_org
        and e.user_id = auth.uid()
        and e.service_id = target_service_id
        and e.enabled = true
        and required_scope = any(e.scopes)
    );
$$;

create or replace function public.bridge_poll_jobs(
  p_organization_id uuid,
  p_device_id text,
  p_service_ids text[],
  p_limit integer default 5,
  p_lease_seconds integer default 120
)
returns table (
  id uuid,
  organization_id uuid,
  service_id text,
  service_instance_id text,
  user_id uuid,
  lease_id uuid,
  scopes text[],
  payload jsonb
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with candidates as (
    select j.id
    from public.bridge_jobs j
    join public.bridge_services s
      on s.organization_id = j.organization_id
     and s.service_id = j.service_id
     and s.enabled = true
    where j.organization_id = p_organization_id
      and j.service_id = any(p_service_ids)
      and (
        j.status = 'queued'
        or (j.status = 'leased' and j.leased_until < now())
      )
    order by j.created_at asc
    limit least(greatest(coalesce(p_limit, 5), 1), 20)
    for update skip locked
  ),
  leased as (
    update public.bridge_jobs j
    set
      status = 'leased',
      lease_id = gen_random_uuid(),
      device_id = p_device_id,
      leased_until = now() + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 120), 30), 900)),
      updated_at = now()
    from candidates c
    where j.id = c.id
    returning
      j.id,
      j.organization_id,
      j.service_id,
      j.service_instance_id,
      j.user_id,
      j.lease_id,
      j.scopes,
      j.payload
  )
  select
    leased.id,
    leased.organization_id,
    leased.service_id,
    leased.service_instance_id,
    leased.user_id,
    leased.lease_id,
    leased.scopes,
    leased.payload
  from leased;
end;
$$;

revoke all on function public.bridge_poll_jobs(uuid, text, text[], integer, integer) from public;
grant execute on function public.bridge_poll_jobs(uuid, text, text[], integer, integer) to service_role;

create or replace function public.bridge_consume_launch_ticket(
  p_ticket_hash text,
  p_return_to text default null
)
returns table (
  id uuid,
  organization_id uuid,
  user_id uuid,
  service_id text,
  service_instance_id text,
  device_id text,
  return_to text,
  service jsonb
)
language sql
security definer
set search_path = public
as $$
  with consumed as (
    update public.bridge_launch_tickets t
    set used_at = now()
    where t.ticket_hash = p_ticket_hash
      and t.used_at is null
      and t.expires_at > now()
      and (p_return_to is null or t.return_to is null or t.return_to = p_return_to)
    returning
      t.id,
      t.organization_id,
      t.user_id,
      t.service_id,
      t.service_instance_id,
      t.device_id,
      t.return_to
  )
  select
    c.id,
    c.organization_id,
    c.user_id,
    c.service_id,
    c.service_instance_id,
    c.device_id,
    c.return_to,
    to_jsonb(s) as service
  from consumed c
  join public.bridge_services s
    on s.organization_id = c.organization_id
   and s.service_id = c.service_id
   and s.enabled = true;
$$;

revoke all on function public.bridge_consume_launch_ticket(text, text) from public;
grant execute on function public.bridge_consume_launch_ticket(text, text) to service_role;
