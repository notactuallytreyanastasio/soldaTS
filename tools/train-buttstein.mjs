#!/usr/bin/env node
// BUTTSTEIN's trainer (goal node 504) — the FOURTH learned brain, derived
// from tools/train-prodigy.mjs, and the first to train on EXACT data.
//
// PRODIGY's post-mortem (outcome nodes 485/489) prescribed all three fixes
// this trainer ships:
//
//   1. REPLAY SCHEMA V2 = NO RECONSTRUCTION. Schema soldat-arena-replay/2
//      rows carry the recorder-computed nearest-bullet-threat (btt + the
//      winning bullet's relative kinematics, selected by the SAME
//      closest-approach scan the runtime brains run), the exact weapon
//      label, and OWN SPRAY HEAT. Training features are now the identical
//      function of the identical inputs as runtime — the train/runtime
//      distribution mismatch that sank the prodigy's threat sense is gone.
//
//   2. SPRAY HEAT IS A SENSE (features v3, FEATURE_DIM_V3 48). The prodigy
//      fired ~36% of in-contact ticks and maxed the bloom (hit% 5.4 vs the
//      disciple's 17.4) because the heat its teacher's tap cadence manages
//      was invisible in v1 rows. The v3 student observes it.
//
//   3. BLENDED AIM LABELS. Hit-EXCLUSIVE labels were too sparse (6.6%);
//      all-rows labels (disciple) imitate the whiffs too. Blend: EVERY row
//      with a usable aim trains the 24-bin head, but rows whose shot landed
//      within the 40-tick flight window carry HIT_WEIGHT (default 5) times
//      the gradient — precision emphasized, volume kept.
//
// Carried from the prodigy lineage (the lessons that held):
//   - HISTORY DROPOUT 0.5 (exposure-bias fix, observation node 484): each
//     sample keeps its one-tick history with p=0.5 else zeros, so the policy
//     can't anchor on the teacher's always-on-target previous aim. Runtime
//     always feeds real history.
//   - SHOT ROWS ALWAYS SAMPLE regardless of stride (tap-cadence parity
//     lesson, observation node 481). Default stride is 1 here anyway: the
//     corpus is fresh and purpose-generated, not a 41 GB pool.
//   - RESERVED EVAL DATA IS NEVER TRAINED ON: datasets on gauntlet arenas
//     [101, 202, 303, 404, 505] are skipped whole; matches with seed ≥ 90000
//     are skipped individually. Both exclusions are counted and printed.
//
// Only schema soldat-arena-replay/2 datasets are read — v1 runs (the old
// pooled corpus) lack the exact fields and are skipped by the schema check.
//
// Usage: node tools/train-buttstein.mjs [--teacher cuadrilla] [--cap 3000000]
//        [--stride 1] [--epochs 6] [--lr 0.001] [--seed 1] [--hidden 128]
//        [--hist-dropout 0.5] [--hit-weight 5] [--max-datasets N]
//        [--datasets DIR] [--out FILE]

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = join(dirname(SELF), '..');

// --- bootstrap: re-exec under tsx so the extensionless TS import chain
// resolves — same pattern as tools/train-prodigy.mjs / evaluate.mjs.
if (process.env.TRAIN_TSX !== '1') {
  const r = spawnSync(join(ROOT, 'packages/arena/node_modules/.bin/tsx'), [SELF, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, TRAIN_TSX: '1' },
  });
  process.exit(r.status ?? 1);
}

const { buildNeuralFeaturesV3, FEATURE_DIM_V3 } =
  await import('../packages/client/src/ai/neuralFeaturesV3.ts');
const { nearestBulletThreat, weaponClassOf } =
  await import('../packages/client/src/ai/neuralFeaturesV2.ts');
const { BUTTON_HEADS } = await import('../packages/client/src/ai/neuralFeatures.ts');

