#!/usr/bin/env bash
# Builds synthetic screen previews. Pass screen names to capture a subset:
# npm run preview -- apps-scenes remote-macros
# Defaults to every screen in both themes. Requires Python 3 for the local server.
set -euo pipefail
cd "$(dirname "$0")/.."
scratch=$(mktemp -d)
cp package.json "$scratch/package.json"
server_pid=''
cleanup() {
  if [ -n "$server_pid" ]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  cp "$scratch/package.json" package.json
  rm -rf "$scratch"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
npm pkg set main=preview/index.ts >/dev/null
rm -rf preview-dist
npx expo export --platform web --output-dir preview-dist
CHROME="${CHROME:-$(command -v google-chrome || command -v chromium || command -v chromium-browser || true)}"
[ -n "$CHROME" ] || { echo "No Chrome found: open preview-dist with any static server instead."; exit 0; }
# Ask the OS for an unused loopback port. Never capture an unrelated stale server.
python3 - "$PWD/preview-dist" "$scratch/port" <<'PYTHON' >"$scratch/server.log" 2>&1 &
import functools, http.server, pathlib, sys
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=sys.argv[1])
with http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler) as server:
    pathlib.Path(sys.argv[2]).write_text(str(server.server_port))
    server.serve_forever()
PYTHON
server_pid=$!
for attempt in {1..50}; do
  [ -s "$scratch/port" ] && break
  if ! kill -0 "$server_pid" 2>/dev/null; then cat "$scratch/server.log" >&2; exit 1; fi
  sleep 0.1
done
[ -s "$scratch/port" ] || { echo 'Preview server did not start' >&2; exit 1; }
port=$(cat "$scratch/port")
mkdir -p preview-shots
screens=("$@")
if [ ${#screens[@]} -eq 0 ]; then
  screens=(tasks tasks-empty tasks-offline tasks-wake task-detail activity apps apps-pinned apps-scenes clipboard files memory remote remote-macros present control settings devices devices-limited computers computers-switching automations automations-edit terminal terminal-start files-backup tabs remote-keys pair)
fi
for screen in "${screens[@]}"; do
  [[ "$screen" =~ ^[a-z0-9-]+$ ]] || { echo "Invalid screen name: $screen" >&2; exit 1; }
done
failed=0
for theme in light dark; do
  for screen in "${screens[@]}"; do
    "$CHROME" --headless=new --no-sandbox --disable-gpu --hide-scrollbars --window-size=390,844 --virtual-time-budget=6000 \
      --screenshot="preview-shots/$screen-$theme.png" "http://127.0.0.1:$port/?screen=$screen&theme=$theme" >/dev/null 2>&1 || { echo "failed: $screen $theme" >&2; failed=1; }
  done
done
ls preview-shots
exit "$failed"
