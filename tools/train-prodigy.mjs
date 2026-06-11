#!/usr/bin/env node
// THE PRODIGY's trainer (goal node 473) — third learned brain, derived from
// tools/train-disciple.mjs. Same single-teacher doctrine (cuadrilla, the
// gauntlet-best at +12.04), trained on the FULL POOLED corpus (server +
// local), with the two upgrades the disciple's diagnosis demanded:
//
//   1. FEATURES V2 (packages/client/src/ai/neuralFeaturesV2.ts, 47 floats):
//      v1's senses PLUS per-enemy reload/ammo/weapon, own weapon, the nearest
//      incoming bullet threat, and one tick of memory (previous velocity +
//      previous aim). The disciple was blind to bullets, reload windows and
//      the wildcard guns; the prodigy is not.
//
//   2. HIT-FILTERED AIM. The aim head (24-bin direction classification, the
//      disciple's proven form) trains ONLY on rows whose shot actually HIT:
//      a row at tick T contributes an aim label iff a `shot` event exists for
//      (bot, T) and a `hit` event with that bot as attacker lands within
//      [T, T+40] (bullet flight ≤ 40 ticks). All rows still train the 7
//      button heads. Imitating only the aims that landed distills the
//      teacher's PRECISION, not its whiffs — aim precision is the diagnosed
//      bottleneck of both prior students.
//
// BULLET RECONSTRUCTION (honest caveat): replay rows do NOT log bullets. The
// trainer rebuilds approximate live bullets deterministically from the shot
// events + the shooter's recorded row at the shot tick: origin = shooter pos
// + 14 px muzzle offset along the recorded aim, velocity = aim unit × the
// weapon's muzzle speed (AK 24.6 / SPAS 14 / BARRETT 55 / ROCKET 10.7 /
// RICOCHET 33 px/tick; chainsaw strikes are skipped — no projectile),
// bullet gravity 0.135 px/tick², lifetime capped at the 30-tick threat
// horizon. Spread jitter, the SPAS pellet fan (one center pellet stands in
// for six), impact deletion and ricochet bounces are NOT modeled. The same
// feature is EXACT at runtime (world.bullets) — an accepted v2 compromise,
// recorded in the weights provenance header.
//
// RESERVED EVAL DATA IS NEVER TRAINED ON: datasets whose CLI arena is one of
// [101, 202, 303, 404, 505] are skipped whole; matches whose seed ≥ 90000
// are skipped individually. Both exclusions are counted and printed.
//
// HISTORY DROPOUT (exposure-bias fix, observation node 484): in the tape the
// teacher's previous aim is ALWAYS near-target, so a net trained with the
// history block ever-present learns to trust it over the live geometry — at
// runtime that slot carries the STUDENT's own drift and the error
// self-confirms (measured live: 26.6° mean aim error with history vs 7.9°
// with it zeroed, against a 0.972 validation cosine). Fix: each training
// sample keeps its history block with probability 1−HIST_DROPOUT and zeroes
// it otherwise, so the policy must stay grounded in the present even when it
// remembers. Runtime always supplies real history (full contract).
//
// Usage: node tools/train-prodigy.mjs [--teacher cuadrilla] [--cap 3000000]
//        [--stride 2] [--epochs 6] [--lr 0.001] [--seed 1] [--hidden 128]
//        [--hist-dropout 0.5] [--max-datasets N] [--datasets DIR] [--out FILE]

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = join(dirname(SELF), '..');

// --- bootstrap: re-exec under tsx so the extensionless TS import chain
// (neuralFeaturesV2.ts → neuralFeatures) resolves — same pattern as
// tools/evaluate.mjs. Zero npm deps of our own; tsx ships with the arena pkg.
if (process.env.TRAIN_TSX !== '1') {
  const r = spawnSync(join(ROOT, 'packages/arena/node_modules/.bin/tsx'), [SELF, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, TRAIN_TSX: '1' },
  });
  process.exit(r.status ?? 1);
}

const {
  buildNeuralFeaturesV2,
  nearestBulletThreat,
  FEATURE_DIM_V2,
  FEATS_HISTORY,
  THREAT_HORIZON,
} = await import('../packages/client/src/ai/neuralFeaturesV2.ts');
const { BUTTON_HEADS } = await import('../packages/client/src/ai/neuralFeatures.ts');

