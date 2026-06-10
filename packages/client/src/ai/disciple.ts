// "disciple" bot engine — the twelfth doctrine: one master, cloned faithfully
// (action node 357, under the v2 plan in node 351).
//
// The v1 learned player (neural.ts) averaged ELEVEN teachers into one net,
// and the average of contradictory doctrines is mush: when half the tape
// kites and half rushes, regression learns to do neither, and its aim head
// (a unit-vector REGRESSION) blurred multimodal targets into a 38°-mean-error
// smear (cosine 0.786) — enemy left and enemy right average to "forward".
// The disciple fixes both mistakes at once:
//
//   ONE TEACHER. Every training row is cuadrilla — the bullfighter's crew,
//   the reigning champion that swept the field 9-0/8-1. Other engines appear
//   in the training data only as the enemies the master was beating.
//
//   AIM IS A CHOICE, NOT AN AVERAGE. The aim head is a 24-way direction
//   CLASSIFICATION (15° bins, softmax). A softmax over directions keeps
//   multimodal aim multimodal and picks the strongest mode; the runtime
//   interpolates between the winning bin and its stronger neighbor for
//   sub-bin precision.
//
// How it plays:
//   1. SEE like the master's tape was recorded — features from the SAME
//      buildNeuralFeatures contract (neuralFeatures.ts): own kinematics and
//      resources + the 2 nearest live enemies + nearest teammate, everything
//      relative and normalized.
//   2. ACT by thresholding the 7 button heads and aiming along the softmax
//      head's chosen direction bin scaled to AIM_DIST (TEMP sharpens the
//      distribution before the neighbor interpolation).
//   3. SURVIVE the gaps any clone has: no live enemy → roamTick like every
//      engine (the master never played an empty arena), and an empty mag
//      always reloads (a rule of the game, not a policy choice).
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
import {
  buildNeuralFeatures,
  BUTTON_HEADS,
  FEATURE_DIM,
  type NeuralContact,
} from './neuralFeatures';
import {
  DISCIPLE_AIM_BINS,
  DISCIPLE_BIASES,
  DISCIPLE_DIMS,
  DISCIPLE_WEIGHTS,
} from './discipleWeights';

/** Disciple's strategy knobs — thresholds on the cloned policy's heads.
 *  A `type` (not interface) so the implicit index signature satisfies the
 *  generic Record<string, number> bound in resolveTweaks/BotEngine.tweaks. */
export type DiscipleConfig = {
  FIRE_THRESH: number;
  MOVE_THRESH: number;
  UPDOWN_THRESH: number;
  JET_THRESH: number;
  RELOAD_THRESH: number;
  AIM_DIST: number;
  TEMP: number;
};

