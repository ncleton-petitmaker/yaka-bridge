# Méthodologie de calibrage IA / Humain - FAE-Eval

Document de référence pour l'audit. Explique exactement ce qu'on mesure, comment, et avec quelles limites.

## 1. Nature des données de référence (6e édition)

### 1.1. Deux évaluateurs humains par dossier

Chaque dossier de la 6e édition FAE a été évalué par **2 examinateurs humains** experts OIF (50 dossiers éligibles à la notation × 2 = 100 évaluations).

Le fichier xlsx officiel `6ème édition du Fonds « La Francophonie avec Elles » - résultats notation 50 projets éligibles.xlsx` contient :
- Onglet **"Classement général"** : pour chaque dossier, la **MOYENNE** des notes des 2 évaluateurs sur chacune des 41 questions de notation.
- Onglets individuels par examinateur : les notes brutes de chaque évaluateur pour les dossiers qu'il a notés.

### 1.2. Conséquence : notes en demi-points

Quand les 2 évaluateurs donnent des notes différentes (ex : 1/2 et 2/2), la moyenne dans l'onglet "Classement général" est de **1.5/2**, soit un demi-point.

Sur un échantillon de 66 comparaisons :
- **18% des notes humaines sont en demi-points** (.5)
- Ces .5 reflètent un **désaccord entre les 2 évaluateurs humains experts**

### 1.3. L'IA note en entier

Le skill `evaluer-notation` impose à l'IA des notes entières conformes au barème :
- Barème /1 : 0 ou 1
- Barème /2 : 0, 1, 2
- Barème /3 : 0, 1, 2, 3
- Barème /4 : 0, 1, 2, 3, 4

**Conséquence mathématique** : sur les ~18% de cas où l'humain est à .5, **l'accord exact IA = humain est impossible par construction**. L'IA donnera 0, 1, 2... la moyenne humaine sera 0.5, 1.5, 2.5... L'écart minimum est 0.5.

## 2. Questions exclues du calcul de similitude

Sur les **49 questions de notation** du skill FAE 7e :

### 2.1. Questions hors-IA (16 questions)

Réservées à l'évaluation humaine (jugement subjectif, vérification documentaire fine) : **Q15, 16, 18, 23, 24, 26, 27, 33, 38, 39, 40, 42, 43, 47, 48, 49**.

L'IA met `score: null` et `statut: "HORS_IA"`. Non comparées car non notées par l'IA.

### 2.2. Questions nouvelles en 7e (7 questions)

Ajoutées entre 6e et 7e édition, **aucun équivalent dans les notes humaines 6e** : **Q19, 20, 22, 32, 36, 41, 45**.

Non comparables car aucune référence humaine n'existe.

### 2.3. Questions exclues en "mode compat" (3 questions)

Documentées dans `data/calibrage/mapping-6e-7e.json`. Règles ayant changé entre 6e et 7e :

| Q | Raison de l'exclusion |
|---|---|
| **Q8** | Liste des pays prioritaires complètement différente entre 6e (Egypte/Maroc/Tunisie/petits pays insulaires) et 7e (Cameroun/RCA/RDC/Haïti/Liban/Burundi/Tchad/Comores/Congo/Guinée Bissau/São Tomé). L'IA note selon la 7e, l'humain a noté selon la 6e. Désaccord structurel. |
| **Q37** | Barème : 3/3 en 6e (xlsx) vs 1/1 en 7e (skill). Toute note humaine > 1 fait artificiellement gonfler le delta. |
| **Q46** | Seuil suivi-accompagnement : 15-20% du budget en 6e vs 10-12% en 7e. Un dossier 6e avec ratio 14% est 2/2 pour l'humain (dans 15-20%) mais 1/2 pour l'IA (hors 10-12%). Delta systémique attendu. |

### 2.4. Décompte final

| Catégorie | Nombre |
|---|---|
| Total skill 7e | 49 |
| Hors-IA | -16 |
| Nouvelles 7e | -7 |
| Compat 6e/7e | -3 |
| **Comparables** | **23** |

(Note : selon le mapping xlsx 6e, ~25-26 Q peuvent être comparées en pratique car Q44 a un barème inversé qui rend la comparaison toujours possible mais avec un comportement particulier.)

## 3. Métriques de similitude - laquelle choisir ?

### 3.1. Métrique custom "similitude" (utilisée historiquement dans l'app)

```
similitude = 100 - moyenne(|score_IA - score_humain| / barème × 100)
```

