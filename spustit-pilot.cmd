@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Nainstalujte Node.js 24 nebo novejsi a spustte tento soubor znovu.
  pause
  exit /b 1
)
echo Po spusteni serveru otevrete http://127.0.0.1:4196/
node --env-file-if-exists=.env.local server.mjs
if errorlevel 1 pause
