---
name: evaluer-eligibilite
description: Évalue la phase 1 (éligibilité) d'un dossier candidate FAE 7e édition. Applique la grille des 14 critères ELG-1 à ELG-14, identifie les motifs de rejet REJ-1 à REJ-15 déclenchés, et produit un verdict (ELIGIBLE / INELIGIBLE / ELIGIBILITE_INCERTAINE) avec sources citées dans le dossier. Se déclenche quand l'utilisateur demande "évalue l'éligibilité du dossier X" ou via la slash command /evaluer.
version: "0.1.0-7e"
---

# Skill : Évaluation éligibilité FAE 7e édition

Tu appliques la **grille des 14 critères d'éligibilité du Fonds "La Francophonie avec Elles" 7e édition** sur un dossier candidate de `candidatures-7e/<id>/`.

## Principes (rappel CLAUDE.md)

- Ton évaluation repose **exclusivement** sur les éléments fournis dans le dossier.
- Tu **n'inventes ni n'extrapoles** aucune information absente.
- Tu **cites systématiquement** la source dans le dossier (nom de fichier + section/page/numéro de question).
- Tu exprimes le doute via le statut `AMBIGU` plutôt que de trancher arbitrairement.
- Tu produis la **grille complète des 14 critères**, même si un critère bloquant échoue.

## Référentiel temporel (7e édition, mai 2026)

- Date de lancement de l'appel : **26 février 2026** (référence pour ancienneté ≥ 2 ans).
- Date limite de soumission : **26 avril 2026 23h59 (heure de Paris)**.
- États membres OIF de plein droit : **53** (vs 56 en 6e édition).

## Statuts possibles

| Statut | Quand l'utiliser |
|---|---|
| `OUI` | Le critère est clairement satisfait. |
| `NON` | Le critère n'est clairement pas satisfait. |
| `NON_TROUVE` | L'information nécessaire est absente du dossier. |
| `AMBIGU` | Information présente mais contradictoire/insuffisamment claire. |
| `SANS_OBJET` | Critère non applicable (cas particulier, ex. ELG-5). |

Pour les vérifications externes (liste lauréates FAE 2020-2024, taux de change BCE), renseigner aussi le champ `verification_externe_requise` avec la nature précise.

## Lecture des fichiers du dossier

**Ordre de lecture pour l'éligibilité** :

1. **`depot.xlsx`** via `mcp__office__read_xlsx` - formulaire de dépôt officiel avec tous les champs Q1-Q54. Source principale pour ELG-1, ELG-2, ELG-10, ELG-11, ELG-12, ELG-13, ELG-14.
2. **Récépissé de reconnaissance légale** (PDF) - ELG-2, ELG-3.
3. **Rapport financier** xlsx ou PDF - ELG-4, ELG-6.
4. **Rapport d'activités** PDF - ELG-5, ELG-7, ELG-8, ELG-9, ELG-10.
5. **Budget prévisionnel xlsx** via `mcp__office__read_xlsx` - ELG-14 (cohérence montant).
6. **PV AG / organigramme / statuts** - ELG-7, ELG-8, ELG-9 seulement si absent des rapports.

**Relecture défensive.** Avant de statuer sur un critère, si le passage n'est plus clairement en mémoire, relire le fichier source.

## Grille des 14 critères ELG-1 à ELG-14

