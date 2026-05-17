# OIF-Eval

Outil d'évaluation IA des candidatures **FAE 7e édition** (Fonds "La Francophonie avec Elles", OIF). App Electron locale qui pilote Claude Code pour analyser ~296 dossiers selon une grille structurée (14 critères d'éligibilité + 49 questions de notation), avec workflow d'amélioration continue des règles.

---

## Installation pour les évaluatrices OIF

### Étape 1 — Installer Claude Code (une seule commande, une seule fois)

Anthropic fournit depuis 2026 un installateur natif **standalone** : pas besoin de Node.js, pas besoin de WSL sur Windows, pas besoin de Git.

**Sur Mac**, ouvrir le **Terminal** (Cmd+Espace, taper "Terminal") et coller :
```bash
curl -fsSL https://claude.ai/install.sh | bash
```

**Sur Windows**, ouvrir **PowerShell** (clic droit sur le menu Démarrer → "Windows PowerShell") et coller :
```powershell
irm https://claude.ai/install.ps1 | iex
```

L'installation prend 30 secondes. Claude Code se met à jour tout seul ensuite.

### Étape 2 — Se connecter au compte Anthropic OIF

Dans le même terminal, taper :
```bash
claude login
```

Suivre les instructions : un onglet de navigateur s'ouvre, se connecter avec le compte Pro/Max/Team de l'OIF.

### Étape 3 — Installer OIF-Eval

Double-cliquer sur le fichier reçu :
- **Mac** : `OIF-Eval.dmg` → glisser l'icône dans Applications
- **Windows** : `OIF-Eval-Setup.exe` → suivre l'assistant

C'est tout. L'app vérifie au démarrage que Claude Code est bien installé. Si ce n'est pas le cas, elle affiche les instructions ci-dessus directement dans une fenêtre.

---

## Premier lancement

L'app affiche un petit **wizard d'installation en 5 étapes** :

1. **Bienvenue** : prénom de la personne qui utilise l'app
2. **Rôle** : admin ou évaluatrice
3. **Dossiers** : où sont les candidatures, où écrire les évaluations, où partager les règles
4. **Campagne** : FAE 7e par défaut
5. **Récap**

Les paramètres peuvent être modifiés à tout moment dans l'onglet **Paramètres**.

---

## Fonctionnalités

### Évaluation
- Sélection d'un dossier → bouton **Évaluer** → Claude analyse le dossier en streaming live (~5 min Sonnet, ~10 min Opus)
- Grille des 14 critères d'éligibilité + 49 questions de notation
- 16 questions hors-IA en surbrillance ambre, à compléter par l'humain via la **Review form**
- Chaque réponse IA peut être **modifiée** par l'humain (override) avec raison obligatoire, tracé en journal RGPD
- Bouton **batch** pour lancer 3 évaluations en parallèle

### Gestion des règles
- **💬 Demander à Claude** : chat libre sur le dossier en cours (contexte isolé par dossier)
- **💡 Signaler un problème** : formulaire structuré qui crée une proposition de règle
- Onglet **Propositions** : diff git-style avant/après, l'admin valide ou rejette
- **Mode calibrage** (admin) : auto-promotion + bouton "Annuler la promotion" qui restaure le skill global précédent

