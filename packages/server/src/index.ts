// @soldat/server — the online-1v1 game server (goal node 450).
//
// A single plain-node process: an HTTP listener whose only routes are
// GET /healthz (200 "ok") and the WebSocket upgrade (any path — in production
// Caddy routes exactly bobbby.online/arena/ws here, in dev the client dials
// ws://localhost:8902 directly). Upgraded sockets go to the Lobby, which
// pairs hello'd visitors two-by-two into Matches; each match gets its own
// ~16 ms interval driving the Game's fixed-60 Hz accumulator.
//
// Env: GAME_SERVER_PORT (default 8902). No persistence — matches live and
// die in memory; a restart simply drops everyone back to the lobby.
//
// Run: pnpm --filter @soldat/server start   (tsx — same pattern as the arena
// CLI; node can't resolve the workspace's extensionless TS imports natively).

import http from 'node:http';
import type { Socket } from 'node:net';
import { Lobby } from './lobby.js';
import { Match } from './match.js';
import { upgradeToWs } from './ws.js';

const PORT = Number(process.env.GAME_SERVER_PORT ?? 8902);
/** Match driver cadence; Game's internal accumulator fixes the 60 Hz sim. */
const TICK_INTERVAL_MS = 16;

const log = (...a: unknown[]): void => {
  console.log(new Date().toISOString(), '[game-server]', ...a);
};

/** Random int in [1, max] — seeds only (the sim itself uses world.rng). */
const roll = (max: number): number => 1 + Math.floor(Math.random() * max);

let liveMatches = 0;

const lobby = new Lobby((a, b) => {
  const opts = { seed: roll(99999), arenaSeed: roll(999) };
  const match = new Match(a, b, opts);
  liveMatches += 1;
  log(`match start (arena=${opts.arenaSeed} seed=${opts.seed}) — ${liveMatches} live`);
  let last = performance.now();
  const interval = setInterval(() => {
    const now = performance.now();
    match.tick((now - last) / 1000);
    last = now;
  }, TICK_INTERVAL_MS);
  match.onEnd = (): void => {
    clearInterval(interval);
    liveMatches -= 1;
    log(`match end (arena=${opts.arenaSeed}) — ${liveMatches} live`);
  };
});

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url !== undefined && req.url.split('?')[0] === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok\n');
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found\n');
});

server.on('upgrade', (req, socket: Socket) => {
  const conn = upgradeToWs(req, socket);
  if (conn !== null) lobby.add(conn);
});

server.listen(PORT, () => {
  log(`listening on :${PORT} (ws + /healthz)`);
});

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    log(`${sig} — shutting down`);
    server.close();
    process.exit(0);
  });
}
