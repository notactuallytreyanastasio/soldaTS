#!/usr/bin/env node
// THE COMMISSIONER — automated "fresh blood" title defenses for the Claude
// Arena. Standalone zero-dep daemon in the watch.mjs mold: timestamps on
// every log line, try/catch around everything, never dies.
//
// Every CYCLE_MS (and once immediately on startup):
//   1. Read site/data.json and find the Big Board #1 (coach+engine).
//   2. If that same coach+engine was on the throne at the last check after a
//      crucible (or no crucible has EVER run), stage a CRUCIBLE NIGHT:
//        champion  = the fights/*.json card matching the #1 coach
//        challenger = FRESH BLOOD: the card whose coach+engine appears in the
//                     FEWEST datasets within the last 2 hours
//                     (ties -> most recently modified card file)
//   3. pnpm arena fight fights/<challenger> fights/<champion> --matches 3
//      --round 120 --arena <minutes-since-epoch % 997>
//      (chance shotgun wildcard default applies — live-fire rules).
//   4. Append the result to crucibles.jsonl; the dataset lands in datasets/
//      so the board + recency decay react automatically — a losing champion
//      bleeds decayed score and can be unseated.
//
// A freshly crowned #1 gets one cycle of peace before facing the crucible.
//
//   nohup node commissioner.mjs > commissioner.log 2>&1 & disown
//   pkill -f "node commissioner.mjs"   # to stop

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TS_ROOT = path.resolve(HERE, '..'); // soldat-ts/
const FIGHTS = path.join(TS_ROOT, 'fights');
const DATASETS = path.join(TS_ROOT, 'datasets');
const DATA_JSON = path.join(HERE, 'site', 'data.json');
const STATE_FILE = path.join(HERE, 'commissioner-state.json');
const CRUCIBLES_FILE = path.join(HERE, 'crucibles.jsonl');
const SEASON_FILE = path.join(HERE, 'season-state.json');
const LADDER_MD = path.join(FIGHTS, 'LADDER.md');
const SEASONS_MD = path.join(FIGHTS, 'SEASONS.md');

const CYCLE_MS = 30 * 1000;               // keep in sync with build.mjs — the
// sim runs a 2-min match in ~1s, so the cadence is presentation, not compute:
// 30s ≈ one best-of-3 landing on the board every refresh (Robert: "it should
// be running fast simulating the games")
const FRESH_WINDOW_MS = 2 * 60 * 60 * 1000; // "fresh blood" lookback
const FIGHT_TIMEOUT_MS = 5 * 60 * 1000;   // kill a hung fight after 5 min
// A season is a fixed 3-hour window. When it expires the commissioner declares
// the winner (the LADDER belt holder, or board #1 if the belt is VACANT),
// APPENDS a season record to fights/SEASONS.md, and rolls a fresh window.
// LADDER.md is never touched — coaches own it.
const SEASON_HOURS = 3;

function log(...args) {
  console.log(new Date().toISOString(), '[commissioner]', ...args);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

function loadState() {
  return readJson(STATE_FILE) ?? { reigning: null, lastCrucibleAt: null, cycles: 0, crucibles: 0 };
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
  } catch (e) {
    log(`WARN cannot write state: ${e.message}`);
  }
}

// --- card discovery ------------------------------------------------------------

function loadCards() {
  const cards = [];
  let files = [];
  try { files = fs.readdirSync(FIGHTS).filter((f) => f.endsWith('.json')); }
  catch (e) { log(`WARN cannot list fights/: ${e.message}`); }
  for (const f of files.sort()) {
    const full = path.join(FIGHTS, f);
    const card = readJson(full);
    if (!card || typeof card !== 'object' || !card.coach || !card.engine) continue;
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(full).mtimeMs; } catch {}
    cards.push({ file: f, coach: String(card.coach), engine: String(card.engine), mtimeMs });
  }
  return cards;
}

function championCard(cards, topRow) {
  const coach = String(topRow.coach).toUpperCase();
  const engine = String(topRow.engine);
  // Prefer an exact coach+engine card; fall back to coach-only.
  return cards.find((c) => c.coach.toUpperCase() === coach && c.engine === engine)
    ?? cards.find((c) => c.coach.toUpperCase() === coach)
    ?? null;
}

/** FRESH BLOOD: card whose coach+engine shows up in the fewest datasets of the
 *  last 2h (ties -> most recently modified card file). Never the champion. */