// --- CLI ---------------------------------------------------------------------
const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
const TEACHER = flag('teacher', 'cuadrilla');
const CAP = Number(flag('cap', 3_000_000));
const STRIDE = Number(flag('stride', 2));
const EPOCHS = Number(flag('epochs', 6));
const LR = Number(flag('lr', 0.001));
const SEED = Number(flag('seed', 1));
const HIDDEN = Number(flag('hidden', 128));
const HIST_DROPOUT = Number(flag('hist-dropout', 0.5));
const MAX_DATASETS = Number(flag('max-datasets', Infinity));
const DATASETS_DIR = flag('datasets', join(ROOT, 'datasets'));
const OUT = flag('out', join(ROOT, 'packages/client/src/ai/prodigyWeights.ts'));
const BATCH = 256;
const VAL_FRAC = 0.05;
const AIM_LOSS_W = 2; // aim CE weight vs mean button BCE, per MASKED sample
const AIM_BINS = 24; // 15° per bin (the disciple's proven head)
const NB = BUTTON_HEADS.length; // 7 button heads
const OUT_DIM = NB + AIM_BINS; // 31 logits
// Y layout per sample: 7 buttons, 1 bin index, 1 hit-mask flag, 2 true aim
// unit-vector comps (unit vector is metric-only — never a training target).
const Y_DIM = NB + 4;

// Reserved gauntlet data — the held-out rule (MANUAL §5, evaluate.mjs).
const RESERVED_ARENAS = new Set([101, 202, 303, 404, 505]);
const RESERVED_SEED_MIN = 90000;

// Bullet reconstruction constants (see header).
const MUZZLE_OFFSET = 14; // px (game.ts MUZZLE_OFFSET)
const BULLET_GRAV = 0.135; // px/tick² (GRAV 0.06 × 2.25 — matador's ballistics)
const HIT_WINDOW = 40; // ticks — max credited bullet flight for the aim mask
const WILDCARD_WEAPON = {
  shotgun: 'SPAS12',
  rifle: 'BARRETT',
  rocket: 'ROCKET',
  ricochet: 'RICOCHET',
  chainsaw: 'CHAINSAW',
};
const BULLET_SPEED = {
  AK74: 24.6,
  SPAS12: 14,
  BARRETT: 55,
  ROCKET: 10.7,
  RICOCHET: 33,
  CHAINSAW: 0, // melee — no projectile reconstructed
};
const WEAPON_CLASS = { AK74: 0, SPAS12: 1, BARRETT: 2 }; // others bucket to AK (0)

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

