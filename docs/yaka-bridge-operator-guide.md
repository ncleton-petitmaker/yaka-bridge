# yaka-bridge operator guide

Ce repo est le template public `yaka-bridge` : un ERP en ligne modulaire,
piloté par Supabase, des services web métier et une application Bridge
installée localement.

Le template ne contient aucun client réel. Les repos client privés sont des
implémentations de production qui peuvent inspirer le template seulement après
anonymisation.

## Produit

yaka-bridge est pensé pour trois usages combinés :

- ERP cloud : admin, modules métier, dashboards et workflows en ligne.
- Bridge local : app installée sur les postes pour ouvrir les services,
  exécuter les jobs autorisés et dialoguer avec ChatGPT au bon moment.
- Agentic-first : chaque action visible dans l'UI possède une action serveur
  typée, exposable en HTTP et en MCP, avec audit et scopes.
- Design-system-first : chaque ERP choisit un système visuel au setup, puis les
  modules et Bridge consomment les mêmes tokens et assets.

L'approche économique consiste à exploiter l'abonnement ChatGPT des
collaborateurs pour les tâches agentiques, plutôt que de transformer tous les
usages en appels API facturés à l'usage. OpenAI indique que l'API est facturée
séparément des abonnements ChatGPT ; les calculs de ROI doivent donc être
refaits avec les prix officiels, les modèles utilisés et les volumes réels.

Phrase business autorisée en cadrage interne :

```text
L'objectif est qu'un budget ChatGPT collaborateur puisse remplacer une partie
importante d'une facture API équivalente ; l'ordre de grandeur "100 EUR
d'abonnements ChatGPT peuvent éviter jusqu'à 15 000 EUR d'appels API" reste une
hypothèse à recalculer et à sourcer pour chaque cas réel.
```

Sources à vérifier avant tout usage commercial :

- https://openai.com/chatgpt/pricing/
- https://openai.com/api/pricing/

## Skills livrés

Les skills de pilotage sont dans `skills-template/_global/` et sont copiés dans
`data/.claude/skills/_global/` au postinstall.

### Créer un module

Utiliser :

```text
Utilise la skill yaka-bridge-create-module pour créer un module de gestion des stocks.
Demande-moi le client cible, puis produis la version template et l'implémentation client.
```

La skill force :

- choix du client cible ;
- id technique anglais ;
- labels FR/EN ;
- manifest canonique ;
- migrations Supabase + RLS ;
- actions serveur typées ;
- parité HTTP/MCP/Bridge ;
- dashboard module ;
- seeds demo anonymisés ;
- tests authZ et factory.

### Créer un nouveau client/VPS

Utiliser :

```text
Utilise la skill yaka-bridge-new-client-vps pour créer un nouveau client sur un VPS neuf.
Pose-moi les questions de cadrage, DNS, domaine, modules, sauvegardes et Bridge.
```

La skill force :

- cadrage client et usages ChatGPT ;
- domaine et zones DNS ;
- VPS, Docker, proxy HTTPS ;
- Supabase self-hosted ;
- migrations yaka-bridge ;
- services web admin/ERP/modules ;
- Bridge installers, updates, tokens et entitlements ;
- sauvegardes, restore drill et observabilité ;
- tests production avant livraison.

### Changer le design system

Utiliser :

```text
Utilise la skill yaka-bridge-refactor-design-system pour importer ce design
system, puis refondre tous les modules, l'admin et Bridge.
```

La skill force :

- choix du repo cible ;
- choix ou création du design system ;
- contrat `design-systems/<id>/` ;
- application par `npm run design:apply` ;
- refonte de `app/`, `components/`, `modules/`, `bridge/` et `public/` ;
- build Bridge ;
- vérification visuelle et tests production.

Pour créer un nouveau design system, utiliser
[`nexu-io/open-design`](https://github.com/nexu-io/open-design) comme atelier de
cadrage, puis adapter la sortie au contrat yaka-bridge documenté dans
[`docs/design-systems.md`](design-systems.md).

## Bonne méthode module client puis template

Quand le travail démarre pour un client réel :

1. Construire dans le repo client privé si les règles métier, données ou
   libellés sont spécifiques.
2. Garder dans le repo client tout ce qui est privé : domaines, données, règles
   propres, secrets, prompts client et overrides.
3. Dès que la structure devient générique, extraire vers yaka-bridge :
   manifest, migrations, actions, UI, tests et seeds demo anonymisés.
4. Rebrancher le repo client sur cette structure générique.
5. Porter dans yaka-bridge toute correction de sécurité, maintenance ou modèle
   découverte en production.

Quand le module est clairement générique dès le départ, commencer dans
yaka-bridge puis installer le module dans le repo client par configuration.

Règle de décision : le privé sert à apprendre le besoin réel ; le template sert
à stabiliser la structure réutilisable.

## DNS standard

Pour un nouvel ERP client :

```text
api.<client-domain>              Supabase API / Kong
admin.<client-domain>            administration ERP
erp.<client-domain>              portail ERP principal
bridge-updates.<client-domain>   artefacts d'update Bridge
<module>.<client-domain>         service web du module
```

Chaque entrée DNS doit être raccordée au proxy HTTPS, aux CORS autorisés, aux
redirect URLs Supabase Auth et au manifest Bridge du service.

## Gates production

Avant de dire "terminé", exécuter :

```bash
npm ci
npm run typecheck
npm test
npm run build
npm audit --audit-level=high
npm run security:grep
npm run factory:check
```

Pour un client, ajouter :

- migrations appliquées sur base fraîche ;
- `/api/*` sans bearer = `401` ;
- mauvais scope = `403` ;
- `/bridge/*` sans token = `401` ;
- token Bridge expiré/révoqué = `401` ;
- mauvais service Bridge = `403` ;
- retrait entitlement = module masqué + job bloqué ;
- sauvegarde restaurée sur environnement de test ;
- DNS, TLS et redirects Supabase validés.

## Politique secrets

Ne jamais écrire dans git :

- clés Supabase service role ;
- JWT secrets ;
- tokens Bridge ;
- secrets SMTP ;
- dumps client ;
- domaines privés non destinés au repo public ;
- prompts ou documents client.

Les secrets vivent dans le VPS, le vault CI/CD ou le gestionnaire de secrets du
client.
