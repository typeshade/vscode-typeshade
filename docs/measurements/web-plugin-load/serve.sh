#!/usr/bin/env bash
# usage: serve.sh <variant> <logfile>   starts test-web with no browser on :3001 (driver.mjs drives Chromium)
cd "$(dirname "$0")"
node make-ext.mjs "$1"
export PLAYWRIGHT_BROWSERS_PATH="$PWD/shim-browsers"
exec npx @vscode/test-web --browserType=none --coi --printServerLog --port=3001 \
  --commit=04c0d99f4fb0d8afe6ce4f0c58e31e183ac3e4b1 --quality=stable \
  --extensionDevelopmentPath="$PWD/ext" "$PWD/folder" > "$2" 2>&1