// --- CLI ---------------------------------------------------------------------
const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
const TEACHER = flag('teacher', 'cuadrilla');
const CAP = Number(flag('cap', 3_000_000));
const STRIDE = Number(flag('stride', 1));
const EPOCHS = Number(flag('epochs', 6));
const LR = Number(flag('lr', 0.001));
const SEED = Number(flag('seed', 1));
const HIDDEN = Number(flag('hidden', 128));
const HIST_DROPOUT = Number(flag('hist-dropout', 0.5));
const HIT_WEIGHT = Number(flag('hit-weight', 5));
const MAX_DATASETS = Number(flag('max-datasets', Infinity));
const DATASETS_DIR = flag('datasets', join(ROOT, 'datasets'));
const OUT = flag('out', join(ROOT, 'packages/client/src/ai/buttsteinWeights.ts'));
const BATCH = 256;
const VAL_FRAC = 0.05;
const AIM_LOSS_W = 2; // aim CE weight vs mean button BCE, per weighted sample
const AIM_BINS = 24; // 15° per bin (the proven head)
const NB = BUTTON_HEADS.length; // 7 button heads
const OUT_DIM = NB + AIM_BINS; // 31 logits
// Y layout per sample: 7 buttons, 1 bin index, 1 aim weight (HIT_WEIGHT for
// hit rows, 1 otherwise, 0 = no usable aim), 2 true aim unit-vector comps
// (unit vector is metric-only — never a training target).
const Y_DIM = NB + 4;

// Reserved gauntlet data — the held-out rule (MANUAL §5, evaluate.mjs).
const RESERVED_ARENAS = new Set([101, 202, 303, 404, 505]);
const RESERVED_SEED_MIN = 90000;
const HIT_WINDOW = 40; // ticks — max credited bullet flight for the hit blend

// --- Seeded RNG (mulberry32) — reproducible runs ------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);

/** Aim direction → bin in [0, AIM_BINS): atan2 (-π,π] mapped to [0,2π). */
function aimBin(ax, ay) {
  const TWO_PI = Math.PI * 2;
  let a = Math.atan2(ay, ax);
  if (a < 0) a += TWO_PI;
  const b = Math.floor((a / TWO_PI) * AIM_BINS);
  return b >= AIM_BINS ? AIM_BINS - 1 : b; // a===2π edge
}

