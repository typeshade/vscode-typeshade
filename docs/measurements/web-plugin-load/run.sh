#!/usr/bin/env bash
# usage: [COI=1] run.sh <variant> <logfile>   (variant: esm | esm-scoped | esm-js | esm-nobrowser | esm-multi | cjs)
set -u
cd "$(dirname "$0")"
node make-ext.mjs "$1"
export PLAYWRIGHT_BROWSERS_PATH="$PWD/shim-browsers"
COMMIT=04c0d99f4fb0d8afe6ce4f0c58e31e183ac3e4b1
timeout 200 npx @vscode/test-web --browserType=chromium --headless ${COI:+--coi} --verbose --printServerLog \
  --commit=$COMMIT --quality=stable \
  --extensionDevelopmentPath="$PWD/ext" --extensionTestsPath="$PWD/ext/test/index.js" \
  "$PWD/folder" > "$2" 2>&1
echo "exit $?"
