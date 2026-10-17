#!/usr/bin/env bash
# Builds the mocked-screen preview as a static web page in ./preview-dist, then (if Chrome is found) screenshots every screen in light and dark into ./preview-shots.
set -euo pipefail
cd "$(dirname "$0")/.."
cp package.json /tmp/orbit-package.json.bak
trap 'cp /tmp/orbit-package.json.bak package.json' EXIT
npm pkg set main=preview/index.ts >/dev/null
rm -rf preview-dist
npx expo export --platform web --output-dir preview-dist
CHROME="${CHROME:-$(command -v google-chrome || command -v chromium || command -v chromium-browser || true)}"
[ -n "$CHROME" ] || { echo "No Chrome found: open preview-dist with any static server instead."; exit 0; }
(cd preview-dist && python3 -m http.server 8099 >/dev/null 2>&1 & echo $! > /tmp/orbit-preview.pid)
sleep 1
mkdir -p preview-shots
for theme in light dark; do
  for screen in tasks tasks-empty tasks-offline tasks-wake task-detail activity apps apps-pinned apps-scenes clipboard files memory remote control settings pair; do
    "$CHROME" --headless=new --no-sandbox --disable-gpu --hide-scrollbars --window-size=390,844 --virtual-time-budget=6000 \
      --screenshot="preview-shots/$screen-$theme.png" "http://localhost:8099/?screen=$screen&theme=$theme" >/dev/null 2>&1 || echo "failed: $screen $theme"
  done
done
kill "$(cat /tmp/orbit-preview.pid)" 2>/dev/null || true
ls preview-shots
