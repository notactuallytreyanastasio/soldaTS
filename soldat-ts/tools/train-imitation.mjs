#!/usr/bin/env node
// Imitation trainer for the `neural` engine (goal 337 / decision 341 / action 342).
//
// Behavior-clones the arena replay datasets (datasets/README.md, schema
// soldat-arena-replay/1) into a small MLP policy. Zero npm deps — gzip via
// node:zlib, the net is hand-rolled forward/backprop + Adam.
//
// Pipeline:
//   1. Walk datasets/, read manifests for engine provenance, shuffle (seeded).
//   2. Per match: gunzip the replay JSONL, join rows by tick (every live bot
//      emits one row per tick), and for each bot row build features with the
//      SAME buildNeuralFeatures the runtime engine uses — imported directly
//      from packages/client/src/ai/neuralFeatures.ts via node's native type
//      stripping, so trainer and runtime CANNOT drift.
//   3. Labels = 7 button booleans + the aim direction as a unit vector
//      (rows with zero aim are skipped). Subsample: stride 3 ticks, capped
//      total, per-engine quota so wolf/hydra-era volume doesn't drown the
//      early doctrines.
//   4. Train input→64 tanh→64 tanh→(7 sigmoid + 2 linear) with BCE on the
//      buttons and MSE-to-unit-vector on aim; Adam, minibatch 256; 5% holdout
//      for per-head val metrics (button accuracy, aim cosine similarity).
//   5. Emit packages/client/src/ai/neuralWeights.ts (generated module).
//
// Usage: node tools/train-imitation.mjs [--cap 1500000] [--stride 3]
//        [--epochs 3] [--lr 0.001] [--seed 1] [--max-datasets N]
//        [--datasets DIR] [--out FILE]

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildNeuralFeatures,
  FEATURE_DIM,
  OUTPUT_DIM,
  BUTTON_HEADS,
} from '../packages/client/src/ai/neuralFeatures.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// --- CLI ---------------------------------------------------------------------
const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
const CAP = Number(flag('cap', 1_500_000));
const STRIDE = Number(flag('stride', 3));
const EPOCHS = Number(flag('epochs', 3));
const LR = Number(flag('lr', 0.001));
const SEED = Number(flag('seed', 1));
const MAX_DATASETS = Number(flag('max-datasets', Infinity));
const DATASETS_DIR = flag('datasets', join(ROOT, 'datasets'));
const OUT = flag('out', join(ROOT, 'packages/client/src/ai/neuralWeights.ts'));
const BATCH = 256;
const VAL_FRAC = 0.05;
const AIM_LOSS_W = 2; // aim MSE weight vs mean button BCE
const HIDDEN = 64;

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

// --- 1. Discover datasets + engine universe -----------------------------------
const t0 = Date.now();
const runDirs = readdirSync(DATASETS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .filter((n) => existsSync(join(DATASETS_DIR, n, 'manifest.json')));

const runs = [];
const engineSet = new Set();
for (const dir of runDirs) {
  try {
    const m = JSON.parse(readFileSync(join(DATASETS_DIR, dir, 'manifest.json'), 'utf8'));
    if (m.schema !== 'soldat-arena-replay/1') continue; // refuse unknown schemas
    const engines = (m.teams ?? []).map((t) => t.engine);
    engines.forEach((e) => engineSet.add(e));
    runs.push({ dir, engines, matches: (m.matches ?? []).map((x) => x.files.replay) });
  } catch {
    /* unreadable manifest → skip run */
  }
}
// Seeded shuffle so per-engine quotas fill from a uniform spread of runs.
for (let i = runs.length - 1; i > 0; i--) {
  const j = Math.floor(rng() * (i + 1));
  [runs[i], runs[j]] = [runs[j], runs[i]];
}
const engines = [...engineSet].sort();
const PER_ENGINE_CAP = Math.floor(CAP / engines.length);
console.log(
  `[data] ${runs.length} runs, engines: ${engines.join(', ')} ` +
    `(per-engine cap ${PER_ENGINE_CAP}, total cap ${CAP})`,
);

// --- 2. Extract samples --------------------------------------------------------
const X = new Float32Array(CAP * FEATURE_DIM);
const Y = new Float32Array(CAP * OUTPUT_DIM);
let nSamples = 0;
const perEngine = Object.fromEntries(engines.map((e) => [e, 0]));
let zeroAimSkipped = 0;

/** Fast tick extraction without JSON.parse: rows start {"tick":NNN, */
function quickTick(line) {
  // '{"tick":' is 8 chars; digits start at index 8.
  let v = 0;
  for (let i = 8; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c < 48 || c > 57) return v;
    v = v * 10 + (c - 48);
  }
  return v;
}

