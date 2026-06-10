// "neural" bot engine — the learned player, the eleventh doctrine and the
// first one nobody wrote (goal node 337, decision 341).
//
// This is ARENA.md's "imitation seed" realized: every hand-written brain in
// this directory argues its doctrine in a header comment; this one's doctrine
// is the recorded games themselves. A small MLP was behavior-cloned from the
// arena replay datasets (observation → control, per tick, all ten incumbent
// doctrines mixed) by tools/train-imitation.mjs, and the forward pass runs
// right here in TS — same adapter, same banner, same telemetry as everyone
// it learned from.
//
// How it plays:
//   1. SEE like the datasets saw — features come from the SAME
//      buildNeuralFeatures the trainer used (neuralFeatures.ts is the shared
//      contract): own kinematics/resources + the 2 nearest live enemies +
//      nearest teammate, everything relative and normalized. Ground-truth
//      contacts (team + spawn-protection alpha checks, no line-of-sight
//      gate) because the replay rows record ground truth.
//   2. ACT by thresholding the 7 button heads (knobs below) and aiming along
//      the net's unit-vector head scaled to AIM_DIST.
//   3. SURVIVE the gaps the clone can't cover: no live enemy → roamTick like
//      every engine (the net never saw an empty arena), and an empty mag
//      always reloads (mag hygiene is a rule of the game, not a policy
//      choice worth mispredicting).
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
import { NEURAL_BIASES, NEURAL_DIMS, NEURAL_WEIGHTS } from './neuralWeights';

/** Neural's strategy knobs — thresholds on the cloned policy's heads.
 *  A `type` (not interface) so the implicit index signature satisfies the
 *  generic Record<string, number> bound in resolveTweaks/BotEngine.tweaks. */
export type NeuralConfig = {
  FIRE_THRESH: number;
  MOVE_THRESH: number;
  UPDOWN_THRESH: number;
  JET_THRESH: number;
  RELOAD_THRESH: number;
  AIM_DIST: number;
};

export const NEURAL_DEFAULTS: Readonly<NeuralConfig> = {
  FIRE_THRESH: 0.5, // p(fire) above this pulls the trigger
  MOVE_THRESH: 0.5, // p(left)/p(right) — strafe heads
  UPDOWN_THRESH: 0.5, // p(up)/p(down) — jump/crouch heads
  JET_THRESH: 0.5, // p(jetpack)
  RELOAD_THRESH: 0.5, // p(reload) — empty mag reloads regardless (rule 3)
  AIM_DIST: 300, // px — length of the aim offset along the net's unit vector
};

const NB = BUTTON_HEADS.length; // 7 button logits; outputs 7..8 are the aim vector

/** A complete weight set in the exact shape neuralWeights.ts exports —
 *  the seam phase-2 evolution uses to run CANDIDATE weights through the
 *  same brain (see createNeuralEngineWithWeights below). */
export interface NeuralNet {
  readonly dims: readonly number[];
  readonly weights: readonly (readonly number[])[];
  readonly biases: readonly (readonly number[])[];
}

/** The committed (shipped) weights as a NeuralNet — the imitation baseline
 *  evolution starts from and is gated against. */
export const NEURAL_SHIPPED_NET: NeuralNet = {
  dims: NEURAL_DIMS,
  weights: NEURAL_WEIGHTS,
  biases: NEURAL_BIASES,
};

/** Forward pass through a weight set: tanh hiddens, raw outputs.
 *  Buffers are per-brain so brains never share mutable state. */
export class NeuralPolicy {
  private readonly h: Float64Array[] = [];

  constructor(private readonly net: NeuralNet = NEURAL_SHIPPED_NET) {
    for (let l = 1; l < net.dims.length; l++) {
      this.h.push(new Float64Array(net.dims[l] ?? 0));
    }
  }

  run(features: readonly number[]): Float64Array {
    let input: readonly number[] | Float64Array = features;
    for (let l = 0; l < this.h.length; l++) {
      const w = this.net.weights[l] ?? [];
      const b = this.net.biases[l] ?? [];
      const fanIn = this.net.dims[l] ?? 0;
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
}

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

class NeuralBrain implements BotBrain {
  private readonly roam: RoamState = createRoamState();
  private readonly policy: NeuralPolicy;

  constructor(
    private readonly cfg: NeuralConfig,
    net: NeuralNet = NEURAL_SHIPPED_NET,
  ) {
    this.policy = new NeuralPolicy(net);
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
      // The net never trained on an enemyless arena — wander like everyone.
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
    const out = this.policy.run(features);

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

    // Aim: the net's direction head, normalized and scaled to AIM_DIST.
    const ax = out[NB] ?? 0;
    const ay = out[NB + 1] ?? 0;
    const alen = Math.hypot(ax, ay);
    if (alen > 1e-6) {
      c.mouseAimX = Math.round((ax / alen) * cfg.AIM_DIST);
      c.mouseAimY = Math.round((ay / alen) * cfg.AIM_DIST);
    }
  }
}

export function createNeuralEngine(tweaks?: EngineTweaks): BotEngine {
  const cfg = resolveTweaks('neural', NEURAL_DEFAULTS, tweaks);
  return {
    id: 'neural',
    strategy:
      'THE LEARNED PLAYER — behavior-cloned MLP over the arena replay corpus: ten doctrines distilled into one forward pass; sees the 2 nearest enemies relative, thresholds 7 button heads, aims along a learned unit vector',
    tweaks: cfg,
    createBrain: (): BotBrain => new NeuralBrain(cfg),
  };
}

/**
 * Evolve-time seam (action node 347): the SAME brain running an injected
 * weight set under an alternate engine id. tools/evolve.mjs registers these
 * ('neural-cand', 'neural-past', ...) to pit candidate/snapshot weights
 * against the champions and each other through the ordinary registry — the
 * Game groups teams by engine id, so distinct ids are also what makes
 * self-vs-self matches possible. INERT for normal play: nothing in the
 * static registry (ai/index.ts) calls this, so shipped behavior and recorded
 * datasets are untouched.
 */
export function createNeuralEngineWithWeights(
  id: string,
  net: NeuralNet,
  tweaks?: EngineTweaks,
): BotEngine {
  const cfg = resolveTweaks(id, NEURAL_DEFAULTS, tweaks);
  return {
    id,
    strategy:
      'THE LEARNED PLAYER (injected weights) — neural forward pass over a candidate/snapshot weight set, used by evolution self-play',
    tweaks: cfg,
    createBrain: (): BotBrain => new NeuralBrain(cfg, net),
  };
}
