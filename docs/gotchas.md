# Gotchas

Pièges connus, recettes éprouvées. À enrichir au fil des apps.

## Maestro 2.5.1 — `--env` n'override pas les defaults YAML

Symptôme : tu passes `--env qid=42 --env question="Bonjour"` à Maestro,
mais dans le flow YAML les valeurs `${qid}` / `${QUESTION}` restent celles
des `defaults:` du flow.

Cause : bug Maestro 2.5.1 ; les valeurs `defaults:` ont précédence sur `--env`.

**Recette** : templater le YAML *direct* avant le spawn. Lire le template,
faire un `.replace(/__QID__/g, qid)` etc., écrire le YAML résolu dans un
fichier temp, spawn `maestro test <temp>.yaml`. Ne pas utiliser `--env`.

## Maestro 2.5.1 — `inputText` refuse les caractères Unicode

Symptôme : `inputText: "Bonjour ça va"` crashe Maestro avec un encoding
error sur les caractères accentués.

**Recette** : strip les accents avant `inputText`. JS :

```js
function stripAccents(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}
```

Puis remplace dans le YAML templaté.

## Node fetch (undici) — `headersTimeout` 5min par défaut

Symptôme : un fetch vers un LLM local qui met >5min à répondre se ferme
avec `UND_ERR_HEADERS_TIMEOUT` (`headers timeout`).

**Recette** : utilise `AbortSignal.timeout(N)` explicite **ou** une option
`signal` avec ton propre AbortController. Pour un LLM long, mettre
`signal: AbortSignal.timeout(600000)` (10 min).

```js
const r = await fetch(url, {
  signal: AbortSignal.timeout(600_000),
  body: JSON.stringify(payload),
});
```

## Kong path stale après redémarrage Docker

Symptôme : après un `docker compose restart` sur la stack Supabase locale,
Kong (port 8000) renvoie 502 sur toutes les routes alors que les services
backend sont up.

**Cause** : Kong cache les paths Postgres au boot ; si la DB n'est pas
encore prête à ce moment-là, les routes restent "non résolues" même après
que la DB soit revenue.

**Recette** : recréer le container Kong (`docker compose up -d --force-recreate kong`)
plutôt que `restart`.

## Electron asar pack — `asarUnpack` mandatory pour binaires natifs + readFileSync de templates

Symptôme : l'app builde, démarre, mais le daemon plante à
`fs.readFileSync(skills-template/...)` avec ENOENT.

**Cause** : avec `asar: true`, `fs.readFileSync` *sait* lire dans un asar
(bon), mais `child_process.spawn`, certains modules natifs et certains
chemins relatifs ne savent pas. Tout ce qui est exécuté (script daemon,
.node binaires) ou inspecté par un sous-processus doit être en
**`asarUnpack`**.

**Recette** : dans `package.json::build.asarUnpack`, lister :

```json
"asarUnpack": [
  "**/*.node",
  "dist/**",
  ".next/standalone/**",
  "skills-template/**",
  "data-template/**"
]
```

Et dans `electron/main.cjs`, calculer `unpackedRoot` :

```js
const appRoot = app.getAppPath();
const unpackedRoot = appRoot.endsWith(".asar")
  ? appRoot + ".unpacked"
  : appRoot.includes(`${path.sep}app.asar${path.sep}`)
  ? appRoot.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
  : appRoot;
```

## Next.js 16 + Electron — standalone mode obligatoire pour le packaging

Symptôme : `electron-builder` produit un bundle, mais Next refuse de booter
en prod avec `Cannot find module 'next/dist/server/...`.

**Cause** : par défaut, `next start` a besoin de tout l'arbre `node_modules`.
Avec `output: "standalone"` dans `next.config.ts`, Next produit un
`.next/standalone/server.js` auto-suffisant qui inline ses deps.

**Recette** : laisser `output: "standalone"` dans `next.config.ts`. Au
packaging, spawn `node .next/standalone/server.js` (pas `npx next start`).
Voir `electron/main.cjs::spawnSidecars` mode packagé.

Detail subtile : le mode standalone *exclut* `.next/static/` et `public/`
du bundle qu'il copie. Il faut les recopier manuellement à côté
(`scripts/prepare-pack.mjs` + `scripts/electron-builder-after-pack.cjs`).

## Claude CLI — `--effort low` requis pour latence prévisible

Symptôme : un run Claude qui doit normalement durer 1-2 min hang pendant
5-10 min sans aucun event SSE.

**Cause** : depuis Sonnet 4.6 / Opus 4.6+, l'option par défaut `effort=high`
active le thinking adaptatif qui peut produire 5-10 min de `thinking_delta`
par tour avant de répondre.

**Recette** : `buildClaudeArgs()` passe `--effort low`. **Et** complète avec
`env: { CLAUDE_CODE_DISABLE_THINKING: "1" }` au spawn (kill-switch officiel
Anthropic). Les deux ensemble garantissent latence prévisible sans perte
notable de qualité sur extraction structurée.

## Claude CLI — `usage` est émis 2x par tour (dédup par message_id)

Symptôme : les coûts USD calculés sont 2x trop élevés.

**Cause** : Claude Code émet un `usage` au `stream_event.message_start` (input
+ cache, output_tokens placeholder) puis un autre au `type: assistant`
(input/cache identiques + output_tokens final cumulé). Si on additionne
naïvement, on double les input + cache.

**Recette** : `server/runs.ts::broadcast()` dédup par `message_id`. Quand un
event `usage` arrive avec un `message_id` déjà vu, on retire l'ancien
snapshot et ajoute le nouveau (qui a l'`output_tokens` final). Ne pas
modifier cette logique.

## Hooks Claude Code — exit 2 = bloquer, écrire sur stderr

Symptôme : ton hook PreToolUse "exit 1" et Claude ignore le résultat.

**Cause** : seul `exit 2` est interprété par Claude comme un blocage. `exit 0`
= autoriser. Les autres codes sont ignorés (avec un warning).

**Recette** : `process.exit(2)` quand on bloque, et écrire l'explication sur
stderr (renvoyée à Claude pour qu'il corrige).

```js
process.stderr.write(`Écriture refusée : ${reason}`);
process.exit(2);
```

## Hooks Claude Code — stdin JSON contient `tool_name` ET parfois `tool`

Symptôme : un hook ne déclenche jamais le matcher.

**Cause** : selon la version de Claude Code, le payload stdin du hook utilise
`tool_name` ou `tool` pour le nom de l'outil.

**Recette** : lire les deux : `const toolName = event.tool_name || event.tool || ""`.

## Audit log — un seul writer par fichier (race-free)

Convention : un fichier JSONL par utilisateur par jour
(`audit-log/<user-slug>/YYYY-MM-DD.jsonl`). Deux processus / machines /
utilisateurs n'écrivent jamais dans le même fichier → pas de race d'`append`.
Chaque fichier est sa propre chaîne SHA-256 isolée. Ne pas casser cette
invariante (ex : ne pas écrire en parallèle depuis plusieurs processus pour
le même user).