### Campagnes (admin)
- Wizard de création (clone de la campagne active, ou import d'un référentiel .docx/.md)
- Édition des skills via chat (Claude régénère depuis un référentiel) ou éditeur markdown manuel
- Activation, archivage, export ZIP, import ZIP
- Une seule campagne active à la fois, isolation totale des évaluations passées

### Calibrage (admin)
- Compare l'IA à la vérité-terrain humaine sur 20 dossiers stratifiés
- Rapport JSON + markdown : biais ELG par critère, biais Q par question, recommandations
- UI dans Paramètres → **Rapport de calibrage** : visualisation interactive
- Bouton **Générer 5 propositions** : Claude crée automatiquement des propositions de correction des skills

### Conformité RGPD (admin)
- Journal de traçabilité avec hash SHA-256 chaîné (tamper-evident)
- Conformité recommandation **CNIL n° 2021-122**
- Page admin avec filtres, vérification d'intégrité, export
- Conservation 12 mois glissants

### Export
- xlsx au format compatible 6e édition (3 onglets : Évaluations, Synthèses, Modifications humaines)
- Cellules modifiées par humain en fond ambre
- Onglet d'audit avec qui/quoi/quand/pourquoi pour chaque override

---

## Architecture technique

```
oif-eval/
├── app/                      Next.js 16 App Router
│   ├── evaluation/           page principale (3 panels resizables)
│   ├── propositions/         diff git-style + arbitrage admin
│   ├── parametres/           profil, campagnes, calibrage, RGPD
│   ├── logs/                 journal RGPD admin
│   └── export/               téléchargement xlsx
├── components/               React (DiffViewer, SkillEditor, CalibrageReportModal, ...)
├── lib/                      types partagés + client API
├── server/                   daemon Hono (port 7456)
│   ├── index.ts              endpoints REST + SSE
│   ├── runs.ts               spawn claude, parse stream-json
│   ├── campaigns.ts          CRUD campagnes
│   ├── audit-log.ts          hash chaîné SHA-256 RGPD
│   ├── calibrage-reports.ts  lecture rapports JSON
│   └── export.ts             ExcelJS xlsx
├── data-template/.claude/    déployé au postinstall
│   ├── CLAUDE.md             cadre métier
│   ├── settings.json         hooks PostToolUse de validation
│   ├── schemas/              JSON Schema strict
│   └── hooks/                validate-evaluation-json.mjs
├── skills-template/_global/  4 skills officiels
└── electron/                 main + preload Electron
```

## Stack

- **Next.js 16** (App Router) + Tailwind + react-resizable-panels
- **Hono** daemon (port 7456) + SSE streaming
- **Electron** packaging Mac/Windows via electron-builder
- **Claude Code CLI** en subprocess, format stream-json
- **ExcelJS**, **JSZip**, **mammoth** (docx → markdown)

---

## Pour Nicolas (dev sur Mac)

```bash
cd /Users/nicolascleton/Documents/OIF/oif-eval

# Premier lancement
npm install                    # installe deps + déploie data-template/ → data/

# Mode dev (daemon + Next.js + Electron, hot reload)
npm run electron               # ouvre la fenêtre native

# Mode dev sans Electron (juste navigateur)
npm run dev                    # http://localhost:3100

# Type-check
npm run typecheck

# Calibrage des skills
npm run calibrer -- --stratified   # 20 dossiers stratifiés (vagues de 3)
npm run calibrer -- --report-only  # Régénère le rapport sans relancer

# Build packageable
npm run electron:pack:mac      # OIF-Eval.dmg
npm run electron:pack:win      # OIF-Eval-Setup.exe
```

---

## Distribution

Pour livrer à l'OIF : générer le .dmg / .exe avec `electron-builder` et envoyer via **SwissTransfer** (RGPD-friendly, lien expirable). Pas besoin de Node.js côté utilisateur (Electron embarque sa propre version pour ses modules internes).

Mises à jour : nouveau lien SwissTransfer à chaque release. Versionner les builds (`OIF-Eval-1.0.0.dmg`, etc.).

---

## Workflow type d'utilisation

1. **Évaluatrice** ouvre l'app, sélectionne un dossier, clique Évaluer (~5 min)
2. **Évaluatrice** complète les 16 questions hors-IA via Review form
3. Si désaccord avec une note IA : **Modifier** sur la question + raison obligatoire (tracé RGPD)
4. Si problème de méthode : **Signaler un problème** ou **Demander à Claude** dans le drawer
5. **Admin** voit les propositions dans `/propositions`, valide via diff visuel
6. **Admin** lance périodiquement un calibrage et examine le rapport pour ajuster les skills
7. **Admin** exporte le xlsx final pour transmission OIF

---

## Calibrage et amélioration continue

Le calibrage compare les évaluations IA aux notes humaines du gold standard 6e (`~/Documents/Memoire/memoireclients/OIF/00-Inbox/OIF/_verite-terrain-6e.jsonl`).

```bash
# Lance 20 dossiers stratifiés (vagues de 3 pour éviter rate-limit)
npm run calibrer -- --stratified
```

Le rapport produit dans `data/calibrage/` détaille :
- Accord verdict éligibilité (cible OIF ≥ 85%)
- Δ score moyen IA vs humain (cible proche 0)
- Biais par critère ELG (top 5 désaccords avec pattern observé)
- Biais par question (top 15 par |Δ|)
- Recommandations d'ajustement skills par critère

Le rapport est aussi visualisable dans **Paramètres > Rapport de calibrage** (admin only) avec un bouton **Générer 5 propositions** qui crée automatiquement les ajustements de skills via le workflow `/propositions`.

---

## Sources de référence

- Vault mémoire client : `~/Documents/Memoire/memoireclients/OIF/`
- Cadre FAE 7e : `02-Connaissance/Cadre-FAE-7e-edition.md`
- Schéma dossier : `02-Connaissance/Schema-Dossier-Candidate-FAE-7e.md`
- Grille notation : `02-Connaissance/Questionnaire-Notation-7e.md`
- Style commentaires : `02-Connaissance/Style-Commentaires-Evaluation.md`

---

## Statut

🚧 **MVP livré le 9 mai 2026 pour démo OIF du 13 mai.**

Repo : https://github.com/ncleton-petitmaker/oif-eval
