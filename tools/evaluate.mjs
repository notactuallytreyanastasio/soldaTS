#!/usr/bin/env node
// THE EVALUATION GAUNTLET driver (goal node 427) — the one standardized,
// variance-controlled, held-out benchmark every training experiment is
// scored against. Spec, math, and per-match extraction live in
// packages/arena/src/evaluate.ts (EVAL_SPEC_V1, tested); this file is the
// CLI, the worker pool (same child-worker pattern as tools/evolve.mjs), the
// tables, and the append-only ledger.
//
// Usage:
//   node tools/evaluate.mjs fights/<candidate>.json [--quick]
//       [--baseline fights/<other>.json] [--weights path.json] [--jobs N]
//
//   --quick      1 arena × 2 matches per cell (72 matches) instead of the
//                full 5 × 2 (360). Same seeds per cell as the full gauntlet.
//   --baseline   ALSO run <other> through the identical cells (same seeds —
//                common random numbers) and report PAIRED per-cell kill-diff
//                deltas with an exact sign test and a bootstrap 95% CI.
//   --weights    Evaluate an unshipped checkpoint as the candidate via the
//                registerNeuralNet seam (neural forward pass; accepts a flat
//                number[], an evolve checkpoint {dims, mean}, or
//                {dims, weights, biases}). The card still names coach/engine
//                identity and contributes its tweaks.
//
// RESERVED: arena seeds [101, 202, 303, 404, 505] and match seeds 90000+
// belong to the gauntlet. Never train or tune against them (see the rule in
// evaluate.ts and MANUAL.md §5 Evaluation).
//
// In-memory only: matches run through runMatch directly — no datasets are
// written, the corpus and the public board never see gauntlet matches.
// Results append one JSON line to tools/eval-ledger.jsonl (the experiment
// registry — append-only, never rewrite history).
//
// Zero npm deps; re-execs itself under the arena package's tsx (EVAL_TSX)
// so the extensionless TS import chain resolves.

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = join(dirname(SELF), '..');
const TSX = join(ROOT, 'packages/arena/node_modules/.bin/tsx');

// --- bootstrap: re-exec under tsx so the TS import chain resolves ------------
if (process.env.EVAL_TSX !== '1') {
  const r = spawnSync(TSX, [SELF, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, EVAL_TSX: '1' },
  });
  process.exit(r.status ?? 1);
}

const {
  EVAL_SPEC_V1,
  bootstrapCi,
  buildLedgerLine,
  gauntletCells,
  pairedDeltas,
  registerCardFighter,
  registerWeightsFighter,
  runCell,
  signTest,
  summarize,
} = await import('../packages/arena/src/evaluate.ts');
const { validateCard } = await import('../packages/arena/src/fighterCard.ts');

// --- CLI ----------------------------------------------------------------------
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};
const has = (name) => args.includes(`--${name}`);

const WORKER = has('worker');
const QUICK = has('quick');
const BASELINE_PATH = flag('baseline');
const WEIGHTS_PATH = flag('weights');
const JOBS = Math.max(1, Number(flag('jobs') ?? Math.min(8, availableParallelism() - 2)));
const LEDGER_PATH = join(ROOT, 'tools/eval-ledger.jsonl');

const CAND_ID = 'eval-cand';
const BASE_ID = 'eval-base';

const sha12 = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 12);

/** Register a fighter spec (shared by main process and workers). */
function registerFighter(f) {
  if (f.kind === 'weights') registerWeightsFighter(f.id, f.raw, f.tweaks);
  else registerCardFighter(f.id, f.engine, f.tweaks);
}

// --- worker mode: JSONL jobs on stdin, JSONL results on stdout -----------------
if (WORKER) {
  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    const msg = JSON.parse(line);
    if (msg.type === 'register') {
      for (const f of msg.fighters) registerFighter(f);
      process.stdout.write(JSON.stringify({ type: 'registered' }) + '\n');
    } else if (msg.type === 'eval') {
      const result = runCell(msg.fighterId, msg.cell);
      process.stdout.write(JSON.stringify({ type: 'result', id: msg.id, result }) + '\n');
    } else if (msg.type === 'exit') {
      process.exit(0);
    }
  });
  rl.on('close', () => process.exit(0));
} else {
  await main();
}

