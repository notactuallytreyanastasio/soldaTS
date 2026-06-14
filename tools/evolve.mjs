#!/usr/bin/env node
// Evolution-strategies self-play for the `neural` engine — phase 2 of the
// learned player (goal 337 / decision 341 / action 347).
//
// Starts from the committed imitation weights (neuralWeights.ts) and climbs
// match fitness against the reigning doctrines: each generation samples
// antithetic weight perturbations, plays every candidate through the headless
// runMatch environment vs a rotating opponent pool (the 4 champion cards +
// past-self snapshots), rank-shapes the fitnesses, and steps the mean
// (packages/arena/src/evolve.ts holds the pure math + tests).
//
// No datasets are written — candidate matches use runMatch directly and keep
// everything in memory. Candidate weights reach the brain through the
// registry seam: createNeuralEngineWithWeights under throwaway engine ids
// ('neural-cand', 'neural-past-<gen>'), so the shipped `neural` engine and
// all recorded artifacts stay byte-identical.
//
// Shipping gate: every checkpoint, the current MEAN plays the imitation
// baseline head-to-head (3 × 120 s); only a ≥2 win series regenerates
// packages/client/src/ai/neuralWeights.ts (same export shape, provenance
// header) — otherwise the shipped weights are left alone and the log says so.
//
// Usage:
//   node tools/evolve.mjs --generations 60 --pop 24 --matches 2 [--resume]
//   node tools/evolve.mjs --eval-only            # shipped weights vs the pool
// Flags: --sigma 0.02 (× rms of the baseline weights) --lr 0.01 --decay 0
//        --seed 1 --round-ticks 3600 --jobs 8 (parallel match workers)
//        --gate-every 10 --snapshot-every 10
//
// --engine neural|mojojojo (default neural): which learned brain to evolve.
//   mojojojo (goal node 553, stage 2) runs the SAME ES loop over MOJOJOJO's
//   48→128→128→31 net via the registerMojojojoNet seam, starting from and
//   gating against the stage-1 imitation seed (mojojojoWeights.ts), with its
//   own checkpoint dir (tools/checkpoints-mojojojo).
// --hit-fit C (default 0): adds C·teamHitRate to each match's fitness
//   (candidate team's hits/shots). MOJOJOJO's reason to exist: BUTTSTEIN
//   dodged to near-parity at hit rate 2.94% vs the disciple's 17.4 — kills
//   alone reward more dodging, so conversion gets its own term. C=30 sizes
//   closing that hole (~14 points of hit rate) at ~4 kills/match — the size
//   of the residual BUTTSTEIN−DISCIPLE gap.
//
// Zero npm deps; the runner's import chain is extensionless TS, so this
// script re-execs itself under the arena package's tsx once (EVOLVE_TSX).

import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = join(dirname(SELF), '..');
const TSX = join(ROOT, 'packages/arena/node_modules/.bin/tsx');

// --- bootstrap: re-exec under tsx so the TS import chain resolves ------------
if (process.env.EVOLVE_TSX !== '1') {
  const r = spawnSync(TSX, [SELF, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, EVOLVE_TSX: '1' },
  });
  process.exit(r.status ?? 1);
}

const { runMatch } = await import('../packages/arena/src/runner.ts');
const {
  MOJOJOJO_SHIPPED_NET,
  NEURAL_SHIPPED_NET,
  esUpdate,
  flattenNet,
  makeCheckpoint,
  mulberry32,
  parseCheckpoint,
  registerMojojojoNet,
  registerNeuralNet,
  rms,
  samplePerturbations,
  unflattenNet,
} = await import('../packages/arena/src/evolve.ts');

// --- CLI ----------------------------------------------------------------------
const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
const has = (name) => args.includes(`--${name}`);

