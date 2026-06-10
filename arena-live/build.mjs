#!/usr/bin/env node
// Arena Live — static-site builder for the Claude Arena play-by-play page.
//
// Scans (read-only):
//   soldat-ts/datasets/*/{manifest,summary}.json + match-N.events.jsonl.gz
//   soldat-ts/fights/*.json + LADDER.md
//   soldat-ts/packages/client/src/ai/*.ts   (doctrine header comments)
//   `deciduous graph` (fallback: <repo>/docs/graph-data.json)
//
// Emits: arena-live/site/{index.html,data.json}
// Zero deps. Never throws on a malformed input — skips it and records a
// warning that the page displays.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TS_ROOT = path.resolve(HERE, '..'); // soldat-ts/
const REPO_ROOT = TS_ROOT; // the game IS the repo root now (post move-to-top) // git repo root
const SITE_DIR = path.join(HERE, 'site');
const DATASETS = path.join(TS_ROOT, 'datasets');
const FIGHTS = path.join(TS_ROOT, 'fights');
const AI_DIR = path.join(TS_ROOT, 'packages', 'client', 'src', 'ai');

// Mirror of BOT_NAMES in packages/client/src/ai/../app/director.ts —
// needed to turn event-stream sprite indices into the names the watch
// replay (and summary.json) shows. nameOffset = matchSeed * 7.
const BOT_NAMES = [
  'Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot',
  'Golf', 'Hotel', 'India', 'Juliett', 'Kilo', 'Lima',
  'Maverick', 'Viper', 'Goose', 'Iceman', 'Jester', 'Slider',
  'Raven', 'Hawk', 'Falcon', 'Osprey', 'Condor', 'Kestrel',
  'Bullet', 'Tracer', 'Ricochet', 'Magnum', 'Trigger', 'Scope',
  'Dynamo', 'Turbine', 'Piston', 'Throttle', 'Afterburn', 'Nitro',
  'Specter', 'Wraith', 'Phantom', 'Banshee', 'Reaver', 'Ghost',
  'Comet', 'Meteor', 'Nova', 'Quasar', 'Pulsar', 'Zenith',
];

function subjectName(index, playerIndex, nameOffset) {
  if (index === playerIndex) return 'You';
  const n = BOT_NAMES.length;
  const at = (((index - playerIndex - 1 + nameOffset) % n) + n) % n;
  return BOT_NAMES[at] ?? `Bot ${index}`;
}

const warnings = [];
function warn(msg) {
  warnings.push(msg);
  console.error(`[arena-live] WARN: ${msg}`);
}