function flushTickGroup(group) {
  if (nSamples >= CAP) return;
  for (const r of group) {
    if (nSamples >= CAP) return;
    if (perEngine[r.engine] >= PER_ENGINE_CAP) continue;
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
      const c = { dx: o.x - r.x, dy: o.y - r.y, vx: o.vx, vy: o.vy, hp: o.hp };
      if (o.team !== r.team) enemies.push(c);
      else teammates.push(c);
    }
    const f = buildNeuralFeatures(
      {
        vx: r.vx,
        vy: r.vy,
        fuel: r.fuel,
        hp: r.hp,
        ammo: r.ammo,
        reloading: r.reloading,
        onGround: r.onGround,
      },
      enemies,
      teammates,
    );
    const xo = nSamples * FEATURE_DIM;
    for (let i = 0; i < FEATURE_DIM; i++) X[xo + i] = f[i];
    const yo = nSamples * OUTPUT_DIM;
    for (let i = 0; i < BUTTON_HEADS.length; i++) {
      Y[yo + i] = r.control[BUTTON_HEADS[i]] ? 1 : 0;
    }
    Y[yo + BUTTON_HEADS.length] = ax / alen;
    Y[yo + BUTTON_HEADS.length + 1] = ay / alen;
    perEngine[r.engine]++;
    nSamples++;
  }
}

let processedRuns = 0;
for (const run of runs) {
  if (processedRuns >= MAX_DATASETS) break;
  if (nSamples >= CAP) break;
  // Skip the whole run if every engine in it already met its quota.
  if (run.engines.every((e) => (perEngine[e] ?? 0) >= PER_ENGINE_CAP)) continue;
  processedRuns++;
  for (const replayFile of run.matches) {
    if (nSamples >= CAP) break;
    const path = join(DATASETS_DIR, run.dir, replayFile);
    if (!existsSync(path)) continue;
    let text;
    try {
      text = gunzipSync(readFileSync(path)).toString('utf8');
    } catch {
      continue;
    }
    let group = [];
    let groupTick = -1;
    let lineStart = 0;
    while (lineStart < text.length) {
      let nl = text.indexOf('\n', lineStart);
      if (nl < 0) nl = text.length;
      const line = text.slice(lineStart, nl);
      lineStart = nl + 1;
      if (line.length < 10) continue;
      const tick = quickTick(line);
      if (tick % STRIDE !== 0) continue; // cheap pre-filter before JSON.parse
      if (tick !== groupTick) {
        flushTickGroup(group);
        group = [];
        groupTick = tick;
      }
      group.push(JSON.parse(line));
    }
    flushTickGroup(group);
  }
}

const mix = engines
  .map((e) => `${e}:${perEngine[e]}`)
  .filter((s) => !s.endsWith(':0'))
  .join(' ');
