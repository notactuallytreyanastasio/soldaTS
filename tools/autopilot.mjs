#!/usr/bin/env node
// THE AUTOPILOT — boot-persistent keeper for the arena (goal 428).
//
// One process, zero npm deps, designed to never die. Installed as a launchd
// LaunchAgent (deploy/com.soldat.autopilot.plist, `make autopilot-install`),
// gated by arena-live/autopilot.json which the config screen at
// http://localhost:8901/config.html reads and writes. The plist stays loaded
// forever; flipping `enabled` in the config is the actual on/off switch.
//
// Every cycle (60s) it re-reads the config. When enabled it:
//   1. DAEMON KEEPER — ensures each enabled daemon is running, started exactly
//      the way `make up` starts them (same argv → same pgrep/pkill patterns):
//        client        pnpm play                 http://localhost:5173
//        watcher       node watch.mjs            http://localhost:8901
//        commissioner  node commissioner.mjs     (crucibles / title bouts)
//        grinder       node league.mjs           (~120 matches/hr)
//      Crashed daemon → restart with exponential backoff (30s → 5min).
//   2. TRAINING LOOP — every trainer.intervalHours, serialized (a cycle never
//      overlaps the previous one; if one is still running we skip):
//        a. pull server datasets additively (rsync --ignore-existing from the
//           Hetzner box; unreachable → log + skip),
//        a2. offload >24h replay blobs to Hetzner Object Storage (verified
//           upload, then delete local — tools/offload-replays.mjs) so the
//           corpus stays bounded; manifests/summaries/events stay forever,
//        b. retrain the disciple (tools/train-disciple.mjs; teacher "auto" =
//           top hand-written engine on the latest board, fallback cuadrilla),
//        c. GATE the new weights — tools/evaluate.mjs gauntlet when present,
//           else a paired 5-match head-to-head (new vs HEAD weights, same
//           seeds/arenas, vs the teacher) via tools/autopilot-gate.mjs;
//           ship = commit + push the weights file, reject = revert it,
//        d. evolve the neural engine (tools/evolve.mjs --resume; its own
//           ship-gate stands — we commit whatever it decided to ship),
//        e. append a summary line to tools/autopilot-ledger.jsonl and log an
//           outcome node to the decision graph.
//   3. PUBLISH LOOP — if publishLoopMinutes > 0, keeps publish.mjs --loop
//      republishing the public snapshot on that cadence.
//
// Usage:
//   node tools/autopilot.mjs            # the keeper (what launchd runs)
//   node tools/autopilot.mjs --once     # one daemon pass + one forced training
//                                       # cycle, then exit (for testing)
//   flags: --evolve-generations N  override config (test runs)
//          --quick                 abbreviated training (few datasets/epochs)
//
// Logs: tools/autopilot.log (timestamped; launchd crash spew goes to
// tools/autopilot.launchd.log). State: tools/autopilot.pid (single instance),
// tools/autopilot-ledger.jsonl (one JSON line per training cycle).

