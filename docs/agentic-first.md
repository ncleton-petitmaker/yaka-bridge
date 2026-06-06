# Agentic-first invariant

Les apps produites par la factory doivent être **agentic-first** : toute action faisable dans l'interface doit aussi être faisable par un agent via MCP, avec le même contrat métier.

CRMclaw est la référence : son serveur MCP expose des tools typés (`<tenant>__orgs__create`, `contacts__update`, `campaigns__send`, etc.) et l'UI ne possède pas de pouvoir métier caché. L'interface est une façade humaine sur des actions serveur que l'agent peut appeler.

## Règle d'or

> Si un bouton, menu, formulaire ou drag/drop déclenche une mutation ou une opération métier, il doit exister une action serveur typée correspondante, exposée en HTTP **et** en MCP.

Le front ne doit jamais contenir une logique métier inaccessible aux agents.

## Architecture cible pour chaque app générée

```
UI Next.js
  └─ lib/client.ts
       └─ HTTP /api/actions/* ou routes métier
            └─ server/actions.ts        # action registry canonique
                 ├─ utilisé par routes Hono
                 ├─ utilisé par serveur MCP local
                 └─ écrit audit log + events SSE si long-running

Agent externe / Claude Code / Pi
  └─ MCP tools
       └─ mêmes handlers server/actions.ts
```

## Contrat d'une action

Chaque action métier doit avoir :

- `id` stable, en kebab ou namespace (`batch.create`, `batch.cancel`, `skill.promote`).
- `description` lisible par un agent.
- `inputSchema` Zod/JSON Schema.
- `outputSchema` ou shape documentée.
- `handler(ctx, input)` unique, côté serveur.
- `audit` : action, resource_type, resource_id, result.
- `capabilities` / garde-fous si destructif (`confirmRequired`, `adminOnly`, `dangerous`).

## Parité UI ↔ MCP

Pour chaque page générée, le `ui-page-generator` doit tenir une checklist :

| UI action | Server action | HTTP route | MCP tool | Audit | OK |
|---|---|---|---|---|---|
| Créer entité | `<entity>.create` | `POST /api/<entities>` | `<app>__<entity>__create` | oui | |
| Lister/rechercher | `<entity>.list/search` | `GET /api/<entities>` | `<app>__<entity>__list/search` | lecture optionnel | |
| Modifier | `<entity>.update` | `PATCH/PUT /api/<entities>/:id` | `<app>__<entity>__update` | oui | |
| Supprimer/annuler | `<entity>.delete/cancel` | `DELETE/POST ...` | `<app>__<entity>__delete/cancel` | oui | |
| Lancer run long | `<entity>.run` | `POST .../run` | `<app>__<entity>__run` | oui + SSE | |

Aucune ligne ne doit rester sans MCP tool.

## MCP local

Le template doit générer un serveur MCP local, lancé comme sidecar ou disponible en stdio, qui expose :

- les actions métier du registry ;
- les actions génériques du template (`runs.start`, `runs.cancel`, `skills.list`, `skills.write`, `appConfig.get/update`, `audit.read` selon permissions) ;
- les actions spécifiques du brief (`EXTRA_ROUTES`) si elles sont invocables depuis l'UI.

Les tools sont préfixés par le slug de l'app pour éviter les collisions :

```text
<app_slug>__runs__start
<app_slug>__runs__cancel
<app_slug>__<entity_plural>__list
<app_slug>__<entity>__create
```

## Implications factory

- `domain-modeler` doit produire les types d'input/output des actions quand ils sont déductibles.
- `subprocess-driver` doit créer les handlers d'actions avant les routes Hono ; les routes appellent les handlers, pas l'inverse.
- `ui-page-generator` doit utiliser `lib/client.ts`, qui appelle les routes actionnées par les mêmes handlers MCP.
- `skill-author` doit documenter les tools MCP utiles pour piloter l'app.

## Critère d'acceptation

Une app générée est refusée si :

1. une action visible dans l'UI n'a pas de tool MCP équivalent ;
2. un handler UI contient de la logique métier non présente côté serveur ;
3. un tool MCP contourne l'audit log ou la validation Zod ;
4. un run long n'est pas cancellable par l'UI et par MCP.
