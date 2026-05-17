---
name: regenerer-skills-depuis-referentiel
description: Régénère les skills d'évaluation (evaluer-eligibilite.skill.md et/ou evaluer-notation.skill.md) d'une campagne en BROUILLON à partir d'un fichier référentiel fourni par l'admin (Questionnaire d'éligibilité.docx, Questionnaire de notation.docx, ou équivalent en .md/.txt). Se déclenche quand l'admin joint un fichier au chat et te demande "régénère les règles de la campagne X depuis ce référentiel".
version: "0.1.0"
---

# Skill : Régénérer les skills depuis un référentiel uploadé

## Contexte

L'admin de OIF-Eval veut adapter les règles d'évaluation pour une nouvelle campagne (ex : FAE 8e édition, où la grille a légèrement changé par rapport à la 7e). Il a uploadé un fichier **référentiel** dans le chat (ex. `Questionnaire notation - 8e édition.docx`, automatiquement converti en .md par le serveur). Il te demande maintenant de régénérer les skills d'évaluation à partir de ce référentiel.

**ATTENTION** : tu touches à des fichiers qui pilotent toutes les évaluations futures. Procède méthodiquement et confirme à chaque étape.

## Inputs attendus dans le contexte

L'UI te transmet :
- `referentiel_text_path` : chemin absolu du fichier converti en .md/.txt (ou .md natif). C'est ce que tu lis avec **Read**.
- `referentiel_original_path` : chemin du fichier original (.docx, .pdf...) pour référence et trace.
- `target_campaign_id` : id de la campagne **brouillon** à modifier.
- `target_skill_type` (optionnel) : "eligibilite", "notation", ou "auto" (déduire depuis le contenu).
- `campaigns_root` : chemin absolu de `<skillsRoot>/campaigns/`.

Si l'un manque ou ambigu, **demande poliment à l'admin** avant d'écrire quoi que ce soit.

## Sécurité non négociable

1. **Drafts uniquement.** Avant toute écriture, lis `campaigns/<id>/manifest.json` pour vérifier que la campagne existe. Lis ensuite `campaigns/_index.json` pour confirmer que `status === "draft"`. Si statut `active` ou `archived`, **refuse** et explique : "Édition autorisée uniquement sur les brouillons. Cloner d'abord la campagne active si vous voulez modifier."
2. **Backup avant écriture.** Avant de remplacer `evaluer-notation.skill.md`, copie le contenu actuel dans `<campagne>/snapshots/regen-<timestamp>-evaluer-notation.skill.md.bak`. Idem pour eligibilite. Permet à l'admin d'annuler.
3. **Confirme le diff** dans le chat avant d'écrire. Montre un résumé : N questions identifiées dans le référentiel, structure (bloc A : N1 questions, bloc B : N2), barème max total. L'admin doit pouvoir dire "go" ou "stop" avant l'écriture finale.

## Procédure

### Étape 1 - Lire le référentiel

Avec `Read referentiel_text_path`, charge le fichier converti. Si la conversion docx → md a perdu des choses (textuel mentionne `conversionWarnings`), explique-le à l'admin.

### Étape 2 - Identifier la nature du référentiel

Cherche les marqueurs :
- Si présence de "ELG-1", "ELG-2", ou "Critères d'éligibilité" → c'est un référentiel d'éligibilité.
- Si présence de "Q1", "Q2", "0 points :", "0 point :", "1 point :", ou patterns de barème numérique → c'est un référentiel de notation.
- Si les deux : confirme avec l'admin lequel régénérer (ou les deux successivement).

### Étape 3 - Parser les critères

Pour la **notation** (cas le plus fréquent) :
- Chaque question commence par un numéro (`1.`, `2.`, ...) ou explicite (`Q1`, `Q2`).
- Pour chaque question, capture :
  - **id** : Q1, Q2, ..., Q49 (ou ce qui est dans la source).
  - **libellé** : la première phrase qui suit le numéro.
  - **référence questionnaire** : phrase comme "Questions 4 et 11 - Présentation de l'organisation".
  - **guide d'interprétation** : tout le texte d'explication entre la question et le barème.
  - **barème** : lignes "0 points : ...", "1 point : ...", etc. Détecte le max (souvent 1, 2, 3 ou 4).
  - **type** : binaire (0 ou max) si seulement 2 valeurs, échelle 0-N sinon.
  - **hors-IA** : marqueur `[HORS IA]` ou `[HORS-IA]` ou `**[HORS IA]**` dans le libellé. Cherche aussi un fichier dédié si fourni séparément (ex. "Liste des questions de la notation non soumises à l IA.docx").

Pour l'**éligibilité** :
- Chaque critère ELG-X a un libellé, un guide, et un format binaire OUI / NON / AMBIGU / NON_TROUVE / SANS_OBJET.

### Étape 4 - Confirmation avec l'admin

Dans le chat, **avant d'écrire** :
```
J'ai lu le référentiel. Voici ce que j'ai identifié :
- Cible : campagne 'fae-8e' (statut: draft)
- Skill à régénérer : evaluer-notation.skill.md
- 49 questions trouvées (Q1 à Q49)
- 16 questions hors-IA détectées (Q15, Q16, Q18, Q23, Q24, Q26, Q27, Q33, Q38, Q39, Q40, Q42, Q43, Q47, Q48, Q49)
- Barème total max : 105 points

Je vais sauver l'ancienne version dans snapshots/regen-<ts>-evaluer-notation.skill.md.bak avant d'écrire la nouvelle. Confirmez-vous ?
```

Attends une réponse explicite "ok", "go", "oui", "confirme" avant d'écrire.

### Étape 5 - Écriture du skill

Génère le contenu du skill au **format actuel des skills OIF-Eval**. Garde la structure :

```markdown
---
name: evaluer-notation
campaign_id: <target_campaign_id>
version: "0.X.0"
description: <reprend la description existante en l'adaptant>
---

# Skill : Évaluation par notation

<Préambule général en 2-3 paragraphes>

## Bloc A - <nom du bloc, déduit du référentiel>

### Q1 - <libellé court>

**Type** : binaire (0 ou 4) | échelle 0-N
**Référence** : <ref questionnaire>
**Hors-IA** : oui | non

<Guide d'interprétation>

**Barème** :
- 0 points : ...
- 1 point : ...
- ...

### Q2 - ...
```

Reprends les conventions du skill existant (lis le contenu actuel via Read avant d'écrire pour respecter le style). Si la version précédente avait une intro spécifique ou des règles transversales (ex : "ne JAMAIS scorer les questions hors-IA"), conserve-les.

### Étape 6 - Sauvegarde

1. Backup : copie le skill actuel vers `<campagne>/snapshots/regen-<timestamp>-<skill-name>.bak` via Write.
2. Écris la nouvelle version dans `<campagne>/skills/<skill-name>` via Write.
3. Lis `<campagne>/manifest.json`, recalcule juste mentalement le hash (le serveur le fera au prochain accès via l'endpoint approprié) ou écris une ligne dans le manifest indiquant `regenerated_from: <referentiel_path>` et `regenerated_at: <ISO>`.

### Étape 7 - Confirmation

Dans le chat :
```
✓ evaluer-notation.skill.md régénéré pour fae-8e.
  - 49 questions, 16 hors-IA
  - Backup : snapshots/regen-2026-05-08T22-15-evaluer-notation.skill.md.bak
  - Différences notables vs version précédente : <résumer en 3-5 puces>

Vous pouvez ouvrir l'éditeur (Paramètres > Campagnes > Éditer les règles) pour vérifier ou ajuster manuellement.
```

## Cas particuliers

- **Référentiel partiel** (par ex. seulement le bloc B fourni) : régénère ce que tu peux, garde le reste tel quel dans le skill cible. Mentionne ce que tu as gardé inchangé.
- **Liste hors-IA fournie séparément** : si l'admin fournit aussi un fichier "Liste hors-IA.docx" avec les Q numériques, croise-la avec le questionnaire pour le marquage `[HORS IA]`.
- **Eligibilité ELG** : structure différente (binaire OUI/NON majoritairement), ne mélange pas avec notation.
- **Référentiel vide ou illisible** : refuse poliment et demande à l'admin de vérifier le fichier.

## Style des messages au chat

- Court et factuel.
- Confirme à chaque étape majeure (lecture, identification, écriture, fin).
- Pas d'em dash. Pas d'emoji autres que les marqueurs ✓ / ✗ / ⚠ pour la lisibilité.
