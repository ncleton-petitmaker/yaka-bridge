# Supabase template

Les entités métier persistantes vivent dans Supabase. Les migrations SQL du template sont dans `supabase/migrations/` :

- `20260606120000_bridge_control_plane.sql` : identité Bridge, organisations, services, appareils, jobs, launch tickets, audit et bus.
- `20260606123000_modular_erp_core.sql` : socle ERP partagé par organisation, registre de modules et liens entre records.

Le daemon local lit la configuration avec cet ordre de priorité :

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` côté serveur uniquement
- `/settings` pour `supabaseUrl` et `supabaseAnonKey` quand une app locale doit les configurer sans fichier `.env`

Ne stocke jamais la service-role key dans l'UI, dans `app-config.json`, ni dans un fichier packagé.

## Mode cloud + Bridge

Le template peut tourner comme app web cloud :

- `NEXT_PUBLIC_APP_API_MODE=cloud`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` ou `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- `NEXT_PUBLIC_CLOUD_API_URL`, ou par défaut les Edge Functions dérivées de l'URL Supabase

Dans ce mode, le navigateur appelle l'API cloud avec le JWT Supabase de l'utilisateur. Les tâches agentiques longues sont déléguées à l'app Electron `Bridge`, qui reste un produit horizontal indépendant du service métier.

Contrat minimal attendu côté Control Plane / Edge Functions :

- `POST /bridge/register`
- `POST /bridge/sync`
- `POST /bridge/services`
- `POST /bridge/launch-ticket`
- `POST /bridge/jobs/poll`
- `POST /bridge/jobs/events`
- `POST /bridge/jobs/complete`
- `POST /bridge/bus/events`
- `POST /bridge/bus/actions/call`
