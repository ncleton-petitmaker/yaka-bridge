---
name: ameliorer-mes-regles
description: Quand un membre de l'équipe signale un problème d'évaluation et propose une nouvelle règle (« sur le dossier X tu as raté Y, à l'avenir fais Z »), crée une proposition partagée dans _propositions/ qui sera arbitrée par l'admin (ou auto-promue si le mode calibrage est actif). Le système de règles persos a été supprimé : toutes les règles passent désormais par le circuit propositions → admin → règle globale.
version: "0.2.0-7e"
---

# Skill : Créer une proposition de règle

Quand un membre de l'équipe te dit "sur le dossier X, tu as raté Y parce que Z, à l'avenir fais W", tu crées une proposition formelle dans `_propositions/`. C'est l'admin qui décidera si la règle devient officielle (skill global), via la page Propositions de l'app. Si le mode calibrage est actif, la promotion est automatique et le serveur fait un snapshot du skill global avant pour permettre un revert.

## Inputs attendus dans le contexte

L'UI te transmet :
- `user` (nom du membre de l'équipe connectée, sert d'auteur de la proposition)
- `dossier_declencheur` (id du dossier sur lequel le désaccord est apparu) - peut être absent si la règle est générique
- `evaluation_concernee` (chemin du JSON d'évaluation concernée) - peut être absent

Si la règle est manifestement générique sans dossier déclencheur, c'est OK de procéder. Sinon, demande au membre de l'équipe le dossier concerné.

## Procédure

1. **Identifier la portée** de la règle : éligibilité (`ELG-X`), notation (`Q-X`), ou règle générale.

2. **Formuler la règle** en 1-2 phrases claires, factuelles, sans em dash (uniquement tirets normaux ou virgules). Elle doit être prescriptive : "fais X", "refuse Y si Z", "passe en AMBIGU si W".

3. **Vérifier les doublons** : avec `Glob`/`Read`, regarde rapidement si une règle similaire existe déjà dans `_global/evaluer-eligibilite.skill.md` ou `_global/evaluer-notation.skill.md`, ou dans `_propositions/` au statut `en_attente`. Si oui, le signaler au membre de l'équipe et lui demander si elle veut quand même soumettre.

4. **Créer la proposition** dans `.claude/skills/_propositions/` (ou son équivalent partagé sur serveur OIF si configuré) avec un nom de fichier `<YYYY-MM-DD>-<user-slug>-<slug>.md` (slug = 3-5 mots de la règle, kebab-case, sans accents).

   Frontmatter YAML obligatoire :
   ```yaml
   ---
   auteur: "<user>"
   date: "<YYYY-MM-DDTHH:MM:SSZ>"
   dossier_declencheur: "<id ou null si générique>"
   affecte: "<ELG-X | Q-Y | general>"
   statut: "en_attente"
   raison: "<phrase courte expliquant le constat sur le dossier déclencheur>"
   ---
   ```

   Corps du fichier en markdown : la règle proposée formulée comme un bloc qu'un admin pourrait directement insérer dans le skill global cible. Inclure éventuellement un exemple court.

5. **Confirmer au membre de l'équipe** ce que tu as écrit (chemin du fichier, statut), et lui rappeler que la proposition apparaîtra dans la page **Propositions** de l'app pour arbitrage admin (ou promotion automatique si le mode calibrage est actif).

## Mode batch depuis un rapport de calibrage

Si le prompt te demande de générer des propositions à partir d'un **rapport de calibrage JSON** (chemin du type `data/calibrage/rapport-*.json`) :

1. Lis le fichier JSON via `Read`. C'est un objet conforme à `CalibrageReportJson` avec :
   - `biais_elg` : tableau ordonné par désaccords décroissants
   - `biais_q` : tableau ordonné par |delta_moyen| décroissant
   - `recommandations.elg` et `recommandations.notation` : recommandations préformulées
   - `meta`, `synthese`, `dossiers` : contexte
2. Sélectionne les **top 5 biais critiques** :
   - Maximum 3 ELG (seuil : `desaccords/total >= 0.3`)
   - Maximum 3 Q (seuil : `|delta_moyen| >= 0.5`)
   - Total max 5 (combine ELG + Q, priorité aux plus impactants)
3. **IGNORE EXPLICITEMENT** ces biais (artefacts du calibrage 6e/7e, pas de vrais bugs) :
   - **ELG-5** "Rapport d'activités 2025 (à défaut 2024)" (les dossiers 6e ont 2023)
   - **ELG-6** "Rapport financier 2025 (à défaut 2024)" (idem)
4. Pour chaque biais sélectionné, crée 1 proposition dans `propositions/` de la campagne active. Frontmatter :
   ```yaml
   ---
   auteur: "calibrage automatique"
   date: "<ISO maintenant>"
   dossier_declencheur: null
   affecte: "<ELG-X | Q-Y>"
   statut: "en_attente"
   raison: "<pattern observé du rapport + recommandation, en 2-3 phrases>"
   ---
   ```
   Corps : règle prescriptive, telle qu'elle pourrait être insérée dans `evaluer-eligibilite.skill.md` ou `evaluer-notation.skill.md`. Cite le pattern chiffré observé (ex: « Sur 9 dossiers calibrés, IA met NON_TROUVE 8/9 fois »). Inclus si possible une instruction concrète ("Cherche aussi dans le rapport d'activité, pas seulement dans un fichier nommé 'PV'").
5. Vérifie via `Glob` qu'aucune proposition existante en statut `en_attente` ne couvre déjà le même `affecte` avant d'écrire (évite les doublons).
6. Confirme dans le chat le total créé : `✓ N propositions créées : ELG-7, ELG-9, Q10, Q5, Q44`.

## Auto-approbation (mode calibrage)

Si le contexte du run inclut une note `[CONFIGURATION AUTO-APPROBATION ACTIVE]`, le daemon t'a déjà demandé d'enchaîner avec la promotion. Suis ces instructions : après avoir créé la proposition, applique-la également au skill global concerné comme si l'admin venait de cliquer "promouvoir", et marque la proposition `statut: promu, promu_par: "auto-approbation"`.

## Sécurité

- Tu ne touches **jamais directement** au skill global hors mode auto-approbation. Sinon le diff visuel ne se calcule pas correctement et l'admin n'a pas la main.
- Tu ne touches **jamais** aux propositions d'autres membres de l'équipe.
- Si le membre te demande "modifie la règle globale tout de suite", refuse poliment : explique qu'il faut passer par la proposition + validation admin (sauf mode calibrage actif et l'utilisateur est admin).

## Style

Réponses **courtes et factuelles** dans le chat. Confirme l'action faite, le chemin de fichier créé, le statut de la proposition. Pas de baratin.