// --- 1. Discover datasets — teacher runs only, schema v2 only, reserved data excluded
const t0 = Date.now();
const runDirs = readdirSync(DATASETS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .filter((n) => existsSync(join(DATASETS_DIR, n, 'manifest.json')));

const runs = [];
let excludedArenaRuns = 0;
let excludedSeedMatches = 0;
let v1Skipped = 0;
for (const dir of runDirs) {
  try {
    const m = JSON.parse(readFileSync(join(DATASETS_DIR, dir, 'manifest.json'), 'utf8'));
    if (m.schema !== 'soldat-arena-replay/2') {
      v1Skipped++;
      continue; // v2 ONLY — older rows lack the exact threat/heat/weapon fields
    }
    const engines = (m.teams ?? []).map((t) => t.engine);
    if (!engines.includes(TEACHER)) continue; // teacher runs only
    const arenaMatch = /--arena\s+(\d+)/.exec(m.cli ?? '');
    const arenaSeed = arenaMatch !== null ? Number(arenaMatch[1]) : null;
    if (arenaSeed !== null && RESERVED_ARENAS.has(arenaSeed)) {
      excludedArenaRuns++;
      continue;
    }
    const matches = [];
    for (const x of m.matches ?? []) {
      if ((x.seed ?? 0) >= RESERVED_SEED_MIN) {
        excludedSeedMatches++;
        continue;
      }
      matches.push({ replay: x.files.replay, events: x.files.events });
    }
    if (matches.length === 0) continue;
    runs.push({ dir, matches });
  } catch {
    /* unreadable manifest → skip run */
  }
}
// Seeded shuffle so the cap fills from a uniform spread of the corpus.
for (let i = runs.length - 1; i > 0; i--) {
  const j = Math.floor(rng() * (i + 1));
  [runs[i], runs[j]] = [runs[j], runs[i]];
}
console.log(
  `[data] teacher=${TEACHER}: ${runs.length} v2 runs fielded the teacher ` +
    `(stride ${STRIDE}, cap ${CAP}, hit-weight ${HIT_WEIGHT}); ${v1Skipped} pre-v2 runs skipped; ` +
    `RESERVED EXCLUDED: ${excludedArenaRuns} runs on gauntlet arenas, ` +
    `${excludedSeedMatches} matches with seeds ≥ ${RESERVED_SEED_MIN}`,
);

// --- 2. Extract samples --------------------------------------------------------
const X = new Float32Array(CAP * FEATURE_DIM_V3);
const Y = new Float32Array(CAP * Y_DIM);
let nSamples = 0;
let nHit = 0; // samples carrying the HIT_WEIGHT aim emphasis
let zeroAimSkipped = 0;
let shotsSeen = 0;
let shotsHit = 0;

/**
 * Process one match: tick sweep with one-tick history and blended aim
 * weights. The threat block is read EXACTLY from the row (btt/btx/bty/
 * btvx/btvy) — nearestBulletThreat over the single logged winner reproduces
 * the runtime scan's output verbatim (see nearestThreatBullet's identity in
 * neuralFeaturesV3.ts). Rows arrive tick-sorted (the writer emits per tick
 * in bot order).
 */
function processMatch(rows, shotSet, hitsByBot) {
  const lastByBot = new Map(); // bot → {tick, vx, vy, aimUx, aimUy}

  let i = 0;
  while (i < rows.length && nSamples < CAP) {
    const T = rows[i].tick;
    let j = i;
    while (j < rows.length && rows[j].tick === T) j++;
    const group = rows.slice(i, j);
    i = j;

    for (const r of group) {
      if (nSamples >= CAP) break;
      if (r.engine !== TEACHER) continue; // SINGLE TEACHER — context only
      // Shot rows always sample regardless of stride (cadence parity lesson).
      const isShotRow = shotSet.has(r.bot * 100000 + T);
      if (T % STRIDE !== 0 && !isShotRow) continue;
      const ax = r.control.aimX;
      const ay = r.control.aimY;
      const alen = Math.hypot(ax, ay);
      if (alen === 0) {
        zeroAimSkipped++;
        continue; // no aim direction → unusable aim label
      }
      const enemies = [];
      const teammates = [];
      for (const o of group) {
        if (o === r) continue;
        const c = {
          dx: o.x - r.x,
          dy: o.y - r.y,
          vx: o.vx,
          vy: o.vy,
          hp: o.hp,
          reloading: o.reloading,
          ammo: o.ammo,
          weapon: weaponClassOf(o.weapon), // EXACT label, schema v2
        };
        if (o.team !== r.team) enemies.push(c);
        else teammates.push(c);
      }
      // EXACT threat: the recorder already ran the runtime scan; re-derive
      // the BulletThreat from the logged winner.
      const threat = r.btt
        ? nearestBulletThreat([{ rx: r.btx, ry: r.bty, vx: r.btvx, vy: r.btvy }])
        : null;
      const last = lastByBot.get(r.bot);
      // HISTORY DROPOUT (see header): randomly forget, so the policy can't
      // anchor on the teacher's always-on-target previous aim.
      const history =
        last !== undefined && last.tick === T - 1 && rng() >= HIST_DROPOUT
          ? { vx: last.vx, vy: last.vy, aimUx: last.aimUx, aimUy: last.aimUy }
          : null;
      const f = buildNeuralFeaturesV3(
        {
          vx: r.vx,
          vy: r.vy,
          fuel: r.fuel,
          hp: r.hp,
          ammo: r.ammo,
          reloading: r.reloading,
          onGround: r.onGround,
          weapon: weaponClassOf(r.weapon), // EXACT label, schema v2
          heat: r.heat, // EXACT spray bloom, schema v2 — the prodigy's blind spot
        },
        enemies,
        teammates,
        threat,
        history,
      );
      const xo = nSamples * FEATURE_DIM_V3;
      for (let k = 0; k < FEATURE_DIM_V3; k++) X[xo + k] = f[k];
      const yo = nSamples * Y_DIM;
      for (let k = 0; k < NB; k++) Y[yo + k] = r.control[BUTTON_HEADS[k]] ? 1 : 0;
      Y[yo + NB] = aimBin(ax, ay);
      // BLENDED AIM WEIGHT: every row trains the aim head at weight 1; rows
      // whose shot landed within the flight window train at HIT_WEIGHT.
      let w = 1;
      if (isShotRow) {
        const hits = hitsByBot.get(r.bot);
        if (hits !== undefined) {
          for (const ht of hits) {
            if (ht > T + HIT_WINDOW) break;
            if (ht >= T) {
              w = HIT_WEIGHT;
              break;
            }
          }
        }
      }
      Y[yo + NB + 1] = w;
      Y[yo + NB + 2] = ax / alen;
      Y[yo + NB + 3] = ay / alen;
      if (w > 1) nHit++;
      nSamples++;
    }

    // Roll history forward for every bot in the tick group.
    for (const r of group) {
      const al = Math.hypot(r.control.aimX, r.control.aimY);
      lastByBot.set(r.bot, {
        tick: T,
        vx: r.vx,
        vy: r.vy,
        aimUx: al > 0 ? r.control.aimX / al : 0,
        aimUy: al > 0 ? r.control.aimY / al : 0,
      });
    }
  }
}

let processedRuns = 0;
let processedMatches = 0;
for (const run of runs) {
  if (processedRuns >= MAX_DATASETS) break;
  if (nSamples >= CAP) break;
  processedRuns++;
  for (const match of run.matches) {
    if (nSamples >= CAP) break;
    const rPath = join(DATASETS_DIR, run.dir, match.replay);
    const ePath = join(DATASETS_DIR, run.dir, match.events);
    if (!existsSync(rPath) || !existsSync(ePath)) continue;
    let rText, eText;
    try {
      rText = gunzipSync(readFileSync(rPath)).toString('utf8');
      eText = gunzipSync(readFileSync(ePath)).toString('utf8');
    } catch {
      continue;
    }
    // Events: shot set (bot*100000+tick) + tick-sorted hit lists per attacker.
    const shotSet = new Set();
    const hitsByBot = new Map();
    let ls = 0;
    while (ls < eText.length) {
      let nl = eText.indexOf('\n', ls);
      if (nl < 0) nl = eText.length;
      const line = eText.slice(ls, nl);
      ls = nl + 1;
      if (line.length < 10) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.type === 'shot') {
        shotSet.add(e.bot * 100000 + e.tick);
        shotsSeen++;
      } else if (e.type === 'hit') {
        let arr = hitsByBot.get(e.attacker);
        if (arr === undefined) {
          arr = [];
          hitsByBot.set(e.attacker, arr);
        }
        arr.push(e.tick);
        shotsHit++;
      }
    }
    // Rows: parse everything (history needs T-1).
    const rows = [];
    ls = 0;
    while (ls < rText.length) {
      let nl = rText.indexOf('\n', ls);
      if (nl < 0) nl = rText.length;
      const line = rText.slice(ls, nl);
      ls = nl + 1;
      if (line.length < 10) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        /* torn tail line */
      }
    }
    if (rows.length === 0) continue;
    processMatch(rows, shotSet, hitsByBot);
    processedMatches++;
  }
  if (processedRuns % 10 === 0) {
    process.stderr.write(
      `\r[data] ${processedRuns} runs, ${processedMatches} matches → ${nSamples} samples (${nHit} hit-weighted)`,
    );
  }
}
process.stderr.write('\n');