const GENERATIONS = Number(flag('generations', 60));
const POP = Number(flag('pop', 24)); // antithetic PAIRS → 2*POP candidates
const MATCHES = Number(flag('matches', 2)); // per candidate per generation
const SIGMA_REL = Number(flag('sigma', 0.02)); // × rms(baseline weights)
const LR = Number(flag('lr', 0.01));
const DECAY = Number(flag('decay', 0)); // pull toward the imitation anchor
const SEED = Number(flag('seed', 1));
const ROUND_TICKS = Number(flag('round-ticks', 3600)); // 60 s rounds
const JOBS = Math.max(1, Number(flag('jobs', Math.min(8, availableParallelism() - 2))));
const GATE_EVERY = Number(flag('gate-every', 10));
const SNAPSHOT_EVERY = Number(flag('snapshot-every', 10));
const RESUME = has('resume');
const EVAL_ONLY = has('eval-only');
const WORKER = has('worker');
const ENGINE = flag('engine', 'neural'); // 'neural' | 'mojojojo'
const HIT_FIT = Number(flag('hit-fit', 0)); // fitness += HIT_FIT·teamHitRate

if (ENGINE !== 'neural' && ENGINE !== 'mojojojo') {
  console.error(`unknown --engine '${ENGINE}' (neural | mojojojo)`);
  process.exit(1);
}
/** Engine-specific seam: register `id` to run `net` through ENGINE's brain. */
const registerNet = ENGINE === 'mojojojo' ? registerMojojojoNet : registerNeuralNet;

const LOG_PATH = join(ROOT, 'tools/evolve-log.jsonl');
const CKPT_DIR = join(
  ROOT,
  ENGINE === 'neural' ? 'tools/checkpoints' : `tools/checkpoints-${ENGINE}`,
);
const WEIGHTS_TS = join(
  ROOT,
  ENGINE === 'neural'
    ? 'packages/client/src/ai/neuralWeights.ts'
    : 'packages/client/src/ai/mojojojoWeights.ts',
);

// Arena layouts rotate per generation so the policy can't overfit one map.
const ARENAS = [0, 5, 11, 23, 41];
const POOL_CAP = 8; // champions (4) + at most 4 past selves

/** The 4 reigning doctrines, tweaks straight from their fighter cards. */
function loadChampions() {
  const cards = ['belmonte.json', 'akela.json', 'falconer-shrike.json', 'lerna.json'];
  return cards.map((f) => {
    const c = JSON.parse(readFileSync(join(ROOT, 'fights', f), 'utf8'));
    return { key: c.coach, engine: c.engine, tweaks: c.tweaks ?? {}, champion: true };
  });
}

const SHIPPED_NET = ENGINE === 'mojojojo' ? MOJOJOJO_SHIPPED_NET : NEURAL_SHIPPED_NET;
const DIMS = SHIPPED_NET.dims;
const BASE_FLAT = flattenNet(SHIPPED_NET);
const DIM = BASE_FLAT.length;
const SIGMA_ABS = SIGMA_REL * rms(BASE_FLAT);
const CAND_ID = `${ENGINE}-cand`;

// --- shared: evaluate one candidate net over a match list ----------------------
// matches: [{ arenaSeed, seed, roundTicks, engine, tweaks, champion }]
// Registration is per-process and re-done before every eval — sequential
// within a process, so '<engine>-cand' always means THIS candidate's weights.
function evalCandidate(flat, matches) {
  registerNet(CAND_ID, unflattenNet(DIMS, flat));
  let fitness = 0;
  let champWins = 0;
  let champCount = 0;
  let killsFor = 0;
  let killsAgainst = 0;
  let shotsFor = 0;
  let hitsFor = 0;
  for (const m of matches) {
    const result = runMatch({
      arenaSeed: m.arenaSeed,
      seed: m.seed,
      roundTicks: m.roundTicks,
      teams: [{ engine: CAND_ID }, { engine: m.engine, tweaks: m.tweaks }],
    });
    const r = result.round;
    if (r === null) continue; // maxTicks cap — scoreless, shouldn't happen
    fitness += r.redKills - r.blueKills + 0.25 * (r.redDom - r.blueDom);
    if (HIT_FIT > 0) {
      // The candidate's team-wide conversion: hits/shots by red (team 1) —
      // see the --hit-fit rationale in the header.
      const redBots = new Set(result.bots.filter((b) => b.team === 1).map((b) => b.index));
      let shots = 0;
      let hits = 0;
      for (const e of result.events) {
        if (e.type === 'shot' && redBots.has(e.bot)) shots++;
        else if (e.type === 'hit' && redBots.has(e.attacker)) hits++;
      }
      fitness += HIT_FIT * (shots > 0 ? hits / shots : 0);
      shotsFor += shots;
      hitsFor += hits;
    }
    killsFor += r.redKills;
    killsAgainst += r.blueKills;
    if (m.champion) {
      champCount++;
      if (r.winnerTeam === 1) champWins++;
    }
  }
  return { fitness, champWins, champCount, killsFor, killsAgainst, shotsFor, hitsFor };
}

