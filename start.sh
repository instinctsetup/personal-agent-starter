#!/bin/sh
# Personal Agent - one-command setup and launch.
set -e
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22+ is required. Install it from https://nodejs.org and run this again."
  exit 1
fi
NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Node.js 22+ is required (you have $(node --version))."
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "Installing dependencies (first run only)..."
  npm install
  npx playwright install chromium
fi
if [ ! -d dist ] || [ src2 -nt dist ] || [ ! -d web-v2/dist ]; then
  npm run build
  npm run build:ui
fi
echo "Starting Personal Agent..."
(sleep 2; (command -v open >/dev/null && open http://127.0.0.1:8787) || (command -v xdg-open >/dev/null && xdg-open http://127.0.0.1:8787) || true) &
node dist/src2/server.js