console.log(
  `[data] ${nSamples} ${TEACHER} samples (${nHit} hit-weighted ×${HIT_WEIGHT} = ${((100 * nHit) / Math.max(1, nSamples)).toFixed(2)}%) ` +
    `from ${processedMatches} matches / ${processedRuns} runs in ${((Date.now() - t0) / 1000).toFixed(1)}s ` +
    `(${zeroAimSkipped} zero-aim rows skipped; corpus-wide ${shotsSeen} shots / ${shotsHit} hits)`,
);
if (nSamples < 1000 || nHit < 500) {
  console.error('[data] too few samples (or too few hit-weighted aim rows) — aborting');
  process.exit(1);
}

// --- 3. Shuffle + split ---------------------------------------------------------
const order = new Uint32Array(nSamples);
for (let i = 0; i < nSamples; i++) order[i] = i;
for (let i = nSamples - 1; i > 0; i--) {
  const j = Math.floor(rng() * (i + 1));
  const t = order[i];
  order[i] = order[j];
  order[j] = t;
}
const nVal = Math.floor(nSamples * VAL_FRAC);
const nTrain = nSamples - nVal;
console.log(`[train] ${nTrain} train / ${nVal} val`);

// --- 4. The MLP: FEATURE_DIM_V3 → 128 tanh → 128 tanh → 31 raw -----------------
const dims = [FEATURE_DIM_V3, HIDDEN, HIDDEN, OUT_DIM];
const W = [];
const B = [];
for (let l = 0; l < dims.length - 1; l++) {
  const fanIn = dims[l];
  const fanOut = dims[l + 1];
  const scale = Math.sqrt(6 / (fanIn + fanOut)); // Xavier uniform
  const w = new Float64Array(fanIn * fanOut);
  for (let i = 0; i < w.length; i++) w[i] = (rng() * 2 - 1) * scale;
  W.push(w);
  B.push(new Float64Array(fanOut));
}

