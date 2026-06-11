// Neural feature contract V2 — the prodigy's senses (goal node 473).
//
// Same anti-drift rule as v1 (neuralFeatures.ts): ONE shared module. The
// trainer (tools/train-prodigy.mjs, node type-stripping import) and the
// runtime engine (prodigy.ts) both call buildNeuralFeaturesV2 — if they ever
// disagreed on layout or normalization the cloned policy would silently play
// a scrambled observation. NEVER change layout/normalization here without
// retraining prodigyWeights.ts. The v1 module is untouched: the shipped
// neural/disciple nets keep their 25-float contract.
//
// What v2 adds over v1's 25 floats (the diagnosed blind spots):
//   - Per nearest-2 enemies: reloading flag, ammo/30, weapon one-hot(3) —
//     AK74 / SPAS12 / BARRETT; every other weapon buckets to AK for now.
//     A reloading Barrett is a free window; a loaded one is a death sentence.
//   - Own weapon one-hot(3) — the wildcard hands the student different guns.
//   - Nearest incoming bullet threat {dx/600, dy/600, closing/30, tClose/30,
//     present} — the same closest-approach scan the hand-written brains'
//     dodge organ runs (cuadrilla.scanBullets), exposed as floats so the net
//     can LEARN to dodge instead of being handed a dodge.
//   - SHORT HISTORY: previous-tick own velocity + previous aim unit vector.
//     One tick of memory: enough to encode "I am already strafing left" and
//     "where was I pointing" — derivatives the per-tick snapshot can't see.
//
// PROVENANCE / honesty note on the bullet threat: at RUNTIME it is exact
// (world.bullets). At TRAINING time replay rows do not log bullets, so the
// trainer reconstructs approximate live bullets from other bots' shot events
// + their recorded aim (muzzle offset 14 px, weapon muzzle speed, bullet
// gravity 0.135 px/tick², lifetime capped at the threat horizon; pellet fans,
// spread jitter, impact deletion and ricochets are NOT modeled). Approximate
// in training, exact at play — an accepted v2 compromise, documented in the
// generated weights header.
//
// Design constraints carried from v1: pure functions of raw numbers (no
// World access), all positions relative + normalized, presence flags so
// "absent" differs from "exactly on top of me".

import {
  NORM_AMMO,
  NORM_DIST,
  NORM_FUEL,
  NORM_HP,
  NORM_VEL,
  type NeuralContact,
  type NeuralSelf,
} from './neuralFeatures';

/** Weapon class for the one-hot: 0 = AK74 (and every unlisted gun), 1 =
 *  SPAS12, 2 = BARRETT. Three classes only — the corpus is overwhelmingly
 *  AK with shotgun/rifle wildcards; rocket/ricochet/chainsaw bucket to AK
 *  until their tape is thick enough to matter. */
export type WeaponClass = 0 | 1 | 2;

/** Map an engine-context weapon label ('AK74' | 'SPAS12' | 'BARRETT' | ...)
 *  to its feature class. Unknown/missing labels are AK74 (the default gun). */
export function weaponClassOf(label: string | undefined): WeaponClass {
  if (label === 'SPAS12') return 1;
  if (label === 'BARRETT') return 2;
  return 0;
}

/** Self-observable state, v2: v1's NeuralSelf + what gun I am holding. */
export interface NeuralSelfV2 extends NeuralSelf {
  weapon: WeaponClass;
}

/** Another live bot, v2: v1's relative kinematics + their magazine state
 *  and gun — the information that turns "enemy at 400px" into "reloading
 *  shotgunner at 400px" (a completely different decision). */
export interface NeuralContactV2 extends NeuralContact {
  reloading: boolean;
  ammo: number; // rounds in their magazine
  weapon: WeaponClass;
}

/** The nearest incoming bullet, RELATIVE to self (px, px/tick, ticks). */
export interface BulletThreat {
  dx: number; // bullet position minus mine
  dy: number;
  closing: number; // radial approach speed, px/tick (positive = incoming)
  tClose: number; // ticks until closest approach
}

/** One tick of memory: my previous velocity and previous aim unit vector.
 *  All-zero when there is no history (first tick of a life). */
export interface ShortHistory {
  vx: number;
  vy: number;
  aimUx: number;
  aimUy: number;
}

/** Threat scan horizon (ticks) — same scale as the dodge organs' 26. */
export const THREAT_HORIZON = 30;
/** Closing-speed normalizer (px/tick) — between AK 24.6 and Barrett 55. */
export const NORM_BULLET_VEL = 30;

export const ENEMY_SLOTS_V2 = 2;
export const FEATS_SELF_V2 = 7; // v1 self block, unchanged order
export const FEATS_PER_ENEMY_V2 = 12; // v1's 7 + reloading, ammo, weapon(3)
export const FEATS_TEAMMATE_V2 = 3; // present, dx, dy (v1 block)
export const FEATS_OWN_WEAPON = 3; // one-hot AK/SPAS/BARRETT
export const FEATS_THREAT = 5; // present, dx, dy, closing, tClose
export const FEATS_HISTORY = 4; // prev vx, vy, aim ux, uy
/** Total: 7 + 2*12 + 3 + 3 + 5 + 4 + 1 bias = 47. */
export const FEATURE_DIM_V2 =
  FEATS_SELF_V2 +
  ENEMY_SLOTS_V2 * FEATS_PER_ENEMY_V2 +
  FEATS_TEAMMATE_V2 +
  FEATS_OWN_WEAPON +
  FEATS_THREAT +
  FEATS_HISTORY +
  1;

