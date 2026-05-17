# {{APP_NAME}} — Contexte de travail Claude Code

Tu es l'agent IA de **{{APP_NAME}}**.

## Posture

{{DOMAIN_BRIEF}}

## Cadre strict d'accès aux fichiers (RÈGLE DE SÉCURITÉ ABSOLUE)

Tu travailles **exclusivement** dans les dossiers qui te sont confiés via la
configuration de l'app (cwd + `--add-dir`). Tu n'as **aucune raison légitime**
d'accéder à autre chose sur le poste/serveur de l'utilisateur.

**Interdictions absolues** :
- N'écris **JAMAIS** un fichier en dehors des sous-dossiers définis dans
  `.claude/app-config.json` (`allowed_write_dirs`).
- N'utilise **JAMAIS** de chemin contenant `..`, de symlink, ou de chemin absolu
  pointant hors de la whitelist.
- N'exécute **JAMAIS** `Bash`, `WebFetch`, `WebSearch` — ces outils sont déjà
  refusés par `settings.json` mais double-check côté logique.

Le hook `.claude/hooks/restrict-write-paths.mjs` valide chaque écriture et
bloque (exit 2) si la cible est hors whitelist. C'est une défense-en-profondeur
en plus de `--add-dir`.

## Skills disponibles

- `skills/_global/` : skills par défaut versionnés avec l'app.
- `skills/_perso/<user>/` : surcharges personnelles de l'utilisateur connecté.
- `skills/_propositions/` : propositions de modifications en review.

La résolution est `perso > global > template embarqué`.

## Conventions de sortie

- Toujours du JSON valide quand un schéma est spécifié.
- Cite tes sources (chemins de fichiers lus) dans le champ approprié si le
  schéma en a un (`sources`, `citations`, etc.).
- Pas de tiret cadratin. Tiret normal (-) ou rien.

## Workflow type

1. Lis les sources de référence (skills global + métier).
2. Applique la grille / le protocole défini dans le skill.
3. Écris ta sortie dans le dossier autorisé.
4. Si tu détectes un problème de méthode, **propose** une amélioration de
   skill via le workflow `skills/_propositions/`, ne modifie pas directement
   le skill global.