function pickChallenger(cards, champ, fights) {
  const cutoff = Date.now() - FRESH_WINDOW_MS;
  const counts = new Map(); // COACH|engine -> recent dataset appearances
  for (const f of fights ?? []) {
    const t = new Date(f.createdAt ?? 0).getTime();
    if (!isFinite(t) || t < cutoff) continue;
    for (const s of f.sides ?? []) {
      const k = `${String(s.coach).toUpperCase()}|${s.engine}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  const pool = cards.filter((c) =>
    !(c.coach.toUpperCase() === champ.coach.toUpperCase() && c.engine === champ.engine));
  if (!pool.length) return null;
  pool.sort((a, b) => {
    const ca = counts.get(`${a.coach.toUpperCase()}|${a.engine}`) ?? 0;
    const cb = counts.get(`${b.coach.toUpperCase()}|${b.engine}`) ?? 0;
    return ca - cb || b.mtimeMs - a.mtimeMs;
  });
  return pool[0];
}

// --- staging the fight -----------------------------------------------------------

function listDatasets() {
  try {
    return new Set(fs.readdirSync(DATASETS, { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name));
  } catch { return new Set(); }
}

function runFight(challengerFile, championFile, arenaSeed) {
  return new Promise((resolve) => {
    const args = ['arena', 'fight', `fights/${challengerFile}`, `fights/${championFile}`,
      '--matches', '3', '--round', '120', '--arena', String(arenaSeed)];
    log(`CRUCIBLE NIGHT: pnpm ${args.join(' ')}`);
    const child = spawn('pnpm', args, { cwd: TS_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const onData = (b) => { out += b.toString(); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => {
      log('WARN fight timed out — killing');
      try { child.kill('SIGKILL'); } catch {}
    }, FIGHT_TIMEOUT_MS);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: out + `\nspawn error: ${e.message}` }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

// --- one cycle ------------------------------------------------------------------

async function cycle() {
  const state = loadState();
  state.cycles = (state.cycles ?? 0) + 1;
  state.lastCheckAt = new Date().toISOString();

  const data = readJson(DATA_JSON);
  const board = data?.board ?? [];
  if (!board.length) {
    log('no board in site/data.json — is the watcher running? skipping cycle');
    saveState(state);
    return;
  }
  const top = board[0];
  const topKey = `${String(top.coach).toUpperCase()}|${top.engine}`;
  log(`board #1: ${topKey} (score ${top.score ?? '?'}, ${top.w}-${top.l} career)`);

  // Crucible due when the throne survived a full cycle (or none has ever run).
  const due = !state.lastCrucibleAt || state.reigning === topKey;
  const prevReigning = state.reigning;
  state.reigning = topKey;
  if (!due) {
    log(`throne changed (${prevReigning ?? 'none'} -> ${topKey}) — the new #1 gets one cycle of peace`);
    saveState(state);
    return;
  }

  const cards = loadCards();
  const champ = championCard(cards, top);
  if (!champ) {
    log(`#1 coach ${top.coach} has no card file in fights/ — cannot summon them, skipping`);
    saveState(state);
    return;
  }
  const challenger = pickChallenger(cards, champ, data?.fights);
  if (!challenger) {
    log('no eligible challenger card — skipping');
    saveState(state);
    return;
  }
  const arenaSeed = Math.floor(Date.now() / 1000) % 997; // fresh seed per crucible
  // (second resolution — at sub-minute cycles the old minute clock would
  // hand consecutive crucibles the same arena)
  log(`summoning FRESH BLOOD ${challenger.coach}/${challenger.engine} (${challenger.file}) ` +
      `to face champion ${champ.coach}/${champ.engine} (${champ.file}) in arena #${arenaSeed}`);

  const before = listDatasets();
  const { code, out } = await runFight(challenger.file, champ.file, arenaSeed);
  for (const line of out.trim().split('\n')) log(`  | ${line}`);
  if (code !== 0) {
    log(`WARN fight exited with code ${code} — no crucible recorded`);
    saveState(state);
    return;
  }

  // The new dataset is whatever directory appeared; challenger fought as red.
  const dataset = [...listDatasets()].filter((d) => !before.has(d)).sort().pop() ?? null;
  let series = null;
  if (dataset) {
    const st = readJson(path.join(DATASETS, dataset, 'summary.json'))?.standings;
    if (st?.red && st?.blue) {
      series = { challenger: st.red.wins, champion: st.blue.wins, draws: st.draws ?? 0,
        winner: st.red.wins > st.blue.wins ? challenger.coach
          : st.blue.wins > st.red.wins ? champ.coach : 'split' };
    }
  }
  const record = {
    ts: new Date().toISOString(),
    champion: { coach: champ.coach, engine: champ.engine, file: champ.file },
    challenger: { coach: challenger.coach, engine: challenger.engine, file: challenger.file },
    series, dataset, arena: arenaSeed,
  };
  try {
    fs.appendFileSync(CRUCIBLES_FILE, JSON.stringify(record) + '\n');
  } catch (e) {
    log(`WARN cannot append crucibles.jsonl: ${e.message}`);
  }
  log(`crucible done: ${challenger.coach} ${series ? `${series.challenger}-${series.champion}` : '?-?'} ` +
      `${champ.coach} (${series?.winner ?? 'unknown'} takes it) — dataset ${dataset ?? 'NOT FOUND'}`);

  state.lastCrucibleAt = record.ts;
  state.lastDataset = dataset;
  state.crucibles = (state.crucibles ?? 0) + 1;
  // The throne may change once the board digests the dataset; reigning stays
  // as observed at THIS check — a usurper detected next cycle gets their peace.
  saveState(state);
}

// --- main -----------------------------------------------------------------------

let running = false;
async function tick() {
  if (running) { log('previous cycle still running — skipping'); return; }
  running = true;
  try { await cycle(); }
  catch (e) { log(`CYCLE FAILED (ignored): ${e.stack ?? e.message}`); }
  finally { running = false; }
}

log(`The Commissioner is in the building (pid ${process.pid}, cycle ${CYCLE_MS / 60000}min)`);
tick(); // one cycle immediately on startup
setInterval(tick, CYCLE_MS);

process.on('uncaughtException', (e) => log(`uncaught (ignored): ${e.stack ?? e}`));
process.on('unhandledRejection', (e) => log(`unhandled rejection (ignored): ${e}`));
