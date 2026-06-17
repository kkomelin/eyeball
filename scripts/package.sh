#!/usr/bin/env bash
# Prepares a Chrome Web Store upload: validates the extension, runs the tests,
# and packs only the runtime files into dist/eyeball-v<version>.zip.
set -euo pipefail

cd "$(dirname "$0")/.."

# Runtime files that ship to the store - keep in sync with manifest.json.
FILES=(
  manifest.json
  background.js
  content.js
  eye.js
  icons/icon16.png
  icons/icon32.png
  icons/icon48.png
  icons/icon128.png
)

echo "==> Validating manifest.json"
VERSION=$(node -p 'const m = JSON.parse(require("fs").readFileSync("manifest.json", "utf8"));
  if (m.manifest_version !== 3 || !m.version || !m.name) throw new Error("manifest missing required fields");
  m.version')
PKG_VERSION=$(node -p 'JSON.parse(require("fs").readFileSync("package.json", "utf8")).version')
if [[ "$VERSION" != "$PKG_VERSION" ]]; then
  echo "Warning: manifest.json version ($VERSION) != package.json version ($PKG_VERSION)" >&2
fi

echo "==> Checking packaged files exist"
for f in "${FILES[@]}"; do
  [[ -f "$f" ]] || { echo "Error: missing file: $f" >&2; exit 1; }
done

echo "==> Running tests"
npm test --silent

if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
  echo "Warning: working tree has uncommitted changes; the zip is built from the working tree, not from git." >&2
fi

OUT="dist/eyeball-v${VERSION}.zip"
mkdir -p dist
rm -f "$OUT"
# -X strips OS-specific extra fields for a reproducible, minimal archive
zip -q -X "$OUT" "${FILES[@]}"

echo "==> Built $OUT"
unzip -l "$OUT"

cat <<'CHECKLIST'

Upload at: https://chrome.google.com/webstore/devconsole

Pre-publish checklist:
  1. Bump "version" in manifest.json (and package.json) if this version
     number was already published - the store rejects reused versions.
  2. Privacy practices tab: declare that the extension collects no data and
     makes no network requests (see PRIVACY.md). The host permission
     "<all_urls>" is used only to read mousemove coordinates - justify this
     clearly. The "alarms" permission powers the periodic blink.
  3. Listing assets: screenshots (1280x800 or 640x400) and the 128px icon.
CHECKLIST