import {
  appendFileSync,
  existsSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = join(dirname(SELF), '..');
const LIVE = join(ROOT, 'arena-live');
const CONFIG_PATH = join(LIVE, 'autopilot.json');
const LOG_PATH = join(ROOT, 'tools/autopilot.log');
const LEDGER_PATH = join(ROOT, 'tools/autopilot-ledger.jsonl');
const PID_PATH = join(ROOT, 'tools/autopilot.pid');
const WEIGHTS_REL = 'packages/client/src/ai/discipleWeights.ts';
const WEIGHTS_PATH = join(ROOT, WEIGHTS_REL);
const EVALUATE_PATH = join(ROOT, 'tools/evaluate.mjs');
const EVAL_LEDGER_PATH = join(ROOT, 'tools/eval-ledger.jsonl');
const GATE_PATH = join(ROOT, 'tools/autopilot-gate.mjs');
const DATASETS_REMOTE = 'root@5.161.181.91:/opt/soldat/datasets/';
const ACTION_NODE = '434'; // decision-graph action this keeper hangs outcomes off

const TICK_MS = 60_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 300_000;

// launchd gives us a bare PATH — daemons need the asdf shims (node/pnpm) and
// homebrew (git). Prepend rather than replace so a normal shell run keeps its
// environment.
const HOME = os.homedir();
process.env.PATH = [
  join(HOME, '.asdf', 'shims'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
  process.env.PATH ?? '',
].join(':');
const DECIDUOUS = existsSync(join(HOME, '.asdf', 'shims', 'deciduous'))
  ? join(HOME, '.asdf', 'shims', 'deciduous')
  : 'deciduous';

// --- CLI -----------------------------------------------------------------------
const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
const ONCE = args.includes('--once');
const QUICK = args.includes('--quick');
const EVOLVE_GENS_OVERRIDE = flag('evolve-generations', null);

// --- logging — file always, console only when a human is watching ----------------
function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.join(' ')}`;
  try {
    appendFileSync(LOG_PATH, line + '\n');
  } catch {
    /* a full disk must not kill the keeper */
  }
  if (process.stdout.isTTY) console.log(line);
}

// --- single instance --------------------------------------------------------------
try {
  const old = Number(readFileSync(PID_PATH, 'utf8').trim());
  if (old && old !== process.pid) {
    let alive = false;
    try {
      process.kill(old, 0);
      alive = true;
    } catch {
      alive = false;
    }
    if (alive) {
      log(`autopilot already running (pid ${old}) — this instance (pid ${process.pid}) exits`);
      process.exit(0);
    }
  }
} catch {
  /* no pidfile — fine */
}
try {
  writeFileSync(PID_PATH, String(process.pid));
} catch {}

// --- config ------------------------------------------------------------------------
const DEFAULT_CONFIG = {
  enabled: false,
  daemons: { client: true, watcher: true, commissioner: true, grinder: true },
  trainer: {
    enabled: true,
    intervalHours: 4,
    teacher: 'auto',
    evolveGenerations: 200,
    evolveJobs: 8,
  },
  pullServerData: true,
  publishLoopMinutes: 0,
};

function readConfig() {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    return {
      ...DEFAULT_CONFIG,
      ...raw,
      daemons: { ...DEFAULT_CONFIG.daemons, ...(raw.daemons ?? {}) },
      trainer: { ...DEFAULT_CONFIG.trainer, ...(raw.trainer ?? {}) },
    };
  } catch (e) {
    log(`config unreadable (${e.message}) — treating as disabled`);
    return null;
  }
}

// --- child helpers --------------------------------------------------------------------
/** Spawn fully detached with output appended to a log file; the child outlives us. */
function detach(cmd, argv, cwd, logFile) {
  const fd = openSync(logFile, 'a');
  const p = spawn(cmd, argv, {
    cwd,
    env: process.env,
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  p.on('error', (e) => log(`spawn ${cmd} failed: ${e.message}`));
  p.unref();
  closeSync(fd);
  return p.pid;
}

/** Async run with captured output + timeout; resolves, never rejects. */
function run(cmd, argv, opts = {}) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      resolve({ code, out, err });
    };
    let p;
    try {
      p = spawn(cmd, argv, {
        cwd: opts.cwd ?? ROOT,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      err = e.message;
      finish(-1);
      return;
    }
    const timer = setTimeout(() => {
      try {
        p.kill('SIGKILL');
      } catch {}
      err += `\n[autopilot] timed out after ${opts.timeout ?? 0}ms`;
    }, opts.timeout ?? 6 * 3600_000);
    const max = opts.capBytes ?? 2_000_000;
    const cap = (s, d) => {
      s += d;
      return s.length > max ? s.slice(-Math.floor(max / 2)) : s;
    };
    // setEncoding: a StringDecoder per stream, so multibyte chars split
    // across chunk boundaries decode intact (the weights files contain →).
    p.stdout.setEncoding('utf8');
    p.stderr.setEncoding('utf8');
    p.stdout.on('data', (d) => (out = cap(out, d)));
    p.stderr.on('data', (d) => (err = cap(err, d)));
    p.on('error', (e) => {
      err += e.message;
      clearTimeout(timer);
      finish(-1);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      finish(code ?? -1);
    });
  });
}

const pgrep = (pattern) =>
  spawnSync('/usr/bin/pgrep', ['-f', pattern], { stdio: 'ignore' }).status === 0;

const httpOk = (url) =>
  new Promise((resolve) => {
    const req = http.get(url, { timeout: 3000 }, (res) => {
      res.resume();
      resolve((res.statusCode ?? 500) < 500);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });

const git = (...argv) => run('git', argv, { timeout: 180_000 });
const tail = (s, n = 3) => String(s ?? '').trim().split('\n').slice(-n).join(' | ');

// --- 1. the daemon keeper ----------------------------------------------------------
// Started EXACTLY the way the Makefile starts them — same cwd, same argv — so
// `make status` / `make down` keep working on autopilot-started daemons.
const DAEMONS = {
  client: {
    check: () => httpOk('http://localhost:5173/'),
    start: () => detach('pnpm', ['play'], ROOT, '/tmp/soldat-play.log'),
    where: ':5173',
  },
  watcher: {
    check: () => pgrep('node watch.mjs'),
    start: () => detach('node', ['watch.mjs'], LIVE, join(LIVE, 'watcher.log')),
    where: ':8901',
  },
  commissioner: {
    check: () => pgrep('node commissioner.mjs'),
    start: () => detach('node', ['commissioner.mjs'], LIVE, join(LIVE, 'commissioner.log')),
    where: 'commissioner.log',
  },
  grinder: {
    check: () => pgrep('node league.mjs'),
    start: () => detach('node', ['league.mjs'], LIVE, join(LIVE, 'league.log')),
    where: 'league.log',
  },
};
const backoff = {}; // name -> { fails, blockedUntil }

async function ensureDaemons(cfg) {
  for (const [name, d] of Object.entries(DAEMONS)) {
    if (!cfg.daemons[name]) continue;
    try {
      const up = await d.check();
      const b = (backoff[name] ??= { fails: 0, blockedUntil: 0 });
      if (up) {
        if (b.fails > 0) log(`daemon ${name}: back up (${d.where})`);
        b.fails = 0;
        continue;
      }
      const now = Date.now();
      if (now < b.blockedUntil) continue; // recently restarted — give it time
      b.fails++;
      b.blockedUntil = now + Math.min(BACKOFF_BASE_MS * 2 ** (b.fails - 1), BACKOFF_MAX_MS);
      const pid = d.start();
      log(`daemon ${name}: DOWN — restarted (pid ${pid}, attempt ${b.fails})`);
    } catch (e) {
      log(`daemon ${name}: keeper error (ignored): ${e.message}`);
    }
  }
}

// --- 3. publish loop -----------------------------------------------------------------
let publishCadence = -1;
function ensurePublishLoop(minutes) {
  try {
    const running = pgrep('node publish.mjs --loop');
    if (minutes > 0) {
      if (running && publishCadence === minutes) return;
      if (running) {
        spawnSync('/usr/bin/pkill', ['-f', 'node publish.mjs --loop'], { stdio: 'ignore' });
        log(`publish loop: cadence change — restarting at every ${minutes}min`);
      }
      detach('node', ['publish.mjs', '--loop', String(minutes)], LIVE, join(LIVE, 'publish.log'));
      publishCadence = minutes;
      log(`publish loop: started (every ${minutes}min, log arena-live/publish.log)`);
    } else if (running) {
      spawnSync('/usr/bin/pkill', ['-f', 'node publish.mjs --loop'], { stdio: 'ignore' });
      publishCadence = -1;
      log('publish loop: stopped (publishLoopMinutes=0)');
    }
  } catch (e) {
    log(`publish loop error (ignored): ${e.message}`);
  }
}

// --- 2. the training cycle --------------------------------------------------------------

/** teacher "auto" = top hand-written engine on the latest board. */
function resolveTeacher(cfg) {
  const want = cfg.trainer.teacher ?? 'auto';
  if (want !== 'auto') return { engine: want, tweaks: null, how: 'config' };
  const LEARNED = new Set(['neural', 'disciple']);
  try {
    const d = JSON.parse(readFileSync(join(LIVE, 'site', 'data.json'), 'utf8'));
    for (const row of d.board ?? []) {
      if (LEARNED.has(row.engine)) continue;
      let tweaks = null;
      if (row.tweaksSig) {
        tweaks = {};
        for (const kv of String(row.tweaksSig).split(',')) {
          const [k, v] = kv.split('=');
          if (k && v !== undefined && Number.isFinite(Number(v))) tweaks[k] = Number(v);
        }
      }
      return { engine: row.engine, tweaks, how: `board #1 (${row.coach})` };
    }
  } catch (e) {
    log(`teacher auto-resolve failed (${e.message}) — falling back to cuadrilla`);
  }
  return { engine: 'cuadrilla', tweaks: null, how: 'fallback' };
}

