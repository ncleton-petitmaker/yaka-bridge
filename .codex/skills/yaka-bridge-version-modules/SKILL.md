---
name: yaka-bridge-version-modules
description: Conseiller et gérer la topologie GitHub, les droits, les protections, le versioning SemVer et la promotion des modules yaka-bridge entre repo module, repo client et template public.
version: 1.0.0
---

# yaka-bridge-version-modules

Utilise cette skill avant de créer, modifier, publier, promouvoir ou installer
un module yaka-bridge. Utilise-la aussi quand l'utilisateur parle de repo,
GitHub, version, release, branche, PR, droits, admin, module client ou nouveau
client.

Objectif : empêcher qu'un novice ou un agent code dans le mauvais repo, protéger
la production client, et garantir que chaque module installé est versionné,
auditable et reproductible.

## Règle figée

- Dossier local client = `Projets/<CompanyFolder>/`, ignoré par git.
- Nouveau client ERP = nouveau repo privé `<clientSlug>-erp`.
- Nouveau module client = nouveau repo privé
  `<clientSlug>-module-<moduleId>` par défaut.
- Module créé ou modifié par un non-développeur = repo module séparé
  obligatoire.
- Repo client ERP = contrôle production, config, DNS, entitlements,
  `modules.lock.json`, déploiement. Ce n'est pas l'atelier de coding quotidien.
- Repo module = zone de travail bornée. Un contributeur module ne doit pouvoir
  casser que son module.
- Template public `yaka-bridge` = structure générique et exemples anonymisés
  uniquement.
- Activation d'un module catalogue déjà stable = pas de nouveau repo module si
  aucun code client spécifique n'est écrit.

## Questions obligatoires

Avant toute action Git ou code, clarifie ce qui manque :

1. Client cible et slug technique.
2. Dossier entreprise local dans `Projets/<CompanyFolder>/`.
3. Owner GitHub ou organisation GitHub.
4. Module concerné et id technique anglais.
5. Type de travail : nouveau client, nouveau module, modification, release,
   promotion vers client, extraction vers template.
6. Qui va coder : mainteneur senior, agent supervisé, employé formé au vibe
   coding, autre.
7. Le module contient-il des règles, données, prompts, domaines ou intégrations
   privées ?
8. Repos existants : `yaka-bridge`, `<clientSlug>-erp`,
   `<clientSlug>-module-<moduleId>`.
9. Version cible ou nature du changement : breaking, ajout compatible, patch.

Si l'utilisateur veut avancer vite, choisis la voie la plus restrictive :
repo module privé séparé, PR obligatoire, release avant promotion.

## Classification

Décide la topologie avant de coder :

| Cas | Décision |
| --- | --- |
| Nouveau client | Créer ou vérifier `<clientSlug>-erp`. |
| Nouveau module client | Créer ou vérifier `<clientSlug>-module-<moduleId>`. |
| Non-développeur impliqué | Repo module séparé obligatoire. |
| Module catalogue déjà stable | Mettre à jour le repo client et `modules.lock.json`. |
| Amélioration structurelle générique | PR dans `yaka-bridge`, puis port client. |
| Module client devenu réutilisable | Extraire une version anonymisée vers `yaka-bridge`. |

## Préflight GitHub

Exécute ou demande les commandes équivalentes. Ne continue pas si une
vérification critique échoue.

```bash
git status --short --branch
git remote -v
npm run projects:check
npm run projects:list
gh auth status
gh repo view <owner>/<repo> --json nameWithOwner,visibility,isPrivate,defaultBranchRef
gh api repos/<owner>/<repo>/branches/main/protection
gh api repos/<owner>/<repo>/rulesets
```

Pour les repos client ou module :

- `visibility` doit être `PRIVATE`.
- `main` doit être protégé.
- Aucun contributeur non-développeur ne doit avoir le rôle admin.
- Le remote doit pointer vers le repo attendu.
- Le working tree doit être propre avant changement de version ou release.

Si `gh` n'est pas installé ou authentifié, arrête le workflow de versioning et
guide l'utilisateur pour installer/authentifier GitHub CLI. Ne contourne pas ces
vérifications avec des suppositions.

## Création des repos

Nouveau repo client :

```bash
gh repo create <owner>/<clientSlug>-erp --private --description "yaka-bridge ERP implementation for <clientSlug>"
```

Nouveau repo module :

