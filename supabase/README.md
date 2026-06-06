# Supabase Template

Les entites metier persistantes vivent dans Supabase. Les migrations SQL du template sont dans `supabase/migrations/` :

- `20260606120000_bridge_control_plane.sql` : identite Bridge, organisations, services, appareils, jobs, launch tickets, audit et bus.
- `20260606123000_modular_erp_core.sql` : socle ERP partage par organisation, registre de modules et liens entre records.

Le daemon local lit la configuration avec cet ordre de priorite :

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` cote serveur uniquement
- `/settings` pour `supabaseUrl` et `supabaseAnonKey` quand une app locale doit les configurer sans fichier `.env`

Ne stocke jamais la service-role key dans l'UI, dans `app-config.json`, ni dans un fichier package.

## Mode Cloud + Bridge

Le template peut tourner comme app web cloud :

- `NEXT_PUBLIC_APP_API_MODE=cloud`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` ou `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- `NEXT_PUBLIC_CLOUD_API_URL`, ou par defaut les Edge Functions derivees de l'URL Supabase

Dans ce mode, le navigateur appelle l'API cloud avec le JWT Supabase de l'utilisateur. Les taches agentiques longues sont deleguees a l'app Electron `Bridge`, qui reste un produit horizontal independant du service metier.

Contrat minimal attendu cote Control Plane / Edge Functions :

- `POST /bridge/register`
- `POST /bridge/sync`
- `POST /bridge/services`
- `POST /bridge/launch-ticket`
- `POST /bridge/jobs/poll`
- `POST /bridge/jobs/events`
- `POST /bridge/jobs/complete`
- `POST /bridge/bus/events`
- `POST /bridge/bus/actions/call`

## VPS Self-Hosted

Le runbook d'architecture VPS est dans [`docs/supabase-vps-architecture.md`](../docs/supabase-vps-architecture.md). Les secrets restent toujours dans `/opt/supabase/.env` sur le serveur ou dans le coffre CI/CD du client.
