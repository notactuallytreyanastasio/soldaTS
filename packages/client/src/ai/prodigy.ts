// "prodigy" bot engine — the THIRD student (goal node 473).
//
// Lineage: MIMIC (neural.ts) averaged eleven teachers and learned mush;
// DISCIPLE (disciple.ts) cloned one master and proved aim-as-classification.
// The prodigy keeps the disciple's spine — one teacher (cuadrilla), 24-bin
// softmax aim — and fixes the two faults the gauntlet diagnosed in every
// prior student: blindness and amnesia.
//
//   FULL POOLED CORPUS. Trained on the merged server + local recordings
//   (the corpus the commissioner and every league run feed), not one
//   machine's slice.
//
//   SEES BULLETS AND RELOAD STATES. Features v2 (neuralFeaturesV2.ts,
//   FEATURE_DIM_V2 47): the v1 senses PLUS each enemy's reloading flag,
//   magazine and weapon (AK/SPAS/BARRETT one-hot), its own weapon, and the
//   nearest incoming bullet threat computed by the same closest-approach
//   scan the hand-written brains' dodge organs run — except here it is an
//   INPUT the policy learned from, not a hand-coded reflex.
//
//   REMEMBERS ONE TICK. Previous-tick velocity + previous aim unit vector
//   ride in the feature vector (training derived them from the prior replay
//   row; at runtime this brain keeps last tick's state and resets it
//   whenever a tick gap betrays death/respawn — mirroring the trainer).
//
//   LEARNS AIM ONLY FROM SHOTS THAT LANDED. The aim head trained exclusively
//   on rows whose shot produced a hit event within the bullet-flight window:
//   the teacher's precision, distilled without its whiffs.
//
// Honest caveat carried from training: the bullet-threat feature was
// APPROXIMATE in training (reconstructed from shot events + recorded aim —
// no spread, no pellet fan, no impact deletion) and is EXACT here at runtime
// (world.bullets). See neuralFeaturesV2.ts and the prodigyWeights.ts header.
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
  buildNeuralFeaturesV2,
  nearestBulletThreat,
  weaponClassOf,
  FEATURE_DIM_V2,
  type NeuralContactV2,
  type RelativeBullet,
  type ShortHistory,
} from './neuralFeaturesV2';
import {
  PRODIGY_AIM_BINS,
  PRODIGY_BIASES,
  PRODIGY_DIMS,
  PRODIGY_WEIGHTS,
} from './prodigyWeights';

/** Prodigy's strategy knobs — thresholds on the cloned policy's heads.
 *  A `type` (not interface) so the implicit index signature satisfies the
 *  generic Record<string, number> bound in resolveTweaks/BotEngine.tweaks. */
export type ProdigyConfig = {
  FIRE_THRESH: number;
  MOVE_THRESH: number;
  UPDOWN_THRESH: number;
  JET_THRESH: number;
  RELOAD_THRESH: number;
  AIM_DIST: number;
  TEMP: number;
};

