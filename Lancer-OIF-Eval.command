#!/bin/bash
# Lanceur Mac : double-cliquable depuis le Finder.
# Démarre daemon + Next.js en local et ouvre le navigateur sur http://localhost:3000

cd "$(dirname "$0")"

# S'assurer que Node 24+ est disponible
if ! command -v node >/dev/null 2>&1; then
  osascript -e 'display alert "OIF-Eval" message "Node.js 24+ requis. Installez-le depuis https://nodejs.org puis relancez."'
  exit 1
fi
if ! command -v claude >/dev/null 2>&1; then
  osascript -e 'display alert "OIF-Eval" message "Claude Code CLI requis. Installez-le et connectez-vous (claude login), puis relancez."'
  exit 1
fi

# Premier run : npm install + déploiement data-template
if [ ! -d "node_modules" ]; then
  echo "Installation des dépendances (~1 min)..."
  npm install
fi

# Ouvre le navigateur après 4s (le temps que Next boote)
( sleep 4 && open "http://localhost:3100/evaluation" ) &

# Lance daemon + Next en avant-plan (Ctrl+C pour arrêter)
exec npm run dev