// --- worker mode: JSONL jobs on stdin, JSONL results on stdout -----------------
if (WORKER) {
  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    const msg = JSON.parse(line);
    if (msg.type === 'register') {
      // Past-self pool entries, registered once per pool change.
      for (const p of msg.nets) registerNet(p.key, unflattenNet(DIMS, p.flat));
      process.stdout.write(JSON.stringify({ type: 'registered' }) + '\n');
    } else if (msg.type === 'eval') {
      const res = evalCandidate(Float64Array.from(msg.flat), msg.matches);
      process.stdout.write(JSON.stringify({ type: 'result', id: msg.id, ...res }) + '\n');
    } else if (msg.type === 'exit') {
      process.exit(0);
    }
  });
  rl.on('close', () => process.exit(0));
} else {
  await main();
}

// --- worker pool ----------------------------------------------------------------
function startWorkers(n) {
  return Array.from({ length: n }, () => {
    // Workers inherit the engine seam + fitness shaping flags.
    const proc = spawn(TSX, [SELF, '--worker', '--engine', ENGINE, '--hit-fit', String(HIT_FIT)], {
      env: { ...process.env, EVOLVE_TSX: '1' },
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

/** Run eval jobs across the pool (or inline when no workers). Results are
 *  deterministic regardless of scheduling: every job is a pure function of
 *  its own seeds. */
async function runJobs(jobs, workers) {
  const results = new Array(jobs.length);
  if (workers.length === 0) {
    for (const job of jobs) results[job.id] = evalCandidate(job.flat, job.matches);
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
          flat: [...job.flat],
          matches: job.matches,
        });
        results[res.id] = res;
      }
    }),
  );
  return results;
}