export const PRODIGY_DEFAULTS: Readonly<ProdigyConfig> = {
  // The disciple's base-rate lesson, baked into the DEFAULT: the teacher
  // fires on ~12% of ticks (disciplined windows), so a 0.5 threshold makes
  // a clone underfire its own good aim — DISCIPLE proved 0.25 on the card
  // (36-9 vs 0.5's draw). The prodigy ships calibrated.
  FIRE_THRESH: 0.15, // p(fire) above this pulls the trigger (0.25 underfired: 0 kills/6000 ticks)
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

class ProdigyBrain implements BotBrain {
  private readonly roam: RoamState = createRoamState();
  // Per-brain forward buffers — brains never share mutable state.
  private readonly h: Float64Array[] = [];
  private readonly probs = new Float64Array(PRODIGY_AIM_BINS);
  // One tick of memory (the trainer's prior-row join, kept live here).
  private lastTick = -2;
  private readonly hist: ShortHistory = { vx: 0, vy: 0, aimUx: 0, aimUy: 0 };

  constructor(private readonly cfg: ProdigyConfig) {
    for (let l = 1; l < PRODIGY_DIMS.length; l++) {
      this.h.push(new Float64Array(PRODIGY_DIMS[l] ?? 0));
    }
  }

  /** Forward pass: tanh hiddens, raw outputs (same shape as the trainer). */
  private run(features: readonly number[]): Float64Array {
    let input: readonly number[] | Float64Array = features;
    for (let l = 0; l < this.h.length; l++) {
      const w = PRODIGY_WEIGHTS[l] ?? [];
      const b = PRODIGY_BIASES[l] ?? [];
      const fanIn = PRODIGY_DIMS[l] ?? 0;
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
    // any tick gap (death/respawn, first tick) means no history. The trainer
    // saw the same gap in the replay rows and fed zeros.
    const hasHistory = clock === this.lastTick + 1;
    const hist = hasHistory ? this.hist : null;

    // Contacts exactly as the training join saw them: every live bot at this
    // tick, split by team (team 0 = FFA: everyone else is an enemy). Spawn-
    // protected ghosts are skipped like every other brain skips them. V2
    // enemies additionally carry reload/ammo/weapon — the same fields the
    // trainer read off their replay rows.
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
    // EXACT here — this is the runtime side of the training-time
    // reconstruction (see neuralFeaturesV2.ts provenance note).
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

    const features = buildNeuralFeaturesV2(
      {
        vx: parts.velocityX[botIndex] ?? 0,
        vy: parts.velocityY[botIndex] ?? 0,
        fuel: s.jetsCount,
        hp: s.health,
        ammo: ctx.ammoOf(botIndex),
        reloading: ctx.reloadingOf(botIndex),
        onGround: s.onGround,
        weapon: weaponClassOf(ctx.weaponOf?.(botIndex)),
      },
      enemies,
      teammates,
      threat,
      hist,
    );
    if (features.length !== FEATURE_DIM_V2) return; // contract guard
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
    for (let j = 0; j < PRODIGY_AIM_BINS; j++) {
      const l = out[NB + j] ?? 0;
      if (l > mx) {
        mx = l;
        best = j;
      }
    }
    let sum = 0;
    for (let j = 0; j < PRODIGY_AIM_BINS; j++) {
      const e = Math.exp(((out[NB + j] ?? 0) - mx) / temp);
      this.probs[j] = e;
      sum += e;
    }
    const prev = (best + PRODIGY_AIM_BINS - 1) % PRODIGY_AIM_BINS;
    const next = (best + 1) % PRODIGY_AIM_BINS;
    const pPrev = (this.probs[prev] ?? 0) / sum;
    const pNext = (this.probs[next] ?? 0) / sum;
    const pBest = (this.probs[best] ?? 0) / sum;
    const dir = pNext >= pPrev ? 1 : -1;
    const pNb = dir === 1 ? pNext : pPrev;
    const lean = pBest + pNb > 0 ? pNb / (pBest + pNb) : 0; // in [0, 0.5]
    const ang = ((best + 0.5 + dir * lean) / PRODIGY_AIM_BINS) * TWO_PI;
    c.mouseAimX = Math.round(Math.cos(ang) * cfg.AIM_DIST);
    c.mouseAimY = Math.round(Math.sin(ang) * cfg.AIM_DIST);

    updateMemory();
  }
}

export function createProdigyEngine(tweaks?: EngineTweaks): BotEngine {
  const cfg = resolveTweaks('prodigy', PRODIGY_DEFAULTS, tweaks);
  return {
    id: 'prodigy',
    strategy:
      'THE PRODIGY — the third student: cloned from cuadrilla over the FULL pooled corpus with v2 senses (sees bullets, reload windows and the wildcard guns, remembers one tick) and an aim head taught ONLY by the shots that landed',
    tweaks: cfg,
    createBrain: (): BotBrain => new ProdigyBrain(cfg),
  };
}