// --- 1. Discover datasets — teacher runs only, reserved eval data excluded ----
const t0 = Date.now();
const runDirs = readdirSync(DATASETS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .filter((n) => existsSync(join(DATASETS_DIR, n, 'manifest.json')));

const runs = [];
let excludedArenaRuns = 0;
let excludedSeedMatches = 0;
for (const dir of runDirs) {
  try {
    const m = JSON.parse(readFileSync(join(DATASETS_DIR, dir, 'manifest.json'), 'utf8'));
    if (m.schema !== 'soldat-arena-replay/1') continue; // refuse unknown schemas
    const engines = (m.teams ?? []).map((t) => t.engine);
    if (!engines.includes(TEACHER)) continue; // teacher runs only
    // RESERVED-ARENA assertion: a dataset recorded on a gauntlet arena never
    // becomes training data.
    const arenaMatch = /--arena\s+(\d+)/.exec(m.cli ?? '');
    const arenaSeed = arenaMatch !== null ? Number(arenaMatch[1]) : null;
    if (arenaSeed !== null && RESERVED_ARENAS.has(arenaSeed)) {
      excludedArenaRuns++;
      continue;
    }
    const matches = [];
    for (const x of m.matches ?? []) {
      // RESERVED-SEED assertion: gauntlet seeds (90000+) never trained on.
      if ((x.seed ?? 0) >= RESERVED_SEED_MIN) {
        excludedSeedMatches++;
        continue;
      }
      matches.push({
        replay: x.files.replay,
        events: x.files.events,
        wildcard: x.wildcard ?? null,
      });
    }
    if (matches.length === 0) continue;
    runs.push({ dir, matches, magSize: m.variant?.tuning?.magSize ?? 30 });
  } catch {
    /* unreadable manifest → skip run */
  }
}
// Seeded shuffle so the cap fills from a uniform spread of the pooled corpus
// (server eras + local eras), not one contiguous slice.
for (let i = runs.length - 1; i > 0; i--) {
  const j = Math.floor(rng() * (i + 1));
  [runs[i], runs[j]] = [runs[j], runs[i]];
}
console.log(
  `[data] teacher=${TEACHER}: ${runs.length} runs fielded the teacher ` +
    `(stride ${STRIDE}, cap ${CAP}); RESERVED EXCLUDED: ${excludedArenaRuns} runs on ` +
    `gauntlet arenas, ${excludedSeedMatches} matches with seeds ≥ ${RESERVED_SEED_MIN}`,
);

// --- 2. Extract samples --------------------------------------------------------
const X = new Float32Array(CAP * FEATURE_DIM_V2);
const Y = new Float32Array(CAP * Y_DIM);
let nSamples = 0;
let nMasked = 0; // samples whose aim head trains (shot fired AND hit landed)
let zeroAimSkipped = 0;
let shotsSeen = 0;
let shotsHit = 0;

/**
 * Process one match: full tick sweep with bullet reconstruction, one-tick
 * history, and hit-filtered aim labels. Rows arrive tick-sorted (the writer
 * emits per tick in bot order).
 */
function processMatch(rows, shotSet, hitsByBot, weaponByBot) {
  // Per-bot rolling one-tick history; per-match virtual bullet list.
  const lastByBot = new Map(); // bot → {tick, vx, vy, aimUx, aimUy}
  let bullets = []; // {t, x, y, vx, vy, bot, team}

  let i = 0;
  while (i < rows.length && nSamples < CAP) {
    // Gather the tick group.
    const T = rows[i].tick;
    let j = i;
    while (j < rows.length && rows[j].tick === T) j++;
    const group = rows.slice(i, j);
    i = j;

    // Expire reconstructed bullets past the threat horizon.
    if (bullets.length > 0) bullets = bullets.filter((b) => T - b.t <= THREAT_HORIZON);

    // Sample BEFORE spawning this tick's shots: at think time a bullet fired
    // this very tick does not exist yet (rows are post-think, pre-physics).
    {
      for (const r of group) {
        if (nSamples >= CAP) break;
        if (r.engine !== TEACHER) continue; // SINGLE TEACHER — context only
        // Stride thins the tape, but SHOT ROWS ALWAYS SAMPLE: the teacher's
        // tap cadence (fireInterval 6) can phase-lock to one tick parity per
        // match, and a parity-aligned stride would silently drop almost every
        // aim-labelable row (measured: 14 of 593 shots on even ticks in one
        // match). Shot rows are also legitimate button samples — the slight
        // fire=1 oversample is documented in the base rates.
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
            weapon: weaponByBot.get(o.bot) ?? 0,
          };
          if (o.team !== r.team) enemies.push(c);
          else teammates.push(c);
        }
        // Reconstructed enemy bullets, advanced to tick T (linear flight +
        // bullet gravity), relative to this bot.
        const rel = [];
        for (const b of bullets) {
          if (b.bot === r.bot) continue;
          if (r.team > 0 && b.team === r.team) continue;
          const dt = T - b.t;
          if (dt <= 0) continue;
          rel.push({
            rx: b.x + b.vx * dt - r.x,
            ry: b.y + b.vy * dt + 0.5 * BULLET_GRAV * dt * dt - r.y,
            vx: b.vx,
            vy: b.vy + BULLET_GRAV * dt,
          });
        }
        const threat = nearestBulletThreat(rel);
        const last = lastByBot.get(r.bot);
        const history =
          last !== undefined && last.tick === T - 1
            ? { vx: last.vx, vy: last.vy, aimUx: last.aimUx, aimUy: last.aimUy }
            : null;
        const f = buildNeuralFeaturesV2(
          {
            vx: r.vx,
            vy: r.vy,
            fuel: r.fuel,
            hp: r.hp,
            ammo: r.ammo,
            reloading: r.reloading,
            onGround: r.onGround,
            weapon: weaponByBot.get(r.bot) ?? 0,
          },
          enemies,
          teammates,
          threat,
          history,
        );
        const xo = nSamples * FEATURE_DIM_V2;
        for (let k = 0; k < FEATURE_DIM_V2; k++) X[xo + k] = f[k];
        const yo = nSamples * Y_DIM;
        for (let k = 0; k < NB; k++) Y[yo + k] = r.control[BUTTON_HEADS[k]] ? 1 : 0;
        Y[yo + NB] = aimBin(ax, ay);
        // HIT-FILTERED AIM MASK: this row fired (shot event at exactly this
        // tick) AND one of its bullets landed within the flight window.
        let mask = 0;
        if (isShotRow) {
          const hits = hitsByBot.get(r.bot);
          if (hits !== undefined) {
            // hits is tick-sorted; scan the window (lists are short).
            for (const ht of hits) {
              if (ht > T + HIT_WINDOW) break;
              if (ht >= T) {
                mask = 1;
                break;
              }
            }
          }
        }
        Y[yo + NB + 1] = mask;
        Y[yo + NB + 2] = ax / alen;
        Y[yo + NB + 3] = ay / alen;
        nMasked += mask;
        nSamples++;
      }
    }

    // Now spawn this tick's shots as virtual bullets + roll history forward.
    for (const r of group) {
      const key = r.bot * 100000 + T;
      if (shotSet.has(key)) {
        const label = r._weaponLabel ?? 'AK74';
        const speed = BULLET_SPEED[label] ?? BULLET_SPEED.AK74;
        const ax = r.control.aimX;
        const ay = r.control.aimY;
        const alen = Math.hypot(ax, ay);
        if (speed > 0 && alen > 0) {
          const ux = ax / alen;
          const uy = ay / alen;
          bullets.push({
            t: T,
            x: r.x + ux * MUZZLE_OFFSET,
            y: r.y + uy * MUZZLE_OFFSET,
            vx: ux * speed,
            vy: uy * speed,
            bot: r.bot,
            team: r.team,
          });
        }
      }
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
    // Rows: parse everything (history needs T-1, bullets need shot ticks).
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
    // Per-bot weapon: spawn magazines betray the gun. A bot whose max
    // observed ammo stays below the AK magazine in a wildcard match is the
    // carrier of the manifest's resolved wildcard weapon.
    const maxAmmo = new Map();
    for (const r of rows) {
      const m = maxAmmo.get(r.bot);
      if (m === undefined || r.ammo > m) maxAmmo.set(r.bot, r.ammo);
    }
    const wcLabel = WILDCARD_WEAPON[match.wildcard] ?? null;
    const weaponByBot = new Map();
    const labelByBot = new Map();
    for (const [bot, m] of maxAmmo) {
      const label = wcLabel !== null && m < run.magSize * 0.8 ? wcLabel : 'AK74';
      labelByBot.set(bot, WEAPON_CLASS[label] !== undefined ? label : 'AK74');
      weaponByBot.set(bot, WEAPON_CLASS[label] ?? 0);
    }
    for (const r of rows) r._weaponLabel = labelByBot.get(r.bot) ?? 'AK74';
    processMatch(rows, shotSet, hitsByBot, weaponByBot);
    processedMatches++;
  }
  if (processedRuns % 50 === 0) {
    process.stderr.write(
      `\r[data] ${processedRuns} runs, ${processedMatches} matches → ${nSamples} samples (${nMasked} hit-masked)`,
    );
  }
}
process.stderr.write('\n');