function readJson(file) {
  try {
    // Datasets gzip their JSON now; old runs may also have been
    // retro-compressed (name.json -> name.json.gz) behind a stale manifest —
    // or the reverse. Resolve either direction before giving up.
    let buf;
    try {
      buf = fs.readFileSync(file);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      buf = fs.readFileSync(file.endsWith('.gz') ? file.slice(0, -3) : `${file}.gz`);
    }
    const raw = buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf;
    return JSON.parse(raw.toString('utf8'));
  } catch (e) {
    warn(`unreadable JSON ${path.relative(TS_ROOT, file)}: ${e.message}`);
    return null;
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

// --- fighter cards -----------------------------------------------------------

function loadCards() {
  const cards = [];
  let files = [];
  try {
    files = fs.readdirSync(FIGHTS).filter((f) => f.endsWith('.json'));
  } catch (e) {
    warn(`cannot list fights/: ${e.message}`);
  }
  for (const f of files.sort()) {
    const full = path.join(FIGHTS, f);
    const card = readJson(full);
    if (!card || typeof card !== 'object') continue;
    let mtime = null;
    try { mtime = fs.statSync(full).mtime.toISOString(); } catch {}
    cards.push({
      file: `fights/${f}`,
      coach: card.coach ?? '(no coach)',
      engine: card.engine ?? '(no engine)',
      tweaks: card.tweaks ?? {},
      rationale: card.rationale ?? '',
      updatedAt: mtime,
    });
  }
  return cards;
}

// --- engine doctrines --------------------------------------------------------

/** Parse the `export const X_DEFAULTS = {...}` block into knob rows:
 *  { key, value, doc } — inline `//` comments plus continuation comment
 *  lines become the knob's documentation. Best-effort: a knob whose value
 *  isn't a plain numeric literal is skipped, never fatal. */
function parseKnobs(src) {
  const m = /export const \w+_DEFAULTS[^=]*=\s*\{([\s\S]*?)\n\};/.exec(src);
  if (!m) return [];
  const knobs = [];
  for (const raw of m[1].split('\n')) {
    const knob = /^\s*([A-Z][A-Z0-9_]*):\s*(-?[\d.]+)\s*,?\s*(?:\/\/\s?(.*))?$/.exec(raw);
    if (knob) {
      knobs.push({ key: knob[1], value: Number(knob[2]), doc: knob[3] ?? '' });
      continue;
    }
    const cont = /^\s*\/\/\s?(.*)$/.exec(raw);
    if (cont && knobs.length > 0) {
      const last = knobs[knobs.length - 1];
      last.doc = (last.doc ? last.doc + ' ' : '') + cont[1].trim();
    }
  }
  return knobs;
}

function loadDoctrines() {
  const out = [];
  let files = [];
  try {
    files = fs
      .readdirSync(AI_DIR)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .filter((f) => !['engine.ts', 'index.ts', 'tweaks.ts'].includes(f));
  } catch (e) {
    warn(`cannot list ai/: ${e.message}`);
    return out;
  }
  for (const f of files.sort()) {
    const src = readText(path.join(AI_DIR, f));
    if (src === null) { warn(`unreadable ${f}`); continue; }
    const lines = [];
    for (const line of src.split('\n')) {
      const t = line.trim();
      if (t.startsWith('//')) lines.push(t.replace(/^\/\/ ?/, ''));
      else if (t === '') { if (lines.length > 0) lines.push(''); }
      else break; // first code line ends the header
    }
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    if (lines.length === 0) continue;

    // Brain-browser enrichment (all best-effort, never fatal):
    // a real ENGINE has a createBrain factory — helper modules
    // (neuralWeights, neuralFeatures, …) carry headers but no brain.
    const isEngine = /createBrain\s*[:(]/.test(src);
    // `// "wolf" bot engine — the pack hunter, the sixth doctrine.`
    const tag = /^"?[\w-]+"? bot engine\s*—\s*(.*?)\.?$/.exec(lines[0] ?? '');
    // The one-line strategy string shown on engine banners.
    const strat = /strategy:\s*\r?\n?\s*(['"])([\s\S]*?)\1/.exec(src);
    out.push({
      engine: f.replace(/\.ts$/, ''),
      file: `packages/client/src/ai/${f}`,
      doctrine: lines.join('\n'),
      isEngine,
      tagline: tag ? tag[1] : null,
      strategy: strat ? strat[2].replace(/\s+/g, ' ').trim() : null,
      knobs: isEngine ? parseKnobs(src) : [],
    });
  }
  return out;
}

// --- datasets ----------------------------------------------------------------

/** Parse coach names out of a runId like 20260610-044923-VEGA-pilot-vs-OKONKWO-reaper. */
function coachesFromRunId(runId, engineA, engineB) {
  const m = /^\d{8}-\d{6}-(.+)-vs-(.+)$/.exec(runId ?? '');
  if (!m) return [null, null];
  const side = (s, engine) => {
    if (engine && s.toLowerCase().endsWith(`-${engine.toLowerCase()}`)) {
      return s.slice(0, s.length - engine.length - 1);
    }
    if (engine && s.toLowerCase() === engine.toLowerCase()) return null; // bare engine, no coach
    return null;
  };
  return [side(m[1], engineA), side(m[2], engineB)];
}

function tweaksToParam(tweaks) {
  return Object.entries(tweaks ?? {}).map(([k, v]) => `${k}=${v}`).join(',');
}

// Where watch URLs point. Local dev: the vite server on :5173. Live deploy
// (the VPS docker service) sets ARENA_WATCH_BASE=/arena/play so every click
// opens the statically deployed client next to the proxied dashboards —
// window.open() resolves an absolute-path URL against the current origin.
const WATCH_BASE = (process.env.ARENA_WATCH_BASE ?? 'http://localhost:5173').replace(/\/+$/, '');

/** Same shape as packages/arena/src/fighterCard.ts buildWatchUrl. */
function buildWatchUrl(a, b, { seed, roundSecs, arenaSeed, wildcard }) {
  const params = new URLSearchParams();
  params.set('spectate', '');
  params.set('ai', `${a.engine},${b.engine}`);
  params.set('teams', '');
  params.set('seed', String(seed));
  params.set('round', String(roundSecs));
  if (arenaSeed > 0) params.set('arena', String(arenaSeed));
  if (wildcard) params.set('wildcard', wildcard); // resolved per match (chance era)
  if (tweaksToParam(a.tweaks) !== '') params.set('tweak-a', tweaksToParam(a.tweaks));
  if (tweaksToParam(b.tweaks) !== '') params.set('tweak-b', tweaksToParam(b.tweaks));
  params.set('coach-a', a.coach);
  params.set('coach-b', b.coach);
  return `${WATCH_BASE}/?${params.toString()}`;
}

function loadKills(dir, eventsFile) {
  const full = path.join(dir, eventsFile);
  try {
    const buf = fs.readFileSync(full);
    // gzip magic 1f 8b; some early datasets wrote plain .jsonl
    const raw = buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf;
    const kills = [];
    for (const line of raw.toString('utf8').split('\n')) {
      if (!line.includes('"kill"')) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'kill') kills.push(ev);
      } catch { /* skip bad line */ }
    }
    return kills;
  } catch (e) {
    warn(`cannot read events ${path.relative(TS_ROOT, full)}: ${e.message}`);
    return null;
  }
}

function fmtClock(tick, hz = 60) {
  const s = Math.floor(tick / hz);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function loadDataset(name, cardByEngine) {
  const dir = path.join(DATASETS, name);
  const manifest = readJson(path.join(dir, 'manifest.json'));
  const summary = readJson(path.join(dir, 'summary.json'));
  if (!manifest) {
    warn(`dataset ${name}: missing/bad manifest.json — skipped`);
    return null;
  }
  const teams = Array.isArray(manifest.teams) ? manifest.teams : [];
  const engineA = teams[0]?.engine ?? '?';
  const engineB = teams[1]?.engine ?? '?';
  const [coachA, coachB] = coachesFromRunId(manifest.runId ?? name, engineA, engineB);
  const arenaSeed = (() => {
    const m = /--arena\s+(\d+)/.exec(manifest.cli ?? '');
    return m ? Number(m[1]) : 0;
  })();
  const roundSecs = Math.round((manifest.roundTicks ?? 5400) / 60);

  const sideA = {
    team: 1, color: 'red',
    coach: coachA ?? (cardByEngine.get(engineA)?.coach ?? engineA.toUpperCase()),
    coachKnown: coachA !== null,
    engine: engineA,
    tweaks: teams[0]?.requestedTweaks ?? {},
    resolvedTweaks: teams[0]?.resolvedTweaks ?? {},
    rationale: cardByEngine.get(engineA)?.rationale ?? null,
  };
  const sideB = {
    team: 2, color: 'blue',
    coach: coachB ?? (cardByEngine.get(engineB)?.coach ?? engineB.toUpperCase()),
    coachKnown: coachB !== null,
    engine: engineB,
    tweaks: teams[1]?.requestedTweaks ?? {},
    resolvedTweaks: teams[1]?.resolvedTweaks ?? {},
    rationale: cardByEngine.get(engineB)?.rationale ?? null,
  };

  // Per-match play-by-play from kill events.
  const matches = [];
  const manifestMatches = Array.isArray(manifest.matches) ? manifest.matches : [];
  for (const mm of manifestMatches) {
    const seed = mm.seed ?? 0;
    const nameOffset = seed * 7;
    const summaryRow = (summary?.matches ?? []).find((x) => x.n === mm.n) ?? null;
    // bot index -> side: read telemetry meta if available, else alternate.
    let botEngines = null;
    if (mm.files?.telemetry) {
      const tele = readJson(path.join(dir, mm.files.telemetry));
      botEngines = tele?.meta?.botEngines ?? null;
    }
    const teamOf = (idx) => {
      if (engineA !== engineB && botEngines && botEngines[String(idx)] !== undefined) {
        return botEngines[String(idx)] === engineA ? 1 : 2;
      }
      return idx % 2 === 0 ? 1 : 2; // bots 2..7 alternate red/blue
    };
    let timeline = null;
    if (mm.files?.events) {
      const kills = loadKills(dir, mm.files.events);
      if (kills) {
        let red = 0, blue = 0;
        timeline = kills.map((k) => {
          const kTeam = teamOf(k.killer);
          if (kTeam === 1) red += 1; else blue += 1;
          const kSide = kTeam === 1 ? sideA : sideB;
          const vSide = teamOf(k.victim) === 1 ? sideA : sideB;
          return {
            tick: k.tick,
            clock: fmtClock(k.tick),
            killer: subjectName(k.killer, 1, nameOffset),
            killerEngine: kSide.engine,
            killerCoach: kSide.coach,
            killerTeam: kTeam,
            victim: subjectName(k.victim, 1, nameOffset),
            victimEngine: vSide.engine,
            victimCoach: vSide.coach,
            victimTeam: vSide.team,
            dist: k.dist ?? null,
            weapon: k.weapon ?? 'AK74', // untagged events are stock AK matches
            score: `${red}:${blue}`,
          };
        });
      }
    }
    // chance-era manifests record the RESOLVED wildcard per match; older
    // wildcard runs only have the run-level field.
    const resolvedWildcard = mm.wildcard ?? (manifest.wildcard === 'shotgun' ? 'shotgun' : null);
    matches.push({
      n: mm.n,
      seed,
      result: summaryRow,
      wildcard: resolvedWildcard,
      watchUrl: buildWatchUrl(sideA, sideB, {
        seed, roundSecs, arenaSeed,
        wildcard: resolvedWildcard,
      }),
      timeline,
    });
  }

  return {
    runId: manifest.runId ?? name,
    dirName: name,
    createdAt: manifest.createdAt ?? null,
    gitRev: manifest.gitRev ?? null,
    map: manifest.map ?? '?',
    botCount: manifest.botCount ?? null,
    roundSecs,
    arenaSeed,
    cli: manifest.cli ?? null,
    sides: [sideA, sideB],
    standings: summary?.standings ?? null,
    bots: summary?.bots ?? null,
    matches,
  };
}

function loadDatasets(cardByEngine) {
  let names = [];
  try {
    names = fs
      .readdirSync(DATASETS, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (e) {
    warn(`cannot list datasets/: ${e.message}`);
  }
  const out = [];
  for (const n of names) {
    try {
      const ds = loadDataset(n, cardByEngine);
      if (ds) out.push(ds);
    } catch (e) {
      warn(`dataset ${n}: ${e.message} — skipped`);
    }
  }
  // newest first (createdAt, falling back to dir name which is timestamped)
  out.sort((a, b) => String(b.createdAt ?? b.dirName).localeCompare(String(a.createdAt ?? a.dirName)));
  return out;
}

// --- big board + rank history --------------------------------------------------
//
// The Big Board ranking (per coach+engine+tweaks-signature, W-L then latest
// K/D) is computed HERE, server-side, and the page consumes it from data.json
// so the page and the persisted history can never drift.
//
// history.jsonl (append-only, one JSON line per snapshot) records the board
// ordering every time it changes. Snapshots are derived deterministically by
// replaying all datasets in chronological order, so the first run backfills
// the whole day and later runs only append the new tail. The file is NEVER
// truncated.

const HISTORY_FILE = path.join(HERE, 'history.jsonl');

function tweaksSigOf(tweaks) {
  const parts = Object.keys(tweaks ?? {}).sort().map((k) => `${k}=${tweaks[k]}`);
  return parts.length ? parts.join(',') : 'stock';
}

function boardKey(coach, engine, sig) {
  return `${String(coach).toUpperCase()}|${engine}|${sig}`;
}

/** ISO timestamp from a dataset dir name like 20260610-052212-... (UTC). */
function tsFromDirName(name) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(name ?? '');
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z`;
}

// --- recency decay -------------------------------------------------------
// Kills stop compounding forever: every fight's contribution to the ranking
// is weighted by exponential age decay, halving every HALF_LIFE_HOURS. Age
// is measured from the fight's createdAt to the NEWEST dataset's createdAt
// (NOT wall clock) so rebuilds are idempotent and the history backfill stays
// deterministic. A row that goes idle for 6+ hours has its score quartered —
// staleness visibly costs rank, and fresh blood can climb.
const HALF_LIFE_HOURS = 3;

function decayWeight(ts, refTs) {
  const age = new Date(refTs).getTime() - new Date(ts).getTime();
  if (!isFinite(age) || age <= 0) return 1;
  return 0.5 ** (age / 3600000 / HALF_LIFE_HOURS);
}

/** Recompute each row's decayed aggregates as of refTs (the newest fight). */
function applyDecay(rows, refTs) {
  for (const r of rows.values()) {
    let ww = 0, wl = 0, wk = 0, wd = 0;
    for (const e of r.results) {
      const w = decayWeight(e.ts ?? refTs, refTs);
      if (e.res === 'w') ww += w;
      else if (e.res === 'l') wl += w;
      wk += w * e.kills;
      wd += w * e.deaths;
    }
    r.score = Number((ww - wl).toFixed(4));            // ranking driver
    r.decayedKd = Number((wk / Math.max(0.001, wd)).toFixed(3)); // tiebreaker
  }
}

// Rank by decayed score (weightedWins - weightedLosses), then decayed K/D.
// Raw career totals (w/l/kills/...) stay on the row for display.
const rankBoard = (rows) => [...rows.values()].sort((x, y) =>
  (y.score - x.score) || (y.decayedKd - x.decayedKd));

/**
 * Replay all fights oldest-first, maintaining the board as it stood after
 * each fight. Returns the final board (ranked rows) and the canonical
 * snapshot sequence (one snapshot per ordering/membership change).
 */
function computeBoard(fights) {
  const chrono = fights.slice().sort((a, b) =>
    String(a.createdAt ?? a.dirName).localeCompare(String(b.createdAt ?? b.dirName)));
  const rows = new Map();
  const canonical = [];
  let prevOrder = '';
  for (const f of chrono) {
    const st = f.standings;
    if (!st || !st.red || !st.blue) continue;
    for (const [side, sideSt] of [[f.sides[0], st.red], [f.sides[1], st.blue]]) {
      const sig = tweaksSigOf(side.tweaks);
      const key = boardKey(side.coach, side.engine, sig);
      if (!rows.has(key)) {
        rows.set(key, { key, coach: side.coach, engine: side.engine, tweaksSig: sig,
          w: 0, l: 0, dr: 0, kills: 0, deaths: 0, hits: 0, shots: 0, kd: [],
          results: [], lastUrl: '', lastAt: null,
          // per-match wildcard splits (deaths ≈ opponent kills that match)
          wc: { matches: 0, kills: 0, deaths: 0 },
          stock: { matches: 0, kills: 0, deaths: 0 } });
      }
      const r = rows.get(key);
      const otherWins = sideSt === st.red ? st.blue.wins : st.red.wins;
      let res;
      if (sideSt.wins > otherWins) { r.w += 1; res = 'w'; }
      else if (sideSt.wins < otherWins) { r.l += 1; res = 'l'; }
      else { r.dr += 1; res = 'd'; }
      r.kills += sideSt.kills; r.deaths += sideSt.deaths;
      r.kd.push(Number((sideSt.kills / Math.max(1, sideSt.deaths)).toFixed(3)));
      r.results.push({
        ts: f.createdAt ?? tsFromDirName(f.dirName),
        res, kills: sideSt.kills, deaths: sideSt.deaths,
      });
      for (const bt of f.bots ?? []) {
        if ((bt.team === 1) === (sideSt === st.red)) { r.hits += bt.hits; r.shots += bt.shots; }
      }
      // Wildcard split: bucket each match's kills by whether the SPAS spawned.
      for (const m of f.matches) {
        if (!m.result) continue;
        const mine = side.team === 1 ? m.result.redKills : m.result.blueKills;
        const theirs = side.team === 1 ? m.result.blueKills : m.result.redKills;
        const bucket = m.wildcard ? r.wc : r.stock;
        bucket.matches += 1; bucket.kills += mine; bucket.deaths += theirs;
      }
      r.lastUrl = f.matches[0] ? f.matches[0].watchUrl : '';
      r.lastAt = f.createdAt ?? tsFromDirName(f.dirName);
    }
    // Decay reference = this fight's timestamp (the newest dataset SO FAR
    // during the replay), so each historical snapshot reflects the board as
    // it stood that moment — and the whole sequence is deterministic.
    const refTs = f.createdAt ?? tsFromDirName(f.dirName) ?? new Date().toISOString();
    applyDecay(rows, refTs);
    const ranked = rankBoard(rows);
    const order = ranked.map((r) => r.key).join('>');
    if (order !== prevOrder) {
      prevOrder = order;
      canonical.push({
        ts: refTs,
        trigger: f.dirName,
        ranks: ranked.map((r, i) => ({
          coach: r.coach, engine: r.engine, tweaksSig: r.tweaksSig,
          rank: i + 1,
          score: r.score,
          kd: r.kd[r.kd.length - 1] ?? 0,
          record: `${r.w}-${r.l}${r.dr ? `-${r.dr}d` : ''}`,
        })),
      });
    }
  }
  // Final board: decayed as of the newest dataset on disk.
  const newest = chrono.length
    ? (chrono[chrono.length - 1].createdAt ?? tsFromDirName(chrono[chrono.length - 1].dirName))
    : new Date().toISOString();
  applyDecay(rows, newest ?? new Date().toISOString());
  const board = rankBoard(rows).map((r, i) => {
    // STREAK: how many consecutive series the row's latest result has run
    // ('w' x4 = four straight wins). Feeds the desk's lead-story picker.
    let streak = null;
    if (r.results.length) {
      const lastRes = r.results[r.results.length - 1].res;
      let n = 0;
      for (let k = r.results.length - 1; k >= 0 && r.results[k].res === lastRes; k--) n += 1;
      streak = { res: lastRes, n };
    }
    return {
      ...r,
      rank: i + 1,
      // SERIES count drives history-favoring: rows with real history (>=3
      // series) get full prominence on the page; one-shots fold away.
      series: r.results.length,
      // FORM: last 5 series results, most recent first ('w'/'l'/'d').
      form: r.results.slice(-5).reverse().map((e) => e.res),
      streak,
    };
  });
  for (const r of board) delete r.results; // internal detail, keep data.json lean
  return { board, canonical };
}

/**
 * Load history.jsonl (skipping bad lines with a warning), append any canonical
 * snapshots newer than the last line on disk, and return the full effective
 * history. Append-only: existing lines are never rewritten.
 */
function syncHistory(canonical) {
  const disk = [];
  let bad = 0;
  try {
    for (const line of fs.readFileSync(HISTORY_FILE, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const s = JSON.parse(t);
        if (s && typeof s.ts === 'string' && Array.isArray(s.ranks)) disk.push(s);
        else bad += 1;
      } catch { bad += 1; }
    }
  } catch { /* missing file: first run, backfill below */ }
  if (bad) warn(`history.jsonl: skipped ${bad} bad line(s)`);

  const orderOf = (s) => s.ranks.map((r) => boardKey(r.coach, r.engine, r.tweaksSig)).join('>');
  let tail;
  if (disk.length === 0) {
    tail = canonical; // first run: backfill the whole saga
  } else {
    const last = disk[disk.length - 1];
    const idx = canonical.findIndex((s) => s.trigger === last.trigger);
    tail = idx >= 0
      ? canonical.slice(idx + 1)
      : canonical.filter((s) => String(s.ts) > String(last.ts));
    // Ordering function changed (e.g. the decay re-rank shipped): the replay
    // now disagrees with the last snapshot on disk even with no new datasets.
    // Record the shake-up as ONE fresh snapshot — never rewrite history.
    if (tail.length === 0 && canonical.length &&
        orderOf(canonical[canonical.length - 1]) !== orderOf(last)) {
      tail = [{ ...canonical[canonical.length - 1],
        ts: new Date().toISOString(),
        trigger: `re-rank:${canonical[canonical.length - 1].trigger}` }];
    }
  }
  // Dedupe across the disk/tail boundary: only orderings that actually differ.
  const toAppend = [];
  let prev = disk.length ? orderOf(disk[disk.length - 1]) : null;
  for (const s of tail) {
    const o = orderOf(s);
    if (o !== prev) toAppend.push(s);
    prev = o;
  }
  if (toAppend.length) {
    try {
      fs.appendFileSync(HISTORY_FILE, toAppend.map((s) => JSON.stringify(s)).join('\n') + '\n');
    } catch (e) {
      warn(`history.jsonl: append failed: ${e.message}`);
    }
  }
  return disk.concat(toAppend);
}

/** Annotate board rows with how long they've held their current slot and
 *  their best-ever rank, derived from the snapshot history. */
function decorateBoard(board, history) {
  for (const row of board) {
    let heldSince = null;
    for (let i = history.length - 1; i >= 0; i--) {
      const e = history[i].ranks.find((r) => boardKey(r.coach, r.engine, r.tweaksSig) === row.key);
      if (!e || e.rank !== row.rank) break;
      heldSince = history[i].ts;
    }
    row.heldSince = heldSince;
    let peakRank = null, peakTs = null;
    for (const snap of history) {
      const e = snap.ranks.find((r) => boardKey(r.coach, r.engine, r.tweaksSig) === row.key);
      if (e && (peakRank === null || e.rank < peakRank)) { peakRank = e.rank; peakTs = snap.ts; }
    }
    row.peakRank = peakRank;
    row.peakTs = peakTs;
  }
}

// --- the commissioner ----------------------------------------------------------
// commissioner.mjs (separate daemon) stages automated "fresh blood" title
// defenses and appends results to crucibles.jsonl; its state file's mtime
// lets the page derive a next-cycle countdown.

const CRUCIBLES_FILE = path.join(HERE, 'crucibles.jsonl');
const COMMISSIONER_STATE = path.join(HERE, 'commissioner-state.json');
const COMMISSIONER_CYCLE_MS = 30 * 1000; // keep in sync with commissioner.mjs

function loadCrucibles() {
  const out = [];
  try {
    for (const line of fs.readFileSync(CRUCIBLES_FILE, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { out.push(JSON.parse(t)); } catch { warn('crucibles.jsonl: bad line skipped'); }
    }
  } catch { /* no crucibles yet */ }
  return out.slice(-20);
}

function loadCommissioner() {
  let state = null, stateMtime = null;
  try {
    state = JSON.parse(fs.readFileSync(COMMISSIONER_STATE, 'utf8'));
    stateMtime = fs.statSync(COMMISSIONER_STATE).mtime.toISOString();
  } catch { /* commissioner not started yet */ }
  return { state, stateMtime, cycleMs: COMMISSIONER_CYCLE_MS };
}

// --- the sports desk -------------------------------------------------------------
// Server-side feed for site/desk.html ("THE SKYREACH DESK" — story-first front
// page). Everything here is nice-to-have: computed in one try/catch from
// build(), and the desk page renders whatever subset survived.

const SEASON_STATE = path.join(HERE, 'season-state.json');
const LEAGUE_STATE = path.join(HERE, 'league-state.json');
const LEAGUE_PACE_MS = 30 * 1000; // keep in sync with league.mjs PACE_MS
const EVOLVE_LOG = path.join(TS_ROOT, 'tools', 'evolve-log.jsonl');
const CHECKPOINTS = path.join(TS_ROOT, 'tools', 'checkpoints');
// Replay rows per match ≈ botCount × roundTicks / 2 (rows land at ~30 Hz);
// matches league.mjs's own "~3.7M rows/hour at 120 matches/hour" arithmetic.
const ROWS_PER_BOT_TICK = 0.5;

/** Last season's winner: fights/SEASONS.md tail if present, else the
 *  LADDER.md season-archive paragraph ("ran A → B → ... → ESCA (angler),
 *  and closed"). Both best-effort. */
function lastSeasonInfo(ladderMd) {
  const seasonsMd = readText(path.join(FIGHTS, 'SEASONS.md'));
  if (seasonsMd) {
    const lines = seasonsMd.split('\n').map((s) => s.trim()).filter(Boolean);
    return { source: 'fights/SEASONS.md', note: lines.slice(-3).join(' '), winner: null, engine: null };
  }
  const m = /ladder ran ([^.]*?),\s*and closed/i.exec(String(ladderMd ?? ''));
  if (m) {
    const last = m[1].split('→').pop().trim();
    const w = /^([A-Z]+)\s*(?:\(([^)]+)\))?/.exec(last);
    if (w) return { source: 'LADDER.md archive note', note: null, winner: w[1], engine: (w[2] ?? '').split(' ')[0] || null };
  }
  return null;
}

/** Training-corpus stats: dataset dirs on disk, matches/rows fought, GB,
 *  and the last hour's match volume (the grinder's pulse). */
function corpusStats(fights) {
  let datasets = 0, bytes = 0;
  for (const d of fs.readdirSync(DATASETS, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    datasets += 1;
    try {
      for (const f of fs.readdirSync(path.join(DATASETS, d.name))) {
        try { bytes += fs.statSync(path.join(DATASETS, d.name, f)).size; } catch { /* gone */ }
      }
    } catch { /* unreadable dir */ }
  }
  let matches = 0, estRows = 0, matchesLastHour = 0;
  const hourAgo = Date.now() - 3600_000;
  for (const f of fights) {
    matches += f.matches.length;
    estRows += f.matches.length * (f.botCount ?? 8) * (f.roundSecs ?? 120) * 60 * ROWS_PER_BOT_TICK;
    const ts = new Date(f.createdAt ?? tsFromDirName(f.dirName) ?? 0).getTime();
    if (ts >= hourAgo) matchesLastHour += f.matches.length;
  }
  return { datasets, matches, estRows: Math.round(estRows), gb: Number((bytes / 1e9).toFixed(2)), matchesLastHour };
}

/** Weight-ship events for the learned bots: evolve.mjs gate lines carry no
 *  timestamp, but every shipped gen has a tools/checkpoints/gen<N>.json whose
 *  mtime is the ship time. */
function evolveShips() {
  const out = [];
  const log = readText(EVOLVE_LOG);
  if (!log) return out;
  for (const line of log.split('\n')) {
    const t = line.trim();
    if (!t || !t.includes('"gate"')) continue;
    let e;
    try { e = JSON.parse(t); } catch { continue; }
    if (!e || typeof e.gen !== 'number') continue;
    let ts = null;
    try { ts = fs.statSync(path.join(CHECKPOINTS, `gen${e.gen}.json`)).mtime.toISOString(); } catch { /* pruned */ }
    out.push({ gen: e.gen, gate: e.gate ?? '', shipped: !!e.shipped, ts, engine: 'neural' });
  }
  return out;
}

/** Which gun did the killing in the last hour (the desk's GUN METER). */
function gunOfTheHour(fights) {
  const hourAgo = Date.now() - 3600_000;
  const tally = {};
  for (const f of fights) {
    const ts = new Date(f.createdAt ?? tsFromDirName(f.dirName) ?? 0).getTime();
    if (ts < hourAgo) continue;
    for (const m of f.matches) {
      for (const k of m.timeline ?? []) {
        const w = k.weapon ?? 'AK74';
        tally[w] = (tally[w] ?? 0) + 1;
      }
    }
  }
  const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0] ?? null;
  return { tally, top: top ? { weapon: top[0], kills: top[1] } : null };
}

function computeDesk(fights, doctrines, ladderMd) {
  const seasonState = readJson(SEASON_STATE); // {season, startedAt, endsAt}
  let league = null;
  try {
    const st = JSON.parse(fs.readFileSync(LEAGUE_STATE, 'utf8'));
    const mtime = fs.statSync(LEAGUE_STATE).mtime.toISOString();
    const engines = doctrines.filter((x) => x.isEngine).length;
    const pairings = engines >= 2 ? (engines * (engines - 1)) / 2 : 0;
    league = {
      cycle: st.cycle ?? 0,
      cycleInPass: pairings ? ((st.cycle ?? 0) % pairings) : 0,
      pairings,
      engines,
      paceMs: LEAGUE_PACE_MS,
      lastPairingAt: mtime,
    };
  } catch { /* grinder not running yet */ }
  return {
    seasonState,
    lastSeason: lastSeasonInfo(ladderMd),
    corpus: corpusStats(fights),
    league,
    evolveShips: evolveShips(),
    gunHour: gunOfTheHour(fights),
  };
}

// --- analytics desk -------------------------------------------------------------
// Server-side aggregation for the D3 charts. The client stays thin: it only
// draws what's precomputed here. Everything is derived from the same fights
// array the board uses, so the charts can never disagree with the board.

function computeAnalytics(fights, board) {
  // Per-config career table (one entry per board row — same identity).
  const configs = board.map((r) => ({
    key: r.key,
    coach: r.coach,
    engine: r.engine,
    tweaksSig: r.tweaksSig,
    rank: r.rank,
    series: r.series,
    w: r.w, l: r.l, dr: r.dr,
    kills: r.kills,
    deaths: r.deaths,
    careerKd: Number((r.kills / Math.max(1, r.deaths)).toFixed(3)),
    decayedKd: r.decayedKd,
    score: r.score,
    hitPct: r.shots ? Number(((r.hits / r.shots) * 100).toFixed(2)) : null,
    shots: r.shots,
    wc: r.wc,
    stock: r.stock,
    lastUrl: r.lastUrl,
    lastAt: r.lastAt,
  }));

  // Engine × engine head-to-head: series win-rates across ALL fights.
  // h2h[a][b] = record of engine a against engine b (mirror matches included
  // both ways so the matrix stays symmetric-complete).
  const h2h = {};
  const cell = (a, b) => {
    h2h[a] ??= {};
    h2h[a][b] ??= { w: 0, l: 0, d: 0 };
    return h2h[a][b];
  };
  for (const f of fights) {
    const st = f.standings;
    if (!st || !st.red || !st.blue) continue;
    const ea = f.sides[0].engine, eb = f.sides[1].engine;
    const ca = cell(ea, eb), cb = cell(eb, ea);
    if (st.red.wins > st.blue.wins) { ca.w += 1; cb.l += 1; }
    else if (st.red.wins < st.blue.wins) { ca.l += 1; cb.w += 1; }
    else { ca.d += 1; cb.d += 1; }
  }

  // Shotgun impact per engine: K/D in wildcard-armed vs stock matches.
  const byEngine = new Map();
  for (const f of fights) {
    for (const side of f.sides) {
      if (!byEngine.has(side.engine)) {
        byEngine.set(side.engine, {
          engine: side.engine,
          wc: { matches: 0, kills: 0, deaths: 0 },
          stock: { matches: 0, kills: 0, deaths: 0 },
        });
      }
      const e = byEngine.get(side.engine);
      for (const m of f.matches) {
        if (!m.result) continue;
        const mine = side.team === 1 ? m.result.redKills : m.result.blueKills;
        const theirs = side.team === 1 ? m.result.blueKills : m.result.redKills;
        const bucket = m.wildcard ? e.wc : e.stock;
        bucket.matches += 1; bucket.kills += mine; bucket.deaths += theirs;
      }
    }
  }
  const shotgun = [...byEngine.values()]
    .map((e) => ({
      engine: e.engine,
      wcMatches: e.wc.matches,
      wcKd: e.wc.deaths ? Number((e.wc.kills / e.wc.deaths).toFixed(3)) : null,
      stockMatches: e.stock.matches,
      stockKd: e.stock.deaths ? Number((e.stock.kills / e.stock.deaths).toFixed(3)) : null,
    }))
    .filter((e) => e.wcMatches + e.stockMatches > 0)
    .sort((a, b) => (b.wcMatches + b.stockMatches) - (a.wcMatches + a.stockMatches));

  return { configs, h2h, shotgun };
}

// --- belt lineage ----------------------------------------------------------------
// Reign bars for the title timeline, parsed from the LADDER.md fight record
// table. A reign starts when a challenger takes the belt (their name leads the
// **bold** result) and ends when the next one does. Each transition links to
// the title-fight dataset so the strip is click-to-watch.

function computeBeltLineage(ladderMd, fights) {
  const rows = [];
  for (const line of String(ladderMd ?? '').split('\n')) {
    const m = /^\|\s*([\d-]+)\s*\|\s*([A-Z]+)\s*\(([^)]*)\)\s*\|\s*([A-Z]+)\s*\(([^)]*)\)\s*\|\s*\*\*([A-Z]+)\s+([\d]+)[–-]([\d]+)\*\*([^|]*)\|\s*#?(\d+)\s*\|\s*`([^`]+)`/.exec(line);
    if (!m) continue;
    rows.push({
      challenger: m[2], champion: m[4], winner: m[6],
      score: `${m[7]}–${m[8]}`,
      arena: Number(m[10]), dataset: m[11],
    });
  }
  if (!rows.length) return [];
  const tsOf = (ds) => {
    const f = fights.find((x) => x.dirName === ds);
    return (f && f.createdAt) || tsFromDirName(ds);
  };
  const urlOf = (ds) => {
    const f = fights.find((x) => x.dirName === ds);
    return f && f.matches[0] ? f.matches[0].watchUrl : '';
  };
  const out = [];
  let holder = rows[0].champion;
  let start = tsOf(rows[0].dataset);
  let crown = null; // the fight that put the current holder on the throne
  let defenses = 0;
  for (const row of rows) {
    const ts = tsOf(row.dataset);
    if (row.winner !== holder) {
      out.push({ coach: holder, from: start, to: ts, crown, defenses });
      holder = row.winner;
      start = ts;
      defenses = 0;
      crown = { dataset: row.dataset, arena: row.arena, score: row.score, watchUrl: urlOf(row.dataset) };
    } else {
      defenses += 1;
    }
  }
  out.push({ coach: holder, from: start, to: null, crown, defenses }); // reigning
  return out;
}

// --- decision graph ----------------------------------------------------------

function loadDecisionGraph() {
  let graph = null;
  let source = null;
  try {
    const raw = execFileSync('deciduous', ['graph'], {
      cwd: REPO_ROOT,
      timeout: 10_000,
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'utf8',
    });
    graph = JSON.parse(raw);
    source = 'deciduous graph (live)';
  } catch (e) {
    const fallback = path.join(REPO_ROOT, 'docs', 'graph-data.json');
    graph = readJson(fallback);
    if (graph) source = 'docs/graph-data.json (static export — may lag live graph)';
    else {
      warn(`decision graph unavailable: ${e.message}`);
      return { source: null, nodes: [] };
    }
  }
  const nodes = (graph.nodes ?? [])
    .slice()
    .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
    .slice(0, 30)
    .map((n) => {
      let meta = {};
      try { meta = JSON.parse(n.metadata_json ?? '{}'); } catch {}
      return {
        id: n.id,
        type: n.node_type,
        title: n.title,
        createdAt: n.created_at,
        branch: meta.branch ?? null,
        commit: meta.commit ?? null,
      };
    });
  return { source, nodes };
}

// --- assemble ----------------------------------------------------------------

export function build() {
  warnings.length = 0;
  const cards = loadCards();
  const cardByEngine = new Map();
  for (const c of cards) if (!cardByEngine.has(c.engine)) cardByEngine.set(c.engine, c);

  const fights = loadDatasets(cardByEngine);

  // Board + rank history: never let a history problem kill the build.
  let board = [], rankHistory = [];
  try {
    const computed = computeBoard(fights);
    board = computed.board;
    rankHistory = syncHistory(computed.canonical);
    decorateBoard(board, rankHistory);
  } catch (e) {
    warn(`rank history failed: ${e.message}`);
  }

  const ladderMarkdown = readText(path.join(FIGHTS, 'LADDER.md')) ?? '(LADDER.md missing)';

  // Analytics desk + belt lineage: nice-to-haves that must NEVER kill a build.
  let analytics = null;
  try {
    analytics = computeAnalytics(fights, board);
  } catch (e) {
    warn(`analytics failed: ${e.message}`);
  }
  let beltLineage = [];
  try {
    beltLineage = computeBeltLineage(ladderMarkdown, fights);
  } catch (e) {
    warn(`belt lineage failed: ${e.message}`);
  }

  // GUN BOARDS: per-weapon kill leaderboards from event weapon tags.
  // Wildcard-era kills carry [AK74]/[SPAS12]/[BARRETT]; stock-era kill
  // events are untagged and are AK by construction (one-gun matches).
  let gunBoards = null;
  try {
    const tally = new Map(); // weapon -> Map(coach|engine -> kills)
    let totalKills = 0;
    for (const f of fights) {
      for (const m of f.matches) {
        if (!m.timeline) continue;
        for (const k of m.timeline) {
          const w = k.weapon ?? 'AK74';
          if (!tally.has(w)) tally.set(w, new Map());
          const key = `${k.killerCoach}\u0000${k.killerEngine}`;
          const t = tally.get(w);
          t.set(key, (t.get(key) ?? 0) + 1);
          totalKills += 1;
        }
      }
    }
    gunBoards = {};
    for (const [w, t] of tally) {
      const rows = [...t.entries()]
        .map(([key, kills]) => {
          const [coach, engine] = key.split('\u0000');
          return { coach, engine, kills };
        })
        .sort((a, b) => b.kills - a.kills);
      const gunTotal = rows.reduce((n, r) => n + r.kills, 0);
      gunBoards[w] = { total: gunTotal, rows: rows.slice(0, 12), allRows: rows.length };
    }
    gunBoards.totalKills = totalKills;
  } catch (e) {
    warn(`gun boards failed: ${e.message}`);
    gunBoards = null;
  }

  const doctrines = loadDoctrines();

  // The sports desk feed (site/desk.html): season clock, corpus stats,
  // grinder progress, weight-ship events — never allowed to kill a build.
  let desk = null;
  try {
    desk = computeDesk(fights, doctrines, ladderMarkdown);
  } catch (e) {
    warn(`desk data failed: ${e.message}`);
  }

  // How many fights (newest-first, with per-kill timelines) data.json carries.
  // Locally: all of them (the full file crossed 300 MB — fine on localhost).
  // The LIVE deploy sets ARENA_DATA_FIGHTS (e.g. 40, matching the publish
  // snapshot) because the floor polls data.json every 5s over the public
  // internet and caddy gzips it per request. Board/decay/desk/analytics are
  // all computed from the FULL corpus above — only the shipped feed is cut.
  const maxFights = Number(process.env.ARENA_DATA_FIGHTS) || 0;

  const data = {
    generatedAt: new Date().toISOString(),
    // In-progress fight feed (schema soldat-arena-live/1), written atomically
    // by the arena runtime during a run — powers the LIVE strip on the page.
    live: readJson(path.join(DATASETS, 'LIVE.json')),
    ladderMarkdown,
    cards,
    doctrines,
    fights: maxFights > 0 ? fights.slice(0, maxFights) : fights,
    board,
    rankHistory,
    analytics,
    beltLineage,
    halfLifeHours: HALF_LIFE_HOURS,
    crucibles: loadCrucibles(),
    commissioner: loadCommissioner(),
    gunBoards,
    desk,
    warRoom: loadDecisionGraph(),
    warnings: [...warnings],
  };

  fs.mkdirSync(SITE_DIR, { recursive: true });
  const tmp = path.join(SITE_DIR, '.data.json.tmp');
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, path.join(SITE_DIR, 'data.json'));
  // When the watch base is overridden (live VPS deploy) the replays open right
  // next to the page — fix the footer copy that otherwise tells visitors to
  // run `pnpm play` on :5173.
  const liveFooter = (html) => {
    if (!process.env.ARENA_WATCH_BASE || html == null) return html;
    return html
      .split('click anything to open the replay (needs <code>pnpm play</code> on :5173)')
      .join('click anything to open the replay — it re-simulates right here in your browser')
      .split('replays need <span class="num">pnpm play</span> on :5173')
      .join('replays re-simulate right in your browser');
  };
  fs.writeFileSync(path.join(SITE_DIR, 'index.html'), liveFooter(readText(path.join(HERE, 'index.template.html'))) ?? FALLBACK_HTML);
  // Second dashboard: THE DESK (story-first sports front page).
  try {
    fs.writeFileSync(path.join(SITE_DIR, 'desk.html'), liveFooter(readText(path.join(HERE, 'desk.template.html'))) ?? FALLBACK_DESK);
  } catch (e) {
    warn(`desk.html emit failed: ${e.message}`);
  }
  // Slim feed for the desk: the full data.json crossed 100 MB (per-kill
  // timelines on every fight) and takes >10s to serve while the synchronous
  // rebuild blocks this process's event loop — a 5s poll of it never lands.
  // The desk only needs headline-grade fields, so it gets its own ~1 MB feed.
  try {
    // newest fight with a kill by each weapon — keeps the desk's gun-meter
    // click-throughs alive without shipping the timelines themselves.
    const gunLastUrl = {};
    for (const f of fights) { // already sorted newest first
      for (const m of f.matches) {
        for (const k of m.timeline ?? []) {
          const w = k.weapon ?? 'AK74';
          if (!(w in gunLastUrl)) gunLastUrl[w] = m.watchUrl;
        }
      }
      if (Object.keys(gunLastUrl).length >= 3) break;
    }
    const deskData = {
      generatedAt: data.generatedAt,
      live: data.live,
      ladderMarkdown,
      board,
      rankHistory,
      h2h: analytics ? analytics.h2h : null,
      beltLineage,
      crucibles: data.crucibles,
      commissioner: data.commissioner,
      gunBoards: gunBoards
        ? Object.fromEntries(Object.entries(gunBoards).map(([k, v]) =>
            [k, typeof v === 'object' && v !== null && Array.isArray(v.rows)
              ? { total: v.total, rows: v.rows.slice(0, 1), lastUrl: gunLastUrl[k] ?? null } : v]))
        : null,
      desk,
      warnings: data.warnings,
      // fights without timelines/bots: just enough for the upset scanner,
      // rivalry latest-meeting lookups, and click-to-watch links. On the
      // LIVE deploy (ARENA_DATA_FIGHTS set) cap the slim feed too — it is
      // polled every 5s; 10x the floor cap keeps a few hours of story.
      fights: (maxFights > 0 ? fights.slice(0, maxFights * 10) : fights).map((f) => ({
        dirName: f.dirName,
        createdAt: f.createdAt,
        arenaSeed: f.arenaSeed,
        sides: f.sides.map((s) => ({ coach: s.coach, engine: s.engine, tweaks: s.tweaks })),
        standings: f.standings,
        watchUrl: f.matches[0] ? f.matches[0].watchUrl : '',
      })),
    };
    const dtmp = path.join(SITE_DIR, '.desk-data.json.tmp');
    fs.writeFileSync(dtmp, JSON.stringify(deskData));
    fs.renameSync(dtmp, path.join(SITE_DIR, 'desk-data.json'));
  } catch (e) {
    warn(`desk-data.json emit failed: ${e.message}`);
  }
  return data;
}

const FALLBACK_HTML = '<!doctype html><title>Arena Live</title><p>template missing — see arena-live/index.template.html</p>';
const FALLBACK_DESK = '<!doctype html><title>The Skyreach Desk</title><p>template missing — see arena-live/desk.template.html</p>';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const d = build();
  console.log(
    `[arena-live] built: ${d.fights.length} fights, ${d.cards.length} cards, ` +
    `${d.board.length} board rows, ${d.rankHistory.length} rank snapshots, ` +
    `${d.doctrines.length} doctrines, ${d.warRoom.nodes.length} graph nodes, ` +
    `${d.warnings.length} warnings`,
  );
}