// Adam state per parameter tensor.
const adam = (size) => ({ m: new Float64Array(size), v: new Float64Array(size) });
const aW = W.map((w) => adam(w.length));
const aB = B.map((b) => adam(b.length));
let adamT = 0;
const B1 = 0.9;
const B2 = 0.999;
const EPS = 1e-8;

function adamStep(param, grad, st) {
  const c1 = 1 - Math.pow(B1, adamT);
  const c2 = 1 - Math.pow(B2, adamT);
  for (let i = 0; i < param.length; i++) {
    const g = grad[i];
    st.m[i] = B1 * st.m[i] + (1 - B1) * g;
    st.v[i] = B2 * st.v[i] + (1 - B2) * g * g;
    param[i] -= (LR * (st.m[i] / c1)) / (Math.sqrt(st.v[i] / c2) + EPS);
  }
}

// Per-batch activation/grad buffers.
const FEAT = FEATURE_DIM_V3;
const h1 = new Float64Array(BATCH * HIDDEN);
const h2 = new Float64Array(BATCH * HIDDEN);
const out = new Float64Array(BATCH * OUT_DIM);
const d2 = new Float64Array(BATCH * HIDDEN);
const d1 = new Float64Array(BATCH * HIDDEN);
const dOut = new Float64Array(BATCH * OUT_DIM);
const gW = W.map((w) => new Float64Array(w.length));
const gB = B.map((b) => new Float64Array(b.length));

const sigmoid = (x) => 1 / (1 + Math.exp(-x));

/** Forward `n` samples whose indices are batchIdx[0..n); fills h1,h2,out. */
function forward(batchIdx, n) {
  for (let s = 0; s < n; s++) {
    const xo = batchIdx[s] * FEAT;
    for (let j = 0; j < HIDDEN; j++) {
      let acc = B[0][j];
      const wo = j * FEAT;
      for (let i = 0; i < FEAT; i++) acc += W[0][wo + i] * X[xo + i];
      h1[s * HIDDEN + j] = Math.tanh(acc);
    }
    for (let j = 0; j < HIDDEN; j++) {
      let acc = B[1][j];
      const wo = j * HIDDEN;
      const ho = s * HIDDEN;
      for (let i = 0; i < HIDDEN; i++) acc += W[1][wo + i] * h1[ho + i];
      h2[s * HIDDEN + j] = Math.tanh(acc);
    }
    for (let j = 0; j < OUT_DIM; j++) {
      let acc = B[2][j];
      const wo = j * HIDDEN;
      const ho = s * HIDDEN;
      for (let i = 0; i < HIDDEN; i++) acc += W[2][wo + i] * h2[ho + i];
      out[s * OUT_DIM + j] = acc;
    }
  }
}

