#!/usr/bin/env node
// THE SPARRING DEPARTMENT — continuous random-pairing fights for training
// data volume. Standalone zero-dep daemon in the watch.mjs/commissioner.mjs
// mold: timestamps on every log line, try/catch around everything, never
// dies. Where the commissioner stages champion drama (one crucible per
// cycle, always vs the board #1), the sparring department maximizes DATASET
// DIVERSITY: every fight is a fresh random pairing of two cards with
// different engines on a fresh arena, so the replay corpus covers the whole
// matchup matrix instead of orbiting the throne.
//
//   WORKERS parallel loops, each: pick pair -> fight (best of 3, 120s
//   rounds, chance wildcard) -> log one line -> repeat. The sim runs a
//   2-minute match in ~1s, so each worker lands a series every ~6-10s of
//   wall clock; pnpm/tsx startup is most of the cost.
//
//   DISK FLOOR: before each fight, check free space on the datasets volume;
//   below FLOOR_GB the worker sleeps instead of fighting (logged, retried
//   every minute) — a runaway corpus must never wedge the machine.
//
//   nohup node sparring.mjs > sparring.log 2>&1 & disown
//   pkill -f "node sparring.mjs"   # to stop

import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TS_ROOT = path.resolve(HERE, '..');
const FIGHTS = path.join(TS_ROOT, 'fights');

const WORKERS = 3; // parallel fights (12-core box; watcher + commissioner + rival sessions share it)
const FLOOR_GB = 12; // stop producing datasets below this much free disk
const FIGHT_TIMEOUT_MS = 5 * 60 * 1000;
const FLOOR_RETRY_MS = 60 * 1000;

function log(...args) {
  console.log(new Date().toISOString(), '[sparring]', ...args);
}

function loadCards() {
  const cards = [];
  let files = [];
  try { files = fs.readdirSync(FIGHTS).filter((f) => f.endsWith('.json')); }
  catch (e) { log(`WARN cannot list fights/: ${e.message}`); }
  for (const f of files.sort()) {
    try {
      const card = JSON.parse(fs.readFileSync(path.join(FIGHTS, f), 'utf8'));
      if (card && card.coach && card.engine) {
        cards.push({ file: f, coach: String(card.coach), engine: String(card.engine) });
      }
    } catch { /* not a card */ }
  }
  return cards;
}

/** Free GiB on the volume holding datasets/ (df -g portable enough here). */
function freeGb() {
  return new Promise((resolve) => {
    execFile('df', ['-g', TS_ROOT], (err, out) => {
      if (err) return resolve(Infinity); // can't measure -> don't wedge the loop
      const line = out.trim().split('\n').pop() ?? '';
      const cols = line.split(/\s+/);
      resolve(Number(cols[3]) || Infinity);
    });
  });
}

/** Two random cards with DIFFERENT engines (same engine on both sides would
 *  homogenize into one team and record no cross-team fight). */
function pickPair(cards, rand) {
  for (let tries = 0; tries < 20; tries++) {
    const a = cards[Math.floor(rand() * cards.length)];
    const b = cards[Math.floor(rand() * cards.length)];
    if (a && b && a.file !== b.file && a.engine !== b.engine) return [a, b];
  }
  return null;
}

function runFight(a, b, arenaSeed) {
  return new Promise((resolve) => {
    const args = ['arena', 'fight', `fights/${a.file}`, `fights/${b.file}`,
      '--matches', '3', '--round', '120', '--arena', String(arenaSeed)];
    const child = spawn('pnpm', args, { cwd: TS_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    const timer = setTimeout(() => {
      log('WARN fight timed out — killing');
      try { child.kill('SIGKILL'); } catch {}
    }, FIGHT_TIMEOUT_MS);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: `${out}\nspawn error: ${e.message}` }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function worker(id) {
  // Per-worker PRNG (mulberry32) so workers don't sync up on the same pairs.
  let seed = (Date.now() ^ (id * 0x9e3779b9)) >>> 0;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  await sleep(id * 2500); // stagger startup (unique dataset dir timestamps)

  for (;;) {
    try {
      const free = await freeGb();
      if (free < FLOOR_GB) {
        log(`worker ${id}: disk floor (${free}G free < ${FLOOR_GB}G) — pausing, retry in ${FLOOR_RETRY_MS / 1000}s`);
        await sleep(FLOOR_RETRY_MS);
        continue;
      }
      const cards = loadCards(); // re-read each round: new cards join the pool live
      const pair = cards.length >= 2 ? pickPair(cards, rand) : null;
      if (!pair) {
        log(`worker ${id}: no eligible pair among ${cards.length} cards — retry in 30s`);
        await sleep(30000);
        continue;
      }
      const [a, b] = pair;
      const arenaSeed = 1 + Math.floor(rand() * 996);
      const { code, out } = await runFight(a, b, arenaSeed);
      const series = out.match(/series: .*/)?.[0]?.trim() ?? `exit ${code}`;
      const dataset = out.match(/dataset: .*\/(\S+)/)?.[1] ?? '?';
      log(`worker ${id}: ${a.coach}/${a.engine} vs ${b.coach}/${b.engine} @ arena ${arenaSeed} — ${series} (${dataset})`);
      if (code !== 0) await sleep(5000); // breathe on failures, don't spin
    } catch (e) {
      log(`worker ${id} ERROR (ignored): ${e.stack ?? e.message}`);
      await sleep(5000);
    }
  }
}

log(`The Sparring Department is open (pid ${process.pid}, ${WORKERS} workers, floor ${FLOOR_GB}G)`);
for (let i = 0; i < WORKERS; i++) void worker(i);

process.on('uncaughtException', (e) => log(`uncaught (ignored): ${e.stack ?? e}`));
process.on('unhandledRejection', (e) => log(`unhandled rejection (ignored): ${e}`));
