# Commandes de dépannage OIF-Eval (Windows)

Toutes les commandes utiles en cas de pépin pendant les tests / le déploiement OIF.

> **Astuce** : si PowerShell mange les espaces au collage, ouvre ce fichier dans Notepad / VS Code et copie depuis là, pas depuis le terminal d'un PDF.

---

## Installation Claude Code

### Commande recommandée (idempotente, fiable)

À coller dans **Windows PowerShell** (chercher "powershell" dans la barre Windows) :

```powershell
irm https://claude.ai/install.ps1 | iex
$bin = "$env:USERPROFILE\.local\bin"; $up = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not $up -or $up -notlike "*$bin*") { [Environment]::SetEnvironmentVariable("Path", ($(if ($up) { "$up;$bin" } else { $bin })), "User") }
$env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
```

Puis :

```powershell
claude
```

Ça lance le flow de connexion au compte Claude.ai (Pro/Max/Team OIF) via le navigateur.

### Commande alternative (winget, sans auto-update)

```powershell
winget install Anthropic.ClaudeCode
```

---

## Si « claude » n'est pas reconnu après install

Réparation idempotente du PATH :

```powershell
$bin = "$env:USERPROFILE\.local\bin"
Test-Path "$bin\claude.exe"
$up = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not $up -or $up -notlike "*$bin*") {
  $newPath = if ($up) { "$up;$bin" } else { $bin }
  [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
}
$env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
claude --version
```

Doit afficher `2.x.x (Claude Code)`.

### Si le PATH user est pourri (cas extrême)

Reset brutal à juste `.local\bin` :

```powershell
$bin = "$env:USERPROFILE\.local\bin"
[Environment]::SetEnvironmentVariable("Path", $bin, "User")
$env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + $bin
claude --version
```

⚠ **Attention** : ce reset efface toutes les autres entrées du PATH user (raccourcis perso). À utiliser seulement si la version idempotente ne marche pas.

---

## Relancer le wizard OIF-Eval (sans désinstaller)

### Méthode Explorateur (recommandée)

1. Fermer OIF-Eval s'il est ouvert
2. **Windows + E** pour ouvrir l'Explorateur
3. Dans la barre d'adresse, coller :
   ```
   %APPDATA%\OIF-Eval\data\.claude
   ```
4. Entrée
5. Clic droit sur **`app-config.json`** > Supprimer
6. Lancer OIF-Eval, le wizard s'ouvre

### Méthode PowerShell

Une commande à la fois :

```powershell
taskkill /F /IM OIF-Eval.exe
```

```powershell
del "$env:APPDATA\OIF-Eval\data\.claude\app-config.json"
```

Puis relance OIF-Eval.

---

## Désinstallation complète d'OIF-Eval (clean reset)

### Méthode Paramètres Windows

1. **Paramètres** > **Applications** > **Applications installées**
2. Chercher **OIF-Eval** > **Désinstaller**
3. Si l'uninstaller a été généré avec une version récente, il efface aussi les data utilisateur. Sinon, étape suivante.

### Effacer les données résiduelles

```powershell
Remove-Item -Recurse -Force "$env:APPDATA\OIF-Eval"
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\Programs\OIF-Eval"
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\OIF-Eval"
```

(Si une commande râle "fichier en cours d'utilisation", fermer OIF-Eval ou redémarrer Windows.)

### Vérifier que c'est propre

```powershell
Test-Path "$env:APPDATA\OIF-Eval"
Test-Path "$env:LOCALAPPDATA\Programs\OIF-Eval"
```

Les deux doivent répondre `False`.

---

## Tuer un OIF-Eval qui tourne en arrière-plan

### Méthode UI

**Ctrl+Shift+Échap** > onglet **Détails** > clic droit sur **OIF-Eval.exe** > Fin de tâche.

### Méthode PowerShell

```powershell
taskkill /F /IM OIF-Eval.exe /T
```

Le `/T` tue aussi les sous-processus (daemon Node + Next standalone).

---

## Voir les logs en cas de bug

### Localisation

```powershell
explorer "$env:APPDATA\OIF-Eval\logs"
```

3 fichiers possibles :
- `electron-main.log` : process principal (le plus utile)
- `daemon.log` : serveur backend
- `next.log` : serveur frontend

### Envoyer un bundle de diagnostic au support

Dans l'app : **Paramètres > Logs > Générer le fichier de diagnostic**. Ça produit un ZIP à envoyer par email à `nicolas.cleton@petitmaker.fr`.

---

## Vérifier l'état de Claude Code

```powershell
claude --version
```

Doit afficher la version (2.x.x).

```powershell
claude
```

Sans argument, lance Claude Code. Si pas connecté, ouvre le navigateur pour la connexion.

---

## Commandes utiles d'inspection

### Voir le PATH user actuel

```powershell
[Environment]::GetEnvironmentVariable("Path", "User")
```

### Voir la longueur du PATH user

```powershell
([Environment]::GetEnvironmentVariable("Path", "User")).Length
```

(Si > 2000 caractères, le PATH user est probablement pourri.)

### Trouver claude.exe

```powershell
Get-Command claude -ErrorAction SilentlyContinue | Select-Object Source
```

Doit retourner `C:\Users\<vous>\.local\bin\claude.exe`.

---

## Contact

Pour toute autre question : **Nicolas Cléton — nicolas.cleton@petitmaker.fr**