/** Softmax over the aim logits of batch slot s, written into `probs`. */
function aimSoftmax(s, probs) {
  const oo = s * OUT_DIM + NB;
  let mx = -Infinity;
  for (let j = 0; j < AIM_BINS; j++) if (out[oo + j] > mx) mx = out[oo + j];
  let sum = 0;
  for (let j = 0; j < AIM_BINS; j++) {
    const e = Math.exp(out[oo + j] - mx);
    probs[j] = e;
    sum += e;
  }
  for (let j = 0; j < AIM_BINS; j++) probs[j] /= sum;
}

const probsBuf = new Float64Array(AIM_BINS);

function trainBatch(batchIdx, n) {
  forward(batchIdx, n);
  // Output deltas: sigmoid+BCE → (p − y)/(n·NB) per button. Aim CE flows
  // through EVERY sample, scaled by its blend weight (HIT_WEIGHT for landed
  // shots, 1 otherwise) and normalized by the batch's TOTAL aim weight, so
  // hit rows pull HIT_WEIGHT× harder without starving the volume.
  let wSum = 0;
  for (let s = 0; s < n; s++) wSum += Y[batchIdx[s] * Y_DIM + NB + 1];
  let loss = 0;
  for (let s = 0; s < n; s++) {
    const yo = batchIdx[s] * Y_DIM;
    const oo = s * OUT_DIM;
    for (let j = 0; j < NB; j++) {
      const p = sigmoid(out[oo + j]);
      const y = Y[yo + j];
      dOut[oo + j] = (p - y) / (n * NB);
      loss += -(y * Math.log(p + 1e-9) + (1 - y) * Math.log(1 - p + 1e-9)) / (n * NB);
    }
    const w = Y[yo + NB + 1];
    if (w > 0 && wSum > 0) {
      aimSoftmax(s, probsBuf);
      const bin = Y[yo + NB] | 0;
      for (let j = 0; j < AIM_BINS; j++) {
        const y = j === bin ? 1 : 0;
        dOut[oo + NB + j] = ((probsBuf[j] - y) * AIM_LOSS_W * w) / wSum;
      }
      loss += (-Math.log(probsBuf[bin] + 1e-9) * AIM_LOSS_W * w) / wSum;
    } else {
      for (let j = 0; j < AIM_BINS; j++) dOut[oo + NB + j] = 0;
    }
  }
  // Backprop layer 3.
  gW[2].fill(0);
  gB[2].fill(0);
  d2.fill(0, 0, n * HIDDEN);
  for (let s = 0; s < n; s++) {
    const oo = s * OUT_DIM;
    const ho = s * HIDDEN;
    for (let j = 0; j < OUT_DIM; j++) {
      const g = dOut[oo + j];
      if (g === 0) continue;
      const wo = j * HIDDEN;
      gB[2][j] += g;
      for (let i = 0; i < HIDDEN; i++) {
        gW[2][wo + i] += g * h2[ho + i];
        d2[ho + i] += g * W[2][wo + i];
      }
    }
  }
  // Layer 2 (through tanh).
  gW[1].fill(0);
  gB[1].fill(0);
  d1.fill(0, 0, n * HIDDEN);
  for (let s = 0; s < n; s++) {
    const ho = s * HIDDEN;
    for (let j = 0; j < HIDDEN; j++) {
      const a = h2[ho + j];
      const g = d2[ho + j] * (1 - a * a);
      if (g === 0) continue;
      const wo = j * HIDDEN;
      gB[1][j] += g;
      for (let i = 0; i < HIDDEN; i++) {
        gW[1][wo + i] += g * h1[ho + i];
        d1[ho + i] += g * W[1][wo + i];
      }
    }
  }
  // Layer 1 (through tanh) — input grads not needed.
  gW[0].fill(0);
  gB[0].fill(0);
  for (let s = 0; s < n; s++) {
    const ho = s * HIDDEN;
    const xo = batchIdx[s] * FEAT;
    for (let j = 0; j < HIDDEN; j++) {
      const a = h1[ho + j];
      const g = d1[ho + j] * (1 - a * a);
      if (g === 0) continue;
      const wo = j * FEAT;
      gB[0][j] += g;
      for (let i = 0; i < FEAT; i++) gW[0][wo + i] += g * X[xo + i];
    }
  }
  adamT++;
  for (let l = 0; l < W.length; l++) {
    adamStep(W[l], gW[l], aW[l]);
    adamStep(B[l], gB[l], aB[l]);
  }
  return loss;
}