### ELG-1 — Nature de l'organisation
**Règle.** Le porteur est une **OSC à but non lucratif**. Catégories acceptées : ONG, fondations, associations à but humanitaire, GIE (groupements d'intérêt économique), coopératives.
**Inéligibles.** Personnes physiques, entreprises, universités (publiques ou privées), collectivités territoriales, entités religieuses ou partisanes.
**Sources.** Récépissé de reconnaissance légale, statuts si fournis, formulaire Présentation-Organisation Q12.
**Si NON déclenche : REJ-1.**

### ELG-2 — Reconnaissance légale dans un État membre OIF
**Règle.** L'organisation est légalement enregistrée et reconnue par les autorités compétentes d'un des **53 États ou gouvernements membres de plein droit de l'OIF**.
**Sources.** Récépissé de reconnaissance légale (DOC-1) ; pays du siège dans le formulaire Q4.
**Pièges.** Une simple attestation de demande de récépissé ou les statuts seuls ne tiennent **pas** lieu de récépissé valide. À signaler `NON` avec REJ-13.
**Si pays hors espace OIF déclenche : REJ-3.**

### ELG-3 — Ancienneté ≥ 2 ans à la date du 26/02/2026
**Règle.** L'organisation justifie d'au moins **2 années d'existence légale** à la date de lancement de l'appel (26/02/2026). Le premier enregistrement doit donc être antérieur au **26 février 2024**.
**Sources.** Date de création sur le récépissé.
**Si NON déclenche : REJ-2.**

### ELG-4 — Capacités budgétaires cohérentes
**Règle.** L'organisation dispose des capacités financières équivalentes au montant de la subvention sollicitée. Règle indicative : pour un projet de 36 mois, **subvention sollicitée ≤ 1,5 × budget annuel** de l'OSC, dans la limite de 100 000 €.
**Méthode de calcul.** Lire le budget annuel sur le rapport financier (DOC-5). Si rapport en devise autre que EUR, convertir au taux **BCE** à la date de clôture de l'exercice. Indiquer dans la justification : devise d'origine, montant en devise, taux appliqué, date de référence du taux, montant en EUR.
**Si conversion impossible avec certitude.** Statut `AMBIGU` + `verification_externe_requise: "Conversion BCE à la date de clôture de l'exercice"`.

### ELG-5 — Rapport d'activités 2025 (à défaut 2024) approuvé
**Règle.** L'OSC dispose d'un rapport d'activités 2025 (à défaut 2024) approuvé par l'AG ou tout organe de gouvernance.
**Sources.** DOC-2 = `rapport-activites-*.pdf` (ou équivalent). Vérifier la **signature/approbation** et l'**année couverte**.
**Refusé.** Rapports d'exécution de projets isolés, rapports antérieurs à N-2.

### ELG-6 — Rapport financier 2025 (à défaut 2024) approuvé
**Règle.** L'OSC dispose d'un rapport financier 2025 (à défaut 2024) approuvé par l'AG ou tout organe de gouvernance, audité de préférence ou signé/approuvé par le bureau administratif.
**Cohérence.** Doit couvrir la même année que ELG-5.
**Refusé.** Rapports financiers de projet isolé, antérieurs à N-2.

### ELG-7 — PV de l'Assemblée générale
**Règle.** Le dossier atteste qu'une AG s'est tenue (PV fourni OU mention claire dans le rapport d'activités/financier).
**Sources prioritaires.** DOC-4 = PV de l'AG si fourni en pièce dédiée.
**Sources de repli (calibrage 6e: 11/12 NON_TROUVE par l'IA, alors que humains mettaient OUI).** Si pas de PV dédié, chercher dans le rapport d'activités OU le rapport financier OU les statuts les éléments suivants :
- Mention explicite "Assemblée générale du JJ/MM/AAAA" ou équivalent.
- Liste des décisions prises par l'AG (approbation des comptes, élection du bureau, etc.).
- Signatures du président + secrétaire avec mention "réunion de l'AG".
**Décision.**
- **OUI** : pièce PV dédiée OU mention claire d'une AG datée + au moins 1 décision dans le rapport.
- **AMBIGU** : mention vague d'une AG sans date ni décisions précises (ex: "l'AG se réunit annuellement" sans détail).
- **NON_TROUVE** : aucune mention d'AG dans aucune pièce.
**Important.** Ne pas mettre `NON_TROUVE` par défaut juste parce qu'il n'y a pas de fichier nommé "PV". Les associations modestes intègrent souvent ces infos dans le rapport d'activités.

### ELG-8 — Organigramme et CA
**Règle.** Le dossier atteste l'existence et la composition d'un organe de gouvernance (CA, bureau, comité de direction).
**Sources prioritaires.** DOC-3 (organigramme dédié) ou questionnaire Q21 (composition du CA).
**Sources de repli (calibrage 6e: 4/12 NON_TROUVE/AMBIGU alors que humains mettaient OUI).** Si pas d'organigramme dédié, chercher dans :
- Rapport d'activités : section "Gouvernance", "Équipe", "Organes statutaires".
- Statuts : articles définissant le CA / bureau.
- Rapport financier : signatures (président, trésorier, etc.) qui révèlent la composition.
**Décision.**
- **OUI** : organigramme dédié OU au moins 3 noms avec leurs fonctions (président, trésorier, secrétaire, etc.) trouvés dans une des sources.
- **AMBIGU** : mention de "CA" / "bureau" sans noms précis ni fonctions.
- **NON_TROUVE** : aucune mention d'organe de gouvernance dans aucune pièce.
**Important.** Ne pas mettre `NON_TROUVE` par défaut juste parce qu'il n'y a pas de fichier nommé "organigramme".

### ELG-9 — Gouvernance fonctionnelle et transparente
**Règle.** Les documents administratifs font état d'une gouvernance fonctionnelle, transparente, démocratique.
**Critères concrets (calibrage 6e: 4/12 désaccord, IA trop souvent AMBIGU).** Évaluer 3 indices :
1. **Réunions régulières** mentionnées (AG annuelle, CA trimestriel, réunions d'équipe...).
2. **Reddition de comptes** : rapport financier signé par plusieurs organes (bureau, CA), traçabilité des dépenses.
3. **Démocratie interne** : élection du bureau, présence de membres actifs, statuts respectés.
**Décision.**
- **OUI** : au moins **2/3** indices présents et documentés.
- **AMBIGU** : 1/3 indice seulement, ou indices présents mais sans détails (dates, noms, montants).
- **NON** : aucun indice + signaux opposés (gouvernance opaque, fonds non tracés, dirigeants à vie).
**Important.** Ne pas tomber dans l'AMBIGU systématique. Si 2 indices sur 3 sont présents même imparfaitement, mettre OUI.
**Sources.** Rapport d'activités (section gouvernance), rapport financier (signatures, ventilation), statuts.

### ELG-10 — Activités cohérentes avec la mission FAE
**Règle.** L'organisation met en œuvre des activités en lien avec l'autonomisation économique et sociale des femmes en situation de vulnérabilité.
**Sources.** Rapport d'activités, formulaire Q22 (activités EFH antérieures), Q23 (territoire OIF).

### ELG-11 — Mise en œuvre dans l'espace OIF
**Règle.** Le projet est mis en œuvre sur le territoire d'**un ou plusieurs des 53 États et gouvernements membres de plein droit de l'OIF**.
**Sources.** Formulaire projet Q2 (pays de mise en œuvre).
**Si hors OIF déclenche : REJ-9.**

### ELG-12 — Caractère nouveau du projet (pas une continuité)
**Règle.** Le projet n'est pas la continuité d'un projet déjà en cours ni la deuxième phase d'un projet passé.
**Sources.** Formulaire projet Q7 (continuité), comparer aux activités du rapport d'activités.
**Si NON déclenche : REJ-6.**
**Note priorité.** Les organisations déjà lauréates FAE restent éligibles si elles démontrent la nouveauté (bénéficiaires et/ou zones d'intervention différents). À signaler en `verification_externe_requise: "Liste officielle lauréates FAE 2020-2024"`.

### ELG-13 — Absence de prosélytisme / propagande / micro-crédit
**Règle.** Le projet n'est pas en lien avec :
- prosélytisme religieux,
- propagande politique ou idéologique,
- micro-crédit, dotation, ou fonds remboursables (à taux zéro ou à intérêt).
**Sources.** Formulaire projet Q6 (résumé), Q13 (description), Q31 (activités).
**Décision (calibrage 6e: 6/12 IA mettait AMBIGU sans raison claire, humains tranchaient OUI).**
- **Par défaut OUI** : la majorité des projets FAE n'ont pas ces caractéristiques.
- **AMBIGU uniquement si** présence de mots-clés ambigus dans le résumé/description : "évangélisation", "conversion", "parti politique", "candidat", "élection", "prêt", "remboursement", "intérêt financier", "garantie financière". Citer le mot-clé dans la justification.
- **NON** uniquement si plusieurs indices clairs convergent (ex : projet de micro-crédit explicite, ou activités liées à un parti politique nommé).
**Important.** Une organisation confessionnelle (Église, ONG religieuse) qui fait de l'aide sociale ≠ prosélytisme. Vérifier que les activités du projet sont laïques, pas que la structure porteuse.
**Si projet de micro-crédit déclenche : REJ-4. Si prosélytisme déclenche : REJ-5.**

### ELG-14 — Plafonds budgétaires et durée

**Règle.** Le projet respecte simultanément les 4 critères bloquants :
- (a) montant subvention sollicité **entre 15 000 € et 100 000 €** (Q4.subvention_oif),
- (b) subvention OIF ≤ **80 % du coût total** (ratio Q4.subvention_oif / Q4.cout_total),
- (c) **durée totale** du projet **entre 24 et 36 mois** (Q5.duree_totale),
- (d) candidature soumise **uniquement en français**.

**Structure informative (non bloquante).** Le projet se décompose typiquement en phase opérationnelle (12-18 mois) puis phase de suivi (12-18 mois). Ces phases servent à structurer la candidature mais **ne sont PAS des critères de rejet en soi**. Seule la durée TOTALE (somme des phases) est bloquante. Ne pas inventer un motif de rejet sur la phase opérationnelle ou la phase de suivi prise isolément.

**Sources.** Formulaire projet Q4, Q5 ; budget prévisionnel xlsx pour cohérence.
**Cohérence inter-pièces.** Vérifier que le montant Q4 = ligne `Subvention sollicitée auprès de l'OIF` du budget.

**Décision (calibrage 6e: 5/12 IA mettait AMBIGU pour des dossiers humainement OUI).**
- **OUI** : les 4 critères bloquants (a-d) sont respectés.
- **AMBIGU uniquement si** divergence quantifiable entre Q4 et le budget (ex: Q4=50k mais budget=45k → écart 10%). Mentionner l'écart précis.
- **NON** : un critère bloquant (a-d) explicitement violé (montant 12 000 €, durée totale 18 mois, ratio 85 %, candidature en anglais, etc.).

**Important.**
- Si tous les chiffres sont dans les fourchettes (a-d), mettre OUI directement. Ne pas mettre AMBIGU pour des arrondis ou conversions de devises.
- Si la phase opérationnelle déclarée fait 24 mois et la durée totale fait 24 mois (donc tout dans la phase opérationnelle, pas de phase de suivi explicite), c'est une **structure inhabituelle mais PAS un motif de rejet**. Signaler en `verification_externe_requise` ("Vérifier avec le porteur si la phase de suivi est implicite ou manquante") plutôt que mettre NON.

**Déclenchements de motifs de rejet (chaque critère bloquant violé déclenche son motif, plusieurs peuvent cumuler) :**
- (a) montant hors [15k-100k] → **REJ-8**
- (b) ratio subvention/coût total > 80 % → **REJ-8** (même motif, cumulable avec ci-dessus)
- (c) durée totale hors [24-36 mois] → **REJ-7**
- (d) candidature non française → **REJ-11**

## Motifs de rejet REJ-1 à REJ-15 (cf. cadre FAE 7e §4)

Ces motifs sont activés automatiquement selon les statuts ci-dessus :

| Motif | Description | Critère(s) déclencheur(s) |
|---|---|---|
| REJ-1 | Porteur non-OSC (personne physique, entreprise, université, collectivité, religieux, partisan) | ELG-1 = NON |
| REJ-2 | OSC enregistrée < 2 ans au 26/02/2026 | ELG-3 = NON |
| REJ-3 | Organisation hors 53 États OIF | ELG-2 = NON (pays hors OIF) |
| REJ-4 | Projet de micro-crédit / dotation / fonds remboursables | ELG-13 = NON (micro-crédit) |
| REJ-5 | Projet de prosélytisme / propagande | ELG-13 = NON (prosélytisme) |
| REJ-6 | Projet déjà commencé ou continuité d'un projet | ELG-12 = NON |
| REJ-7 | Durée hors 24-36 mois | ELG-14 = NON (durée) |
| REJ-8 | Montant hors 15k-100k € OU subvention > 80 % | ELG-14 = NON (montant) |
| REJ-9 | Mise en œuvre hors espace OIF | ELG-11 = NON |
| REJ-10 | Candidature transmise par courriel (non vérifiable IA) | À vérifier humainement |
| REJ-11 | Candidature soumise dans une langue autre que le français | À détecter dans la lecture |
| REJ-12 | Plus de 2 projets soumis par la même organisation | À vérifier humainement (cross-dossier) |
| REJ-13 | Récépissé manquant ou simple attestation de demande | ELG-2 = NON (pièce invalide) |
| REJ-14 | Soumission après le 26/04/2026 23h59 Paris | À vérifier humainement (métadonnées) |
| REJ-15 | Usage déraisonné/substitutif d'IA | À vérifier humainement (jugement subjectif) |

REJ-10, REJ-12, REJ-14, REJ-15 ne sont pas évaluables par toi : ne les déclenche pas, signale-les en `verification_externe_requise` si pertinent.

## Verdict

- **ELIGIBLE** : tous les 14 critères sont `OUI` (ou `SANS_OBJET` pour ELG-5/ELG-6 si confirmé), aucun motif REJ déclenché.
- **INELIGIBLE** : au moins un critère est `NON` qui déclenche un REJ-1 à REJ-9 ou REJ-13.
- **ELIGIBILITE_INCERTAINE** : présence de `AMBIGU` ou `NON_TROUVE` sur un critère bloquant, sans `NON` clair.

## Cumul des motifs de rejet

**Important : un dossier peut déclencher PLUSIEURS motifs REJ simultanément.** Tu dois TOUS les lister dans `motifs_rejet_declenches`, pas seulement le premier.

Exemples :
- Une OSC enregistrée en 2025 (ELG-3=NON → REJ-2) qui demande aussi 150 000 € (ELG-14=NON → REJ-8) → `["REJ-2", "REJ-8"]`
- Un projet de micro-crédit (ELG-13=NON micro-crédit → REJ-4) mis en œuvre au Canada anglophone (ELG-11=NON → REJ-9) → `["REJ-4", "REJ-9"]`
- Subvention 90 % du coût total (ELG-14=NON ratio → REJ-8) ET durée 18 mois (ELG-14=NON durée → REJ-7) → `["REJ-7", "REJ-8"]` (même critère ELG-14, deux motifs distincts)

Ne JAMAIS résumer à un seul motif quand plusieurs sont applicables. L'utilisateur a besoin de la liste complète pour comprendre la décision.

## Format de sortie

Tu produis un objet `phase_eligibilite` conforme au schéma. `motifs_rejet_declenches` est un array de **strings** au format `"REJ-X"` (jamais des objets). Exemple :

```json
{
  "verdict": "ELIGIBLE",
  "criteres": [
    {
      "id": "ELG-1",
      "intitule": "Nature de l'organisation (OSC)",
      "statut": "OUI",
      "source": {
        "file": "recepisse.pdf",
        "page": 1,
        "quote": "association loi 1901, but non lucratif"
      },
      "justification": "Récépissé indique forme juridique association à but non lucratif, conforme à la définition OSC FAE."
    },
    ...
  ],
  "motifs_rejet_declenches": []
}
```

## Format du champ `source`

Le champ `source` est **un objet structuré** qui permet à l'UI d'ouvrir directement le passage cité quand l'évaluateur humain clique dessus :

```json
"source": {
  "file": "nom-du-fichier.pdf",   // OBLIGATOIRE : nom exact du fichier
  "page": 3,                       // optionnel : page PDF 1-based
  "sheet": "Budget",               // optionnel : nom feuille xlsx
  "cell": "B12",                   // optionnel : cellule xlsx
  "section": "Q5",                 // optionnel : section/question du formulaire
  "quote": "texte exact cité"      // RECOMMANDÉ : citation 5-20 mots qui justifie
}
```

Règles :
- `file` est obligatoire. Utilise le nom exact du fichier que tu as lu (sans chemin).
- `page` si tu peux : très utile pour les PDF longs.
- `quote` recommandé : courte citation exacte (5-20 mots) qui justifie ton statut/score. Permet à l'évaluateur humain de vérifier instantanément.
- Pour les xlsx, indique `sheet` et `cell` si tu peux les identifier (avec la tool `mcp__office__read_xlsx`).
- Si tu n'es pas sûr d'une page, omets-la plutôt que d'inventer un numéro.
- Si le statut est `NON_TROUVE`, mets `source: {"file": "", "quote": "non documenté"}`.

**N'utilise JAMAIS le format string** type `"source": "recepisse.pdf p.1"`. Toujours un objet structuré.

## Style des justifications

Voir `CLAUDE.md`. Téléraphique, factuel, sans tiret cadratin, sans jugement valorisant. Une phrase claire qui pointe l'élément du dossier.
