---
name: evaluer-notation
description: Évalue la phase 2 (notation) d'un dossier candidate FAE 7e édition déclaré ÉLIGIBLE. Applique la grille des 49 questions Q1 à Q49, avec 16 questions explicitement marquées "hors_ia" laissées à null pour la review humaine, et 33 questions évaluables par l'IA (score sur 67 max). Se déclenche après le skill evaluer-eligibilite ou via la slash command /evaluer.
version: "0.1.0-7e"
---

# Skill : Notation FAE 7e édition (49 questions)

Tu appliques la **grille de notation FAE 7e édition** sur un dossier déclaré éligible. La grille contient **49 questions**, dont **16 sont explicitement hors IA** (jugement humain requis) et **33 sont IA-évaluables**. Total maximum théorique : **105 points**, dont 67 IA + 38 humain.

## Principes (rappel CLAUDE.md)

- Tu cites systématiquement la source (numéro de question du formulaire, nom de fichier, page).
- Pour `NON_TROUVE` : score = 0 + signalement explicite. Tu ne devines jamais.
- Pour `AMBIGU` : score médian du barème ; si l'intention est clairement présente mais imprécisément formulée, accorder le score intermédiaire favorable.
- Pour `VERIFICATION_EXTERNE` : score provisoire + champ `verification_externe_requise`.
- Style télégraphique pour les justifications.

## Questions HORS IA (à laisser score=null, statut=HORS_IA)

**Liste complète des 16 questions hors IA :** Q15, Q16, Q18, Q23, Q24, Q26, Q27, Q33, Q38, Q39, Q40, Q42, Q43, Q47, Q48, Q49.

Pour ces questions : `score: null`, `statut: "HORS_IA"`, `justification: "Question réservée au membre de l'équipe humaine."`, `source: ""`. Tu **ne tentes pas** de les noter.

## Statuts pour les 33 questions IA-évaluables

- `EVALUE` : score attribué avec certitude.
- `NON_TROUVE` : info absente du dossier, score = 0, signalé.
- `AMBIGU` : info présente mais contradictoire, score retenu avec doute exprimé.
- `VERIFICATION_EXTERNE` : score provisoire, vérification externe à faire.

## Stratégie de lecture et checkpoint anti-compaction

**Ordre de lecture obligatoire** (respecter cette séquence) :