console.log(
  `[data] ${nSamples} ${TEACHER} samples (${nMasked} hit-masked = ${((100 * nMasked) / Math.max(1, nSamples)).toFixed(2)}% train the aim head) ` +
    `from ${processedMatches} matches / ${processedRuns} runs in ${((Date.now() - t0) / 1000).toFixed(1)}s ` +
    `(${zeroAimSkipped} zero-aim rows skipped; corpus-wide ${shotsSeen} shots / ${shotsHit} hits)`,
);
if (nSamples < 1000 || nMasked < 500) {
  console.error('[data] too few samples (or too few hit-masked aim rows) — aborting');
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

// --- 4. The MLP: FEATURE_DIM_V2 → 128 tanh → 128 tanh → 31 raw -----------------
const dims = [FEATURE_DIM_V2, HIDDEN, HIDDEN, OUT_DIM];
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
const FEAT = FEATURE_DIM_V2;
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
  // Output deltas: sigmoid+BCE → (p − y)/(n·NB) per button. Aim CE flows ONLY
  // through hit-masked samples and is normalized by the batch's masked count
  // (not n) so the rare hit rows keep a full-strength gradient — otherwise a
  // ~2% mask rate would starve the aim head 50:1 against the buttons.
  let nMaskBatch = 0;
  for (let s = 0; s < n; s++) nMaskBatch += Y[batchIdx[s] * Y_DIM + NB + 1];
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
    const masked = Y[yo + NB + 1] === 1;
    if (masked && nMaskBatch > 0) {
      aimSoftmax(s, probsBuf);
      const bin = Y[yo + NB] | 0;
      for (let j = 0; j < AIM_BINS; j++) {
        const y = j === bin ? 1 : 0;
        dOut[oo + NB + j] = ((probsBuf[j] - y) * AIM_LOSS_W) / nMaskBatch;
      }
      loss += (-Math.log(probsBuf[bin] + 1e-9) * AIM_LOSS_W) / nMaskBatch;
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
 *  + effective cosine — reported BOTH on hit-masked rows (the training
 *  population for aim) and on all rows (the disciple-comparable number). */
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
      const buckets = Y[yo + NB + 1] === 1 ? [aim.all, aim.hit] : [aim.all];
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

// --- 6. Emit prodigyWeights.ts ---------------------------------------------------
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
const file = `// GENERATED BY tools/train-prodigy.mjs — DO NOT EDIT BY HAND.
// Retrain instead: node tools/train-prodigy.mjs (see flags in that file).
//
// Behavior-cloned policy weights for the prodigy engine (goal node 473) —
// the THIRD student: full pooled corpus (server + local), features v2, and a
// HIT-FILTERED aim head (24-bin classification trained only on rows whose
// shot landed; ${nMasked} of ${nSamples} samples = ${((100 * nMasked) / nSamples).toFixed(2)}% carried an aim label).
// Teacher: ${TEACHER}
// Trained ${new Date().toISOString()} on ${nSamples} samples (stride ${STRIDE},
// ${processedMatches} matches / ${processedRuns} runs, 95/5 split, ${EPOCHS} epochs, lr ${LR}, seed ${SEED}).
//
// PROVENANCE CAVEAT (bullet-threat features): training-time bullets are
// RECONSTRUCTED from shot events + recorded aim (muzzle 14 px, weapon muzzle
// speeds, gravity 0.135 px/tick², ${THREAT_HORIZON}-tick horizon; no spread/pellet
// fan/impact deletion). The same feature is exact at runtime (world.bullets).
//
// Validation (${nVal} held-out samples):
${valLines}
//   aim on HIT-masked rows (n=${val.aimHit.n}): top-1 ${(val.aimHit.top1 * 100).toFixed(2)}%  top-3 ${(val.aimHit.top3 * 100).toFixed(2)}%  effCos ${val.aimHit.effCos.toFixed(4)}
//   aim on ALL rows     (n=${val.aimAll.n}): top-1 ${(val.aimAll.top1 * 100).toFixed(2)}%  top-3 ${(val.aimAll.top3 * 100).toFixed(2)}%  effCos ${val.aimAll.effCos.toFixed(4)}
//
// Layout: dense layers input→${HIDDEN} tanh→${HIDDEN} tanh→${OUT_DIM} raw
// (7 button logits + ${AIM_BINS} aim-direction bin logits, bin = 15° sector of
// atan2(aimY, aimX) mapped to [0, 2π)). weights[l] is row-major [fanOut × fanIn];
// the runtime forward pass lives in prodigy.ts and the feature contract in
// neuralFeaturesV2.ts (FEATURE_DIM_V2 ${FEATURE_DIM_V2}).

/** Number of aim-direction bins in the classification head. */
export const PRODIGY_AIM_BINS = ${AIM_BINS};

export const PRODIGY_DIMS: readonly number[] = ${JSON.stringify(dims)};

export const PRODIGY_WEIGHTS: readonly (readonly number[])[] = [
${W.map((w) => `  ${fmt(w)},`).join('\n')}
];

export const PRODIGY_BIASES: readonly (readonly number[])[] = [
${B.map((b) => `  ${fmt(b)},`).join('\n')}
];
`;
writeFileSync(OUT, file);
console.log(`[out] wrote ${OUT}`);
console.log(`[total] ${((Date.now() - t0) / 1000).toFixed(1)}s`);
