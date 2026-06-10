#!/usr/bin/env node
// Arena supervisor — pid 1 of the live-arena container on the VPS.
//
// Boot:  pnpm install --frozen-lockfile against the bind-mounted repo
//        (/opt/soldat on the host is mounted at /app, so node_modules lives
//        ON THE HOST and survives container recreation; reinstall is a fast
//        no-op check. The pnpm store also lives in the tree (.pnpm-store) so
//        redeploys never re-download. No named volumes needed.)
// Then:  start the three arena daemons as children with prefixed logs:
//          watch        arena-live/watch.mjs        (HTTP on $PORT, def 8901)
//          commissioner arena-live/commissioner.mjs (crucibles/title bouts/seasons)
//          league       arena-live/league.mjs       (the grinder: 1 pairing/30s)
// Rule:  any child that dies is restarted after RESTART_BACKOFF_MS.
//        SIGTERM/SIGINT kills all children and exits — docker-stop friendly.
//
// Env: PORT (watcher http port, default 8901)
//      ARENA_WATCH_BASE (inherited by build.mjs via watch.mjs — watch URLs base)

import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const LIVE = path.join(ROOT, 'arena-live');

const RESTART_BACKOFF_MS = 5000;
const STORE_DIR = path.join(ROOT, '.pnpm-store');

const log = (tag, ...a) => console.log(new Date().toISOString(), `[${tag}]`, ...a);

// --- bootstrap: install deps into the mounted tree ---------------------------

function install() {
  for (let attempt = 1; ; attempt++) {
    log('supervisor', `pnpm install --frozen-lockfile (attempt ${attempt})…`);
    const r = spawnSync('pnpm', [
      'install', '--frozen-lockfile', '--store-dir', STORE_DIR,
    ], { cwd: ROOT, stdio: 'inherit' });
    if (r.status === 0) { log('supervisor', 'install ok'); return; }
    log('supervisor', `install failed (status ${r.status ?? r.error?.message}) — retrying in 15s`);
    spawnSync('sleep', ['15']);
    if (attempt >= 20) throw new Error('pnpm install failed 20 times — giving up');
  }
}

// --- children -----------------------------------------------------------------

const CHILDREN = [
  { tag: 'watch', script: path.join(LIVE, 'watch.mjs') },
  { tag: 'commissioner', script: path.join(LIVE, 'commissioner.mjs') },
  { tag: 'league', script: path.join(LIVE, 'league.mjs') },
];

let shuttingDown = false;
const procs = new Map(); // tag -> ChildProcess

function pipePrefixed(stream, tag) {
  let buf = '';
  stream.on('data', (b) => {
    buf += b.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) console.log(`[${tag}]`, line);
    }
  });
}

function start(child) {
  if (shuttingDown) return;
  log('supervisor', `starting ${child.tag} (${path.relative(ROOT, child.script)})`);
  const p = spawn(process.execPath, [child.script], {
    cwd: path.dirname(child.script),
    env: process.env, // PORT + ARENA_WATCH_BASE flow through
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  procs.set(child.tag, p);
  pipePrefixed(p.stdout, child.tag);
  pipePrefixed(p.stderr, child.tag);
  p.on('exit', (code, signal) => {
    procs.delete(child.tag);
    if (shuttingDown) return;
    log('supervisor', `${child.tag} exited (code ${code}, signal ${signal}) — restart in ${RESTART_BACKOFF_MS / 1000}s`);
    setTimeout(() => start(child), RESTART_BACKOFF_MS);
  });
  p.on('error', (e) => {
    log('supervisor', `${child.tag} spawn error: ${e.message} — restart in ${RESTART_BACKOFF_MS / 1000}s`);
    procs.delete(child.tag);
    if (!shuttingDown) setTimeout(() => start(child), RESTART_BACKOFF_MS);
  });
}

function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('supervisor', `${sig} — stopping children`);
  for (const [tag, p] of procs) {
    log('supervisor', `kill ${tag} (pid ${p.pid})`);
    try { p.kill('SIGTERM'); } catch {}
  }
  // Hard-exit fallback if a child ignores SIGTERM.
  setTimeout(() => process.exit(0), 8000).unref();
  const wait = setInterval(() => {
    if (procs.size === 0) { clearInterval(wait); process.exit(0); }
  }, 200);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (e) => log('supervisor', `uncaught (ignored): ${e.stack ?? e}`));
process.on('unhandledRejection', (e) => log('supervisor', `unhandled rejection (ignored): ${e}`));

// --- main -----------------------------------------------------------------------

log('supervisor', `arena supervisor up (pid ${process.pid}, node ${process.version})`);
install();
for (const c of CHILDREN) start(c);
