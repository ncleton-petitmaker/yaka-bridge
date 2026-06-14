---
name: yaka-bridge-sync-guardian
description: Détecter et empêcher la dérive entre le repo plateforme yaka-bridge, les repos clients Yaka et les templates avant modification, build, packaging, migration, commit ou push. Utiliser quand Codex touche `yaka-bridge`, un dossier client sous `Projets/`, un repo client ERP, un module client, Bridge Desktop, un template, ou quand un bug/fix client peut être générique et doit être proposé ou promu vers la source/template avant sauvegarde Git.
---

# yaka-bridge-sync-guardian

Utilise cette skill dès qu'un travail touche `yaka-bridge`, un dossier
`Projets/<Client>/`, un repo client ERP, un module client, un build Bridge, un
artefact Desktop, un template, ou une sauvegarde Git après changement client.

Objectif : empêcher qu'un agent travaille sur un vieux clone client ou génère un
DMG/EXE depuis un core Yaka copié.

## Règle

- `yaka-bridge` est la plateforme source.
- Un repo client doit consommer les packages `@ncleton-petitmaker/yaka-*`.
- Un repo client ne doit pas contenir de core copié : `bridge/`,
  `bridge-voice/`, `electron-builder.bridge.cjs` ou scripts de packaging
  plateforme.
- Tout client doit avoir `yaka.project.json` et `modules.lock.json`.
- Tout build Bridge client doit passer par `yaka doctor --strict`.

## Préflight obligatoire

Dans le repo courant :

```bash
node scripts/yaka-sync-guardian.mjs doctor --strict
```

Si tu es dans un repo client où le package `@ncleton-petitmaker/yaka-sync-guardian` est installé :

```bash
npx yaka doctor --strict
```

Si le check échoue, ne build pas d'artefact et ne prétends pas que le client est
à jour. Corrige la dérive ou propose une migration.

## Quand la plateforme change

1. Lancer `npm run yaka:doctor`.
2. Lister les clients avec `npm run yaka:clients`.
3. Pour chaque client impacté, créer ou proposer une PR d'upgrade `@ncleton-petitmaker/yaka-*`.
4. Ne jamais copier manuellement le dossier `bridge/` dans un client.

## Quand un client change

1. Lancer le guardian dans le client.
2. Si un changement touche un comportement générique, le promouvoir vers
   `yaka-bridge`.
3. Garder dans le client uniquement le métier, la configuration, le branding, les
   modules privés et le déploiement.

## Avant Commit ou Push Client

Toujours faire un audit source/template avant `git add`, `git commit` ou
`git push` dans un repo client ou `Projets/<Client>/`.

1. Classer chaque changement client :
   - **client-only** : données métier, branding, config, secrets, déploiement,
     modules privés ou adaptation locale ;
   - **générique** : Bridge, provider de statut, sync, templates, design system
     partagé, SDK, règles de génération, packaging, sécurité, workflow commun.
2. Si au moins un changement est générique, ne pas faire une sauvegarde Git
   client-only sans traiter la source. Promouvoir le changement dans
   `yaka-bridge` ou le template quand c'est évident.
3. Si la promotion n'est pas évidente ou si elle peut changer le contrat public,
   demander explicitement : "Ce fix semble générique, veux-tu aussi que je le
   remonte dans la source/template avant le commit/push client ?"
4. Dans le message final d'un commit/push client, mentionner explicitement l'un
   des résultats :
   - "source/template mis à jour" ;
   - "client-only justifié" ;
   - "promotion source/template demandée à l'utilisateur".

## Build Desktop

Un DMG/EXE client est valide seulement si :

- `yaka doctor --strict` passe ;
- le client est épinglé sur les versions `@ncleton-petitmaker/yaka-*` attendues ;
- aucun vieux artefact local dans `release-bridge` n'est utilisé comme source ;
- le build vient du workflow de packaging prévu.
