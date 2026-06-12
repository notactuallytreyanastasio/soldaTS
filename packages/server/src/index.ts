// @soldat/server — the online team-vs-team game server (goal node 450).
// Two humans pair up, each picks the bot engine for their side, and the match
// runs 3v3: human + 2 bots per team.
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
import { Arena } from './arena.js';
import type { Match } from './match.js';
import { upgradeToWs } from './ws.js';

const PORT = Number(process.env.GAME_SERVER_PORT ?? 8902);
/** Match driver cadence; Game's internal accumulator fixes the 60 Hz sim. */
const TICK_INTERVAL_MS = 16;

const log = (...a: unknown[]): void => {
  console.log(new Date().toISOString(), '[game-server]', ...a);
};

/** Random int in [1, max] — seeds only (the sim itself uses world.rng). */
const roll = (max: number): number => 1 + Math.floor(Math.random() * max);

// One global stage (goal node 551): two players, everyone else spectates and
// queues. The Arena owns participants; here we only drive each match's clock.
const drivers = new Map<Match, ReturnType<typeof setInterval>>();

const arena = new Arena({
  rollSeeds: () => ({ seed: roll(99999), arenaSeed: roll(999) }),
  onMatchStart: (match) => {
    let last = performance.now();
    const interval = setInterval(() => {
      const now = performance.now();
      match.tick((now - last) / 1000);
      last = now;
    }, TICK_INTERVAL_MS);
    drivers.set(match, interval);
    log(
      `match start (red=${match.teamEngines[0]} blue=${match.teamEngines[1]}) — ` +
        `${arena.playerCount} players, ${arena.spectatorCount} watching`,
    );
  },
  onMatchEnd: (match) => {
    const interval = drivers.get(match);
    if (interval !== undefined) {
      clearInterval(interval);
      drivers.delete(match);
    }
    log(`match end — ${arena.spectatorCount} in queue`);
  },
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
  if (conn !== null) arena.add(conn);
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
