#!/usr/bin/env node
// Plain-node launcher for the @soldat/server game server — the arena
// supervisor spawns `node server.mjs` like every other daemon child, and this
// shim runs src/index.ts under the package's own tsx (the workspace's
// extensionless TS import chain needs it; same pattern as tools/evaluate.mjs).
// SIGTERM/SIGINT forward to the child so docker-stop stays clean.

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TSX = join(HERE, 'node_modules', '.bin', 'tsx');

const child = spawn(TSX, [join(HERE, 'src', 'index.ts')], {
  cwd: HERE,
  stdio: 'inherit',
  env: process.env,
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    try {
      child.kill(sig);
    } catch {
      /* already gone */
    }
  });
}

child.on('exit', (code, signal) => {
  process.exit(code ?? (signal !== null ? 1 : 0));
});
