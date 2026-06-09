#!/usr/bin/env bash
# Downloads the OpenSoldat base assets (soldat.smod) and extracts the gfx/sfx/
# maps the web client needs into packages/client/public/. Assets are NOT
# committed (large + licensed); run this once after cloning.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
PUB="$HERE/packages/client/public"
SMOD="${SMOD:-/tmp/soldat.smod}"
URL="https://github.com/opensoldat/base/releases/download/v0.2/soldat.smod"
SHA1="bf87492d10563319839cec7dc414976deffeba25"

if [ ! -f "$SMOD" ]; then
  echo "Downloading soldat.smod (~109 MB)…"
  curl -fL "$URL" -o "$SMOD"
fi
got="$(shasum "$SMOD" | awk '{print $1}')"
[ "$got" = "$SHA1" ] || { echo "SHA1 mismatch: $got != $SHA1"; exit 1; }

mkdir -p "$PUB"
echo "Extracting gfx / objects / sfx / maps…"
unzip -oq "$SMOD" 'gostek-gfx/*' 'weapons-gfx/*' 'sparks-gfx/*' 'objects-gfx/*' 'interface-gfx/*' -d "$PUB/gfx"
unzip -oq "$SMOD" 'objects/gostek.po' -d "$PUB"
unzip -oq "$SMOD" 'sfx/*' -d "$PUB"
unzip -oq "$SMOD" 'maps/*.pms' -d "$PUB"
unzip -oq "$SMOD" 'textures/*' -d "$PUB"
echo "Done. Assets in $PUB"