/** Play the gate matches with whatever discipleWeights.ts is in the tree. */
async function gateRun(teacher, seedBase, matches) {
  const argv = [GATE_PATH, '--opponent', teacher.engine, '--matches', String(matches), '--seed-base', String(seedBase)];
  if (teacher.tweaks && Object.keys(teacher.tweaks).length > 0) {
    argv.push('--opponent-tweaks', JSON.stringify(teacher.tweaks));
  }
  const r = await run('node', argv, { timeout: 1800_000 });
  if (r.code !== 0) throw new Error(`gate run failed (code ${r.code}): ${tail(r.err)}`);
  const line = r.out.split('\n').find((l) => l.startsWith('GATE_RESULT '));
  if (!line) throw new Error(`gate run produced no GATE_RESULT: ${tail(r.out)}`);
  return JSON.parse(line.slice('GATE_RESULT '.length));
}

/** The gauntlet gate (EVAL_SPEC_V1, tools/evaluate.mjs — landed with the
 *  science program, node 435). The gauntlet pits FIGHTER CARDS, and its
 *  --weights seam is neural-only, so new-vs-old DISCIPLE weights can't ride a
 *  single --baseline invocation yet. Instead: run the quick gauntlet twice on
 *  the disciple card — once with the new weights in the tree, once with the
 *  previous weights swapped back in. Cells use identical held-out arenas and
 *  seeds both runs (common random numbers), so the score difference is paired
 *  and pure policy. Ship iff the new score strictly improves.
 *  TODO(evaluate): when evaluate.mjs grows a disciple-weights seam, switch to
 *  one `--baseline` run and ship on paired bootstrap CI low > 0 instead. */
