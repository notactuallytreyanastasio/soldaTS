#!/usr/bin/env node
// Autopilot gate runner — plays N headless matches of the disciple (with
// WHATEVER discipleWeights.ts is currently in the tree) against a fixed
// opponent on fixed seeds, and prints one machine-readable result line:
//
//   GATE_RESULT {"matches":[...],"wins":W,"diff":D}
//
// tools/autopilot.mjs calls this twice for its paired head-to-head gate:
// once with the freshly trained weights in place, once with the HEAD weights
// swapped in — same seeds/arenas both times, so the comparison is paired and
// the difference is pure policy. The static import of discipleWeights.ts is
// exactly why this is a SEPARATE process: each run binds the weights file as
// it exists on disk at spawn time.
//
// Usage: node tools/autopilot-gate.mjs --opponent cuadrilla [--matches 5]
//        [--seed-base 40000] [--round-ticks 3600] [--opponent-tweaks '{"K":1}']
//
// Zero npm deps; the import chain is extensionless TS, so this re-execs
// itself under the arena package's tsx once (same trick as tools/evolve.mjs).

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = join(dirname(SELF), '..');
const TSX = join(ROOT, 'packages/arena/node_modules/.bin/tsx');

if (process.env.GATE_TSX !== '1') {
  const r = spawnSync(TSX, [SELF, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, GATE_TSX: '1' },
  });
  process.exit(r.status ?? 1);
}

const { runMatch } = await import('../packages/arena/src/runner.ts');
await import('../packages/client/src/ai/index.ts'); // registers all engines

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
const OPPONENT = flag('opponent', 'cuadrilla');
const MATCHES = Number(flag('matches', 5));
const SEED_BASE = Number(flag('seed-base', 40000));
const ROUND_TICKS = Number(flag('round-ticks', 3600));
const TWEAKS = JSON.parse(flag('opponent-tweaks', 'null')) ?? undefined;

// Same arena rotation evolve trains against — known-fair layouts.
const ARENAS = [0, 5, 11, 23, 41];

const matches = [];
let wins = 0;
let diff = 0;
for (let k = 0; k < MATCHES; k++) {
  const arenaSeed = ARENAS[k % ARENAS.length];
  const seed = SEED_BASE + k * 101 + 7;
  const r = runMatch({
    arenaSeed,
    seed,
    roundTicks: ROUND_TICKS,
    teams: [{ engine: 'disciple' }, { engine: OPPONENT, tweaks: TWEAKS }],
  }).round;
  if (r === null) continue; // scoreless tick-cap — shouldn't happen
  const d = r.redKills - r.blueKills;
  diff += d;
  if (r.winnerTeam === 1) wins++;
  matches.push({ arenaSeed, seed, redKills: r.redKills, blueKills: r.blueKills, d });
}

console.log('GATE_RESULT ' + JSON.stringify({ opponent: OPPONENT, matches, wins, diff }));
