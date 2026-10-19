@echo off
rem Personal Agent - Windows double-click launcher.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22+ is required. Install it from https://nodejs.org and run this again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing dependencies (first run only)...
  call npm install || goto :err
  call npx playwright install chromium || goto :err
)
if not exist dist call npm run build || goto :err
echo Starting Personal Agent on http://127.0.0.1:8787
start "" http://127.0.0.1:8787
call npm start
goto :eof
:err
echo Setup failed. See the message above.
pause