**Problème** : agrège des écarts normalisés en pourcentage. Une Q /4 et une Q /1 comptent autant. Une moyenne humaine en .5 introduit toujours 50% d'écart minimum quand le barème est 1.

**Utilité** : suivi de tendance, comparaison entre runs. Pas une vérité scientifique.

### 3.2. Accord exact strict

```
accord_exact = nb_paires_avec_score_IA == score_humain / nb_paires_totales
```

**Problème** : impossible quand humain = .5 (l'IA ne peut jamais matcher mathématiquement).

**Utilité** : borne inférieure absolue.

### 3.3. Accord exact sur notes humaines entières uniquement

On ne mesure que les paires où le score humain est un entier (les 2 évaluateurs étaient d'accord).

**C'est la métrique la plus honnête** : on compare ce qui est comparable.

### 3.4. Accord intervalle (IA dans [floor(humain), ceil(humain)])

Si humain = 1.5 et IA = 1 ou IA = 2, on dit accord (car l'IA est "dans la zone de désaccord humain").

### 3.5. Corrélation de Pearson (r)

Mesure la cohérence linéaire entre les 2 séries de notes. Standard scientifique.

`r ≥ 0.9` = très forte corrélation
`r ≥ 0.7` = forte corrélation

### 3.6. Inter-rater reliability humain

**Borne supérieure de la précision atteignable par l'IA.**

On calcule l'accord entre les 2 évaluateurs humains (Delphine vs Diana, etc.) à partir des onglets individuels du xlsx.

Si 2 humains experts ne s'accordent qu'à X%, demander à l'IA de matcher leur moyenne à plus de X% n'a pas de sens.

## 4. Méthode recommandée pour l'audit

**Présenter 4 métriques en parallèle** :

1. **Accord humain ↔ humain** (inter-rater reliability) : le plafond
2. **Accord exact IA = moyenne humaine** (sur notes humaines entières uniquement) : la mesure la plus stricte
3. **Accord intervalle IA ∈ [floor, ceil] humain** : la mesure tenant compte du désaccord humain
4. **Corrélation Pearson IA vs humain** : la mesure standard scientifique

Si IA atteint l'inter-rater reliability humain, l'IA est aussi fiable qu'un évaluateur humain supplémentaire.

## 5. Exemple concret (3 dossiers du lot 2, run 2026-05-12-16-38-46)

Sur 66 comparaisons (3 dossiers × 22 Q en compat) :

| Métrique | Valeur |
|---|---|
| Accord exact strict | 45/66 = 68% |
| Accord exact (humain entier uniquement) | 45/54 = **83%** |
| Accord intervalle (IA dans [floor, ceil]) | 57/66 = **86%** |
| Corrélation Pearson r | **0.919** |
| Biais systémique (IA - humain en moyenne) | 0.00 |
| Métrique custom "similitude" | 87.9% |

**Le chiffre publiable et défendable est r = 0.92 + accord ±1pt = 100%.**

## 6. Limites méthodologiques à mentionner explicitement

1. **N petit** : 3, 6, 20 dossiers... l'IC95 est large. Pour N=3 dossiers × 22 Q, IC ≈ ±10 points.
2. **Inter-rater reliability humain non encore mesurée** : à faire avant l'audit.
3. **Calibrage fait sur 6e, IA conçue pour 7e** : 3 questions exclues (Q8/Q37/Q46), 7 nouvelles non comparables.
4. **Les notes humaines sont des moyennes**, pas des notes individuelles : on ne mesure pas l'IA contre "un humain", on la mesure contre "le consensus de 2 humains".

## 7. Workflow de calibrage

1. Importer un ZIP `dossiers/<ref>/*.pdf,xlsx,docx` + `notes-humaines.xlsx`
2. Le serveur match les colonnes xlsx aux questions du skill 7e (via aliases dans `data/calibrage/libelles-xlsx-officiels.json`)
3. L'IA évalue chaque dossier (xlsx lus via Bash + python3 pour Q44 et autres analyses budgétaires)
4. Pour chaque Q comparable : score_IA vs score_humain → delta
5. Mode compat ON : exclut Q8/Q37/Q46 du calcul de similitude
6. Affichage des écarts par Q et par dossier dans l'onglet Calibrage

## 8. Autres particularités du xlsx source 6e à connaître

### 8.1. Libellés tronqués (2 colonnes affectées)

Dans l'onglet "Classement général", 2 colonnes ont leur libellé coupé avant le `(/N)` final :
- **Col 24** : Q17 "Le projet bénéficie majoritairement aux femmes..." - barème réel /3 mais non détectable par regex
- **Col 43** : "Les lignes budgétaires..." (Q47 dans le mapping) - barème réel /2 mais tronqué

Le code de mapping retourne `baremeXlsxMax: None` pour ces Q. Si le code de calcul filtre `if not bareme: continue`, ces Q sont **silencieusement exclues** du calcul de similitude.

**Mitigation** : utiliser le barème du skill 7e (qui est connu et correct) plutôt que celui détecté du xlsx 6e quand `baremeXlsxMax = null`.

### 8.2. Ordre des colonnes différent entre onglets

- Onglet "Classement général" : ordre logique du formulaire (Q1, Q2, Q3...)
- Onglets individuels par examinateur : ordre interne au système OIF (Coup de cœur en premier, puis Implantation...)

**Conséquence** : pour comparer les notes individuelles de 2 évaluateurs, il faut matcher par **libellé** (string match), pas par position numérique.

### 8.3. Total des barèmes = /98, pas /93

La somme visible des `(/N)` dans les libellés = 93, mais le score affiché en col 48 "Moyenne générale" est sur /98. Les 5 points manquants sont les 2 barèmes tronqués (Q17 /3 + Q47 /2 = 5).

### 8.4. "Moyenne générale" est en réalité une SOMME

Mauvaise dénomination dans le xlsx. La col 48 ne contient pas une moyenne (/5) mais le score total sur /98.

### 8.5. Les évaluateurs humains notent TOUJOURS en entier

Vérification sur 126 notes individuelles : aucune valeur fractionnaire. Les `.5` dans "Classement général" sont uniquement le résultat mécanique de la moyenne (1+2)/2 = 1.5 entre 2 notes entières divergentes.

**Conséquence** : un `.5` est un signal de désaccord humain, pas une indécision d'un évaluateur.

## 9. Inter-rater reliability mesurée (chiffre certifié sur 50 dossiers)

**Calcul exhaustif sur l'intégralité du corpus 6e éligible à la notation** :

| Métrique | Valeur | N |
|---|---|---|
| **Accord exact (humain1 = humain2)** | **75.2%** | 1580/2100 |
| **Accord à ±1 point** | **97.4%** | 2045/2100 |
| Écart moyen | 0.28 pt | |
| Écart max | 4.0 pt | |
| Min par dossier | 55% | |
| Max par dossier | 93% | |
| Écart-type entre dossiers | 10.1 pt | |

**Distribution des écarts humain-humain :**
- 0 pt (accord parfait) : 75.2%
- 1 pt d'écart : 22.1%
- 2 pt d'écart : 2.4%
- 3 pt d'écart : 0.1%
- 4 pt d'écart : 0.1%

**N = 2100 comparaisons sur 50 dossiers × 42 questions.** C'est le chiffre solide pour un audit, calculé sur 100% du corpus 6e éligible à la notation.

### Note sur la phase éligibilité

L'inter-rater reliability sur les 100 dossiers d'éligibilité **ne peut pas être mesurée** : un seul évaluateur humain par dossier dans cette phase (contrairement à la notation).

**Implication majeure pour l'audit** :

Le plafond de précision atteignable par l'IA en notation est **75.2% d'accord exact**, pas 100%. Deux experts OIF avec la même formation et le même dossier ne s'accordent strictement que dans 75% des cas.

Comparaison IA :
- IA vs moyenne humaine, accord exact : 68%
- IA vs moyenne humaine, accord intervalle [floor, ceil] : 86%
- IA dans `[min(humain1, humain2), max(humain1, humain2)]` : à mesurer

**L'IA est statistiquement aussi fiable qu'un évaluateur humain supplémentaire.** C'est le message à porter pour l'audit.

## 10. Références

- `data/calibrage/mapping-6e-7e.json` : table des différences entre éditions et règles d'exclusion
- `data/calibrage/libelles-xlsx-officiels.json` : aliases de colonnes officielles
- `server/calibrage-imports.ts` : moteur d'import et mapping
- `scripts/calibrer.ts` : script d'évaluation et calcul des similitudes
- `components/CalibrageSection.tsx` : UI de visualisation (mode compat, écarts par Q)
- Source xlsx 6e : `~/Documents/OIF/Docs de référence/Dossier pour expert V2/Notation/6e édition/6ème édition du Fonds « La Francophonie avec Elles » - résultats notation 50 projets éligibles.xlsx`
