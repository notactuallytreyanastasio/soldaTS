#!/usr/bin/env node
// Arena Live watcher — rebuilds the static site whenever arena inputs change
// and serves site/ over plain node http. No deps. Designed to never die:
// every rebuild is wrapped in try/catch; a bad input produces a page warning,
// not a crash.
//
//   node watch.mjs            # serve on 8901 (or next free port upward)
//   POLL: every 5s, signature of input mtimes; rebuild on change.
//   Also force-rebuilds every 60s (catches deciduous db changes etc.).

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TS_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = TS_ROOT; // the game IS the repo root now (post move-to-top)
const SITE_DIR = path.join(HERE, 'site');

const WATCH_PATHS = [
  path.join(TS_ROOT, 'datasets'),
  path.join(TS_ROOT, 'fights'),
  path.join(TS_ROOT, 'packages', 'client', 'src', 'ai'),
  path.join(REPO_ROOT, '.deciduous', 'deciduous.db'),
  path.join(REPO_ROOT, 'docs', 'graph-data.json'),
  path.join(HERE, 'index.template.html'),
  path.join(HERE, 'desk.template.html'),
  path.join(HERE, 'build.mjs'),
  path.join(HERE, 'crucibles.jsonl'),
  path.join(HERE, 'commissioner-state.json'),
  path.join(HERE, 'season-state.json'),
  path.join(HERE, 'league-state.json'),
];

const POLL_MS = 5000;
const FORCE_REBUILD_MS = 60_000;
const BASE_PORT = 8901;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

/** Cheap change signature: every watched file's path:mtime:size, one level
 *  of recursion into directories (datasets/<run>/file). */
function signature() {
  const parts = [];
  const statOne = (p) => {
    try {
      const st = fs.statSync(p);
      parts.push(`${p}:${st.mtimeMs}:${st.size}`);
      return st;
    } catch { return null; }
  };
  const walk = (p, depth) => {
    const st = statOne(p);
    if (!st || !st.isDirectory() || depth <= 0) return;
    let entries = [];
    try { entries = fs.readdirSync(p); } catch { return; }
    for (const e of entries) {
      if (e === 'node_modules' || e.startsWith('.')) continue;
      walk(path.join(p, e), depth - 1);
    }
  };
  for (const p of WATCH_PATHS) walk(p, 2);
  return parts.join('|');
}

// The build runs in a CHILD PROCESS, not in this one. Two hard lessons led
// here: (1) a static import pinned stale builder code (the brains-browser
// rollout), and a query-string dynamic re-import leaked module copies;
// (2) far worse, build() is synchronous and grew past 10s as the corpus
// crossed 1,500 datasets — run in-process it froze this same event loop
// that serves HTTP, so with the grinder triggering a rebuild every few
// seconds the pages could wait 15s+ for a 2 MB fetch and rendered EMPTY.
// A child gets fresh code every run and the server never blocks.
let building = false;
function rebuild(reason) {
  if (building) return Promise.resolve();
  building = true;
  const t0 = Date.now();
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(HERE, 'build.mjs')], {
      cwd: HERE,
      timeout: 180_000,
      maxBuffer: 16 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        log(`REBUILD FAILED (${reason}): ${err.message.split('\n')[0]}`);
        const tail = String(stderr).trim().split('\n').slice(-3).join(' | ');
        if (tail) log(`  builder stderr: ${tail}`);
        // leave the previous site/ in place — stale beats dead
      } else {
        const summary = String(stdout).trim().replace(/^\[arena-live\] built: /, '');
        log(`rebuilt (${reason}) in ${Date.now() - t0}ms — ${summary}`);
      }
      building = false;
      resolve();
    });
  });
}

// --- static server -----------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function handler(req, res) {
  try {
    let urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
    if (urlPath === '/') urlPath = '/index.html';
    const file = path.normalize(path.join(SITE_DIR, urlPath));
    if (!file.startsWith(SITE_DIR + path.sep) && file !== SITE_DIR) {
      res.writeHead(403); res.end('forbidden'); return;
    }
    let body;
    try { body = fs.readFileSync(file); }
    catch { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch (e) {
    try { res.writeHead(500); res.end('error: ' + e.message); } catch {}
  }
}

function listen(port, maxPort) {
  const server = http.createServer(handler);
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && port < maxPort) {
      log(`port ${port} taken, trying ${port + 1}`);
      listen(port + 1, maxPort);
    } else {
      log(`server error: ${e.message}`);
      process.exit(1);
    }
  });
  server.listen(port, () => {
    log(`Arena Live serving http://localhost:${port}/  (pid ${process.pid})`);
    try { fs.writeFileSync(path.join(HERE, 'watcher.port'), String(port)); } catch {}
  });
}

// --- main --------------------------------------------------------------------

rebuild('startup');
listen(BASE_PORT, BASE_PORT + 50);

let lastSig = signature();
let lastForced = Date.now();
setInterval(async () => {
  try {
    const sig = signature();
    if (sig !== lastSig) {
      await rebuild('inputs changed');
      lastForced = Date.now();
      // Re-snapshot AFTER the build: the build itself runs `deciduous graph`,
      // which appends to deciduous's command log and dirties the db mtime —
      // without this, every rebuild would trigger the next one forever.
      lastSig = signature();
    } else if (Date.now() - lastForced > FORCE_REBUILD_MS) {
      lastForced = Date.now();
      await rebuild('periodic');
      lastSig = signature();
    }
  } catch (e) {
    log(`poll error (ignored): ${e.message}`);
  }
}, POLL_MS);

process.on('uncaughtException', (e) => log(`uncaught (ignored): ${e.stack ?? e}`));
process.on('unhandledRejection', (e) => log(`unhandled rejection (ignored): ${e}`));
