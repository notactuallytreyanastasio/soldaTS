// Neural feature contract — the ONE place observation→feature mapping lives
// (decision node 341, action 342).
//
// Both the imitation trainer (tools/train-imitation.mjs, plain node — it
// imports this .ts module directly via node's native type stripping) and the
// runtime engine (neural.ts) call buildNeuralFeatures. Keeping a single
// implementation is the contract: if trainer and runtime ever disagreed on
// feature order or normalization, the cloned policy would silently play a
// scrambled observation. NEVER change layout/normalization here without
// retraining neuralWeights.ts.
//
// Design constraints:
//   - Pure function of raw numbers — no World access, so the trainer can feed
//     it replay-row joins and the engine can feed it live sprite state.
//   - All positions RELATIVE (dx/dy from self) and normalized — arenas vary,
//     absolute map coordinates would not transfer across arena seeds.
//   - Presence flags per contact slot so the net can tell "no enemy" from
//     "enemy exactly on top of me" (absent slots are all zeros).

/** Self-observable state — mirrors the replay row minus position/control. */
export interface NeuralSelf {
  vx: number; // px/tick
  vy: number; // px/tick, y down
  fuel: number; // jet ticks remaining (700 = full)
  hp: number; // health (150 = full)
  ammo: number; // rounds in magazine (30 = full AK mag)
  reloading: boolean;
  onGround: boolean;
}

/** Another live bot, RELATIVE to self (dx/dy = their pos minus mine, px). */
export interface NeuralContact {
  dx: number;
  dy: number; // y down
  vx: number;
  vy: number;
  hp: number;
}

/** Normalization constants — match the game's observable ranges. */
export const NORM_VEL = 10; // px/tick — typical top speeds are single digits
export const NORM_DIST = 600; // px — the engagement envelope every brain uses
export const NORM_FUEL = 700; // full jet tank
export const NORM_HP = 150; // full health
export const NORM_AMMO = 30; // full AK74 magazine

export const ENEMY_SLOTS = 2; // the 2 nearest enemies
export const FEATS_SELF = 7;
export const FEATS_PER_ENEMY = 7; // present, dx, dy, dist, vx, vy, hp
export const FEATS_TEAMMATE = 3; // present, dx, dy
/** Total feature vector length: 7 + 2*7 + 3 + 1 bias = 25. */
export const FEATURE_DIM = FEATS_SELF + ENEMY_SLOTS * FEATS_PER_ENEMY + FEATS_TEAMMATE + 1;

const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

/**
 * Build the policy-net input. `enemies`/`teammates` are ALL live contacts
 * (any order) — this function picks the 2 nearest enemies and the nearest
 * teammate by relative distance. Ties keep the caller's order, which is
 * ascending bot index in both the trainer (replay-row order within a tick)
 * and the engine (sprite-array iteration) — consistent by construction.
 */
export function buildNeuralFeatures(
  self: NeuralSelf,
  enemies: readonly NeuralContact[],
  teammates: readonly NeuralContact[],
): number[] {
  const f = new Array<number>(FEATURE_DIM).fill(0);
  f[0] = self.vx / NORM_VEL;
  f[1] = self.vy / NORM_VEL;
  f[2] = self.fuel / NORM_FUEL;
  f[3] = self.hp / NORM_HP;
  f[4] = self.ammo / NORM_AMMO;
  f[5] = self.reloading ? 1 : 0;
  f[6] = self.onGround ? 1 : 0;

  // Stable nearest-k: sort a copy by squared relative distance.
  const byDist = (a: NeuralContact, b: NeuralContact): number =>
    a.dx * a.dx + a.dy * a.dy - (b.dx * b.dx + b.dy * b.dy);
  const es = [...enemies].sort(byDist);
  for (let i = 0; i < ENEMY_SLOTS; i++) {
    const e = es[i];
    if (e === undefined) continue; // absent slot stays all-zero (present=0)
    const o = FEATS_SELF + i * FEATS_PER_ENEMY;
    f[o] = 1;
    f[o + 1] = clamp(e.dx / NORM_DIST, -2, 2);
    f[o + 2] = clamp(e.dy / NORM_DIST, -2, 2);
    f[o + 3] = Math.min(Math.hypot(e.dx, e.dy), NORM_DIST) / NORM_DIST;
    f[o + 4] = e.vx / NORM_VEL;
    f[o + 5] = e.vy / NORM_VEL;
    f[o + 6] = e.hp / NORM_HP;
  }

  const ts = [...teammates].sort(byDist);
  const t = ts[0];
  const to = FEATS_SELF + ENEMY_SLOTS * FEATS_PER_ENEMY;
  if (t !== undefined) {
    f[to] = 1;
    f[to + 1] = clamp(t.dx / NORM_DIST, -2, 2);
    f[to + 2] = clamp(t.dy / NORM_DIST, -2, 2);
  }

  f[FEATURE_DIM - 1] = 1; // bias
  return f;
}

/** Label head order — 7 buttons then the aim unit vector. Shared so the
 *  trainer's label writer and the engine's output reader cannot drift. */
export const BUTTON_HEADS = [
  'left',
  'right',
  'up',
  'down',
  'fire',
  'jetpack',
  'reload',
] as const;
export const OUTPUT_DIM = BUTTON_HEADS.length + 2; // + aimX, aimY (unit vector)
