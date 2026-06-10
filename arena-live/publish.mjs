#!/usr/bin/env node
// Arena publisher — packages both dashboards + the BUILT game client into a
// self-contained static snapshot and rsyncs it to the public site:
//
//   https://bobbby.online/arena/            THE FLOOR (stock ticker)
//   https://bobbby.online/arena/desk.html   THE SKYREACH DESK (sports section)
//   https://bobbby.online/arena/play/?...   deterministic in-browser replays
//
// Everything in the snapshot is LLM-free at runtime: the brains are plain
// TypeScript functions, a watch URL re-simulates its match byte-for-byte from
// the seed in the query string. The snapshot is frozen until the next publish.
//
// Usage:
//   node publish.mjs               build snapshot + rsync + verify
//   node publish.mjs --dry         build snapshot only (arena-live/public/)
//   node publish.mjs --no-client   skip the vite build (reuse client dist/)
//   node publish.mjs --loop 10     republish every 10 minutes, forever
//
// Env: ARENA_DEPLOY_HOST (default root@5.161.181.91)
//      ARENA_DEPLOY_DIR  (default /opt/arena — mounted at /srv/arena in caddy)
//
// Server side (one-time, already wired in the blog repo's Caddyfile +
// docker-compose.yml): Caddy serves /srv/arena under bobbby.online/arena/.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from './build.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TS_ROOT = path.resolve(HERE, '..');
const SITE = path.join(HERE, 'site');
const PUBLIC = path.join(HERE, 'public');
const CLIENT = path.join(TS_ROOT, 'packages', 'client');

const HOST = process.env.ARENA_DEPLOY_HOST ?? 'root@5.161.181.91';
const DEST = process.env.ARENA_DEPLOY_DIR ?? '/opt/arena';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const NO_CLIENT = args.includes('--no-client');
const loopIdx = args.indexOf('--loop');
const LOOP_MIN = loopIdx >= 0 ? Math.max(1, Number(args[loopIdx + 1]) || 10) : 0;

// How many fights (newest-first, WITH play-by-play timelines) the public
// ticker feed carries. The full local data.json crossed 100 MB; 40 fights
// keeps the public file in single-digit MB and gzips well.
const PUBLIC_FIGHTS = 40;
// Local dev watch URLs -> the deployed client, relative to /arena/.
const LOCAL_PLAY = 'http://localhost:5173/';
const PUBLIC_PLAY = 'play/';

const log = (...a) => console.log(new Date().toISOString(), '[publish]', ...a);

/** Apply a string replacement, warning (not failing) if the needle moved. */
function sub(content, from, to, what) {
  if (!content.includes(from)) {
    log(`WARN: could not apply "${what}" (pattern not found — template drifted?)`);
    return content;
  }
  return content.split(from).join(to);
}

function publicHtml(file) {
  let html = fs.readFileSync(path.join(SITE, file), 'utf8');
  // A frozen snapshot doesn't change every 5s — poll once a minute.
  html = sub(html, 'setInterval(tick, 5000)', 'setInterval(tick, 60000)', `${file}: calm polling`);
  // The replays are deployed right next to the page now.
  if (file === 'index.html') {
    html = sub(html,
      'click anything to open the replay (needs <code>pnpm play</code> on :5173)',
      'click anything to open the replay — it re-simulates right here in your browser',
      `${file}: floor footer`);
  } else {
    html = sub(html,
      'replays need <span class="num">pnpm play</span> on :5173',
      'replays re-simulate right in your browser',
      `${file}: desk footer`);
  }
  return html;
}

function buildSnapshot() {
  log('building site data (full rebuild)…');
  const data = build(); // also refreshes site/desk-data.json + site/*.html

  fs.rmSync(PUBLIC, { recursive: true, force: true });
  fs.mkdirSync(PUBLIC, { recursive: true });

  // Ticker feed: newest N fights with timelines, everything else intact,
  // every watch URL pointed at the deployed client.
  const publicData = { ...data, fights: data.fights.slice(0, PUBLIC_FIGHTS) };
  delete publicData.warRoom; // page tolerates absence? no — keep an empty shell
  publicData.warRoom = { source: 'snapshot publish', nodes: data.warRoom?.nodes ?? [] };
  const dataJson = JSON.stringify(publicData).split(LOCAL_PLAY).join(PUBLIC_PLAY);
  fs.writeFileSync(path.join(PUBLIC, 'data.json'), dataJson);

  // Desk feed: already slim — just retarget the watch URLs.
  const deskJson = fs.readFileSync(path.join(SITE, 'desk-data.json'), 'utf8')
    .split(LOCAL_PLAY).join(PUBLIC_PLAY);
  fs.writeFileSync(path.join(PUBLIC, 'desk-data.json'), deskJson);

  fs.writeFileSync(path.join(PUBLIC, 'index.html'), publicHtml('index.html'));
  fs.writeFileSync(path.join(PUBLIC, 'desk.html'), publicHtml('desk.html'));

  // The game client: vite build with a RELATIVE base so it lives happily at
  // /arena/play/ (asset paths go through assetUrl() since the same change).
  const dist = path.join(CLIENT, 'dist');
  if (!NO_CLIENT) {
    log('building game client (vite, base=./)…');
    execFileSync('npx', ['vite', 'build', '--base=./'], { cwd: CLIENT, stdio: 'inherit' });
  }
  if (!fs.existsSync(path.join(dist, 'index.html'))) {
    throw new Error('client dist/ missing — run without --no-client');
  }
  log('copying client dist -> public/play…');
  fs.cpSync(dist, path.join(PUBLIC, 'play'), { recursive: true });

  const mb = (f) => (fs.statSync(path.join(PUBLIC, f)).size / 1e6).toFixed(1);
  log(`snapshot ready: data.json ${mb('data.json')} MB, desk-data.json ${mb('desk-data.json')} MB, ` +
      `${publicData.fights.length} fights on the public tape`);
}

function deploy() {
  log(`rsync -> ${HOST}:${DEST}`);
  execFileSync('ssh', [HOST, 'mkdir', '-p', DEST], { stdio: 'inherit' });
  execFileSync('rsync', ['-az', '--delete', `${PUBLIC}/`, `${HOST}:${DEST}/`], { stdio: 'inherit' });
  log('deployed: https://bobbby.online/arena/  (desk: /arena/desk.html)');
}

async function run() {
  buildSnapshot();
  if (!DRY) deploy();
}

await run();
if (LOOP_MIN > 0) {
  log(`looping: republish every ${LOOP_MIN} min (ctrl-c to stop)`);
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await run(); } catch (e) { log(`publish failed (will retry): ${e.message}`); }
    busy = false;
  }, LOOP_MIN * 60_000);
}
