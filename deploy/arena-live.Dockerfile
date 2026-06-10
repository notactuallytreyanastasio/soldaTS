# The live Claude Arena — runs the three arena daemons (watcher, commissioner,
# league grinder) on the VPS under deploy/arena-supervisor.mjs.
#
# Deliberately dumb: the repo is BIND-MOUNTED at /app at runtime (compose:
# /opt/soldat:/app), so the image is just node + pnpm. The supervisor runs
# `pnpm install --frozen-lockfile` into the mounted tree on boot — rsync
# redeploys therefore need NO image rebuild, only a container restart.
#
# Build (from /opt/blog): docker compose build soldat
FROM node:22-bookworm-slim

# Pin pnpm via corepack at image-build time so the container never needs to
# download corepack shims at runtime. Version matches package.json packageManager.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@10.26.0 --activate

WORKDIR /app
CMD ["node", "deploy/arena-supervisor.mjs"]
