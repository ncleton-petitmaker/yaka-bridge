create extension if not exists pgcrypto;

create table if not exists public.purchasing_suppliers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.bridge_organizations(id) on delete cascade,
  external_ref text,
  name text not null,
  category text not null default 'general',
  contact_email text,
  rating integer check (rating is null or rating between 1 and 5),
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, external_ref)
);

create table if not exists public.purchasing_quotes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.bridge_organizations(id) on delete cascade,
  supplier_id uuid references public.purchasing_suppliers(id) on delete set null,
  external_ref text,
  title text not null,
  amount numeric(14, 2),
  currency text not null default 'EUR',
  status text not null default 'draft'
    check (status in ('draft', 'under_review', 'approved', 'rejected', 'archived')),
  risk_level text not null default 'unknown'
    check (risk_level in ('unknown', 'low', 'medium', 'high')),
  document_refs jsonb not null default '[]'::jsonb,
  analysis jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, external_ref)
);

create index if not exists purchasing_suppliers_org_idx
  on public.purchasing_suppliers(organization_id, name);

create index if not exists purchasing_quotes_org_status_idx
  on public.purchasing_quotes(organization_id, status, created_at desc);

alter table public.purchasing_suppliers enable row level security;
alter table public.purchasing_quotes enable row level security;

drop policy if exists "purchasing readers read suppliers" on public.purchasing_suppliers;
create policy "purchasing readers read suppliers"
  on public.purchasing_suppliers for select
  using (
    public.bridge_has_scope(organization_id, 'purchasing', 'service:purchasing:read')
    or public.bridge_has_scope(organization_id, 'purchasing', 'service:purchasing:write')
    or public.bridge_has_scope(organization_id, 'purchasing', 'service:purchasing:admin')
  );

drop policy if exists "purchasing admins manage suppliers" on public.purchasing_suppliers;
drop policy if exists "purchasing writers manage suppliers" on public.purchasing_suppliers;
create policy "purchasing writers manage suppliers"
  on public.purchasing_suppliers for all
  using (
    public.bridge_has_scope(organization_id, 'purchasing', 'service:purchasing:write')
    or public.bridge_has_scope(organization_id, 'purchasing', 'service:purchasing:admin')
  )
  with check (
    public.bridge_has_scope(organization_id, 'purchasing', 'service:purchasing:write')
    or public.bridge_has_scope(organization_id, 'purchasing', 'service:purchasing:admin')
  );

drop policy if exists "purchasing readers read quotes" on public.purchasing_quotes;
create policy "purchasing readers read quotes"
  on public.purchasing_quotes for select
  using (
    public.bridge_has_scope(organization_id, 'purchasing', 'service:purchasing:read')
    or public.bridge_has_scope(organization_id, 'purchasing', 'service:purchasing:write')
    or public.bridge_has_scope(organization_id, 'purchasing', 'service:purchasing:admin')
  );

drop policy if exists "purchasing admins manage quotes" on public.purchasing_quotes;
drop policy if exists "purchasing writers manage quotes" on public.purchasing_quotes;
create policy "purchasing writers manage quotes"
  on public.purchasing_quotes for all
  using (
    public.bridge_has_scope(organization_id, 'purchasing', 'service:purchasing:write')
    or public.bridge_has_scope(organization_id, 'purchasing', 'service:purchasing:admin')
  )
  with check (
    public.bridge_has_scope(organization_id, 'purchasing', 'service:purchasing:write')
    or public.bridge_has_scope(organization_id, 'purchasing', 'service:purchasing:admin')
  );

insert into public.erp_modules (module_key, name, category, description, default_data_strategy, required_scopes, manifest)
values (
  'purchasing',
  'Achats',
  'business',
  'Module achats generique pour fournisseurs, devis et decisions.',
  'service-supabase',
  array[
    'erp:core:read',
    'erp:events:publish',
    'erp:events:consume',
    'service:purchasing:read',
    'service:purchasing:write',
    'codex:run'
  ],
  '{
    "actions": [
      {"id": "purchasing.quote.import"},
      {"id": "purchasing.quote.analyze"}
    ],
    "events": [
      {"type": "purchasing.quote.imported"}
    ],
    "tables": [
      "purchasing_suppliers",
      "purchasing_quotes"
    ]
  }'::jsonb
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

create or replace function public.seed_demo_purchasing(target_org uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  supplier_one uuid;
  supplier_two uuid;
begin
  if not public.bridge_is_admin(target_org) then
    raise exception 'reserved-to-bridge-admin';
  end if;

  insert into public.purchasing_suppliers (organization_id, external_ref, name, category, contact_email, rating)
  values
    (target_org, 'SUP-DEMO-001', 'Demo Supplies', 'general', 'sales@demo-supplies.example', 4),
    (target_org, 'SUP-DEMO-002', 'Sample Industrial', 'industrial', 'contact@sample-industrial.example', 3)
  on conflict (organization_id, external_ref) do update
  set
    name = excluded.name,
    category = excluded.category,
    contact_email = excluded.contact_email,
    rating = excluded.rating,
    updated_at = now();

  select id into supplier_one
  from public.purchasing_suppliers
  where organization_id = target_org and external_ref = 'SUP-DEMO-001';

  select id into supplier_two
  from public.purchasing_suppliers
  where organization_id = target_org and external_ref = 'SUP-DEMO-002';

  insert into public.purchasing_quotes (organization_id, supplier_id, external_ref, title, amount, currency, status, risk_level)
  values
    (target_org, supplier_one, 'Q-DEMO-001', 'Office equipment renewal', 12450, 'EUR', 'under_review', 'low'),
    (target_org, supplier_two, 'Q-DEMO-002', 'Warehouse consumables', 18300, 'EUR', 'under_review', 'medium')
  on conflict (organization_id, external_ref) do update
  set
    supplier_id = excluded.supplier_id,
    title = excluded.title,
    amount = excluded.amount,
    currency = excluded.currency,
    status = excluded.status,
    risk_level = excluded.risk_level,
    updated_at = now();
end;
$$;
