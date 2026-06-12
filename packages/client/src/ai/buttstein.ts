// "buttstein" bot engine — the FOURTH student, the first to train on EXACT
// data (goal node 504).
//
// Lineage: MIMIC (neural.ts) averaged eleven teachers and learned mush;
// DISCIPLE (disciple.ts) cloned one master and proved aim-as-classification;
// PRODIGY (prodigy.ts) grew v2 senses but trained them on RECONSTRUCTED
// bullets and hit-exclusive aim labels — and its own post-mortem prescribed
// the cure. BUTTSTEIN is that cure, named proudly and built on three fixes:
//
//   EXACT TRAINING DATA. Replay schema v2 (soldat-arena-replay/2) logs the
//   nearest-bullet-threat per row using the SAME closest-approach scan this
//   brain runs live (nearestThreatBullet — recorder and runtime cannot
//   disagree), plus the exact weapon label. The train/runtime distribution
//   mismatch that sank the prodigy's threat sense is gone: what BUTTSTEIN
//   trained on IS what BUTTSTEIN sees.
//
//   SEES ITS OWN SPRAY HEAT (features v3, FEATURE_DIM_V3 48). The prodigy
//   fired ~36% of in-contact ticks and maxed the bloom (hit% 5.4 vs the
//   disciple's 17.4) because spray heat — the mechanic every written brain's
//   tap cadence is built around — was invisible in v1 rows. Schema v2 logs
//   it; BUTTSTEIN observes it (ctx.sprayHeatOf) and learned the teacher's
//   trigger discipline as a RESPONSE to heat, not a mystery rhythm.
//
//   BLENDED AIM LABELS. Every row trains the 24-bin aim head; rows whose
//   shot landed within the 40-tick flight window carry 5× gradient. The
//   teacher's precision emphasized without throwing away 93% of the volume
//   (hit-exclusive labels were 6.6% of rows — too sparse).
//
// Carried from the lineage: one teacher (cuadrilla), 24-bin softmax aim with
// neighbor interpolation, one tick of memory with respawn-gap reset, and 50%
// history dropout at training (exposure-bias fix, observation node 484 —
// runtime always feeds real history).
//
// Same contract as every engine: output is the bot's control only, all
// randomness through world.rng (the forward pass is deterministic — the only
// rng this brain consumes is roamTick's).

import {
  createRoamState,
  resolveTweaks,
  roamTick,
  type BotBrain,
  type BotEngine,
  type BotEngineContext,
  type EngineTweaks,
  type RoamState,
} from './engine';
import { BUTTON_HEADS, type NeuralContact } from './neuralFeatures';
import {
  nearestBulletThreat,
  weaponClassOf,
  type NeuralContactV2,
  type RelativeBullet,
  type ShortHistory,
} from './neuralFeaturesV2';
import { buildNeuralFeaturesV3, FEATURE_DIM_V3 } from './neuralFeaturesV3';
import {
  BUTTSTEIN_AIM_BINS,
  BUTTSTEIN_BIASES,
  BUTTSTEIN_DIMS,
  BUTTSTEIN_WEIGHTS,
} from './buttsteinWeights';

/** BUTTSTEIN's strategy knobs — thresholds on the cloned policy's heads.
 *  A `type` (not interface) so the implicit index signature satisfies the
 *  generic Record<string, number> bound in resolveTweaks/BotEngine.tweaks. */
export type ButtsteinConfig = {
  FIRE_THRESH: number;
  MOVE_THRESH: number;
  UPDOWN_THRESH: number;
  JET_THRESH: number;
  RELOAD_THRESH: number;
  AIM_DIST: number;
  TEMP: number;
};

export const BUTTSTEIN_DEFAULTS: Readonly<ButtsteinConfig> = {
  // The lineage's base-rate lesson: the teacher fires on ~12% of ticks
  // (disciplined windows), so 0.5 makes a clone underfire its own aim.
  // Probed at factory like disciple (0.25) and prodigy (0.15) before it:
  // over seeds {7,21,99,3,42} × 6000 ticks, 0.5/0.35 produced ZERO kills,
  // 0.25 zeroed on seed 7 (the sustainment test's seed), 0.15 zeroed on
  // seed 42 — 0.2 sustained kills on EVERY probed seed (teacher fire base
  // rate 7.60% in the v2 corpus). Ships at the value that genuinely sustains.
  FIRE_THRESH: 0.2,
  MOVE_THRESH: 0.5, // p(left)/p(right) — strafe heads
  UPDOWN_THRESH: 0.5, // p(up)/p(down) — jump/crouch heads
  JET_THRESH: 0.5, // p(jetpack)
  RELOAD_THRESH: 0.5, // p(reload) — empty mag reloads regardless (rule 3)
  AIM_DIST: 300, // px — length of the aim offset along the chosen direction
  TEMP: 1, // softmax temperature: <1 sharpens the aim distribution
};