async function gauntletGate(newWeights, oldWeights) {
  const cardPath = 'fights/disciple.json';
  if (!existsSync(join(ROOT, cardPath))) throw new Error(`no ${cardPath} fighter card`);
  const runOnce = async (label) => {
    const r = await run('node', [EVALUATE_PATH, cardPath, '--quick'], { timeout: 1800_000 });
    if (r.code !== 0) throw new Error(`evaluate.mjs exit ${r.code}: ${tail(r.err)}`);
    const lines = readFileSync(EVAL_LEDGER_PATH, 'utf8').trim().split('\n');
    const e = JSON.parse(lines[lines.length - 1]);
    const score = e?.results?.score;
    if (typeof score !== 'number') throw new Error('eval ledger line has no results.score');
    log(`gate gauntlet (${label} weights): score ${score.toFixed(3)}`);
    return score;
  };
  const newScore = await runOnce('new');
  writeFileSync(WEIGHTS_PATH, oldWeights);
  let oldScore;
  try {
    oldScore = await runOnce('old');
  } finally {
    writeFileSync(WEIGHTS_PATH, newWeights); // ALWAYS restore the candidate
  }
  return {
    method: 'gauntlet',
    ship: newScore > oldScore,
    detail:
      `EVAL_SPEC_V1 --quick, CRN-paired runs: new score ${newScore.toFixed(3)} ` +
      `vs old ${oldScore.toFixed(3)} (ship iff improved)`,
  };
}

