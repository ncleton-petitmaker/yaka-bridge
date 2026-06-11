create extension if not exists pgcrypto;

create table if not exists public.erp_modules (
  id uuid primary key default gen_random_uuid(),
  module_key text not null unique,
  name text not null,
  category text not null default 'business',
  description text,
  default_data_strategy text not null default 'service-supabase'
    check (default_data_strategy in ('erp-core', 'service-supabase', 'external-api')),
  required_scopes text[] not null default array[]::text[],
  manifest jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.erp_module_instances (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.bridge_organizations(id) on delete cascade,
  module_id uuid not null references public.erp_modules(id) on delete restrict,
  service_id text,
  service_instance_id text,
  status text not null default 'active' check (status in ('active', 'paused', 'disabled')),
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, module_id),
  unique (organization_id, service_instance_id),
  foreign key (organization_id, service_id)
    references public.bridge_services(organization_id, service_id)
    on delete set null
);

create table if not exists public.erp_module_dependencies (
  id uuid primary key default gen_random_uuid(),
  module_id uuid not null references public.erp_modules(id) on delete cascade,
  depends_on_module_id uuid not null references public.erp_modules(id) on delete cascade,
  required boolean not null default true,
  scopes text[] not null default array[]::text[],
  created_at timestamptz not null default now(),
  unique (module_id, depends_on_module_id),
  check (module_id <> depends_on_module_id)
);

create table if not exists public.erp_core_records (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.bridge_organizations(id) on delete cascade,
  record_type text not null,
  external_ref text,
  display_name text not null,
  payload jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, record_type, external_ref)
);

create table if not exists public.erp_record_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.bridge_organizations(id) on delete cascade,
  source_record_id uuid not null references public.erp_core_records(id) on delete cascade,
  target_record_id uuid not null references public.erp_core_records(id) on delete cascade,
  relation_type text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (source_record_id, target_record_id, relation_type)
);

create index if not exists erp_module_instances_org_idx on public.erp_module_instances(organization_id, status);
create index if not exists erp_core_records_lookup_idx on public.erp_core_records(organization_id, record_type, display_name);
create index if not exists erp_record_links_source_idx on public.erp_record_links(source_record_id, relation_type);

alter table public.erp_modules enable row level security;
alter table public.erp_module_instances enable row level security;
alter table public.erp_module_dependencies enable row level security;
alter table public.erp_core_records enable row level security;
alter table public.erp_record_links enable row level security;

drop policy if exists "members read enabled erp modules" on public.erp_modules;
create policy "members read enabled erp modules"
  on public.erp_modules for select
  using (enabled = true);

drop policy if exists "members read erp module instances" on public.erp_module_instances;
create policy "members read erp module instances"
  on public.erp_module_instances for select
  using (public.bridge_is_member(organization_id));

drop policy if exists "admins manage erp module instances" on public.erp_module_instances;
create policy "admins manage erp module instances"
  on public.erp_module_instances for all
  using (public.bridge_is_admin(organization_id))
  with check (public.bridge_is_admin(organization_id));

drop policy if exists "members read erp dependencies" on public.erp_module_dependencies;
create policy "members read erp dependencies"
  on public.erp_module_dependencies for select
  using (true);

drop policy if exists "members read erp core records" on public.erp_core_records;
create policy "members read erp core records"
  on public.erp_core_records for select
  using (public.bridge_is_member(organization_id));

drop policy if exists "admins manage erp core records" on public.erp_core_records;
create policy "admins manage erp core records"
  on public.erp_core_records for all
  using (public.bridge_is_admin(organization_id))
  with check (public.bridge_is_admin(organization_id));

drop policy if exists "members read erp record links" on public.erp_record_links;
create policy "members read erp record links"
  on public.erp_record_links for select
  using (public.bridge_is_member(organization_id));

drop policy if exists "admins manage erp record links" on public.erp_record_links;
create policy "admins manage erp record links"
  on public.erp_record_links for all
  using (public.bridge_is_admin(organization_id))
  with check (public.bridge_is_admin(organization_id));

insert into public.erp_modules (module_key, name, category, description, default_data_strategy, required_scopes, manifest)
values
  (
    'crm',
    'CRM',
    'core',
    'Socle clients, contacts et organisations partagé par les modules.',
    'erp-core',
    array['erp:core:read', 'erp:events:publish'],
    '{"actions":[{"id":"customer.lookup"}],"events":[{"type":"core.customer.updated"}]}'::jsonb
  ),
  (
    'purchasing',
    'Achats',
    'business',
    'Module achats et import des offres fournisseurs.',
    'service-supabase',
    array['erp:core:read', 'erp:events:consume', 'service:purchasing:read', 'service:purchasing:write', 'codex:run'],
    '{"actions":[{"id":"purchasing.quote.import"}],"events":[{"type":"purchasing.quote.imported"}]}'::jsonb
  )
on conflict (module_key) do update
set
  name = excluded.name,
  category = excluded.category,
  description = excluded.description,
  default_data_strategy = excluded.default_data_strategy,
  required_scopes = excluded.required_scopes,
  manifest = excluded.manifest,
  updated_at = now();

insert into public.erp_module_dependencies (module_id, depends_on_module_id, scopes)
select purchasing.id, crm.id, array['erp:core:read']
from public.erp_modules purchasing
join public.erp_modules crm on crm.module_key = 'crm'
where purchasing.module_key = 'purchasing'
on conflict (module_id, depends_on_module_id) do update
set scopes = excluded.scopes;