/** Validation: per-button accuracy + base rate, aim top-1/top-3 bin accuracy
 *  + effective cosine — reported on ALL rows (the disciple-comparable
 *  number) and on hit-weighted rows (the precision population). */
function validate() {
  const correct = new Float64Array(NB);
  const posRate = new Float64Array(NB);
  const aim = {
    all: { n: 0, top1: 0, top3: 0, cos: 0 },
    hit: { n: 0, top1: 0, top3: 0, cos: 0 },
  };
  const idx = new Uint32Array(BATCH);
  let done = 0;
  while (done < nVal) {
    const n = Math.min(BATCH, nVal - done);
    for (let s = 0; s < n; s++) idx[s] = order[nTrain + done + s];
    forward(idx, n);
    for (let s = 0; s < n; s++) {
      const yo = idx[s] * Y_DIM;
      const oo = s * OUT_DIM;
      for (let j = 0; j < NB; j++) {
        const p = sigmoid(out[oo + j]) > 0.5 ? 1 : 0;
        if (p === Y[yo + j]) correct[j]++;
        posRate[j] += Y[yo + j];
      }
      const bin = Y[yo + NB] | 0;
      let best = 0;
      let rank = 0;
      const trueLogit = out[oo + NB + bin];
      for (let j = 0; j < AIM_BINS; j++) {
        const l = out[oo + NB + j];
        if (l > out[oo + NB + best]) best = j;
        if (j !== bin && l > trueLogit) rank++;
      }
      const ang = ((best + 0.5) / AIM_BINS) * Math.PI * 2;
      const cos = Math.cos(ang) * Y[yo + NB + 2] + Math.sin(ang) * Y[yo + NB + 3];
      const buckets = Y[yo + NB + 1] > 1 ? [aim.all, aim.hit] : [aim.all];
      for (const b of buckets) {
        b.n++;
        if (best === bin) b.top1++;
        if (rank < 3) b.top3++;
        b.cos += cos;
      }
    }
    done += n;
  }
  const buttons = {};
  for (let j = 0; j < NB; j++) {
    buttons[BUTTON_HEADS[j]] = { acc: correct[j] / nVal, baseRate: posRate[j] / nVal };
  }
  const pack = (b) => ({
    n: b.n,
    top1: b.n > 0 ? b.top1 / b.n : 0,
    top3: b.n > 0 ? b.top3 / b.n : 0,
    effCos: b.n > 0 ? b.cos / b.n : 0,
  });
  return { buttons, aimAll: pack(aim.all), aimHit: pack(aim.hit) };
}

// --- 5. Training loop ------------------------------------------------------------
const tTrain = Date.now();
const perm = new Uint32Array(nTrain);
const batchIdx = new Uint32Array(BATCH);
for (let epoch = 1; epoch <= EPOCHS; epoch++) {
  for (let i = 0; i < nTrain; i++) perm[i] = order[i];
  for (let i = nTrain - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = perm[i];
    perm[i] = perm[j];
    perm[j] = t;
  }
  let lossSum = 0;
  let steps = 0;
  for (let off = 0; off + BATCH <= nTrain; off += BATCH) {
    for (let s = 0; s < BATCH; s++) batchIdx[s] = perm[off + s];
    lossSum += trainBatch(batchIdx, BATCH);
    steps++;
  }
  const v = validate();
  const accs = Object.entries(v.buttons)
    .map(([k, m]) => `${k}:${(m.acc * 100).toFixed(1)}%`)
    .join(' ');
  console.log(
    `[epoch ${epoch}/${EPOCHS}] loss ${(lossSum / steps).toFixed(4)} ` +
      `aim(hit n=${v.aimHit.n}) top1 ${(v.aimHit.top1 * 100).toFixed(1)}% top3 ${(v.aimHit.top3 * 100).toFixed(1)}% cos ${v.aimHit.effCos.toFixed(3)} | ` +
      `aim(all) top1 ${(v.aimAll.top1 * 100).toFixed(1)}% top3 ${(v.aimAll.top3 * 100).toFixed(1)}% cos ${v.aimAll.effCos.toFixed(3)} | ${accs} ` +
      `(${((Date.now() - tTrain) / 1000).toFixed(0)}s)`,
  );
}
const val = validate();
const trainSecs = ((Date.now() - tTrain) / 1000).toFixed(1);
console.log(`[train] done in ${trainSecs}s`);

