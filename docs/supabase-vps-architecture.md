# Supabase VPS Architecture

The modular ERP stack can use one shared Supabase control plane per company, or a managed Supabase project during early deployments.

- Public API: `https://supabase.example.com` through the chosen ingress layer.
- Private database: Postgres remains private to the Supabase deployment.
- Bridge control plane: `bridge_*` tables store organizations, memberships, services, devices, jobs, launch tickets, bus events, and audit events.
- ERP module registry: `erp_modules` and `erp_module_instances` declare which modules are available for each organization.
- Shared ERP core: `erp_core_records` and `erp_record_links` hold cross-module canonical records such as customers, contacts, suppliers, contracts, documents, products, or settings.

Each module chooses one data strategy:

- `erp-core`: the module reads and writes shared canonical records.
- `service-supabase`: the module owns its own Supabase tables but uses the shared Bridge bus.
- `external-api`: the module delegates data to a third-party system and only mirrors events or references.

Services do not read each other's databases directly. They communicate through typed actions, typed events, or published views authorized by organization, role, and scope.
