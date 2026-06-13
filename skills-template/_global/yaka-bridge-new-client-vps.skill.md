---
name: yaka-bridge-new-client-vps
description: Créer un nouveau client yaka-bridge sur un VPS neuf, avec cadrage, DNS, Supabase, services ERP, Bridge, sécurité et validation production. Ne pas utiliser pour un simple redeploy Coolify ou une mise à jour de landing : utiliser yaka-bridge-deploy-coolify.
version: 1.0.0
---

# yaka-bridge-new-client-vps

Utilise cette skill quand l'utilisateur demande de créer un nouveau client,
un nouvel ERP client, une nouvelle installation VPS ou une mise en production
complète depuis un VPS neuf.

Pour un simple redeploy Coolify, une mise à jour de landing, une publication
d'app existante ou une relance de ressource Coolify, utiliser
`yaka-bridge-deploy-coolify`.

Objectif : partir d'un VPS propre et obtenir un ERP client sécurisé,
maintenable, avec domaines, DNS, Supabase, services web, Bridge installé et
checks production exécutés.

## Questions obligatoires

Ne commence pas l'installation tant que ces entrées ne sont pas connues ou
explicitement décidées :

1. Nom public du client et slug technique privé.
2. Dossier entreprise local `Projets/<CompanyFolder>/`.
3. Owner GitHub ou organisation GitHub qui hébergera les repos privés.
4. Domaine principal contrôlé par le client.
5. Provider DNS et accès disponibles.
6. VPS provider, IPv4, utilisateur SSH, système d'exploitation.
7. Email technique pour TLS et notifications.
8. Premier administrateur ERP.
9. Modules initiaux (`MODULES`), par défaut `["purchasing"]` si le client veut
   le socle démontrable.
10. Design system initial : `claude`, design system existant ou création avec
   `nexu-io/open-design`.
11. Services attendus et sous-domaines publics.
12. Politique de sauvegarde : cible externe, rétention, test restore.
13. Contraintes métier et d'usage : qui utilise ChatGPT, qui installe Bridge,
    quels documents transitent, quels workflows sont sensibles.

Si un secret est fourni dans le chat, demande sa rotation et ne l'écris jamais
dans le repo.

## Positionnement produit

yaka-bridge est un ERP en ligne modulaire pensé pour fonctionner avec :

- un site web cloud par admin ou service métier ;
- une application Bridge installée localement ;
- l'abonnement ChatGPT de chaque collaborateur pour les tâches agentiques ;
- Supabase comme source d'autorité pour auth, droits, données, jobs et audit.

Le Bridge transmet les données utiles entre l'ERP et ChatGPT au bon moment,
avec scopes, entitlements, audit et jobs contrôlés. L'objectif économique est
de réduire la dépendance aux appels API facturés à l'usage en exploitant les
abonnements ChatGPT déjà payés par les collaborateurs.

L'ordre de grandeur interne "100 EUR d'abonnements ChatGPT peuvent éviter
jusqu'à 15 000 EUR d'appels API" doit être présenté comme une hypothèse de
cadrage à recalculer selon les modèles, limites, conditions OpenAI et volumes
réels. Ne jamais le présenter comme une garantie contractuelle.

## DNS requis

Prévoir les enregistrements avant les tests navigateur :

```text
api.<client-domain>              A ou CNAME    <vps-or-proxy-target>
admin.<client-domain>            A ou CNAME    <vps-or-proxy-target>
erp.<client-domain>              A ou CNAME    <vps-or-proxy-target>
bridge-updates.<client-domain>   A ou CNAME    <vps-or-proxy-target>
<service>.<client-domain>        A ou CNAME    <vps-or-proxy-target>
```

Pour chaque nouveau module exposé :

```text
<module>.<client-domain>         A ou CNAME    <vps-or-proxy-target>
```

Ensuite mettre à jour :