1. **`depot.xlsx`** via `mcp__office__read_xlsx` - formulaire de dépôt officiel avec tous les champs Q1-Q54 organisé en feuilles (Organisation, Projet). C'est la source principale pour la quasi-totalité des critères.
2. **Budget xlsx** (fichier `*budget*` ou `*previsionnel*`) via `mcp__office__read_xlsx` - nécessaire pour Q44-Q46.
3. **Rapport financier** - nécessaire pour Q4 (budget annuel organisation).
4. **PDFs de contexte** (Présentation-du-projet, Rapport d'activités, Présentation-de-lorganisation) - approfondissement Q5, Q7, Q10, Q31 uniquement.
5. **Pièces annexes** (organigramme, calendrier, récépissé) - en dernier, seulement si nécessaires.

**Checkpoint obligatoire après les étapes 1-3 :** Dès que tu as lu `depot.xlsx` + budget xlsx + rapport financier, écrire immédiatement un fichier `notation-partielle.json` avec toutes les questions déjà évaluables (Q1-Q14, Q17, Q19-Q22, Q25, Q28-Q37, Q41, Q44-Q46). Pour les questions dont la source est encore non lue, utiliser `statut: "NON_TROUVE"` provisoire. Ce checkpoint protège contre la compaction de contexte qui peut survenir pendant la lecture des PDFs.

**Relecture défensive :** Avant de rédiger la justification d'une question, si le passage pertinent n'est plus clairement accessible en mémoire (compaction possible), relire le fichier source concerné avant d'écrire.

## Processus de notation (obligatoire pour chaque question IA-évaluable)

Pour chaque question, dans cet ordre :

1. **CITATION** : cite le ou les passages exacts du dossier pertinents pour ce critère (nom de fichier + extrait textuel).
2. **ANALYSE** : explique pourquoi ces passages correspondent (ou non) aux paliers du barème.
3. **NOTE** : déduis la note. Elle doit découler directement des citations de l'étape 1.

Si aucun passage pertinent trouvé : statut `NON_TROUVE`, score 0. Ne jamais inférer un score à partir de l'absence de mention.

## Bloc A — Capacités et profil de l'organisation (Q1-Q7, max 19 pts)

### Q1 [0 ou 4 pts]
**Implantation locale.** L'organisation a-t-elle son siège social dans le pays de mise en œuvre ?
- 0 = non ; 4 = oui.
- **Sources.** Récépissé d'enregistrement (pays du siège), formulaire projet Q2 (pays de mise en œuvre).

### Q2 [0 ou 2 pts]
**Accréditation Francophonie.** L'organisation est-elle accréditée auprès de la COING et/ou membre du RF EFH et/ou du RIJF ?
- 0 = non ; 2 = oui.
- **Sources.** Formulaire organisation Q9 (déclaration), pièce d'accréditation si fournie (DOC-8). Marquer `verification_externe_requise: "Vérifier listes officielles COING / RF EFH / RIJF"` car les listes complètes ne sont pas embarquées dans le skill v0.

### Q3 [0 ou 2 pts] — barème inversé
**Lauréate édition précédente FAE.** L'organisation a-t-elle déjà été lauréate du Fonds ?
- 0 = oui (déjà lauréate) ; 2 = non (jamais lauréate).
- **Sources.** Formulaire organisation Q10. Marquer `verification_externe_requise: "Liste officielle lauréates FAE 2020-2024"`.

### Q4 [0 à 4 pts]
**Taille modeste.** Budget annuel de l'organisation en EUR.
- 0 si ≥ 100 000 € ; 1 si 55 001-99 999 € ; 2 si 30 001-55 000 € ; 3 si 20 001-30 000 € ; 4 si ≤ 20 000 €.
- **Sources.** Formulaire organisation Q18 + rapport financier annuel (cohérence à vérifier). Convertir en EUR si autre devise.

### Q5 [0 à 2 pts]
**Organisation de jeunes (15-34 ans).** Critères : (1) thématique jeunesse, (2) initiatives spécifiques jeunes, (3) participation des jeunes dans gouvernance.
- 0 = aucun critère ; 1 = un ou deux ; 2 = les trois.
- **Sources.** Rapport d'activités, formulaire organisation Q15/Q21.
- **Calibrage 6e (n=8): IA sous-note de -0.56 pts en moyenne.** Tendance : trop strict sur la définition de "jeunesse". Dès qu'**un seul critère sur 3** est trouvé (mention de "jeunes", de "15-34 ans", d'un projet jeunesse passé, ou d'un membre de gouvernance < 35 ans), mettre **1 pt minimum**. Ne pas exiger des preuves chiffrées d'âge pour reconnaître un critère.

### Q6 [0 à 2 pts]
**Organisation de femmes.** Critères : (1) thématique femmes & EFH, (2) initiatives spécifiques femmes, (3) gouvernance/participation féminine.
- 0 = aucun ; 1 = un ou deux ; 2 = les trois.
- **Sources.** Rapport d'activités, formulaire organisation Q15/Q16/Q21.
- **Calibrage 6e (n=8): IA sur-note de +0.44 pts.** Tendance : trop généreux dès qu'on parle de "femmes". Pour 2 pts, exiger les **3 critères concrètement documentés** (pas seulement mentionnés en passant). Pour 1 pt, exiger au moins 2 critères sur 3 (un seul ne suffit pas). Une mention vague "nous travaillons aussi avec des femmes" ne compte pas comme critère.

### Q7 [0 à 3 pts]
**Expérience FAE/EFH dans le pays/région.**
- 0 = aucun lien ; 1 = bonne connaissance OU mandat OU partenariats prévus ; 2 = expérience récente (< 2 ans) ; 3 = expérience plusieurs années (> 2 ans).
- **Sources.** Rapport d'activités, formulaire Q11/Q15/Q22, formulaire projet Q9/Q28.

## Bloc B — Présentation du projet (Q8-Q49, max 86 pts)

### Q8 [0 ou 3 pts]
**Pays prioritaire.** Le projet est-il mis en œuvre dans : Cameroun, République centrafricaine, RDC, Haïti, Liban, Burundi, Tchad, Comores, République du Congo, Guinée Bissau, Sao Tomé-et-Principe ?
- 0 = non ; 3 = oui.
- **Sources.** Formulaire projet Q2.

### Q9 [0 à 2 pts]
**Régions rurales/montagneuses/côtières/arides.**
- 0 = urbain seul ; 1 = couverture partielle ; 2 = entièrement dans ces zones.
- **Sources.** Formulaire projet Q3 (localités).

### Q10 [0 à 3 pts]
**Contexte et état des lieux des besoins.** Clair, détaillé, chiffré, basé sur consultation des femmes/filles ?
- 0 = besoins non présentés ; 1 = brièvement ; 2 = détaillés (rapports/études/données chiffrées) ; 3 = analyse détaillée + consultation des femmes/filles.
- **Sources.** Formulaire projet Q8.
- **Calibrage 6e (n=8): IA sur-note systématiquement de +0.81 pts (3.0 vs 1.94 humain).** Critères stricts à appliquer :
  - **0 pt** : pas de présentation des besoins ou seulement une description générale du pays.
  - **1 pt** : besoins évoqués sans données chiffrées ni sources, juste descriptifs.
  - **2 pts** : besoins documentés avec **au moins 1 source citée** (INSEE, ONU, étude académique, rapport ONG) ET au moins 1 chiffre concret (pourcentage, effectif).
  - **3 pts** : tout ce qui est requis pour 2 pts + **consultation directe des femmes/filles bénéficiaires** explicitement mentionnée (interviews, focus groups, ateliers participatifs avec dates ou nombre de participantes).
- **Important.** Ne mettre 3 pts QUE si la consultation directe des bénéficiaires est documentée avec preuves (date, nombre, méthode). Sinon plafonner à 2 pts. La majorité des dossiers tombent à 1 ou 2, rarement 3.

### Q11 [0 ou 1 pt]
**OSC partenaires impliquées.**
- 0 = non ; 1 = oui.
- **Sources.** Formulaire projet Q9.

### Q12 [0 à 2 pts]
**Rôle des OSC partenaires bien défini.**
- 0 = pas d'OSC ou rôle non défini ; 1 = brièvement défini ; 2 = bien défini (responsabilités précises).
- **Sources.** Formulaire projet Q10.

### Q13 [0 ou 1 pt]
**Pouvoirs publics locaux impliqués.**
- 0 = non ; 1 = oui.
- **Sources.** Formulaire projet Q11.

### Q14 [0 à 2 pts]
**Rôle des pouvoirs publics bien défini.**
- 0 = aucun ou non défini ; 1 = brièvement ; 2 = bien défini.
- **Sources.** Formulaire projet Q12.

### Q15 [HORS IA] — barème 0-3
Description claire du projet et réponse aux besoins. **Réservée au membre de l'équipe humaine.**

### Q16 [HORS IA] — barème 0-3
Spécificité de la thématique à la région. **Réservée au membre de l'équipe humaine.**

### Q17 [0 à 3 pts]
**Bénéficiaires majoritairement femmes intersectionnelles.**
- 0 = pas aux femmes ; 1 = femmes + autres ; 2 = majoritairement femmes (sans intersectionnalité explicite) ; 3 = majoritairement femmes intersectionnelles (jeunes, âgées, migrantes, déplacées, filles-mères, mères célibataires, VIH, situation rue, handicap, minorités sexuelles/genre).
- **Sources.** Formulaire projet Q18 (catégories) + Q19 (nombres).

### Q18 [HORS IA] — barème 0-2
Bénéficiaires directs reflètent groupe cible de l'état des lieux. **Réservée au membre de l'équipe humaine.**

### Q19 [0 ou 1 pt]
**Moyens d'identification des bénéficiaires précis.**
- 0 = vague/inadapté ; 1 = précis et pertinents.
- **Sources.** Formulaire projet Q20.

### Q20 [0 ou 1 pt]
**Stratégie de mobilisation complète et adaptée.**
- 0 = aucune ou générique ; 1 = complète, proactive, adaptée.
- **Sources.** Formulaire projet Q21.

### Q21 [0 à 2 pts]
**Cohérence résultat / objectif global.**
- 0 = non cohérent ; 1 = partiellement ; 2 = cohérent.
- **Sources.** Formulaire projet Q25 (objectif global) et Q26 (résultat attendu).

### Q22 [0 à 2 pts]
**Objectifs répondent à la problématique état des lieux.**
- 0 = ne correspondent pas / générique ; 1 = en partie ; 2 = pleinement.
- **Sources.** Formulaire projet Q8 + Q25 + Q27.

### Q23 [HORS IA] — barème 0-3
Insertion durable dans l'emploi des femmes. **Réservée au membre de l'équipe humaine.**

### Q24 [HORS IA] — barème 0-2
Résultats permettent l'atteinte des objectifs et sont mesurables. **Réservée au membre de l'équipe humaine.**

### Q25 [0 ou 1 pt]
**Besoins des jeunes (15-34) pris en compte.**
- 0 = non ; 1 = oui.
- **Sources.** Formulaire projet Q8/Q18/Q19/Q31.

### Q26 [HORS IA] — barème 0-2
Activités précises, réalisables, atteignent résultats. **Réservée au membre de l'équipe humaine.**

### Q27 [HORS IA] — barème 0-3
Théorie du changement claire. **Réservée au membre de l'équipe humaine.**

### Q28 [0 à 2 pts]
**Usage des technologies numériques.** Critères : (1) communication digitale par bénéficiaires, (2) compétences numériques, (3) activités numériques.
- 0 = aucun ; 1 = un ; 2 = deux ou trois.
- **Sources.** Formulaire projet Q31 + Q32.
- **Calibrage 6e (n=8): IA sur-note de +0.50 pts.** Tendance : trop généreux dès qu'on mentionne "WhatsApp" ou "réseaux sociaux". Pour qu'un critère compte :
  - Critère 1 (communication digitale) : il faut une **stratégie documentée** (liste de canaux, fréquence, audience visée), pas juste "on utilise Facebook".
  - Critère 2 (compétences numériques) : **formation technique** explicite (pas juste sensibilisation).
  - Critère 3 (activités numériques) : produit ou service numérique **livrable** (app, plateforme, contenu en ligne), pas juste "diffusion par mail".
- Si un seul critère mentionné de manière vague, mettre 0. Si un seul critère vraiment documenté, mettre 1.

### Q29 [0 à 2 pts]
**Lutte contre changement climatique.**
- 0 = pas du tout ; 1 = partiellement ; 2 = clairement et pleinement.
- **Sources.** Formulaire projet Q31 + Q33.
- **Calibrage 6e (n=8): IA sous-note de -0.50 pts.** Tendance : trop strict, exige une mention explicite "changement climatique". Or les humains comptent aussi :
  - Agriculture durable / agroécologie (compte pour 1 pt minimum).
  - Économie verte / circulaire / bleue (1 pt).
  - Reforestation / gestion des déchets / énergies renouvelables (1 pt).
  - Mention de "résilience climatique" ou "adaptation aux dérèglements" (compte pleinement = 2 pts).
- **Décision** :
  - 0 pt : aucune mention environnementale du tout.
  - 1 pt : présence d'au moins 1 thématique parmi celles ci-dessus, même implicite.
  - 2 pts : mention explicite "changement climatique" + activités structurées autour de ce thème.

### Q30 [0 ou 1 pt]
**Mesures pour adhésion entourage masculin.**
- 0 = non ou générique ; 1 = oui.
- **Sources.** Formulaire projet Q34.

### Q31 [0 à 3 pts]
**Obstacles à la participation des femmes pris en compte.**
- 0 = aucun obstacle mentionné/générique ; 1 = évoqués, peu concret ; 2 = identifiés, mesures incomplètes ; 3 = clairement identifiés + mesures adaptées.
- **Sources.** Formulaire projet Q35.

### Q32 [0 ou 1 pt]
**Activités pour changement de mentalités EFH (vers hommes/communautés).**
- 0 = non ; 1 = oui.
- **Sources.** Formulaire projet Q36.

### Q33 [HORS IA] — barème 0-3
Actions et mécanismes de suivi. **Réservée au membre de l'équipe humaine.**

### Q34 [0 ou 1 pt]
**Usage français + valorisation langues locales.**
- 0 = non ; 1 = oui.
- **Sources.** Formulaire projet Q39.

### Q35 [0 à 2 pts]
**Visibilité de l'organisation porteuse.**
- 0 = pas d'actions ; 1 = partiel ; 2 = pleinement promue.
- **Sources.** Formulaire projet Q40.

### Q36 [0 à 2 pts]
**Visibilité du soutien de l'OIF.**
- 0 = pas d'actions ; 1 = partiel ; 2 = pleinement valorisé + présentation OIF prévue au démarrage.
- **Sources.** Formulaire projet Q41 + Q42.

### Q37 [0 ou 1 pt]
**Présentation OIF dans la communication.**
- 0 = non ; 1 = oui.
- **Sources.** Formulaire projet Q42.

### Q38 [HORS IA] — barème 0-3
Réalisable et viable. **Réservée au membre de l'équipe humaine.**

### Q39 [HORS IA] — barème 0-3
Stratégie de pérennisation. **Réservée au membre de l'équipe humaine.**

### Q40 [HORS IA] — barème 0-2
Indicateurs cohérents/pertinents/réalisables. **Réservée au membre de l'équipe humaine.**

### Q41 [0 ou 1 pt]
**Risques identifiés + mesures préventives.**
- 0 = non ; 1 = oui.
- **Sources.** Formulaire projet Q54.

### Q42 [HORS IA] — barème 0-3
Calendrier cohérent et détaillé. **Réservée au membre de l'équipe humaine.**

### Q43 [HORS IA] — barème 0-2
Budget suffisamment détaillé. **Réservée au membre de l'équipe humaine.**

### Q44 [0 ou 1 pt]
**Frais de fonctionnement ≤ 20 % du budget total.** Calcul automatique à partir du budget xlsx.
- 0 = > 20 % ; 1 = ≤ 20 %.
- **Sources.** Budget prévisionnel xlsx, ligne "Total I (Frais de fonctionnement)".
- **Méthode.** Lire `Total I` et `Total dépenses`, calculer le ratio.

### Q45 [0 à 2 pts]
**Ligne communication 5-7 % du budget.**
- 0 = inexistante ; 1 = 1-5 % ; 2 = 5-7 %.
- **Sources.** Budget prévisionnel xlsx (ligne dédiée communication/visibilité).

### Q46 [0 à 2 pts]
**Ligne suivi-accompagnement 10-12 % du budget.**
- 0 = < 5 % ; 1 = 5-10 % ; 2 = 10-12 %.
- **Sources.** Budget prévisionnel xlsx (ligne IV. Suivi et accompagnement).

### Q47 [HORS IA] — barème 0-2
Lignes budgétaires cohérentes/réalistes/détaillées vs activités. **Réservée au membre de l'équipe humaine.**

### Q48 [HORS IA] — barème 0-2
Ratio coût/bénéficiaire raisonnable. **Réservée au membre de l'équipe humaine.**

### Q49 [HORS IA] — barème 0-3
Coup de cœur. **Réservée au membre de l'équipe humaine.**

## Calcul du score

- `score_total_ia` = somme des `score` des 33 questions IA-évaluables (Q1-14, Q17, Q19-22, Q25, Q28-32, Q34-37, Q41, Q44-46). Les questions HORS_IA sont exclues du total IA.
- `score_max_ia` = 64. `score_max_total` = 105.
- Le `review.score_final_total` sera calculé par l'UI après que le membre de l'équipe ait rempli les 16 questions hors IA.

## Synthèse finale

Tu produis un objet `synthese` avec :
- `points_forts` : 2-3 éléments concrets tirés du dossier (style télégraphique).
- `points_vigilance` : 2-3 éléments concrets ou informations manquantes.
- `verifications_externes` : liste des points à confirmer hors dossier (lauréates FAE, COING/RF EFH, taux BCE, etc.).

Pas de champ "recommandation" : la recommandation finale est portée par le membre de l'équipe humaine après review.

## Format de sortie

Tu produis l'objet `phase_notation` conforme au schéma, avec un tableau `questions` de 49 entrées dans l'ordre Q1 à Q49. Exemple :

```json
{
  "phase_notation": {
    "questions": [
      {
        "id": 1, "intitule": "Implantation locale", "bareme_max": 4, "score": 4, "statut": "EVALUE",
        "source": { "file": "recepisse.pdf", "page": 1, "quote": "siège social : Kinshasa, RDC" },
        "justification": "Siège social et mise en œuvre dans le même pays.", "hors_ia": false
      },
      ...
      {
        "id": 15, "intitule": "Description claire du projet", "bareme_max": 3, "score": null, "statut": "HORS_IA",
        "source": { "file": "", "quote": "" },
        "justification": "Question réservée au membre de l'équipe humaine.", "hors_ia": true
      },
      ...
    ],
    "score_total_ia": 47,
    "score_max_ia": 64,
    "score_max_total": 105
  }
}
```

## Format du champ `source` (NOUVEAU)

Le champ `source` est désormais un **objet structuré** :

```json
"source": {
  "file": "budget-previsionnel.xlsx",   // OBLIGATOIRE : nom exact du fichier
  "page": 3,                             // optionnel : page PDF 1-based
  "sheet": "Budget",                     // optionnel : feuille xlsx (utilise mcp__office__read_xlsx pour la connaître)
  "cell": "B12",                         // optionnel : cellule xlsx précise
  "section": "Q5",                       // optionnel : section/question du formulaire
  "quote": "Total I = 16 375 000 FCFA"   // RECOMMANDÉ : citation 5-20 mots
}
```

Pour `HORS_IA` : `source: {"file": "", "quote": ""}`.

Pour `NON_TROUVE` : `source: {"file": "", "quote": "Information absente du dossier"}`.

**N'utilise JAMAIS le format string** type `"source": "recepisse.pdf p.1"`. Toujours un objet structuré.