// --- shipping: regenerate the engine's weights TS from a flat vector -------------
function writeWeightsTs(flat, gen, gateNote, meanFitness) {
  const net = unflattenNet(DIMS, flat);
  const fmt = (arr) => {
    const parts = [];
    for (let i = 0; i < arr.length; i++) parts.push(Number(arr[i].toPrecision(7)));
    return JSON.stringify(parts);
  };
  if (ENGINE === 'mojojojo') {
    const file = `// GENERATED BY tools/evolve.mjs --engine mojojojo — DO NOT EDIT BY HAND.
// Re-evolve: node tools/evolve.mjs --engine mojojojo (see flags in that
// file); the imitation seed comes from tools/train-mojojojo.mjs.
//
// MOJOJOJO STAGE 2 of 2 (goal node 553): evolution-strategies self-play from
// the stage-1 outcome-weighted imitation seed. Written ${new Date().toISOString()}
// at generation ${gen} (antithetic ES, pop ${POP} pairs, ${MATCHES} matches/candidate,
// sigma ${SIGMA_REL}×rms, lr ${LR}, seed ${SEED}, ${ROUND_TICKS / 60}s rounds vs champions + past
// selves). Fitness per match: killDiff + 0.25·domDiff + ${HIT_FIT}·teamHitRate —
// the hit-rate term is MOJOJOJO's assignment (BUTTSTEIN dodged to
// near-parity at hit rate 2.94%; conversion gets its own gradient).
// Mean candidate fitness at this generation: ${meanFitness.toFixed(2)}.
// Shipping gate: ${gateNote}
//
// STAGE 1 imitation parent (tools/train-mojojojo.mjs, teacher cuadrilla,
// 3,000,000 schema-v2 samples, 178 matches / 64 runs): fire head
// OUTCOME-WEIGHTED (hit ×5 / miss ×0.3 / no-fire ×1) — fire acc 92.32%
// (base rate 6.95%), P/R vs teacher 44.08/39.35%, P/R vs HIT-CONVERTING
// rows 12.92/24.32%; aim blended ×5 hit-weighted (buttstein's recipe,
// unchanged) — all-rows top-1 76.72% / cos 0.8729, hit-rows top-1 85.45%
// / cos 0.9256. Factory FIRE_THRESH 0.35 (probed over 5 seeds — the only
// sustaining threshold).
//
// Layout: dense layers input→128 tanh→128 tanh→31 raw (7 button logits +
// 24 aim-direction bin logits, 15° sectors). weights[l] is row-major
// [fanOut × fanIn]; the runtime forward pass lives in mojojojo.ts and the
// feature contract in neuralFeaturesV3.ts (FEATURE_DIM_V3 ${DIMS[0]}).

/** Number of aim-direction bins in the classification head. */
export const MOJOJOJO_AIM_BINS = 24;

export const MOJOJOJO_DIMS: readonly number[] = ${JSON.stringify([...DIMS])};

export const MOJOJOJO_WEIGHTS: readonly (readonly number[])[] = [
${net.weights.map((w) => `  ${fmt(w)},`).join('\n')}
];

export const MOJOJOJO_BIASES: readonly (readonly number[])[] = [
${net.biases.map((b) => `  ${fmt(b)},`).join('\n')}
];
`;
    writeFileSync(WEIGHTS_TS, file);
    return;
  }
  const file = `// GENERATED BY tools/evolve.mjs — DO NOT EDIT BY HAND.
// Re-evolve: node tools/evolve.mjs (see flags in that file); the imitation
// parent comes from tools/train-imitation.mjs.
//
// Evolution-strategies self-play weights for the neural engine (decision
// node 341, phase 2). Written ${new Date().toISOString()} at generation ${gen}
// (antithetic ES, pop ${POP} pairs, ${MATCHES} matches/candidate, sigma ${SIGMA_REL}×rms,
// lr ${LR}, seed ${SEED}, ${ROUND_TICKS / 60}s rounds vs champions + past selves).
// Mean candidate fitness at this generation: ${meanFitness.toFixed(2)}
// (sum over matches of killDiff + 0.25·domDiff).
// Shipping gate: ${gateNote}
// Imitation parent (phase 1): aim cosine 0.786, button acc 79-99%,
// trained on 1,440,621 replay rows across 11 doctrines.
//
// Layout: dense layers input→64 tanh→64 tanh→9 raw (7 button logits + 2 aim).
// weights[l] is row-major [fanOut × fanIn]; the runtime forward pass lives in
// neural.ts and the feature contract in neuralFeatures.ts (FEATURE_DIM ${DIMS[0]}).

export const NEURAL_DIMS: readonly number[] = ${JSON.stringify([...DIMS])};

export const NEURAL_WEIGHTS: readonly (readonly number[])[] = [
${net.weights.map((w) => `  ${fmt(w)},`).join('\n')}
];

export const NEURAL_BIASES: readonly (readonly number[])[] = [
${net.biases.map((b) => `  ${fmt(b)},`).join('\n')}
];
`;
  writeFileSync(WEIGHTS_TS, file);
}

// --- the gate: mean vs the imitation baseline, 3 × 120 s -------------------------
function gateVsBaseline(flat, gen) {
  registerNet(CAND_ID, unflattenNet(DIMS, flat));
  registerNet(`${ENGINE}-imit`, unflattenNet(DIMS, BASE_FLAT));
  let wins = 0;
  const scores = [];
  for (let j = 0; j < 3; j++) {
    const r = runMatch({
      arenaSeed: ARENAS[j % ARENAS.length],
      seed: gen * 977 + j,
      roundTicks: 7200,
      teams: [{ engine: CAND_ID }, { engine: `${ENGINE}-imit` }],
    }).round;
    if (r === null) continue;
    if (r.winnerTeam === 1) wins++;
    scores.push(`${r.redKills}-${r.blueKills}`);
  }
  return { wins, scores };
}