```bash
gh repo create <owner>/<clientSlug>-module-<moduleId> --private --description "yaka-bridge module <moduleId> for <clientSlug>"
```

Après création :

1. Créer ou confirmer `Projets/<CompanyFolder>/`.
2. Cloner ou générer le repo dans `Projets/<CompanyFolder>/<subproject>/`.
3. Initialiser `main`.
4. Ajouter CI minimale.
5. Ajouter README sobre avec le périmètre privé.
6. Ajouter `CODEOWNERS` quand le mainteneur ou l'équipe GitHub est connu.
7. Protéger `main`.
8. Donner au contributeur module uniquement l'accès au repo module.
9. Vérifier qu'aucun secret ou donnée client réelle n'a été commité.

## Protection minimale

Configurer au minimum :

- PR obligatoire avant merge.
- Checks CI obligatoires.
- Force-push interdit.
- Suppression de branche protégée interdite.
- Conversations résolues avant merge.
- Historique linéaire si compatible avec l'organisation.
- Review mainteneur obligatoire pour les repos de production et modules client.

Si l'API GitHub est utilisée, préférer des commandes `gh api` reproductibles et
inclure la sortie utile dans le compte rendu. Si la configuration dépend d'une
offre GitHub ou de droits manquants, documente précisément ce qui reste à faire
dans l'interface GitHub.

## Versioning module

Chaque `module.config.json` doit contenir :

```json
{
  "id": "stock",
  "version": "0.1.0"
}
```

SemVer :

- `MAJOR` : changement incompatible de manifest, action, scope, route, table ou
  migration.
- `MINOR` : nouvelle capacité compatible.
- `PATCH` : correction, sécurité ou maintenance sans changement de contrat.

Règles :

- Une migration publiée est append-only : ne jamais la réécrire.
- Un tag publié ne se déplace jamais.
- La release doit référencer les migrations et actions ajoutées.
- Le repo client doit épingler la version dans `modules.lock.json`.
- Le template public ne reçoit qu'une version anonymisée.

Tags :

- Repo module client : `vX.Y.Z`.
- Repo template multi-modules : `<moduleId>-vX.Y.Z` si un tag module est utile.

## Promotion vers repo client

Pour installer ou mettre à jour un module dans `<clientSlug>-erp` :

1. Vérifier la release du repo module.
2. Vérifier que CI module est verte.
3. Mettre à jour `modules.lock.json` avec `id`, `repository`, `ref`,
   `version`, `source`.
4. Appliquer ou référencer les migrations nécessaires.
5. Mettre à jour DNS, entitlements, Bridge service et CORS si le module expose
   un service.
6. Ouvrir une PR dans le repo client.
7. Lancer les tests client.
8. Merger uniquement après review mainteneur.

Exemple `modules.lock.json` :

```json
{
  "schema": "yaka-bridge/modules-lock.v1",
  "modules": [
    {
      "id": "stock",
      "source": "client-module",
      "repository": "github.com/<owner>/<clientSlug>-module-stock",
      "ref": "v0.1.0",
      "version": "0.1.0"
    }
  ]
}
```

## Extraction vers template

Quand un module client devient réutilisable :

1. Créer une branche dans `yaka-bridge`.
2. Copier uniquement la structure générique.
3. Supprimer noms, domaines, prompts, documents, données et règles privées.
4. Ajouter seeds demo anonymisés.
5. Ajouter ou adapter tests, manifest, migrations et docs.
6. Exécuter :

```bash
npm ci
npm run typecheck
npm test
npm run build
npm audit --audit-level=high
npm run security:grep
npm run factory:check
```

7. Ouvrir une PR vers `yaka-bridge`.

## Interdits

- Ne jamais pousser directement sur `main`.
- Ne jamais rendre public un repo client ou module client.
- Ne jamais donner admin à un contributeur non-développeur.
- Ne jamais installer en prod une branche flottante.
- Ne jamais corriger un module directement dans le repo client si le travail
  devrait être isolé dans le repo module.
- Ne jamais copier des données client dans `yaka-bridge`.
- Ne jamais annoncer "terminé" sans CI, audit high et vérification des
  protections GitHub.

## Compte rendu attendu

À la fin, donne :

- décision de topologie ;
- repos créés ou vérifiés ;
- protections GitHub vérifiées ou à terminer ;
- version précédente et nouvelle version ;
- tag/release créé ou PR ouverte ;
- changements dans `modules.lock.json` ;
- tests exécutés ;
- risques résiduels.