- proxy HTTPS ;
- CORS explicites ;
- Supabase Auth `SITE_URL` et `ADDITIONAL_REDIRECT_URLS` ;
- variables `NEXT_PUBLIC_*` des apps ;
- manifest Bridge service ;
- URLs de healthcheck.

Interdit en production : CORS wildcard, redirect URL trop large, port Postgres
public, dashboard proxy sans auth séparée.

## Méthode VPS

1. Utiliser `yaka-bridge-version-modules` pour créer ou vérifier le repo privé
   `<clientSlug>-erp`, ses protections GitHub et sa politique de versioning.
2. Créer ou vérifier le dossier local `Projets/<CompanyFolder>/` avec
   `npm run projects:check`.
3. Créer le repo privé client depuis yaka-bridge avec un brief `MODULES` et
   `DESIGN_SYSTEM`.
4. Initialiser le VPS :
   - mises à jour système ;
   - utilisateur non-root si demandé par la politique client ;
   - SSH durci ;
   - firewall minimal ;
   - Docker et compose ;
   - proxy HTTPS type Traefik/Coolify.
5. Installer Supabase self-hosted :
   - Kong/API exposé via `api.<client-domain>` ;
   - Postgres privé ;
   - Auth avec signup fermé ;
   - SMTP réel ;
   - Storage pour Bridge installers et updates ;
   - secrets dans `/opt/supabase/.env` ou vault, jamais git.
6. Appliquer toutes les migrations yaka-bridge en ordre lexical.
7. Déployer les services web :
   - admin ;
   - ERP principal ;
   - chaque module exposé ;
   - variables serveur et navigateur cohérentes ;
   - `REQUIRE_AUTH=1`.
8. Configurer Bridge :
   - buckets installers et updates ;
   - build signé/notarisé quand applicable ;
   - service records ;
   - entitlements ;
   - token Bridge signé, expirant, révocable ;
   - tests polling/job/complete.
9. Configurer sauvegardes :
   - dump Postgres ;
   - archive Storage ;
   - copie externe chiffrée ;
   - restore drill documenté.
10. Configurer observabilité :
   - logs proxy ;
   - logs app ;
   - audit events ;
   - alertes de certificats, disque, backup.

## Méthode cadrage usage

Avant de livrer, documenter dans le repo client privé :

- rôles ERP (`owner`, `admin`, opérateurs par module) ;
- collaborateurs qui utilisent ChatGPT ;
- règles de données autorisées dans ChatGPT ;
- installation Bridge par poste ;
- modules activés par groupe ;
- workflows agentiques autorisés ;
- workflow de révocation d'un appareil Bridge ;
- workflow de retrait d'accès module.

## Commandes et checks

Dans le repo yaka-bridge :

```bash
npm ci
npm run typecheck
npm test
npm run build
npm audit --audit-level=high
npm run security:grep
npm run factory:check
```

Dans le repo client :

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Sur le VPS :

```bash
curl -fsS https://api.<client-domain>/rest/v1/
curl -fsS https://admin.<client-domain>/
curl -fsS https://<service>.<client-domain>/
```

Tester aussi :

- `/api/*` sans bearer retourne `401`.
- `/api/*` avec mauvais scope retourne `403`.
- `/bridge/*` sans token retourne `401`.
- token Bridge expiré ou révoqué retourne `401`.
- token Bridge valide mais mauvais service retourne `403`.
- retrait entitlement masque le module et bloque les jobs.
- restore backup sur environnement de test.

## Critère de fin

Le client est prêt uniquement si :

- DNS et TLS sont valides ;
- Supabase Auth fonctionne avec signup fermé ;
- migrations et RLS sont présentes ;
- services web sont protégés ;
- Bridge peut installer, ouvrir un service, poller et terminer un job ;
- sauvegardes et restore drill sont documentés ;
- aucun secret n'est dans git ;
- les changements génériques utiles sont remontés dans yaka-bridge.