const NB = BUTTON_HEADS.length; // 7 button logits; outputs 7..30 are aim bins
const TWO_PI = Math.PI * 2;

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

class ButtsteinBrain implements BotBrain {
  private readonly roam: RoamState = createRoamState();
  // Per-brain forward buffers — brains never share mutable state.
  private readonly h: Float64Array[] = [];
  private readonly probs = new Float64Array(BUTTSTEIN_AIM_BINS);
  // One tick of memory (the trainer's prior-row join, kept live here).
  private lastTick = -2;
  private readonly hist: ShortHistory = { vx: 0, vy: 0, aimUx: 0, aimUy: 0 };

  constructor(private readonly cfg: ButtsteinConfig) {
    for (let l = 1; l < BUTTSTEIN_DIMS.length; l++) {
      this.h.push(new Float64Array(BUTTSTEIN_DIMS[l] ?? 0));
    }
  }

  /** Forward pass: tanh hiddens, raw outputs (same shape as the trainer). */
  private run(features: readonly number[]): Float64Array {
    let input: readonly number[] | Float64Array = features;
    for (let l = 0; l < this.h.length; l++) {
      const w = BUTTSTEIN_WEIGHTS[l] ?? [];
      const b = BUTTSTEIN_BIASES[l] ?? [];
      const fanIn = BUTTSTEIN_DIMS[l] ?? 0;
      const o = this.h[l] as Float64Array;
      const last = l === this.h.length - 1;
      for (let j = 0; j < o.length; j++) {
        let acc = b[j] ?? 0;
        const wo = j * fanIn;
        for (let i = 0; i < fanIn; i++) acc += (w[wo + i] ?? 0) * (input[i] ?? 0);
        o[j] = last ? acc : Math.tanh(acc); // hidden tanh, output raw
      }
      input = o;
    }
    return this.h[this.h.length - 1] as Float64Array;
  }