console.log(
  `[data] ${nSamples} samples from ${processedRuns} runs in ${((Date.now() - t0) / 1000).toFixed(1)}s` +
    ` (${zeroAimSkipped} zero-aim rows skipped)\n[data] mix: ${mix}`,
);
if (nSamples < 1000) {
  console.error('[data] too few samples — aborting');
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

// --- 4. The MLP: FEATURE_DIM → 64 tanh → 64 tanh → OUTPUT_DIM -------------------
const NB = BUTTON_HEADS.length; // 7 sigmoid heads; last 2 outputs linear (aim)
const dims = [FEATURE_DIM, HIDDEN, HIDDEN, OUTPUT_DIM];
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
const h1 = new Float64Array(BATCH * HIDDEN);
const h2 = new Float64Array(BATCH * HIDDEN);
const out = new Float64Array(BATCH * OUTPUT_DIM);
const d2 = new Float64Array(BATCH * HIDDEN);
const d1 = new Float64Array(BATCH * HIDDEN);
const dOut = new Float64Array(BATCH * OUTPUT_DIM);
const gW = W.map((w) => new Float64Array(w.length));
const gB = B.map((b) => new Float64Array(b.length));

const sigmoid = (x) => 1 / (1 + Math.exp(-x));

/** Forward `n` samples whose indices are batchIdx[0..n); fills h1,h2,out. */
function forward(batchIdx, n) {
  for (let s = 0; s < n; s++) {
    const xo = batchIdx[s] * FEATURE_DIM;
    for (let j = 0; j < HIDDEN; j++) {
      let acc = B[0][j];
      const wo = j * FEATURE_DIM;
      for (let i = 0; i < FEATURE_DIM; i++) acc += W[0][wo + i] * X[xo + i];
      h1[s * HIDDEN + j] = Math.tanh(acc);
    }
    for (let j = 0; j < HIDDEN; j++) {
      let acc = B[1][j];
      const wo = j * HIDDEN;
      const ho = s * HIDDEN;
      for (let i = 0; i < HIDDEN; i++) acc += W[1][wo + i] * h1[ho + i];
      h2[s * HIDDEN + j] = Math.tanh(acc);
    }
    for (let j = 0; j < OUTPUT_DIM; j++) {
      let acc = B[2][j];
      const wo = j * HIDDEN;
      const ho = s * HIDDEN;
      for (let i = 0; i < HIDDEN; i++) acc += W[2][wo + i] * h2[ho + i];
      out[s * OUTPUT_DIM + j] = acc;
    }
  }
}

function trainBatch(batchIdx, n) {
  forward(batchIdx, n);
  // Output deltas: sigmoid+BCE → (p - y)/n per button (mean over batch and
  // heads); aim linear+MSE → 2*(o - y)*AIM_LOSS_W/n.
  let loss = 0;
  for (let s = 0; s < n; s++) {
    const yo = batchIdx[s] * OUTPUT_DIM;
    const oo = s * OUTPUT_DIM;
    for (let j = 0; j < NB; j++) {
      const p = sigmoid(out[oo + j]);
      const y = Y[yo + j];
      dOut[oo + j] = (p - y) / (n * NB);
      loss += -(y * Math.log(p + 1e-9) + (1 - y) * Math.log(1 - p + 1e-9)) / (n * NB);
    }
    for (let j = NB; j < OUTPUT_DIM; j++) {
      const diff = out[oo + j] - Y[yo + j];
      dOut[oo + j] = (2 * diff * AIM_LOSS_W) / (n * 2);
      loss += (diff * diff * AIM_LOSS_W) / (n * 2);
    }
  }
  // Backprop layer 3.
  gW[2].fill(0);
  gB[2].fill(0);
  d2.fill(0, 0, n * HIDDEN);
  for (let s = 0; s < n; s++) {
    const oo = s * OUTPUT_DIM;
    const ho = s * HIDDEN;
    for (let j = 0; j < OUTPUT_DIM; j++) {
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
    const xo = batchIdx[s] * FEATURE_DIM;
    for (let j = 0; j < HIDDEN; j++) {
      const a = h1[ho + j];
      const g = d1[ho + j] * (1 - a * a);
      if (g === 0) continue;
      const wo = j * FEATURE_DIM;
      gB[0][j] += g;
      for (let i = 0; i < FEATURE_DIM; i++) gW[0][wo + i] += g * X[xo + i];
    }
  }
  adamT++;
  for (let l = 0; l < W.length; l++) {
    adamStep(W[l], gW[l], aW[l]);
    adamStep(B[l], gB[l], aB[l]);
  }
  return loss;
}

/** Validation: per-button accuracy + base rate, mean aim cosine similarity. */
function validate() {
  const correct = new Float64Array(NB);
  const posRate = new Float64Array(NB);
  let cosSum = 0;
  const idx = new Uint32Array(BATCH);
  let done = 0;
  while (done < nVal) {
    const n = Math.min(BATCH, nVal - done);
    for (let s = 0; s < n; s++) idx[s] = order[nTrain + done + s];
    forward(idx, n);
    for (let s = 0; s < n; s++) {
      const yo = idx[s] * OUTPUT_DIM;
      const oo = s * OUTPUT_DIM;
      for (let j = 0; j < NB; j++) {
        const p = sigmoid(out[oo + j]) > 0.5 ? 1 : 0;
        if (p === Y[yo + j]) correct[j]++;
        posRate[j] += Y[yo + j];
      }
      const ox = out[oo + NB];
      const oy = out[oo + NB + 1];
      const olen = Math.hypot(ox, oy) || 1;
      cosSum += (ox / olen) * Y[yo + NB] + (oy / olen) * Y[yo + NB + 1];
    }
    done += n;
  }
  const buttons = {};
  for (let j = 0; j < NB; j++) {
    buttons[BUTTON_HEADS[j]] = {
      acc: correct[j] / nVal,
      baseRate: posRate[j] / nVal,
    };
  }
  return { buttons, aimCos: cosSum / nVal };
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
      `aimCos ${v.aimCos.toFixed(4)} | ${accs} ` +
      `(${((Date.now() - tTrain) / 1000).toFixed(0)}s)`,
  );
}
const val = validate();
const trainSecs = ((Date.now() - tTrain) / 1000).toFixed(1);
console.log(`[train] done in ${trainSecs}s`);

// --- 6. Emit neuralWeights.ts -------------------------------------------------------
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
const file = `// GENERATED BY tools/train-imitation.mjs — DO NOT EDIT BY HAND.
// Retrain instead: node tools/train-imitation.mjs (see flags in that file).
//
// Behavior-cloned policy weights for the neural engine (decision node 341).
// Trained ${new Date().toISOString()} on ${nSamples} samples (stride ${STRIDE},
// ${processedRuns} runs, 95/5 train/val split, ${EPOCHS} epochs, lr ${LR}, seed ${SEED}).
// Engine mix: ${mix}
// Validation (${nVal} held-out samples):
${valLines}
//   aim cosine similarity ${val.aimCos.toFixed(4)}
//
// Layout: dense layers input→64 tanh→64 tanh→9 raw (7 button logits + 2 aim).
// weights[l] is row-major [fanOut × fanIn]; the runtime forward pass lives in
// neural.ts and the feature contract in neuralFeatures.ts (FEATURE_DIM ${FEATURE_DIM}).

export const NEURAL_DIMS: readonly number[] = ${JSON.stringify(dims)};

export const NEURAL_WEIGHTS: readonly (readonly number[])[] = [
${W.map((w) => `  ${fmt(w)},`).join('\n')}
];

export const NEURAL_BIASES: readonly (readonly number[])[] = [
${B.map((b) => `  ${fmt(b)},`).join('\n')}
];
`;
writeFileSync(OUT, file);
console.log(`[out] wrote ${OUT}`);
console.log(`[total] ${((Date.now() - t0) / 1000).toFixed(1)}s`);