export const DISCIPLE_DEFAULTS: Readonly<DiscipleConfig> = {
  FIRE_THRESH: 0.5, // p(fire) above this pulls the trigger
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

class DiscipleBrain implements BotBrain {
  private readonly roam: RoamState = createRoamState();
  // Per-brain forward buffers — brains never share mutable state.
  private readonly h: Float64Array[] = [];
  private readonly probs = new Float64Array(DISCIPLE_AIM_BINS);

  constructor(private readonly cfg: DiscipleConfig) {
    for (let l = 1; l < DISCIPLE_DIMS.length; l++) {
      this.h.push(new Float64Array(DISCIPLE_DIMS[l] ?? 0));
    }
  }

  /** Forward pass: tanh hiddens, raw outputs (same shape as the trainer). */
  private run(features: readonly number[]): Float64Array {
    let input: readonly number[] | Float64Array = features;
    for (let l = 0; l < this.h.length; l++) {
      const w = DISCIPLE_WEIGHTS[l] ?? [];
      const b = DISCIPLE_BIASES[l] ?? [];
      const fanIn = DISCIPLE_DIMS[l] ?? 0;
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

    // Contacts exactly as the training join saw them: every live bot at this
    // tick, split by team (team 0 = FFA: everyone else is an enemy). Spawn-
    // protected ghosts are skipped like every other brain skips them.
    const enemies: NeuralContact[] = [];
    const teammates: NeuralContact[] = [];
    for (let i = 1; i < world.sprites.length; i++) {
      if (i === botIndex) continue;
      const o = world.sprites[i];
      if (o === undefined || !o.active || o.deadMeat) continue;
      if (o.alpha !== 255 && o.holdedThing === 0) continue;
      const contact: NeuralContact = {
        dx: (parts.posX[i] ?? 0) - px,
        dy: (parts.posY[i] ?? 0) - py,
        vx: parts.velocityX[i] ?? 0,
        vy: parts.velocityY[i] ?? 0,
        hp: o.health,
      };
      if (s.team > 0 && o.team === s.team) teammates.push(contact);
      else enemies.push(contact);
    }

    if (enemies.length === 0) {
      // The master never played an enemyless arena — wander like everyone.
      roamTick(this.roam, botIndex, ctx);
      return;
    }

    const features = buildNeuralFeatures(
      {
        vx: parts.velocityX[botIndex] ?? 0,
        vy: parts.velocityY[botIndex] ?? 0,
        fuel: s.jetsCount,
        hp: s.health,
        ammo: ctx.ammoOf(botIndex),
        reloading: ctx.reloadingOf(botIndex),
        onGround: s.onGround,
      },
      enemies,
      teammates,
    );
    if (features.length !== FEATURE_DIM) return; // contract guard
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

    // Aim: tempered softmax over the 24 direction bins. The winning bin's
    // CENTER is the base direction; interpolating toward the stronger
    // adjacent bin (by probability mass) recovers sub-15° precision without
    // ever averaging opposite modes — the v1 regression's fatal flaw.
    const temp = cfg.TEMP > 1e-3 ? cfg.TEMP : 1e-3;
    let best = 0;
    let mx = -Infinity;
    for (let j = 0; j < DISCIPLE_AIM_BINS; j++) {
      const l = out[NB + j] ?? 0;
      if (l > mx) {
        mx = l;
        best = j;
      }
    }
    let sum = 0;
    for (let j = 0; j < DISCIPLE_AIM_BINS; j++) {
      const e = Math.exp(((out[NB + j] ?? 0) - mx) / temp);
      this.probs[j] = e;
      sum += e;
    }
    const prev = (best + DISCIPLE_AIM_BINS - 1) % DISCIPLE_AIM_BINS;
    const next = (best + 1) % DISCIPLE_AIM_BINS;
    const pPrev = (this.probs[prev] ?? 0) / sum;
    const pNext = (this.probs[next] ?? 0) / sum;
    const pBest = (this.probs[best] ?? 0) / sum;
    const dir = pNext >= pPrev ? 1 : -1;
    const pNb = dir === 1 ? pNext : pPrev;
    const lean = pBest + pNb > 0 ? pNb / (pBest + pNb) : 0; // in [0, 0.5]
    const ang = ((best + 0.5 + dir * lean) / DISCIPLE_AIM_BINS) * TWO_PI;
    c.mouseAimX = Math.round(Math.cos(ang) * cfg.AIM_DIST);
    c.mouseAimY = Math.round(Math.sin(ang) * cfg.AIM_DIST);
  }
}

export function createDiscipleEngine(tweaks?: EngineTweaks): BotEngine {
  const cfg = resolveTweaks('disciple', DISCIPLE_DEFAULTS, tweaks);
  return {
    id: 'disciple',
    strategy:
      "THE DISCIPLE — one master, cloned faithfully: a behavior clone of cuadrilla's tape ONLY (the champion, not the eleven-doctrine average), with aim as a 24-bin direction classification so multimodal targets stay choices instead of blurring to the mean",
    tweaks: cfg,
    createBrain: (): BotBrain => new DiscipleBrain(cfg),
  };
}
