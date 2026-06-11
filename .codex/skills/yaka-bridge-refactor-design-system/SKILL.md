---
name: yaka-bridge-refactor-design-system
description: Importer ou créer un design system puis refondre toutes les surfaces yaka-bridge, modules et Bridge inclus, sans casser les contrats métier.
version: 1.0.0
---

# yaka-bridge-refactor-design-system

Utilise cette skill quand l'utilisateur demande de changer le design system,
d'importer une charte, d'utiliser un design system open-design, de refondre
l'UI de tous les modules ou d'aligner Bridge avec une nouvelle identité.

Objectif : appliquer un design system complet à un projet yaka-bridge ou à un
repo client privé, tout en conservant les garanties production : auth, scopes,
Bridge, MCP, actions métier, migrations et tests.

## Questions obligatoires

Avant toute modification, clarifie :

1. Quel est le repo cible ?
   - template public ;
   - repo client privé existant ;
   - les deux, avec extraction générique vers template.
2. Quel design system appliquer ?
   - `claude` intégré ;
   - dossier local `design-systems/<id>` ;
   - dossier importé ;
   - design à créer avec `nexu-io/open-design`.
3. Quel est l'id technique du design system ?
4. Quelles surfaces sont dans le scope ?
   - app/admin ;
   - modules ;
   - Bridge ;
   - docs/screenshots ;
   - generated customer apps.
5. Y a-t-il une contrainte client privée ?
   - marque ;
   - police ;
   - logo ;
   - domaine ;
   - règles d'accessibilité ;
   - composants interdits.

Ne jamais écrire de nom client, logo client ou domaine privé dans le template
public.

## Contrat yaka-bridge

Un design system valide doit fournir :

```text
design-systems/<id>/
  DESIGN.md
  design-system.config.json
  tokens.css
  assets/app-mark.svg
  assets/bridge-mark.svg
```

Le manifest doit décrire :

- `id`
- `name`
- `version`
- `targets`
- `files.tokens`
- `files.designDoc`
- `files.appMark`
- `files.bridgeMark`
- `bridge.tokens`
- `requiredCssVariables`

Les tokens actifs sont appliqués par :

```bash
npm run design:apply -- --design-system <id>
```

Pour une source externe :

```bash
npm run design:apply -- \
  --design-system <id> \
  --source /absolute/path/to/design-system
```

## Usage avec nexu-io/open-design

Si l'utilisateur veut créer un nouveau design system :

1. Utiliser `nexu-io/open-design` comme atelier de cadrage visuel :
   <https://github.com/nexu-io/open-design>
2. Exporter ou rédiger un `DESIGN.md`.
3. Adapter la sortie au contrat yaka-bridge.
4. Créer `tokens.css` avec toutes les variables requises.
5. Créer `bridge.tokens` dans le manifest.
6. Appliquer le design system.
7. Refondre les surfaces.

Ne jamais considérer une sortie open-design comme prête à merger sans
normalisation, audit d'accessibilité et vérification yaka-bridge.

## Surfaces à auditer

Lire et adapter :

- `DESIGN.md`
- `design-system.config.json`
- `app/design-system.css`
- `app/globals.css`
- `tailwind.config.ts`
- `components/`
- `app/`
- `modules/`
- `bridge/`
- `public/app-mark.svg`
- `public/bridge-mark.svg`
- `scripts/brand-icons.mjs`
- docs qui décrivent la charte

Bridge est obligatoire : vérifier `bridge/provider-setup.cjs`,
`bridge/design-system.json`, puis `npm run bridge:build`.

## Règles de refonte

- Préserver tous les contrats métier.
- Ne pas modifier les scopes, actions, auth, RLS ou migrations sauf nécessité
  strictement liée au design system.
- Remplacer les couleurs hardcodées par des tokens.
- Conserver ou adapter les alias existants pour éviter de casser les modules.
- Adapter les assets Bridge et app ensemble.
- Vérifier les états : hover, focus, disabled, loading, error, empty.
- Vérifier les layouts desktop et mobile.
- Vérifier les textes longs et labels bilingues.
- Ne pas introduire de palette mono-teinte ou de décoration gratuite.
- Ne pas masquer les signaux de sécurité, d'erreur ou d'audit.

## Workflow robuste

1. Inspecter l'état git et créer une branche.
2. Lire `docs/design-systems.md`.
3. Lire le design source.
4. Créer ou corriger le contrat `design-systems/<id>/`.
5. Exécuter `npm run design:apply`.
6. Refondre app, modules et Bridge.
7. Exécuter :

   ```bash
   npm ci
   npm run typecheck
   npm test
   npm run build
   npm run bridge:build
   npm audit --audit-level=high
   npm run security:grep
   npm run factory:check
   ```

8. Faire une vérification navigateur si une surface frontend a changé.
9. Créer une PR si `main` est protégée.

## Livrables

- Design system source dans `design-systems/<id>/`.
- `DESIGN.md` actif.
- `app/design-system.css` actif.
- `bridge/design-system.json` actif.
- Assets app/Bridge cohérents.
- UI modules refondue.
- Bridge setup UI refondue.
- Docs à jour.
- Tests et build verts.
