---
name: yaka-bridge-deploy-coolify
description: Déployer Yaka-Bridge, sa landing page, un ERP client, un module ou un service Bridge sur Coolify/VPS. Utiliser quand l'utilisateur dit "mets en ligne", "déploie", "publie", "redeploy", "Coolify", "VPS", "landing Yaka-Bridge", ou demande une mise en production/preview Yaka-Bridge. Ne jamais utiliser Vercel pour les déploiements Yaka-Bridge.
---

# yaka-bridge-deploy-coolify

Yaka-Bridge se déploie sur VPS/Coolify. Pour ce projet, Vercel est hors-scope :
si un réflexe, plugin ou skill Vercel paraît applicable, l'ignorer et revenir
au flux Coolify.

## Sources A Charger

Si le fichier existe, lire `references/coolify-yaka-bridge.md` avant tout
déploiement. Il contient les variables attendues, les choix landing vs ERP, et
les commandes de redeploy.

Si le script existe, utiliser `scripts/deploy_coolify.sh` quand un webhook ou
un token Coolify est disponible. Lire le script seulement s'il faut l'adapter.

Si un accès SSH au VPS existe, préférer `scripts/deploy_ssh_compose.sh` pour un
site déjà installé en Docker Compose/Coolify.

## Workflow

1. Identifier la cible : landing publique, app ERP principale, admin, module,
   service Bridge ou Supabase self-hosted.
2. Inspecter le workspace avec `git status --short` et préserver les
   changements non liés. S'il y a des modifications utilisateur dans les mêmes
   fichiers, les intégrer sans les écraser.
3. Pour une mise à jour de landing issue d'un zip, extraire dans un dossier
   temporaire, comparer les fichiers, puis intégrer seulement les assets et le
   HTML nécessaires. Ne pas remplacer `app/page.tsx` si la cible est la landing
   marketing séparée : ce fichier redirige volontairement l'ERP vers
   `/dashboard`.
4. Vérifier l'accès SSH au VPS avant de chercher un webhook :
   - résoudre le domaine public (`dig +short <domain>`) ;
   - tester `ssh -o BatchMode=yes root@<host>` ou l'alias connu ;
   - localiser le dossier Compose avec les labels Docker
     `com.docker.compose.project.working_dir` et
     `com.docker.compose.project.config_files` ;
   - si le dossier est un clone Git propre, faire `git pull --ff-only`, puis
     `docker compose up -d --build <service>` ;
   - vérifier le healthcheck Docker et l'URL publique.
5. Vérifier le déclenchement GitHub push avant de pousser :
   - lister les webhooks GitHub avec `gh api repos/<owner>/<repo>/hooks` ;
   - lister les secrets Actions avec `gh secret list --repo <owner>/<repo>` ;
   - vérifier `.github/workflows/deploy-coolify.yml` si le projet utilise
     GitHub Actions ;
   - si aucun webhook/action Coolify n'existe, le configurer avant le push ou
     prévenir explicitement que le push ne peut pas redeployer Coolify.
6. Vérifier les secrets disponibles sans les afficher : `COOLIFY_DEPLOY_WEBHOOK`
   ou `COOLIFY_URL` + `COOLIFY_RESOURCE_UUID` + `COOLIFY_TOKEN`. Les secrets ne
   vont jamais dans Git ; ils restent dans l'environnement local, GitHub
   Secrets, Coolify ou le vault client.
7. Lancer les checks adaptés au périmètre :
   - landing statique : validation des fichiers, liens d'assets, rendu local si
     nécessaire ;
   - Next/ERP : `npm run typecheck`, `npm test`, `npm run build` ;
   - production sensible : ajouter `npm run security:grep` et les checks VPS du
     runbook.
8. Déployer via Coolify/VPS :
   - si SSH fonctionne, déployer directement sur le VPS avec
     `.codex/skills/yaka-bridge-deploy-coolify/scripts/deploy_ssh_compose.sh`
     ou l'équivalent manuel `git pull --ff-only && docker compose up -d --build`;
   - si l'app Coolify est en auto-deploy GitHub ou GitHub Actions, vérifier que
     le webhook/action est configuré, faire un commit ciblé, pousser la branche
     qui déclenche Coolify, puis vérifier l'exécution GitHub ou la livraison du
     webhook ;
   - si un webhook/API est disponible, lancer
     `.codex/skills/yaka-bridge-deploy-coolify/scripts/deploy_coolify.sh` ;
   - si aucune info Coolify n'est présente, demander uniquement les informations
     manquantes.
9. Vérifier dans Coolify ou via l'URL publique connue. Pour une landing,
   contrôler au minimum `200`, titre, favicon/assets, responsive rapide et
   absence de redirection vers `/dashboard`.

## Déploiement SSH Direct

Pour la landing publique Yaka-Bridge actuelle, les valeurs par défaut sont :

```bash
export COOLIFY_SSH_TARGET="root@92.222.247.135"
export COOLIFY_APP_DIR="/opt/yaka-bridge-landing"
export COOLIFY_COMPOSE_SERVICE="landing"
.codex/skills/yaka-bridge-deploy-coolify/scripts/deploy_ssh_compose.sh
```

Le script doit :

1. vérifier que le dossier serveur est un clone Git propre ;
2. faire `git pull --ff-only origin main` ;
3. reconstruire/redémarrer le service Compose ;
4. attendre le healthcheck ;
5. vérifier que l'URL publique sert le nouveau contenu.

## Configuration GitHub Push

Ne jamais considérer "push sur GitHub" comme suffisant par lui-même. Le repo
doit avoir au moins l'un de ces déclencheurs :

- GitHub App Coolify installée et auto-deploy activé dans Coolify ;
- webhook GitHub direct vers l'URL "Manual Git Webhook" fournie par Coolify ;
- GitHub Actions avec `.github/workflows/deploy-coolify.yml` et secrets
  `COOLIFY_DEPLOY_WEBHOOK` + `COOLIFY_TOKEN`.

Pour créer le webhook GitHub direct quand Coolify fournit l'URL :

```bash
export COOLIFY_GITHUB_WEBHOOK_URL="<url webhook push fournie par Coolify>"
export COOLIFY_GITHUB_WEBHOOK_SECRET="<secret webhook Coolify>"
export GITHUB_REPO="<owner>/<repo>"
.codex/skills/yaka-bridge-deploy-coolify/scripts/configure_github_push.sh
```

Pour GitHub Actions, ajouter le workflow puis définir les secrets :

```bash
gh secret set COOLIFY_DEPLOY_WEBHOOK --repo <owner>/<repo>
gh secret set COOLIFY_TOKEN --repo <owner>/<repo>
gh workflow run deploy-coolify.yml --repo <owner>/<repo>
```

Si le webhook/token Coolify est absent, demander précisément ces deux éléments
et ne pas annoncer que le site est en ligne.

## Garde-Fous

- Ne pas utiliser `deploy-to-vercel`, `vercel deploy`, `vercel link`,
  `vercel ls`, ni une solution Vercel de remplacement pour Yaka-Bridge.
- Ne pas imprimer de token, webhook secret, service role key ou variable
  sensible.
- Ne pas mélanger les changements de landing avec des refactors ERP non liés.
- Ne pas modifier `.env.example` avec des valeurs réelles.
- Ne pas exposer Postgres, Supabase Studio ou dashboards proxy sans auth.
- Ne pas déclarer le déploiement terminé tant que l'URL publique ne sert pas le
  nouveau contenu ou que Coolify/GitHub n'a pas confirmé l'exécution.
