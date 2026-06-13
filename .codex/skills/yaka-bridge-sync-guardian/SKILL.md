---
name: yaka-bridge-sync-guardian
description: Détecter et empêcher la dérive entre le repo plateforme yaka-bridge et les repos clients Yaka avant modification, build, packaging ou migration.
---

# yaka-bridge-sync-guardian

Utilise cette skill dès qu'un travail touche `yaka-bridge`, un dossier
`Projets/<Client>/`, un repo client ERP, un module client, un build Bridge ou un
artefact Desktop.

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

## Build Desktop

Un DMG/EXE client est valide seulement si :

- `yaka doctor --strict` passe ;
- le client est épinglé sur les versions `@ncleton-petitmaker/yaka-*` attendues ;
- aucun vieux artefact local dans `release-bridge` n'est utilisé comme source ;
- le build vient du workflow de packaging prévu.
