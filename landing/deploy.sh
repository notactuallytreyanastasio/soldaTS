#!/bin/bash
set -euo pipefail
# Deploy the SOLDAT, REWRITTEN landing page (goal node 533).
# -L resolves the img symlink into real files on the server.
HOST="${1:-root@5.161.181.91}"
rsync -azL --delete "$(dirname "$0")/" "$HOST:/opt/soldat-landing/"
echo "deployed -> https://soldat.bobbby.online/ (needs the soldat DNS record in Cloudflare)"