// --- 6. Emit buttsteinWeights.ts ---------------------------------------------------
const fmt = (arr) => {
  const parts = [];
  for (let i = 0; i < arr.length; i++) parts.push(Number(arr[i].toPrecision(7)));
  return JSON.stringify(parts);
};
const valLines = Object.entries(val.buttons)
  .map(
    ([k, m]) =>
      `//   ${k.padEnd(8)} acc ${(m.acc * 100).toFixed(2)}%  (base rate ${(m.baseRate * 100).toFixed(2)}%)`,
  )
  .join('\n');
const file = `// GENERATED BY tools/train-buttstein.mjs — DO NOT EDIT BY HAND.
// Retrain instead: node tools/train-buttstein.mjs (see flags in that file).
//
// Behavior-cloned policy weights for BUTTSTEIN (goal node 504) — the FOURTH
// student, the first trained on EXACT data: replay schema v2 rows whose
// bullet-threat block is the recorder-run runtime scan (no reconstruction),
// whose weapon labels are exact, and which carry OWN SPRAY HEAT — the
// mechanic the prodigy could not see (features v3, FEATURE_DIM_V3 ${FEATURE_DIM_V3}).
// Aim labels are BLENDED: every row trains the 24-bin head, rows whose shot
// landed within ${HIT_WINDOW} ticks carry ×${HIT_WEIGHT} gradient (${nHit} of ${nSamples} = ${((100 * nHit) / nSamples).toFixed(2)}%).
// Teacher: ${TEACHER}
// Trained ${new Date().toISOString()} on ${nSamples} samples (stride ${STRIDE},
// ${processedMatches} matches / ${processedRuns} runs, 95/5 split, ${EPOCHS} epochs, lr ${LR}, seed ${SEED},
// history dropout ${HIST_DROPOUT} — exposure-bias fix carried from observation node 484).
//
// Validation (${nVal} held-out samples):
${valLines}
//   aim on HIT-weighted rows (n=${val.aimHit.n}): top-1 ${(val.aimHit.top1 * 100).toFixed(2)}%  top-3 ${(val.aimHit.top3 * 100).toFixed(2)}%  effCos ${val.aimHit.effCos.toFixed(4)}
//   aim on ALL rows         (n=${val.aimAll.n}): top-1 ${(val.aimAll.top1 * 100).toFixed(2)}%  top-3 ${(val.aimAll.top3 * 100).toFixed(2)}%  effCos ${val.aimAll.effCos.toFixed(4)}
//
// Layout: dense layers input→${HIDDEN} tanh→${HIDDEN} tanh→${OUT_DIM} raw
// (7 button logits + ${AIM_BINS} aim-direction bin logits, bin = 15° sector of
// atan2(aimY, aimX) mapped to [0, 2π)). weights[l] is row-major [fanOut × fanIn];
// the runtime forward pass lives in buttstein.ts and the feature contract in
// neuralFeaturesV3.ts (FEATURE_DIM_V3 ${FEATURE_DIM_V3}).

/** Number of aim-direction bins in the classification head. */
export const BUTTSTEIN_AIM_BINS = ${AIM_BINS};

export const BUTTSTEIN_DIMS: readonly number[] = ${JSON.stringify(dims)};

export const BUTTSTEIN_WEIGHTS: readonly (readonly number[])[] = [
${W.map((w) => `  ${fmt(w)},`).join('\n')}
];

export const BUTTSTEIN_BIASES: readonly (readonly number[])[] = [
${B.map((b) => `  ${fmt(b)},`).join('\n')}
];
`;
writeFileSync(OUT, file);
console.log(`[out] wrote ${OUT}`);
console.log(`[total] ${((Date.now() - t0) / 1000).toFixed(1)}s`);
