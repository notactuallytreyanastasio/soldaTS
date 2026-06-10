#!/usr/bin/env node
// League daemon — the perpetual grinder. Guarantees a steady floor of
// recorded matches (= training data for the learned bots) by running one
// round-robin pairing per cycle, forever, under live rules (chance
// wildcard). Same never-die discipline as watch.mjs/commissioner.mjs:
// timestamps, try/catch everything, a crash logs and the loop continues.
//
//   nohup node league.mjs > league.log 2>&1 & disown
//
// Pace: one pairing (1 match, 120 s round, ~1-2 s wall) every PACE_MS.
// At 30 s that is ~120 matches/hour, ~3.7M replay rows/hour. The roster is
// re-read from the registry every full round-robin pass, so new engines
// join the grind automatically. Arena seeds rotate; match seeds advance
// per cycle so no two grinds replay the same fight. Datasets land in
// datasets/ like any fight; the watcher, decay board, and trainers pick
// them up with no further wiring.
//
// Disk: replays are the training corpus, so NOTHING is pruned here. Each
// cycle logs datasets/ size; if it crosses DISK_WARN_GB the log shouts,
// a human (or a future janitor daemon) decides what to archive.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DATASETS = path.join(ROOT, 'datasets');
const STATE_FILE = path.join(HERE, 'league-state.json');

const PACE_MS = 30_000; // one pairing per 30 s ≈ 120 matches/hour
const ROUND_SECS = 120;
const MATCHES_PER_PAIRING = 1;
const ARENA_SEEDS = [0, 5, 11, 19, 23, 31, 41, 53, 67, 88];
const DISK_WARN_GB = 8;

function log(...args) {
  console.log(new Date().toISOString(), '[league]', ...args);
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { cycle: 0, seedBase: 50_000 }; // far from coach-picked 1337-range
  }
}

function saveState(st) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(st));
  } catch (e) {
    log(`state write failed (continuing): ${e.message}`);
  }
}

/** Registered engine ids, via the arena CLI's own registry (tsx import). */
function rosterSync() {
  // engineIds() lives behind the client headless barrel; cheapest reliable
  // source from plain node is asking the arena CLI to fail helpfully:
  // `--teams nope vs nope` prints "registered: a, b, c...". Parse that.
  return new Promise((resolve) => {
    execFile('pnpm', ['arena', '--teams', '__nope__ vs __also_nope__'], {
      cwd: ROOT, timeout: 60_000,
    }, (_err, stdout, stderr) => {
      const m = /registered: ([a-z0-9_, -]+)/i.exec(String(stderr) + String(stdout));
      resolve(m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : null);
    });
  });
}

function pairings(roster) {
  const out = [];
  for (let i = 0; i < roster.length; i++)
    for (let j = i + 1; j < roster.length; j++) out.push([roster[i], roster[j]]);
  return out;
}

function datasetsSizeGb() {
  try {
    let bytes = 0;
    for (const d of fs.readdirSync(DATASETS)) {
      const dir = path.join(DATASETS, d);
      try {
        for (const f of fs.readdirSync(dir)) bytes += fs.statSync(path.join(dir, f)).size;
      } catch { /* file, not dir */ }
    }
    return bytes / 1e9;
  } catch {
    return 0;
  }
}

function runPairing(a, b, seedBase, arenaSeed) {
  return new Promise((resolve) => {
    execFile('pnpm', [
      'arena', '--teams', `${a} vs ${b}`,
      '--matches', String(MATCHES_PER_PAIRING),
      '--round', String(ROUND_SECS),
      '--seed', String(seedBase),
      '--arena', String(arenaSeed),
    ], { cwd: ROOT, timeout: 180_000 }, (err, stdout) => {
      if (err) {
        log(`pairing ${a} vs ${b} FAILED (continuing): ${err.message.split('\n')[0]}`);
        resolve(false);
        return;
      }
      const verdict = /standings: (.*)$/m.exec(String(stdout));
      log(`${a} vs ${b} · seed ${seedBase} · arena #${arenaSeed} · ${verdict ? verdict[1] : 'done'}`);
      resolve(true);
    });
  });
}

let roster = null;
let queue = [];
const state = loadState();
log(`grinder up — pace ${PACE_MS / 1000}s/pairing, resuming at cycle ${state.cycle}`);

async function cycle() {
  try {
    if (!queue.length) {
      const fresh = await rosterSync();
      if (fresh && fresh.length >= 2) roster = fresh;
      if (!roster) { log('no roster yet (registry unreachable) — retrying next cycle'); return; }
      queue = pairings(roster);
      log(`new round-robin pass: ${roster.length} engines, ${queue.length} pairings`);
      const gb = datasetsSizeGb();
      log(`datasets/ at ${gb.toFixed(2)} GB${gb > DISK_WARN_GB ? ' — OVER WARN THRESHOLD, consider archiving' : ''}`);
    }
    const [a, b] = queue.shift();
    state.cycle += 1;
    state.seedBase += MATCHES_PER_PAIRING;
    await runPairing(a, b, state.seedBase, ARENA_SEEDS[state.cycle % ARENA_SEEDS.length]);
    saveState(state);
  } catch (e) {
    log(`cycle error (ignored): ${e.message}`);
  }
}

cycle();
setInterval(cycle, PACE_MS);
process.on('uncaughtException', (e) => log(`uncaught (ignored): ${e.stack ?? e}`));
process.on('unhandledRejection', (e) => log(`unhandled rejection (ignored): ${e}`));