/** Commit exactly these paths (bypasses whatever else is staged) and push. */
async function commitAndPush(paths, message) {
  for (const p of paths) await git('add', '--', p);
  const c = await git('commit', '-m', message, '--', ...paths);
  if (c.code !== 0) return `commit failed: ${tail(c.err || c.out)}`;
  let push = await git('push', 'origin', 'main');
  if (push.code !== 0) {
    await git('pull', '--rebase', 'origin', 'main');
    push = await git('push', 'origin', 'main');
  }
  const dev = await git('push', 'origin', 'main:develop');
  return `committed; push main ${push.code === 0 ? 'ok' : 'FAILED'}, develop ${dev.code === 0 ? 'ok' : 'FAILED'}`;
}

let cycleRunning = false;
let lastCycleEnd = 0;
try {
  // Survive restarts without retraining immediately: resume the clock from
  // the last ledger entry.
  const lines = readFileSync(LEDGER_PATH, 'utf8').trim().split('\n');
  lastCycleEnd = new Date(JSON.parse(lines[lines.length - 1]).at).getTime() || 0;
} catch {}

async function trainingCycle(cfg) {
  const t0 = Date.now();
  const summary = {
    at: new Date().toISOString(),
    pulled: null,
    offload: null,
    teacher: null,
    train: null,
    gate: null,
    evolve: null,
    errors: [],
  };
  const oops = (step, e) => {
    const msg = `${step}: ${e.message ?? e}`;
    summary.errors.push(msg);
    log(`cycle ${msg}`);
  };
  log(`training cycle START${QUICK ? ' (quick)' : ''}`);

  // (a) pull server datasets — additive only, skip when unreachable.
  if (cfg.pullServerData) {
    try {
      const r = await run(
        'rsync',
        ['-az', '--ignore-existing', '-e', 'ssh -o BatchMode=yes -o ConnectTimeout=10', DATASETS_REMOTE, join(ROOT, 'datasets') + '/'],
        { timeout: 1800_000 },
      );
      summary.pulled = r.code === 0;
      log(r.code === 0 ? 'pull: server datasets synced (additive)' : `pull: skipped — rsync exit ${r.code} (${tail(r.err, 1)})`);
    } catch (e) {
      summary.pulled = false;
      oops('pull', e);
    }
  }

  // (a2) offload >24h replay blobs to the bucket — keeps the corpus bounded forever.
  // Verified upload before any delete; manifests/summaries/events/telemetry untouched.
  try {
    const r = await run('node', [join(ROOT, 'tools/offload-replays.mjs')], { timeout: 2 * 3600_000 });
    summary.offload = r.code === 0 ? tail(r.out, 1) : `exit ${r.code}: ${tail(r.err, 1)}`;
    log(`offload: ${summary.offload}`);
  } catch (e) {
    summary.offload = `FAILED: ${e.message}`;
    oops('offload', e);
  }

  // (b) retrain the disciple from the corpus.
  const teacher = resolveTeacher(cfg);
  summary.teacher = `${teacher.engine} (${teacher.how})`;
  const oldWeights = existsSync(WEIGHTS_PATH) ? readFileSync(WEIGHTS_PATH, 'utf8') : '';
  let trained = false;
  try {
    const argv = [join(ROOT, 'tools/train-disciple.mjs'), '--teacher', teacher.engine];
    if (QUICK) argv.push('--max-datasets', '60', '--epochs', '2');
    log(`train: node tools/train-disciple.mjs --teacher ${teacher.engine} (${teacher.how})`);
    const r = await run('node', argv, { timeout: 4 * 3600_000 });
    trained = r.code === 0;
    summary.train = trained ? tail(r.out, 2) : `FAILED (code ${r.code}): ${tail(r.err)}`;
    log(`train: ${summary.train}`);
  } catch (e) {
    summary.train = `FAILED: ${e.message}`;
    oops('train', e);
  }

  // (c) the gate — only when training produced new weights.
  if (trained) {
    const newWeights = readFileSync(WEIGHTS_PATH, 'utf8');
    if (newWeights === oldWeights) {
      summary.gate = { method: 'none', ship: false, detail: 'weights unchanged' };
      log('gate: weights byte-identical to previous — nothing to ship');
    } else {
      let verdict = null;
      if (existsSync(EVALUATE_PATH) && oldWeights.length > 0) {
        try {
          verdict = await gauntletGate(newWeights, oldWeights);
        } catch (e) {
          log(`gate: gauntlet unavailable (${e.message}) — falling back to head-to-head`);
        }
      }
      if (!verdict) {
        try {
          // Paired head-to-head (the fallback gate): same seeds/arenas vs the
          // same teacher, new weights then the pre-cycle weights; ship only on
          // a strictly better total kill-diff (tie-break on wins).
          const seedBase = 40000 + (Math.floor(t0 / 1000) % 997) * 101;
          const newRes = await gateRun(teacher, seedBase, 5);
          let oldRes = null;
          if (oldWeights.length > 0) {
            writeFileSync(WEIGHTS_PATH, oldWeights);
            try {
              oldRes = await gateRun(teacher, seedBase, 5);
            } finally {
              writeFileSync(WEIGHTS_PATH, newWeights); // ALWAYS restore
            }
          }
          const ship =
            oldRes === null ||
            newRes.diff > oldRes.diff ||
            (newRes.diff === oldRes.diff && newRes.wins > oldRes.wins);
          verdict = {
            method: 'head-to-head',
            ship,
            detail:
              `vs ${teacher.engine}, 5 paired matches: new diff ${newRes.diff} (${newRes.wins}W)` +
              (oldRes ? ` / old diff ${oldRes.diff} (${oldRes.wins}W)` : ' / no HEAD baseline'),
          };
        } catch (e) {
          verdict = { method: 'head-to-head', ship: false, detail: `gate errored: ${e.message}` };
          oops('gate', e);
        }
      }
      summary.gate = verdict;
      log(`gate (${verdict.method}): ${verdict.ship ? 'SHIP' : 'REJECT'} — ${verdict.detail}`);
      try {
        if (verdict.ship) {
          const msg =
            `auto(train): disciple retrained by autopilot (teacher=${teacher.engine})\n\n` +
            `Gate: ${verdict.method} — ${verdict.detail}\nLedger: tools/autopilot-ledger.jsonl\n\n` +
            'Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>';
          verdict.git = await commitAndPush([WEIGHTS_REL], msg);
          log(`gate ship: ${verdict.git}`);
        } else {
          writeFileSync(WEIGHTS_PATH, oldWeights); // revert — gate said no
          log('gate: reverted discipleWeights.ts to previous content');
        }
      } catch (e) {
        oops('gate-ship', e);
      }
    }
  }

  // (d) evolve the neural engine — its own ship-gate stands.
  if (cfg.trainer.evolveGenerations > 0) {
    try {
      const gens = String(EVOLVE_GENS_OVERRIDE ?? cfg.trainer.evolveGenerations);
      const jobs = String(cfg.trainer.evolveJobs ?? 8);
      log(`evolve: node tools/evolve.mjs --resume --generations ${gens} --jobs ${jobs}`);
      const r = await run(
        'node',
        [join(ROOT, 'tools/evolve.mjs'), '--resume', '--generations', gens, '--jobs', jobs],
        { timeout: 12 * 3600_000 },
      );
      const gateLines = r.out.split('\n').filter((l) => l.includes('[gate]'));
      summary.evolve = {
        generations: Number(gens),
        ok: r.code === 0,
        gate: tail(gateLines.join('\n'), 1) || 'no gate ran',
      };
      log(`evolve: exit ${r.code} — ${summary.evolve.gate}`);
      // Commit whatever evolve's gate shipped (plus its log/checkpoints).
      const st = await git(
        'status', '--porcelain', '--',
        'packages/client/src/ai/neuralWeights.ts', 'tools/evolve-log.jsonl', 'tools/checkpoints',
      );
      const changed = st.out.split('\n').filter(Boolean).map((l) => l.slice(3).trim());
      if (changed.includes('packages/client/src/ai/neuralWeights.ts')) {
        const msg =
          `auto(evolve): neural weights shipped by evolve's own gate (autopilot cycle)\n\n` +
          `${summary.evolve.gate}\n\n` +
          'Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>';
        summary.evolve.git = await commitAndPush(changed, msg);
        log(`evolve ship: ${summary.evolve.git}`);
      }
    } catch (e) {
      oops('evolve', e);
    }
  }

  // (e) the ledger + a decision-graph outcome.
  summary.secs = Math.round((Date.now() - t0) / 1000);
  try {
    appendFileSync(LEDGER_PATH, JSON.stringify(summary) + '\n');
  } catch (e) {
    oops('ledger', e);
  }
  try {
    const title =
      `Autopilot cycle: teacher=${summary.teacher ?? '?'}; ` +
      `gate ${summary.gate ? `${summary.gate.method} → ${summary.gate.ship ? 'SHIPPED' : 'rejected'}` : 'n/a'}; ` +
      `evolve ${summary.evolve ? `${summary.evolve.generations} gens (${summary.evolve.gate})` : 'off'}; ` +
      `${summary.errors.length} errors, ${summary.secs}s`;
    const add = await run(DECIDUOUS, ['add', 'outcome', title, '-c', '75'], { timeout: 60_000 });
    const id = (add.out.match(/Created node (\d+)/) ?? [])[1];
    if (id) await run(DECIDUOUS, ['link', ACTION_NODE, id, '-r', 'autopilot training cycle'], { timeout: 60_000 });
  } catch (e) {
    oops('deciduous', e);
  }
  lastCycleEnd = Date.now();
  log(`training cycle DONE in ${summary.secs}s (${summary.errors.length} errors)`);
  return summary;
}