// --- worker pool (same pattern as tools/evolve.mjs) -----------------------------
function startWorkers(n) {
  return Array.from({ length: n }, () => {
    const proc = spawn(TSX, [SELF, '--worker'], {
      env: { ...process.env, EVAL_TSX: '1' },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const rl = createInterface({ input: proc.stdout, terminal: false });
    const w = { proc, rl, pending: null };
    rl.on('line', (line) => {
      const msg = JSON.parse(line);
      const resolve = w.pending;
      w.pending = null;
      if (resolve) resolve(msg);
    });
    return w;
  });
}

function workerSend(w, msg) {
  return new Promise((resolve) => {
    w.pending = resolve;
    w.proc.stdin.write(JSON.stringify(msg) + '\n');
  });
}

/** Run cells across the pool (or inline). Deterministic regardless of
 *  scheduling: every cell is a pure function of its own seeds. */
async function runJobs(jobs, workers, onDone) {
  const results = new Array(jobs.length);
  if (workers.length === 0) {
    for (const job of jobs) {
      results[job.id] = runCell(job.fighterId, job.cell);
      onDone();
    }
    return results;
  }
  let next = 0;
  await Promise.all(
    workers.map(async (w) => {
      while (next < jobs.length) {
        const job = jobs[next++];
        const res = await workerSend(w, {
          type: 'eval',
          id: job.id,
          fighterId: job.fighterId,
          cell: job.cell,
        });
        results[res.id] = res.result;
        onDone();
      }
    }),
  );
  return results;
}

// --- tables ----------------------------------------------------------------------
// (function declarations only below main(): the top-level `await main()`
// runs before later `const` initializers — hoisting is load-bearing here)
function fmt(v, w, d = 2) {
  return v.toFixed(d).padStart(w);
}

function printSummary(label, summary) {
  console.log(`\n=== ${label} — ${EVAL_SPEC_V1.id}${QUICK ? ' (--quick)' : ''} ===`);
  console.log(
    'opponent      W-L-D      win%   killDiff/m     K/D    hit%   dom/m',
  );
  const row = (name, g) => {
    const wld = `${g.wins}-${g.losses}-${g.draws}`.padEnd(9);
    console.log(
      `${name.padEnd(12)}  ${wld} ${fmt(100 * g.winRate, 6, 1)}  ${fmt(g.killDiffPerMatch, 11)}  ${fmt(g.kd, 6)}  ${fmt(g.hitPct, 6, 1)}  ${fmt(g.domDiffPerMatch, 6, 1)}`,
    );
  };
  for (const [opp, g] of Object.entries(summary.perOpponent)) row(opp, g);
  row('OVERALL', summary.overall);
  console.log(
    `GAUNTLET SCORE (mean per-opponent killDiff/match, equal-weighted): ${summary.score.toFixed(3)}`,
  );
}

function printPaired(candLabel, baseLabel, deltas, st, ci) {
  console.log(`\n=== PAIRED: ${candLabel} − ${baseLabel} (common random numbers) ===`);
  console.log('opponent      cells   mean Δ killDiff');
  for (const opp of EVAL_SPEC_V1.opponents) {
    const ds = deltas.filter((d) => d.opponent === opp).map((d) => d.delta);
    if (ds.length === 0) continue;
    console.log(
      `${opp.padEnd(12)}  ${String(ds.length).padStart(5)}   ${fmt(ds.reduce((a, b) => a + b, 0) / ds.length, 8)}`,
    );
  }
  console.log(
    `overall: mean Δ ${ci.mean.toFixed(3)} per match, bootstrap 95% CI [${ci.lo.toFixed(3)}, ${ci.hi.toFixed(3)}] (${ci.iters} resamples)`,
  );
  console.log(
    `sign test: +${st.pos} / −${st.neg} / =${st.zero} cells, two-sided p = ${st.pValue.toPrecision(3)}`,
  );
}

// --- main ---------------------------------------------------------------------------
function loadFighter(id, path, weightsPath) {
  const bytes = readFileSync(join(ROOT, path));
  const { card } = validateCard(JSON.parse(bytes.toString('utf8')));
  const identity = {
    path,
    coach: card.coach,
    engine: card.engine,
    tweaks: card.tweaks,
    hash: sha12(bytes),
  };
  if (weightsPath !== undefined) {
    const wBytes = readFileSync(join(ROOT, weightsPath));
    return {
      spec: { id, kind: 'weights', raw: JSON.parse(wBytes.toString('utf8')), tweaks: card.tweaks },
      identity,
      weights: { path: weightsPath, hash: sha12(wBytes) },
    };
  }
  return {
    spec: { id, kind: 'card', engine: card.engine, tweaks: card.tweaks },
    identity,
    weights: null,
  };
}

async function main() {
  const candPath = args.find((a) => !a.startsWith('--') && a !== flag('baseline') && a !== flag('weights') && a !== flag('jobs'));
  if (candPath === undefined) {
    console.error('usage: node tools/evaluate.mjs fights/<candidate>.json [--quick] [--baseline fights/<other>.json] [--weights path.json] [--jobs N]');
    process.exit(2);
  }

  const cand = loadFighter(CAND_ID, candPath, WEIGHTS_PATH);
  const base = BASELINE_PATH !== undefined ? loadFighter(BASE_ID, BASELINE_PATH) : null;
  const fighters = [cand.spec, ...(base !== null ? [base.spec] : [])];
  for (const f of fighters) registerFighter(f);

  const cells = gauntletCells(QUICK);
  const jobs = [];
  for (const f of fighters) {
    for (const cell of cells) jobs.push({ id: jobs.length, fighterId: f.id, cell });
  }

  const candLabel = `${cand.identity.coach} (${cand.identity.engine}${cand.weights !== null ? ` + ${cand.weights.path}` : ''})`;
  console.log(
    `[gauntlet] ${EVAL_SPEC_V1.id}${QUICK ? ' --quick' : ''}: ${cells.length} cells/fighter × ${fighters.length} fighter(s) = ${jobs.length} matches, ` +
      `${EVAL_SPEC_V1.roundTicks / 60}s rounds, arenas [${(QUICK ? EVAL_SPEC_V1.arenas.slice(0, 1) : EVAL_SPEC_V1.arenas).join(', ')}], seeds ${EVAL_SPEC_V1.seedBase}+, ${JOBS} worker(s)`,
  );
  console.log(`[gauntlet] candidate: ${candLabel}${base !== null ? ` | baseline: ${base.identity.coach} (${base.identity.engine})` : ''}`);

  const t0 = Date.now();
  const workers = JOBS > 1 ? startWorkers(JOBS) : [];
  if (workers.length > 0) {
    await Promise.all(workers.map((w) => workerSend(w, { type: 'register', fighters })));
  }
  let done = 0;
  const results = await runJobs(jobs, workers, () => {
    done++;
    if (done % 24 === 0 || done === jobs.length) {
      process.stderr.write(`\r[gauntlet] ${done}/${jobs.length} matches (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    }
  });
  for (const w of workers) w.proc.stdin.write(JSON.stringify({ type: 'exit' }) + '\n');
  process.stderr.write('\n');
  const secs = (Date.now() - t0) / 1000;

  const candResults = results.filter((_, i) => jobs[i].fighterId === CAND_ID);
  const candSummary = summarize(candResults);
  printSummary(candLabel, candSummary);

  let baseSummary = null;
  let paired = null;
  if (base !== null) {
    const baseResults = results.filter((_, i) => jobs[i].fighterId === BASE_ID);
    baseSummary = summarize(baseResults);
    printSummary(`${base.identity.coach} (${base.identity.engine}) [baseline]`, baseSummary);
    const deltas = pairedDeltas(candResults, baseResults);
    const st = signTest(deltas.map((d) => d.delta));
    const ci = bootstrapCi(deltas.map((d) => d.delta));
    printPaired(cand.identity.coach, base.identity.coach, deltas, st, ci);
    paired = { cells: deltas.length, meanDelta: ci.mean, ci95: [ci.lo, ci.hi], signTest: st };
  }

  const line = buildLedgerLine({
    ts: new Date().toISOString(),
    quick: QUICK,
    candidate: cand.identity,
    weights: cand.weights,
    baseline: base !== null ? base.identity : null,
    results: candSummary,
    baselineResults: baseSummary,
    paired,
    secs: Number(secs.toFixed(1)),
  });
  appendFileSync(LEDGER_PATH, JSON.stringify(line) + '\n');
  console.log(`\n[gauntlet] ${secs.toFixed(1)}s — ledger line appended to tools/eval-ledger.jsonl`);
}
