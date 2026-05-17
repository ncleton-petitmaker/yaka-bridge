# Démarrer avec OIF-Eval

**5 minutes chrono pour commencer à évaluer.**

OIF-Eval intègre Claude Code (l'IA d'Anthropic). L'application gère la connexion automatiquement lors du premier lancement.

---

## 1. Installer OIF-Eval

**Sur Windows**

Votre admin OIF vous fournit un fichier `OIF-Eval-Setup.exe` (~170 Mo).

**Double-cliquer dessus.** Une mini barre de progression s'affiche, l'install se fait dans votre profil utilisateur (~10 secondes), puis OIF-Eval se lance automatiquement. Un raccourci est créé sur le bureau et dans le menu Démarrer.

> **Le tout premier lancement met 20 à 30 secondes** avant que la fenêtre OIF-Eval n'apparaisse. C'est **normal** : Windows Defender analyse l'app au démarrage initial pour vérifier qu'elle est sûre. Pendant ces secondes vous voyez juste le curseur de chargement, ne fermez rien. **Tous les lancements suivants sont quasi-instantanés** (Defender garde l'app en cache).

> **Avertissement Windows Defender.** Au premier lancement, Windows peut afficher "Windows a protégé votre PC" parce que le binaire n'est pas signé. Cliquer **Informations complémentaires** puis **Exécuter quand même**.

> **Pas de droits admin requis.** L'installation se fait dans `C:\Users\<vous>\AppData\Local\Programs\OIF-Eval\`, accessible sans élévation. Si votre poste DSI bloque même cet emplacement, écrire au support.

**Sur Mac**

Votre admin vous fournit `OIF-Eval.dmg`. Double-clic, glisser `OIF-Eval.app` dans Applications, double-clic sur l'app.

> **Avertissement macOS.** Au premier lancement, macOS peut bloquer l'app non signée. Clic droit sur OIF-Eval.app > Ouvrir > confirmer.

Pas d'install système, pas de droits admin, l'app tourne depuis votre profil utilisateur.

---

## 2. Premier lancement

Au premier démarrage, un assistant en quelques étapes vous guide :

1. **Votre prénom** : il apparaîtra à côté de vos évaluations terminées.
2. **Connexion Claude** : l'app ouvre une fenêtre de connexion. Connectez-vous avec votre compte Claude.ai OIF (Pro, Max ou Team). La connexion est mémorisée, vous n'aurez pas à la refaire.
3. **Mode de partage** : choisissez le dossier que votre admin OIF vous a indiqué (typiquement un dossier OneDrive ou SharePoint partagé). Si vous ne savez pas, sélectionnez "Import / Export manuel" pour commencer.
4. **C'est prêt.**

---

## 3. Evaluer un dossier

L'écran principal affiche la liste des dossiers candidats à gauche. Cliquer sur un dossier pour l'analyser.

L'IA Claude lit les pièces du dossier et propose une grille préremplie : 14 critères d'éligibilité et 49 questions de notation. Vous validez, ajustez ou complétez.

**Trois pictogrammes à connaître**

- Icone robot = note proposée par Claude
- Icone personne = question réservée à un humain (jugement subjectif)
- Icone crayon = note IA modifiée par vous

**Modifier une note IA**

Cliquer "Modifier" à droite d'une question, choisir une nouvelle note, expliquer pourquoi (3 caractères minimum). Enregistrer. La modification est tracée.

**Compléter les questions humaines**

Cliquer "à compléter" pour basculer en vue Review. Pour chaque question marquée humain, choisir une note et écrire une justification.

**Valider l'évaluation**

En bas de la vue Review, cliquer "Valider la review". L'évaluation est signée à votre nom et apparaît comme finalisée.

---

## 4. Discuter avec Claude

Si vous avez un doute sur un point précis du dossier, cliquer "Demander à Claude" en haut du panneau central. Un drawer s'ouvre, posez votre question, Claude répond en consultant les pièces du dossier. La conversation est isolée à ce dossier.

## 5. Signaler un problème

Si Claude se trompe systématiquement sur un type de critère, cliquer "Signaler un problème". Décrire le constat ("sur ce dossier, Claude a mis NON alors que..."), proposer la règle à appliquer ("à l'avenir, vérifier que..."). Votre admin examinera et, si la règle est pertinente, l'intégrera pour tous les évaluateurs.

---

## Aide rapide

**L'évaluation ne se lance pas**

Aller dans Paramètres > Réglage Claude. Une pastille verte indique que Claude est connecté. Si elle est rouge, aller dans Paramètres > Tuto et cliquer "Relancer l'assistant" pour vous reconnecter.

**Au double-clic sur OIF-Eval.exe, rien ne se passe**

Attendre 5-10 secondes (le premier lancement initialise tout, c'est lent). Si toujours rien, regarder les logs dans `%APPDATA%\OIF-Eval\logs\`.

**Une autre question**

Ecrire a Nicolas Cleton : **nicolas.cleton@petitmaker.fr**.

---

*OIF-Eval - Guide demarrage v1 - 13 mai 2026 - Petitmaker*