// --- main loop ----------------------------------------------------------------------------
let lastEnabledState = null;
async function tick(force = false) {
  const cfg = readConfig();
  if (!cfg || !cfg.enabled) {
    if (lastEnabledState !== false) {
      log('autopilot idle — enabled:false in arena-live/autopilot.json (flip it at http://localhost:8901/config.html)');
      lastEnabledState = false;
    }
    return;
  }
  if (lastEnabledState !== true) {
    log(`autopilot ENGAGED (pid ${process.pid}) — keeping daemons up, training every ${cfg.trainer.intervalHours}h`);
    lastEnabledState = true;
  }
  await ensureDaemons(cfg);
  ensurePublishLoop(Number(cfg.publishLoopMinutes) || 0);
  const due = Date.now() - lastCycleEnd >= cfg.trainer.intervalHours * 3600_000;
  if (cfg.trainer.enabled && (force || due)) {
    if (cycleRunning) {
      log('training cycle due but previous cycle still running — skipping');
      return;
    }
    cycleRunning = true;
    try {
      await trainingCycle(cfg);
    } catch (e) {
      log(`training cycle blew up (caught): ${e.stack ?? e}`);
    } finally {
      cycleRunning = false;
    }
  }
}

process.on('uncaughtException', (e) => log(`uncaught (ignored): ${e.stack ?? e}`));
process.on('unhandledRejection', (e) => log(`unhandled rejection (ignored): ${e}`));

log(`autopilot up (pid ${process.pid}, node ${process.version}${ONCE ? ', --once' : ''})`);
if (ONCE) {
  await tick(true);
  log('--once complete — exiting');
  process.exit(0);
} else {
  // Do NOT await the first tick: it may kick off an hours-long training
  // cycle, and the interval (i.e. the daemon keeper) must start regardless.
  tick().catch((e) => log(`startup tick error (ignored): ${e.message}`));
  setInterval(() => {
    tick().catch((e) => log(`tick error (ignored): ${e.message}`));
  }, TICK_MS);
}
