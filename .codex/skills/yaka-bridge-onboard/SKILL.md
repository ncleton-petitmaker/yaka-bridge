---
name: yaka-bridge-onboard
description: Lancer l'assistant d'onboarding yaka-bridge après import du repo, guider un novice de zéro jusqu'au cadrage GitHub, client, OVH/VPS, DNS, Supabase, modules, design system, Bridge et checklist production.
version: 1.0.0
---

# yaka-bridge-onboard

Utilise cette skill quand l'utilisateur vient d'importer ou cloner
`yaka-bridge`, demande comment démarrer, veut créer un nouveau client, connecter
un VPS existant, commander/configurer un VPS OVH, configurer un domaine/DNS, ou
veut "rendre le repo opérationnel".

Objectif : agir comme assistant d'installation produit. Guide le novice étape
par étape, pose les bonnes questions au bon moment, crée les briefs nécessaires,
et délègue aux skills spécialisées sans noyer l'utilisateur.

## Démarrage obligatoire

Commence par vérifier le contexte local :

```bash
pwd
git status --short --branch
npm run skills:check
node --version
npm --version
codex --version
gh auth status
```

Si `npm run skills:check` échoue, lance `npm run skills:sync`, puis relance le
check. Si `codex` ou `gh` manque, explique l'installation minimale avant de
continuer. Ne lance aucune opération VPS ou GitHub destructive sans validation
explicite.

## Première réponse attendue

Ne commence pas par un long cours. Pose d'abord ces questions en bloc court :

1. Est-ce un test local, un nouveau client, ou un client existant ?
2. Nom du client et slug technique souhaité ?
3. Domaine principal et provider DNS : OVH, Cloudflare, autre ?
4. VPS : nouveau VPS OVH à créer, VPS existant, ou pas encore décidé ?
5. GitHub : owner/organisation qui hébergera les repos privés ?
6. Modules initiaux et design system : `purchasing` + `claude` par défaut ?

Ensuite, adapte le parcours.

## Parcours

### 1. Cadrage produit

Collecte :

- nom client public ;
- slug technique ;
- modules initiaux ;
- design system initial ;
- utilisateurs ChatGPT et postes Bridge ;
- données qui auront le droit de transiter vers ChatGPT ;
- workflows sensibles et rôles admin.

Si le client n'existe pas encore, prépare un brief `MODULES` et
`DESIGN_SYSTEM`. Si un module client doit être créé, délègue à
`yaka-bridge-version-modules` avant `yaka-bridge-create-module`.

### 2. GitHub et repos

Utilise `yaka-bridge-version-modules`.

Règle :

- nouveau client = repo privé `<clientSlug>-erp` ;
- nouveau module client = repo privé `<clientSlug>-module-<moduleId>` par
  défaut ;
- non-développeur impliqué = repo module séparé obligatoire ;
- repo client = `modules.lock.json`, config, DNS, déploiement, pas atelier de
  coding module.

Vérifie `gh auth status`, visibilité privée, `main` protégée, PR obligatoire,
checks CI obligatoires, force-push bloqué.

### 3. VPS OVH ou VPS existant

Si l'utilisateur choisit OVH, guide vers une base conservatrice :

- Ubuntu LTS récent ;
- IPv4 publique dédiée ;
- accès SSH par clé ;
- firewall OVH + firewall système minimal ;
- snapshots/backups activés ;
- région proche des utilisateurs ;
- taille initiale suffisante pour Supabase self-hosted, puis upgrade vertical
  si nécessaire.

Si VPS existant, vérifier :

```bash
ssh <user>@<vps-ip> 'uname -a && lsb_release -a || cat /etc/os-release'
ssh <user>@<vps-ip> 'docker --version || true'
ssh <user>@<vps-ip> 'df -h && free -h'
```

Ne demande jamais un mot de passe SSH ou une clé privée dans le chat. Si l'accès
SSH échoue, guide l'utilisateur pour configurer sa clé localement.

### 4. DNS et domaine

Pour OVH Manager ou tout provider DNS, prévoir ces entrées :

```text
api.<client-domain>              A ou CNAME    <vps-or-proxy-target>
admin.<client-domain>            A ou CNAME    <vps-or-proxy-target>
erp.<client-domain>              A ou CNAME    <vps-or-proxy-target>
bridge-updates.<client-domain>   A ou CNAME    <vps-or-proxy-target>
<module>.<client-domain>         A ou CNAME    <vps-or-proxy-target>
```

Conseils :

- utiliser `A` vers IPv4 si le VPS porte directement le proxy ;
- utiliser `CNAME` si un proxy/plateforme donne une cible DNS ;
- TTL 300 pendant l'installation, puis 3600 ou plus en production stable ;
- aucun wildcard DNS/CORS/redirect en production.

Valider avec :

```bash
dig +short api.<client-domain>
dig +short admin.<client-domain>
dig +short erp.<client-domain>
```

### 5. Supabase, proxy et Bridge

Utilise `yaka-bridge-new-client-vps`.

Ordre attendu :

1. durcir SSH et firewall ;
2. installer Docker/Compose ;
3. installer Supabase self-hosted ;
4. exposer Kong via `api.<client-domain>` ;
5. garder Postgres privé ;
6. configurer Auth avec signup fermé et SMTP réel ;
7. appliquer toutes les migrations ;
8. déployer admin, ERP, services modules ;
9. créer entitlements et services Bridge ;
10. préparer installers/update feed Bridge ;
11. configurer sauvegardes et restore drill.

### 6. Validation avant "terminé"

Ne jamais annoncer production-ready sans :

```bash
npm ci
npm run skills:check
npm run typecheck
npm test
npm run build
npm audit --audit-level=high
npm run security:grep
npm run factory:check
```

Et côté VPS :

- DNS résout vers le bon proxy ;
- TLS valide ;
- `/api/*` sans bearer = `401` ;
- mauvais scope = `403` ;
- `/bridge/*` sans token = `401` ;
- token Bridge expiré/révoqué = `401` ;
- mauvais service Bridge = `403` ;
- retrait entitlement = module masqué + job bloqué ;
- backup restauré sur environnement de test.

## Interdits

- Ne jamais demander ou écrire de secret dans le repo.
- Ne jamais accepter CORS wildcard en production.
- Ne jamais exposer Postgres publiquement.
- Ne jamais contourner GitHub protections.
- Ne jamais créer un module client dans le repo ERP si un repo module séparé
  est requis.
- Ne jamais présenter l'ordre de grandeur économique ChatGPT/API comme une
  garantie contractuelle.

## Livrables attendus

Selon le parcours, produire :

- réponses de cadrage manquantes ;
- brief client prêt à générer ;
- plan DNS précis ;
- plan VPS OVH ou audit VPS existant ;
- liste de repos GitHub à créer/vérifier ;
- checklist de secrets à renseigner hors git ;
- commandes de validation ;
- prochaines actions classées par priorité.