  tick(botIndex: number, ctx: BotEngineContext): void {
    const { world } = ctx;
    const s = world.sprites[botIndex];
    const parts = world.spriteParts;
    if (s === undefined || parts === null) return;
    const c = s.control;

    c.left = false;
    c.right = false;
    c.up = false;
    c.down = false;
    c.fire = false;
    c.jetpack = false;
    c.reload = false;

    const px = parts.posX[botIndex] ?? 0;
    const py = parts.posY[botIndex] ?? 0;
    const clock = world.mainTickCounter;

    // History discipline mirrors the trainer: a row at T uses T−1's state;
    // any tick gap (death/respawn, first tick) means no history.
    const hasHistory = clock === this.lastTick + 1;
    const hist = hasHistory ? this.hist : null;

    // Contacts exactly as the training join saw them: every live bot at this
    // tick, split by team (team 0 = FFA: everyone else is an enemy). Spawn-
    // protected ghosts are skipped like every other brain skips them.
    const enemies: NeuralContactV2[] = [];
    const teammates: NeuralContact[] = [];
    for (let i = 1; i < world.sprites.length; i++) {
      if (i === botIndex) continue;
      const o = world.sprites[i];
      if (o === undefined || !o.active || o.deadMeat) continue;
      if (o.alpha !== 255 && o.holdedThing === 0) continue;
      const contact: NeuralContactV2 = {
        dx: (parts.posX[i] ?? 0) - px,
        dy: (parts.posY[i] ?? 0) - py,
        vx: parts.velocityX[i] ?? 0,
        vy: parts.velocityY[i] ?? 0,
        hp: o.health,
        reloading: ctx.reloadingOf(i),
        ammo: ctx.ammoOf(i),
        weapon: weaponClassOf(ctx.weaponOf?.(i)),
      };
      if (s.team > 0 && o.team === s.team) teammates.push(contact);
      else enemies.push(contact);
    }

    // Update memory for the NEXT tick before any early return, so roam ticks
    // still advance the clock (velocity refreshes; aim keeps its last value —
    // exactly how recorded control.aim persists through roaming in the rows).
    const updateMemory = (): void => {
      this.lastTick = clock;
      this.hist.vx = parts.velocityX[botIndex] ?? 0;
      this.hist.vy = parts.velocityY[botIndex] ?? 0;
      const al = Math.hypot(c.mouseAimX, c.mouseAimY);
      if (al > 1e-6) {
        this.hist.aimUx = c.mouseAimX / al;
        this.hist.aimUy = c.mouseAimY / al;
      }
    };

    if (enemies.length === 0) {
      // The master never played an enemyless arena — wander like everyone.
      roamTick(this.roam, botIndex, ctx);
      updateMemory();
      return;
    }

    // The dodge organ's scan, as a sense: live enemy bullets relative to me.
    // EXACT on both sides now — schema-v2 rows logged the winner of this very
    // scan at training time (see neuralFeaturesV3.ts).
    const bp = world.bulletParts;
    const rel: RelativeBullet[] = [];
    if (bp !== null) {
      for (let i = 1; i < world.bullets.length; i++) {
        const b = world.bullets[i];
        if (b === undefined || !b.active) continue;
        if (b.owner === botIndex) continue;
        const owner = world.sprites[b.owner];
        if (owner !== undefined && s.team > 0 && owner.team === s.team) continue;
        rel.push({
          rx: (bp.posX[b.num] ?? 0) - px,
          ry: (bp.posY[b.num] ?? 0) - py,
          vx: bp.velocityX[b.num] ?? 0,
          vy: bp.velocityY[b.num] ?? 0,
        });
      }
    }
    const threat = nearestBulletThreat(rel);

    const features = buildNeuralFeaturesV3(
      {
        vx: parts.velocityX[botIndex] ?? 0,
        vy: parts.velocityY[botIndex] ?? 0,
        fuel: s.jetsCount,
        hp: s.health,
        ammo: ctx.ammoOf(botIndex),
        reloading: ctx.reloadingOf(botIndex),
        onGround: s.onGround,
        weapon: weaponClassOf(ctx.weaponOf?.(botIndex)),
        heat: ctx.sprayHeatOf?.(botIndex) ?? 0, // the v3 sense
      },
      enemies,
      teammates,
      threat,
      hist,
    );
    if (features.length !== FEATURE_DIM_V3) return; // contract guard
    const out = this.run(features);

    const cfg = this.cfg;
    c.left = sigmoid(out[0] ?? 0) > cfg.MOVE_THRESH;
    c.right = sigmoid(out[1] ?? 0) > cfg.MOVE_THRESH;
    c.up = sigmoid(out[2] ?? 0) > cfg.UPDOWN_THRESH;
    c.down = sigmoid(out[3] ?? 0) > cfg.UPDOWN_THRESH;
    c.fire = sigmoid(out[4] ?? 0) > cfg.FIRE_THRESH;
    c.jetpack = sigmoid(out[5] ?? 0) > cfg.JET_THRESH;
    c.reload = sigmoid(out[6] ?? 0) > cfg.RELOAD_THRESH;
    // Rule of the game, not a policy choice: an empty mag always reloads.
    if (!ctx.reloadingOf(botIndex) && ctx.ammoOf(botIndex) === 0) c.reload = true;

    // Aim: tempered softmax over the 24 direction bins, neighbor-interpolated
    // for sub-15° precision (the disciple's proven decode, unchanged).
    const temp = cfg.TEMP > 1e-3 ? cfg.TEMP : 1e-3;
    let best = 0;
    let mx = -Infinity;
    for (let j = 0; j < BUTTSTEIN_AIM_BINS; j++) {
      const l = out[NB + j] ?? 0;
      if (l > mx) {
        mx = l;
        best = j;
      }
    }
    let sum = 0;
    for (let j = 0; j < BUTTSTEIN_AIM_BINS; j++) {
      const e = Math.exp(((out[NB + j] ?? 0) - mx) / temp);
      this.probs[j] = e;
      sum += e;
    }
    const prev = (best + BUTTSTEIN_AIM_BINS - 1) % BUTTSTEIN_AIM_BINS;
    const next = (best + 1) % BUTTSTEIN_AIM_BINS;
    const pPrev = (this.probs[prev] ?? 0) / sum;
    const pNext = (this.probs[next] ?? 0) / sum;
    const pBest = (this.probs[best] ?? 0) / sum;
    const dir = pNext >= pPrev ? 1 : -1;
    const pNb = dir === 1 ? pNext : pPrev;
    const lean = pBest + pNb > 0 ? pNb / (pBest + pNb) : 0; // in [0, 0.5]
    const ang = ((best + 0.5 + dir * lean) / BUTTSTEIN_AIM_BINS) * TWO_PI;
    c.mouseAimX = Math.round(Math.cos(ang) * cfg.AIM_DIST);
    c.mouseAimY = Math.round(Math.sin(ang) * cfg.AIM_DIST);

    updateMemory();
  }
}

export function createButtsteinEngine(tweaks?: EngineTweaks): BotEngine {
  const cfg = resolveTweaks('buttstein', BUTTSTEIN_DEFAULTS, tweaks);
  return {
    id: 'buttstein',
    strategy:
      'BUTTSTEIN — the fourth student, first trained on EXACT data: replay schema v2 (recorder-run threat scan, exact weapons, own spray heat as a sense) with blended 5x hit-weighted aim labels — the three fixes the prodigy post-mortem prescribed',
    tweaks: cfg,
    createBrain: (): BotBrain => new ButtsteinBrain(cfg),
  };
}
