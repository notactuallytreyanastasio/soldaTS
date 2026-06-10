#!/bin/bash
set -euo pipefail

# Deploy the LIVE Claude Arena to the Hetzner VPS.
#
#   ./deploy/deploy-arena-live.sh [user@host]
#
# What it does:
#   1. rsync this repo -> $HOST:/opt/soldat (the soldat container bind-mounts
#      it at /app and the supervisor pnpm-installs into it, so a redeploy is
#      JUST this rsync + a container restart — no image rebuild needed).
#   2. ssh: docker compose build/up the `soldat` service (defined in the blog
#      repo's /opt/blog/docker-compose.yml) and restart it to pick up code.
#
# Sync policy (the server OWNS its own arena once live):
#   - replay blobs (*.replay.jsonl.gz) never travel: the site re-simulates
#     replays from the seed; manifests/summaries/events/telemetry DO travel so
#     the board and the desk's history carry the local story.
#   - server-grown datasets are PROTECTED from --delete (they don't exist
#     locally; deleting them would wipe the server's corpus).
#   - server-owned mutable state (daemon state files, logs, watcher.port)
#     never travels — the server keeps its own season clock, crucible ledger
#     position, and league cycle.
#   - story ledgers (crucibles.jsonl, history.jsonl, fights/SEASONS.md,
#     datasets/LIVE.json) travel ONCE (--ignore-existing): they seed the
#     server's history on first deploy, then the server appends its own.

HOST="${1:-${ARENA_DEPLOY_HOST:-root@5.161.181.91}}"
DEST="/opt/soldat"
HERE="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> Syncing soldat repo -> $HOST:$DEST ..."
ssh "$HOST" mkdir -p "$DEST"

rsync -az --delete --info=stats1 \
  --filter='protect datasets/***' \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude '.pnpm-store' \
  --exclude '*.replay.jsonl.gz' \
  --exclude 'datasets/LIVE.json' \
  --exclude 'arena-live/site' \
  --exclude 'arena-live/public' \
  --exclude 'arena-live/*.log' \
  --exclude 'arena-live/watcher.port' \
  --exclude 'arena-live/commissioner-state.json' \
  --exclude 'arena-live/league-state.json' \
  --exclude 'arena-live/season-state.json' \
  --exclude 'arena-live/crucibles.jsonl' \
  --exclude 'arena-live/history.jsonl' \
  --exclude 'fights/SEASONS.md' \
  --exclude 'tools/checkpoints' \
  --exclude 'packages/client/dist' \
  --exclude '.DS_Store' \
  "$HERE/" "$HOST:$DEST/"

echo "==> Seeding story ledgers (first deploy only — server appends its own after)..."
rsync -az --ignore-existing \
  "$HERE/arena-live/crucibles.jsonl" \
  "$HERE/arena-live/history.jsonl" \
  "$HOST:$DEST/arena-live/" 2>/dev/null || true
rsync -az --ignore-existing "$HERE/fights/SEASONS.md" "$HOST:$DEST/fights/" 2>/dev/null || true
rsync -az --ignore-existing "$HERE/datasets/LIVE.json" "$HOST:$DEST/datasets/" 2>/dev/null || true

echo "==> Building + (re)starting the soldat service on $HOST ..."
ssh "$HOST" bash -s <<'REMOTE'
  set -euo pipefail
  cd /opt/blog
  docker compose build soldat
  docker compose up -d soldat
  # Code changes land via the bind mount; restart so running daemons reload.
  docker compose restart soldat
  docker compose ps soldat
REMOTE

echo "==> Done. Live at https://bobbby.online/arena/ (supervisor logs: ssh $HOST docker compose -f /opt/blog/docker-compose.yml logs -f soldat)"
