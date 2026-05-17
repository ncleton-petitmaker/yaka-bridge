@echo off
REM Lanceur Windows : double-cliquable depuis l'Explorateur.
REM Démarre daemon + Next.js en local et ouvre Edge sur http://localhost:3000

cd /d "%~dp0"

where node >nul 2>nul
IF %ERRORLEVEL% NEQ 0 (
  msg * "OIF-Eval : Node.js 24+ requis. Installez-le depuis https://nodejs.org puis relancez."
  exit /b 1
)
where claude >nul 2>nul
IF %ERRORLEVEL% NEQ 0 (
  msg * "OIF-Eval : Claude Code CLI requis. Installez-le et connectez-vous (claude login), puis relancez."
  exit /b 1
)

IF NOT EXIST "node_modules" (
  echo Installation des dependances (~1 min)...
  call npm install
)

REM Ouvre le navigateur après 5s
start "" /B cmd /C "timeout /t 5 /nobreak >nul && start http://localhost:3100/evaluation"

REM Lance daemon + Next (Ctrl+C pour arrêter)
call npm run dev
