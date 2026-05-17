# Guide admin OIF-Eval

**Document destiné aux administrateurs OIF.** Couvre les fonctions admin : suivi de l'équipe, stockage et partage, campagnes, calibrage et amélioration des règles, journal d'audit.

Pour la prise en main de base (installation, évaluation d'un dossier), se référer au PDF "Démarrer avec OIF-Eval" distribué aux évaluateurs.

---

## Sommaire

1. [Ce qui change quand on est admin](#1-ce-qui-change-quand-on-est-admin)
2. [Dashboard et suivi de l'équipe](#2-dashboard-et-suivi-de-lequipe)
3. [Stockage et partage entre évaluateurs](#3-stockage-et-partage-entre-evaluateurs)
4. [Gestion des campagnes](#4-gestion-des-campagnes)
5. [Calibrage et amélioration des règles](#5-calibrage-et-amelioration-des-regles)
6. [Workflow propositions](#6-workflow-propositions)
7. [Journal d'audit](#7-journal-daudit)
8. [Diagnostic et envoi de logs au support](#8-diagnostic-et-envoi-de-logs-au-support)

---

## 1. Ce qui change quand on est admin

Le statut admin se coche dans **Paramètres > Profil** ("Je suis admin"). Activez-le uniquement si vous êtes autorisé par le responsable du dispositif.

L'admin a accès à des onglets supplémentaires dans la navigation :

- **Dashboard** : suivi de l'avancement de toute l'équipe
- **Propositions** : validation des règles proposées par les évaluateurs
- **Paramètres > Campagnes** : création, activation, archivage des campagnes
- **Paramètres > Calibrage** : rapports de calibrage et génération de règles
- **Paramètres > Logs (RGPD)** : journal d'audit complet

L'admin a également un onglet "Diagnostic" pour envoyer les logs au support en cas de problème.

---

## 2. Dashboard et suivi de l'équipe

L'onglet **Dashboard** dans la barre du haut donne une vue d'ensemble de l'avancement.

### Avancement global

En haut de la page, une jauge circulaire affiche le pourcentage global (validés + inéligibles / pool total). Cinq tuiles complètent : Pool total, Validés, En cours, Inéligibles, À traiter.

### Avancement par évaluateur

Une carte par évaluateur, triée par pourcentage décroissant. Sur chaque carte : nom, pourcentage personnel, barre de progression, breakdown (validés / en cours / inéligibles), date de la dernière action.

### Détail par évaluateur

Cliquer sur une carte ouvre un panneau dessous avec la liste de ses dossiers. Triés par actionabilité (en cours en premier). Cliquer sur un dossier ouvre directement la fiche d'évaluation.

Le bouton "Actualiser" recharge les statistiques (utile après un import de pack ou un batch).

---

## 3. Stockage et partage entre évaluateurs

L'onglet **Paramètres > Stockage** est le plus important à configurer correctement. Il définit comment l'équipe partage les skills (règles), les évaluations et le journal.

### Choisir un mode de partage

Deux modes en haut de l'onglet :

#### Mode 1 - Dossier synchronisé (recommandé)

Tous les évaluateurs pointent vers le même dossier sur un service de synchronisation. Le service propage les fichiers automatiquement.

L'application détecte automatiquement le type de stockage à partir du chemin choisi :

- ☁ **OneDrive Business** : `~/Library/CloudStorage/OneDrive-OIF/...` (Mac) ou `%USERPROFILE%\OneDrive - OIF\...` (Windows)
- ☁ **SharePoint Online** : `~/Library/CloudStorage/SharePoint-OIF/...`
- ☁ **Dropbox**, **Google Drive**, **iCloud** : également détectés
- **Partage réseau (SMB)** : `\\serveur\partage` ou volume monté `/Volumes/<nom>`
- 📁 **Dossier local** : aucun partage, vos collègues ne verront pas son contenu

Un badge de couleur confirme le type, et l'application vérifie que le service de synchronisation tourne sur le poste (vert ou rouge).

**Recommandé pour OIF** : OneDrive Business ou SharePoint Online (compatible avec l'environnement Microsoft 365 de l'OIF).

#### Mode 2 - Import / Export manuel (fallback)

Si aucun dossier partagé n'est disponible, le mode autonome permet d'échanger les données via des fichiers ZIP.

Workflow en étoile, l'admin centralise :

1. **L'admin** exporte un **pack admin** (skills + propositions de la campagne active)
2. Diffusion aux évaluateurs (Teams, email)
3. Chaque évaluateur **importe le pack admin** au démarrage
4. À la fin de la journée, l'évaluateur **exporte ses évaluations finalisées**
5. Le pack évaluations est renvoyé à l'admin
6. **L'admin importe** chaque pack reçu, les évaluations sont mergées

Les ZIP sont signés par hash SHA-256 par fichier (corruption détectée à l'import).

### Configurer le dossier partagé

En mode synchronisé, indiquer le **dossier racine** que tous les évaluateurs partageront. L'application crée automatiquement la sous-structure (`skills/`, `audit-log/`, `evaluations/`).

**Important** : le **premier** évaluateur à configurer ce dossier crée la structure. Les **suivants** se branchent sur la structure existante : aucun dossier dupliqué, rien n'est écrasé.

### Conflits de synchronisation

Si deux évaluateurs modifient le même fichier au même moment, OneDrive ou Dropbox créent un fichier "conflict copy". L'application détecte ces fichiers et affiche un bandeau orange en haut de toutes les pages :

> ⚠ 2 fichiers en conflit dans le dossier partagé. Cliquer pour résoudre.

Cliquer ouvre une modale qui liste les fichiers concernés. Comparer, garder la bonne version, supprimer le doublon (sans toucher au fichier original sans le suffixe).

---

## 4. Gestion des campagnes

Une **campagne** = une grille d'évaluation pour une édition (FAE 7e, 8e, etc.). Une seule campagne est active à la fois. Les autres restent en archive.

### Créer une nouvelle campagne

Bouton "Nouvelle campagne" en haut de l'onglet **Paramètres > Campagnes**. Trois options :

- **Vide** : grille de zéro
- **Cloner une existante** : repartir d'une campagne existante (ex. FAE 7e) et adapter
- **À partir d'un référentiel** : importer un PDF / Word / Markdown qui décrit les critères, Claude génère la grille

### Activer / archiver

Pour chaque campagne dans la liste : Activer (la mettre en service, l'ancienne est archivée), Archiver, Exporter en ZIP, Édition manuelle des skills.

Statuts : Active (vert), Brouillon (orange), Archivée (gris).

### Importer un bundle

Bouton "Importer un ZIP" : importer un bundle exporté depuis une autre instance OIF-Eval. Utile pour migrer entre postes ou récupérer une campagne archivée.

---

## 5. Calibrage et amélioration des règles

Le **calibrage** est l'outil clé pour le rodage de la grille avant le démarrage d'une campagne.

### Principe

Le calibrage compare les évaluations produites par Claude à des **notes humaines de référence** (édition précédente, échantillon validé). Plus l'écart est faible, plus les règles sont fiables.

Le cycle complet :

1. **Importer une référence humaine** (notes manuelles existantes)
2. **Lancer Claude** sur les mêmes dossiers avec la grille actuelle
3. **Lire le rapport de calibrage** : où Claude diverge-t-il, sur quels critères
4. **Générer des propositions de règles** correctives, les promouvoir dans la grille officielle

### Liste des rapports

Onglet **Paramètres > Calibrage**. Chaque rapport affiche :

- Date et modèle Claude utilisé
- Nombre de dossiers comparés
- Pourcentage d'accord sur les verdicts d'éligibilité (vert si ≥ 85%, orange entre 60 et 85%, rouge sinon)
- Écart de score moyen Δ entre Claude et l'humain (vert si < 5 pts, orange si < 15, rouge sinon)

### Détail d'un rapport

Cliquer sur un rapport ouvre un tableau de bord avec 4 indicateurs et un tableau "Biais par critère ELG" qui montre où Claude diverge des notes humaines (OUI vs NON, ambigu, non trouvé).

### Générer 5 propositions

Bouton **"⚡ Générer 5 propositions"** en bas du modal. Claude analyse le rapport et propose jusqu'à 5 règles d'amélioration. Vous arbitrez ensuite chaque proposition une par une via le diff visuel (section 6).

### Bonnes pratiques

- Lancer un calibrage **avant** chaque nouvelle édition, sur un échantillon de l'édition précédente
- Activer le **mode calibrage** dans Profil pendant cette phase (promotion immédiate, annulation possible en un clic)
- Refaire un calibrage après chaque batch significatif de promotions
- Viser **≥ 90% d'accord d'éligibilité** et **< 5 pts d'écart de score moyen** avant de lancer la campagne en production

---

## 6. Workflow propositions

L'onglet **Propositions** liste toutes les règles proposées par l'équipe (évaluateurs ou générées par calibrage).

### Filtres

Sélecteur en haut à droite : En attente (jaune), Promues (vert), Rejetées (rouge), Toutes.

Chaque proposition affiche l'auteur, le critère affecté, le dossier déclencheur et la raison.

### Voir le diff

Cliquer sur "Voir le diff" pour examiner précisément ce que la proposition changerait dans la règle officielle. Bascule "Côte à côte" / "Unifié" en haut à droite. Ajouts en vert, suppressions en rouge.

### Décider

- **Promouvoir** : intègre la règle au skill officiel. Tous les évaluateurs en bénéficient au prochain dossier.
- **Rejeter** : avec un commentaire obligatoire expliquant pourquoi.
- **Annuler la promotion** : retire une règle qui s'avère inadaptée. Snapshot pris avant promotion, restauration garantie.

---

## 7. Journal d'audit

OIF-Eval enregistre automatiquement toutes les actions sensibles dans un journal.

Onglet **Paramètres > Logs (RGPD)** :

- Filtres par utilisateur, action, plage de dates
- Cliquer un événement pour voir son détail JSON brut
- Bouton "Vérifier l'intégrité" pour confirmer que le journal n'a pas été altéré
- Statistiques en haut : volume total, top actions, top utilisateurs, taux d'échecs

Architecture : un fichier par utilisateur par jour (`audit-log/<utilisateur>/<date>.jsonl`), chaque fichier protégé par un hash chaîné SHA-256. Pas de race d'écriture concurrente entre évaluateurs.

L'OIF étant une organisation internationale, le RGPD au sens strict ne s'applique pas. Le journal sert à la **traçabilité interne** et à la transparence du travail.

---

## 8. Diagnostic et envoi de logs au support

En cas de problème, onglet **Paramètres > Diagnostic** :

- Bouton "Générer le fichier de diagnostic" : produit un ZIP avec les logs techniques (electron-main, daemon, next). Aucun contenu de dossier candidat n'est inclus.
- Lien email pré-rempli vers nicolas.cleton@petitmaker.fr avec le ZIP en pièce jointe.

À utiliser dès qu'un comportement vous surprend ou bloque l'équipe. Les logs sont rotatifs (dernière session + précédente seulement).

---

## Contact

Pour toute question d'utilisation ou demande d'évolution : **Nicolas Cléton — nicolas.cleton@petitmaker.fr**.

---

*OIF-Eval · Guide admin v1 · 13 mai 2026 · Petitmaker*