const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

/** A live bullet in coordinates RELATIVE to self (the caller subtracts its
 *  own position) — what both the engine's world scan and the trainer's
 *  reconstruction produce. */
export interface RelativeBullet {
  rx: number;
  ry: number;
  vx: number;
  vy: number;
}

/**
 * The dodge organ's closest-approach scan as a pure function: among bullets
 * whose closest approach happens within (0, THREAT_HORIZON] ticks, pick the
 * one with the smallest miss distance and report it as a BulletThreat.
 * Returns null when nothing qualifies. Shared by prodigy.ts (live
 * world.bullets) and train-prodigy.mjs (reconstructed bullets) so the two
 * sides rank threats identically.
 */
export function nearestBulletThreat(bullets: readonly RelativeBullet[]): BulletThreat | null {
  let best: BulletThreat | null = null;
  let bestMiss = Infinity;
  for (const b of bullets) {
    const v2 = b.vx * b.vx + b.vy * b.vy;
    if (v2 < 1e-6) continue;
    const tStar = -(b.rx * b.vx + b.ry * b.vy) / v2;
    if (tStar <= 0 || tStar > THREAT_HORIZON) continue;
    const mx = b.rx + b.vx * tStar;
    const my = b.ry + b.vy * tStar;
    const miss = Math.hypot(mx, my);
    if (miss >= bestMiss) continue;
    const r = Math.hypot(b.rx, b.ry);
    bestMiss = miss;
    best = {
      dx: b.rx,
      dy: b.ry,
      closing: r > 1e-6 ? -(b.rx * b.vx + b.ry * b.vy) / r : Math.sqrt(v2),
      tClose: tStar,
    };
  }
  return best;
}

/**
 * Build the v2 policy-net input. `enemies`/`teammates` are ALL live contacts
 * (any order); the 2 nearest enemies and nearest teammate are picked by
 * relative distance exactly like v1. `threat` is the nearestBulletThreat
 * result (null = no incoming fire); `history` is last tick's own velocity +
 * aim unit vector (null = no history; the slot stays all-zero).
 */
export function buildNeuralFeaturesV2(
  self: NeuralSelfV2,
  enemies: readonly NeuralContactV2[],
  teammates: readonly NeuralContact[],
  threat: BulletThreat | null,
  history: ShortHistory | null,
): number[] {
  const f = new Array<number>(FEATURE_DIM_V2).fill(0);
  f[0] = self.vx / NORM_VEL;
  f[1] = self.vy / NORM_VEL;
  f[2] = self.fuel / NORM_FUEL;
  f[3] = self.hp / NORM_HP;
  f[4] = self.ammo / NORM_AMMO;
  f[5] = self.reloading ? 1 : 0;
  f[6] = self.onGround ? 1 : 0;

  // Stable nearest-k, identical ordering rule to v1.
  const byDist = (a: NeuralContact, b: NeuralContact): number =>
    a.dx * a.dx + a.dy * a.dy - (b.dx * b.dx + b.dy * b.dy);
  const es = [...enemies].sort(byDist);
  for (let i = 0; i < ENEMY_SLOTS_V2; i++) {
    const e = es[i];
    if (e === undefined) continue; // absent slot stays all-zero (present=0)
    const o = FEATS_SELF_V2 + i * FEATS_PER_ENEMY_V2;
    f[o] = 1;
    f[o + 1] = clamp(e.dx / NORM_DIST, -2, 2);
    f[o + 2] = clamp(e.dy / NORM_DIST, -2, 2);
    f[o + 3] = Math.min(Math.hypot(e.dx, e.dy), NORM_DIST) / NORM_DIST;
    f[o + 4] = e.vx / NORM_VEL;
    f[o + 5] = e.vy / NORM_VEL;
    f[o + 6] = e.hp / NORM_HP;
    f[o + 7] = e.reloading ? 1 : 0;
    f[o + 8] = e.ammo / NORM_AMMO;
    f[o + 9 + e.weapon] = 1; // one-hot AK/SPAS/BARRETT
  }

  const ts = [...teammates].sort(byDist);
  const t = ts[0];
  const to = FEATS_SELF_V2 + ENEMY_SLOTS_V2 * FEATS_PER_ENEMY_V2;
  if (t !== undefined) {
    f[to] = 1;
    f[to + 1] = clamp(t.dx / NORM_DIST, -2, 2);
    f[to + 2] = clamp(t.dy / NORM_DIST, -2, 2);
  }

  const wo = to + FEATS_TEAMMATE_V2;
  f[wo + self.weapon] = 1; // own weapon one-hot

  const bo = wo + FEATS_OWN_WEAPON;
  if (threat !== null) {
    f[bo] = 1;
    f[bo + 1] = clamp(threat.dx / NORM_DIST, -2, 2);
    f[bo + 2] = clamp(threat.dy / NORM_DIST, -2, 2);
    f[bo + 3] = clamp(threat.closing / NORM_BULLET_VEL, -3, 3);
    f[bo + 4] = clamp(threat.tClose / THREAT_HORIZON, 0, 1);
  }

  const ho = bo + FEATS_THREAT;
  if (history !== null) {
    f[ho] = history.vx / NORM_VEL;
    f[ho + 1] = history.vy / NORM_VEL;
    f[ho + 2] = history.aimUx;
    f[ho + 3] = history.aimUy;
  }

  f[FEATURE_DIM_V2 - 1] = 1; // bias
  return f;
}