// --- eval-only: shipped weights vs the champion pool ------------------------------
function evalOnly() {
  const champions = loadChampions();
  console.log(`[eval] shipped ${ENGINE} weights vs the champion pool (${ROUND_TICKS / 60}s rounds)`);
  console.log('opponent              W-L   killsFor  killsAgainst  avg fitness');
  for (const champ of champions) {
    const matches = ARENAS.slice(0, 4).map((arenaSeed, k) => ({
      arenaSeed,
      seed: 9000 + k,
      roundTicks: ROUND_TICKS,
      engine: champ.engine,
      tweaks: champ.tweaks,
      champion: true,
    }));
    const r = evalCandidate(BASE_FLAT, matches);
    console.log(
      `${champ.key.padEnd(20)} ${r.champWins}-${r.champCount - r.champWins}   ` +
        `${String(r.killsFor).padStart(8)}  ${String(r.killsAgainst).padStart(12)}  ` +
        `${(r.fitness / matches.length).toFixed(2).padStart(11)}`,
    );
  }
}

// --- main evolution loop ------------------------------------------------------------
async function main() {
  if (EVAL_ONLY) {
    evalOnly();
    return;
  }

  mkdirSync(CKPT_DIR, { recursive: true });
  const champions = loadChampions();

  let mean = Float64Array.from(BASE_FLAT);
  let startGen = 1;
  let pastSelves = []; // { gen, flat: Float64Array }

  if (RESUME) {
    const ckpts = readdirSync(CKPT_DIR)
      .filter((f) => /^gen\d+\.json$/.test(f))
      .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
    const latest = ckpts.at(-1);
    if (latest === undefined) {
      console.log('[resume] no checkpoints found — starting fresh from the imitation weights');
    } else {
      const c = parseCheckpoint(readFileSync(join(CKPT_DIR, latest), 'utf8'));
      mean = Float64Array.from(c.mean);
      startGen = c.gen + 1;
      pastSelves = c.pastSelves.map((p) => ({ gen: p.gen, flat: Float64Array.from(p.flat) }));
      console.log(`[resume] ${latest}: gen ${c.gen}, ${pastSelves.length} past selves in pool`);
    }
  }

  const workers = JOBS > 1 ? startWorkers(JOBS) : [];
  console.log(
    `[evolve] engine=${ENGINE}${HIT_FIT > 0 ? ` hit-fit=${HIT_FIT}` : ''}: ` +
      `${DIM} params, sigma ${SIGMA_ABS.toFixed(5)} (${SIGMA_REL}×rms ${rms(BASE_FLAT).toFixed(4)}), ` +
      `lr ${LR}, pop ${POP} pairs × ${MATCHES} matches, ${ROUND_TICKS / 60}s rounds, ` +
      `${workers.length || 1} worker(s), gens ${startGen}..${startGen + GENERATIONS - 1}`,
  );

  let poolDirty = true; // (re)send past selves to workers when the pool changes

  for (let gen = startGen; gen < startGen + GENERATIONS; gen++) {
    const t0 = Date.now();

    if (poolDirty && workers.length > 0) {
      const nets = pastSelves.map((p) => ({ key: `${ENGINE}-past-${p.gen}`, flat: [...p.flat] }));
      await Promise.all(workers.map((w) => workerSend(w, { type: 'register', nets })));
      poolDirty = false;
    }
    const pool = [
      ...champions,
      ...pastSelves.map((p) => ({
        key: `${ENGINE}-past-${p.gen}`,
        engine: `${ENGINE}-past-${p.gen}`,
        tweaks: undefined,
        champion: false,
      })),
    ];
    // Past selves must also exist in THIS process (gate + jobs-1 mode).
    for (const p of pastSelves) registerNet(`${ENGINE}-past-${p.gen}`, unflattenNet(DIMS, p.flat));

    // Common random numbers: every candidate in the generation plays the SAME
    // opponents on the SAME seeds — fitness differences are pure policy.
    const matchSpecs = Array.from({ length: MATCHES }, (_, k) => {
      const opp = pool[(gen * MATCHES + k) % pool.length];
      return {
        arenaSeed: ARENAS[(gen + k) % ARENAS.length],
        seed: gen * 10007 + k * 101 + 7,
        roundTicks: ROUND_TICKS,
        engine: opp.engine,
        tweaks: opp.tweaks,
        champion: opp.champion,
      };
    });

    const eps = samplePerturbations(mulberry32(SEED * 100003 + gen), DIM, POP);
    const jobs = [];
    for (let i = 0; i < POP; i++) {
      for (const sign of [1, -1]) {
        const flat = new Float64Array(DIM);
        for (let k = 0; k < DIM; k++) flat[k] = mean[k] + sign * SIGMA_ABS * eps[i][k];
        jobs.push({ id: jobs.length, flat, matches: matchSpecs });
      }
    }
    const results = await runJobs(jobs, workers);

    const fitPlus = [];
    const fitMinus = [];
    let champWins = 0;
    let champCount = 0;
    let shotsAll = 0;
    let hitsAll = 0;
    for (let i = 0; i < POP; i++) {
      fitPlus.push(results[2 * i].fitness);
      fitMinus.push(results[2 * i + 1].fitness);
      for (const r of [results[2 * i], results[2 * i + 1]]) {
        champWins += r.champWins;
        champCount += r.champCount;
        shotsAll += r.shotsFor ?? 0;
        hitsAll += r.hitsFor ?? 0;
      }
    }
    mean = esUpdate(mean, eps, fitPlus, fitMinus, { lr: LR, decay: DECAY, anchor: BASE_FLAT });

    const all = [...fitPlus, ...fitMinus];
    const meanFitness = all.reduce((a, b) => a + b, 0) / all.length;
    const bestFitness = Math.max(...all);
    const vsChampionWinRate = champCount > 0 ? champWins / champCount : null;
    const hitRate = HIT_FIT > 0 && shotsAll > 0 ? hitsAll / shotsAll : null;
    const secs = (Date.now() - t0) / 1000;
    const opps = matchSpecs.map((m) => m.engine).join(',');
    appendFileSync(
      LOG_PATH,
      JSON.stringify({
        ...(ENGINE === 'neural' ? {} : { engine: ENGINE, hitFit: HIT_FIT }),
        gen,
        meanFitness: Number(meanFitness.toFixed(3)),
        bestFitness: Number(bestFitness.toFixed(3)),
        vsChampionWinRate,
        ...(hitRate === null ? {} : { hitRate: Number(hitRate.toFixed(4)) }),
        opponents: opps,
        arenaSeeds: matchSpecs.map((m) => m.arenaSeed),
        sigma: Number(SIGMA_ABS.toFixed(6)),
        lr: LR,
        secs: Number(secs.toFixed(1)),
      }) + '\n',
    );
    console.log(
      `[gen ${gen}] mean ${meanFitness.toFixed(2)} best ${bestFitness.toFixed(2)} ` +
        `vsChamp ${vsChampionWinRate === null ? 'n/a' : (vsChampionWinRate * 100).toFixed(0) + '%'} ` +
        `${hitRate === null ? '' : `hit% ${(hitRate * 100).toFixed(2)} `}(${opps}) ${secs.toFixed(1)}s`,
    );

    const last = gen === startGen + GENERATIONS - 1;

    if (gen % SNAPSHOT_EVERY === 0 || last) {
      // Past-self snapshot into the pool (champions are never evicted).
      pastSelves.push({ gen, flat: Float64Array.from(mean) });
      while (champions.length + pastSelves.length > POOL_CAP) pastSelves.shift();
      poolDirty = true;
      writeFileSync(
        join(CKPT_DIR, `gen${gen}.json`),
        JSON.stringify(makeCheckpoint(gen, DIMS, mean, pastSelves, meanFitness, bestFitness)),
      );
      console.log(`[ckpt] wrote ${join(CKPT_DIR, `gen${gen}.json`)}`);
    }

    if (gen % GATE_EVERY === 0 || last) {
      const gate = gateVsBaseline(mean, gen);
      const shipped = gate.wins >= 2;
      const note = `gen ${gen} mean vs imitation baseline ${gate.wins}-${3 - gate.wins} (${gate.scores.join(', ')})`;
      if (shipped) {
        writeWeightsTs(mean, gen, note, meanFitness);
        console.log(`[gate] ${note} → SHIPPED to ${WEIGHTS_TS}`);
      } else {
        console.log(`[gate] ${note} → shipped weights left alone`);
      }
      appendFileSync(
        LOG_PATH,
        JSON.stringify({ gen, gate: note, shipped }) + '\n',
      );
    }
  }

  for (const w of workers) w.proc.stdin.write(JSON.stringify({ type: 'exit' }) + '\n');
}
