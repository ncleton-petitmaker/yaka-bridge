# Coolify pour Yaka-Bridge

## Position

Yaka-Bridge est publié sur VPS/Coolify. Les ressources attendues sont :

- landing marketing publique, idéalement ressource statique séparée ;
- ERP Next.js, admin et modules comme ressources Coolify dédiées si besoin ;
- Supabase self-hosted sur le VPS, avec Kong public et Postgres privé ;
- Bridge installers et updates dans Supabase Storage self-hosted.

La racine `app/page.tsx` de l'ERP redirige vers `/dashboard`. Ne pas la
remplacer par une landing marketing sans instruction explicite : la landing
publique doit plutôt vivre dans un dossier/site dédié et être liée à son propre
domaine Coolify.

## Variables De Déploiement

Préférer un webhook complet :

```bash
export COOLIFY_DEPLOY_WEBHOOK="https://coolify.example.com/api/v1/deploy?uuid=<resource_uuid>&force=false"
export COOLIFY_TOKEN="<token avec permission deploy>" # si le webhook/API l'exige
```

Alternative avec URL + UUID :

```bash
export COOLIFY_URL="https://coolify.example.com"
export COOLIFY_RESOURCE_UUID="<resource_uuid>"
export COOLIFY_TOKEN="<token avec permission deploy>"
export COOLIFY_FORCE="false"
```

Alias acceptés par le script : `COOLIFY_WEBHOOK`,
`COOLIFY_RESOURCE_ID`, `COOLIFY_API_TOKEN`.

Ne jamais commiter ces valeurs. Les stocker dans le shell local, Coolify,
GitHub Secrets ou le vault client.

## Commandes

Redeploy direct par SSH, mode préféré quand l'accès VPS fonctionne :

```bash
export COOLIFY_SSH_TARGET="root@92.222.247.135"
export COOLIFY_APP_DIR="/opt/yaka-bridge-landing"
export COOLIFY_COMPOSE_SERVICE="landing"
.codex/skills/yaka-bridge-deploy-coolify/scripts/deploy_ssh_compose.sh
```

Redeploy via webhook/API :

```bash
.codex/skills/yaka-bridge-deploy-coolify/scripts/deploy_coolify.sh
```

Dry-run sans secret affiché :

```bash
.codex/skills/yaka-bridge-deploy-coolify/scripts/deploy_coolify.sh --dry-run
.codex/skills/yaka-bridge-deploy-coolify/scripts/deploy_ssh_compose.sh --dry-run
```

Configurer un webhook GitHub direct vers Coolify seulement si le deploy SSH
n'est pas le bon chemin et que Coolify fournit l'URL de webhook :

```bash
export GITHUB_REPO="<owner>/<repo>"
export COOLIFY_GITHUB_WEBHOOK_URL="<url webhook push Coolify>"
export COOLIFY_GITHUB_WEBHOOK_SECRET="<secret webhook Coolify>"
.codex/skills/yaka-bridge-deploy-coolify/scripts/configure_github_push.sh
```

## Landing Depuis Zip

1. Extraire le zip dans un dossier temporaire.
2. Identifier la version canonique : `index.html` si présent.
3. Copier les assets nécessaires dans le dossier de landing cible, par exemple
   `landing/`, `public/landing/`, ou le repo dédié si Coolify déploie un autre
   dépôt.
4. Vérifier les chemins `favicon.svg`, `logo-options/`, `model-logos/` et les
   images Open Graph.
5. Si Coolify déploie une ressource statique, garder le build simple :
   `index.html` + assets, sans dépendance Next.js inutile.
6. Contrôler que `https://yaka-bridge.com/` sert la landing et ne redirige pas
   vers `/dashboard`.

## Checks

Pour une landing statique :

```bash
find <landing-dir> -maxdepth 3 -type f
python3 -m http.server 4173 --directory <landing-dir>
```

Puis vérifier en navigateur ou avec `curl -I http://127.0.0.1:4173/`.

Pour l'ERP Next.js :

```bash
npm run typecheck
npm test
npm run build
npm run security:grep
```

Pour Supabase/VPS, suivre `docs/vps-provisioning-runbook.md`.

## Références Officielles

- Coolify API Authorization : https://coolify.io/docs/api-reference/authorization
- Coolify GitHub Actions deploy webhook/API : https://coolify.io/docs/applications/ci-cd/github/actions
- Coolify GitHub Auto Deploy : https://coolify.io/docs/applications/ci-cd/github/auto-deploy
