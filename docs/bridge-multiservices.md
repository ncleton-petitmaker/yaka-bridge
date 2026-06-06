# Bridge multi-services

Bridge est l'application Electron centrale du template. Les applications
client ne doivent plus être générées comme applications Electron autonomes :
elles deviennent des sites web Supabase qui gravitent autour de Bridge.

## Rôle de Bridge

- Bridge garde toujours le nom produit `Bridge`.
- Bridge est packagé séparément avec `electron-builder.bridge.cjs`.
- Bridge conserve une configuration locale dans `~/.bridge/config.json`.
- Bridge cloisonne les données locales par service sous
  `<BridgeData>/services/<serviceId>/`.
- Bridge exécute les jobs Codex uniquement dans le contexte du service,
  avec racines locales autorisées et scopes explicites.

## Rôle des services web

- Chaque service est un site web en ligne, généralement basé sur Supabase.
- Le service publie un manifeste : URL, healthcheck, scopes, actions et events.
- Le service ne stocke pas son propre mot de passe utilisateur dans Bridge.
- L'ouverture depuis Bridge doit passer par un launch ticket court et à usage
  unique généré par le Control Plane.

## Control Plane

Le Control Plane Bridge gère :

- organisations, membres et rôles ;
- catalogue de services ;
- droits utilisateur par service ;
- appareils Bridge autorisés ;
- jobs Codex ;
- tickets de lancement ;
- bus ERP actions/events ;
- audit.

Le template inclut un Control Plane local de développement dans
`server/bridge-control-plane.ts`. En production, les mêmes routes doivent être
portées dans des Edge Functions ou une API cloud.

## Bus ERP

La règle de base : un service ne lit pas directement la base d'un autre
service. Il consomme une action, un event ou une vue publiée.

Les entités communes d'entreprise doivent vivre dans un socle ERP partagé
quand elles structurent plusieurs modules : organisations, utilisateurs,
clients, documents, produits, paramètres et référentiels.
