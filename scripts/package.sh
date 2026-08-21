#!/bin/bash
# Build a load-unpacked-ready zip of the extension: scripts/package.sh
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./manifest.json').version" 2>/dev/null \
  || grep -m1 '"version"' manifest.json | sed -E 's/.*"([0-9.]+)".*/\1/')
OUT="pile-v${VERSION}.zip"

rm -f "$OUT"
zip -r -X -q "$OUT" manifest.json src assets README.md -x "*.DS_Store"
echo "built $OUT"
