---
name: promouvoir-regle
description: ADMIN UNIQUEMENT. Promeut une proposition de règle (issue d'un membre de l'équipe) en règle globale partagée par toute l'équipe. Édite le skill global concerné, journalise dans _historique.jsonl, et marque la proposition comme "promue". Se déclenche quand l'admin clique "promouvoir" dans l'UI ou dit "promeus la proposition X".
version: "0.1.0-7e"
---

# Skill : Promouvoir une proposition en règle globale (admin only)

Tu intègres une proposition validée par l'admin dans la règle globale OIF-Eval, pour que toutes les membres de l'équipe en bénéficient au prochain dossier.

## Pré-requis

L'utilisateur connecté doit avoir le rôle `admin`. Le daemon te transmet ce rôle dans le contexte. Si `role !== "admin"`, refuse et explique qu'il faut être admin pour promouvoir.

## Inputs attendus

- `proposition_id` (chemin du fichier dans `.claude/skills/_propositions/`)
- `decision` ("promouvoir" | "rejeter")
- `commentaire_admin` (optionnel, raison)

## Procédure si decision = "promouvoir"

1. **Lire la proposition** dans `.claude/skills/_propositions/<proposition_id>.md`.
2. **Identifier le skill global cible** depuis le frontmatter `affecte` :
   - `ELG-X` → `_global/evaluer-eligibilite.skill.md`
   - `Q-Y` → `_global/evaluer-notation.skill.md`
   - `general` → demander confirmation à l'admin sur la cible avant d'éditer.
3. **Lire le skill global** courant.
4. **Insérer la nouvelle règle** au bon endroit (sous le critère ou la question concernée). Si la règle est très transversale, créer une section "Règles ajoutées" en fin de fichier.
5. **Mettre à jour la version** du skill (version: 0.1.X → 0.1.(X+1)).
6. **Écrire le skill global mis à jour**.
7. **Marquer la proposition comme promue** : éditer le frontmatter `statut: en_attente` → `statut: promu`, ajouter `promu_le: <date>`, `promu_par: <admin>`, `commentaire_admin: <texte>`.
8. **Journaliser dans `.claude/_historique.jsonl`** : appender une ligne JSON
   ```json
   {"date": "<ISO>", "action": "promouvoir", "proposition_id": "<...>", "auteur": "<user>", "admin": "<admin>", "skill_cible": "<chemin>", "version_skill_avant": "0.1.X", "version_skill_apres": "0.1.(X+1)"}
   ```

## Procédure si decision = "rejeter"

1. **Lire la proposition**.
2. **Marquer la proposition comme rejetée** : `statut: rejete`, `rejete_le: <date>`, `rejete_par: <admin>`, `commentaire_admin: <texte obligatoire>`.
3. **Ne pas toucher** au skill global.
4. **Journaliser** dans `_historique.jsonl` avec `action: "rejeter"` et `commentaire_admin`.

## Sécurité

- **Backup mental** : avant d'écrire le skill global, vérifie que la nouvelle règle n'introduit pas de contradiction avec une règle existante. Si oui, demande confirmation à l'admin.
- **Idempotence** : si la même proposition est promue deux fois, ne pas dupliquer la règle dans le skill global. Détecter par le hash du contenu de la règle ou par un commentaire `<!-- prop:<id> -->`.
- **Jamais d'effet rétroactif** : la promotion ne réécrit pas les évaluations déjà faites. L'admin doit demander explicitement une re-évaluation des dossiers concernés (autre commande).

## Style des messages au chat

```
✓ Proposition <id> promue en règle globale.
  Skill modifié : evaluer-eligibilite.skill.md (v0.1.0 → v0.1.1)
  Règle ajoutée sous ELG-2.
  Tous les membres de l'équipe appliqueront cette règle au prochain dossier.
  Journal mis à jour dans _historique.jsonl.
```

## Restrictions

- Tu ne crées **pas** de skill global de toi-même. Tu modifies uniquement les skills existants en y ajoutant une règle promue.
- Tu n'autorises pas la suppression d'une règle promue par un autre admin sans nouvelle décision documentée.
