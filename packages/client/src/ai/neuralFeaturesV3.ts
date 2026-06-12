// Neural feature contract V3 — BUTTSTEIN's senses (goal node 504).
//
// Same anti-drift rule as v1/v2: ONE shared module. The trainer
// (tools/train-buttstein.mjs) and the runtime engine (buttstein.ts) both call
// buildNeuralFeaturesV3 — if they ever disagreed on layout or normalization
// the cloned policy would silently play a scrambled observation. NEVER change
// layout/normalization here without retraining buttsteinWeights.ts. The v1
// and v2 modules are untouched: shipped neural/disciple/prodigy nets keep
// their contracts.
//
// What v3 adds over v2's 47 floats: ONE new sense — OWN SPRAY HEAT.
// PRODIGY's post-mortem (outcome node 489) found the student fires ~36% of
// in-contact ticks and maxes the spray bloom (hit% 5.4 vs the disciple's
// 17.4) because the heat that punishes spraying was INVISIBLE in the replay
// rows: the teacher's disciplined tap cadence is a response to a state the
// student never saw. Replay schema v2 logs the recorder-exact heat per row,
// so the v3 student observes the exact mechanic the written brains are built
// around.
//
// The other v3 difference is NOT in this file but matters for provenance:
// the bullet-threat block is now EXACT at training time too. Schema-v2 rows
// carry the nearest threat bullet (btx/bty/btvx/btvy) computed by the SAME
// closest-approach scan the runtime brains run (nearestThreatBullet below is
// the selection; replay.ts calls it at the post-think seam), so the
// reconstruction gap that sank PRODIGY (outcome node 485) is closed.
//
// Layout: v2's 46 informative floats in their exact order, then own spray
// heat, then bias — implemented by DELEGATING to buildNeuralFeaturesV2 so
// the shared blocks cannot drift.

import {
  buildNeuralFeaturesV2,
  FEATURE_DIM_V2,
  type BulletThreat,
  type NeuralContactV2,
  type NeuralSelfV2,
  type RelativeBullet,
  type ShortHistory,
  THREAT_HORIZON,
} from './neuralFeaturesV2';
import type { NeuralContact } from './neuralFeatures';

/** Spray-heat normalizer: SPREAD_HEAT_MAX in game.ts — heat is clamped to
 *  0.16 rad of bloom, so heat/NORM_HEAT spans exactly [0, 1]. */
export const NORM_HEAT = 0.16;

/** Self-observable state, v3: v2's NeuralSelfV2 + my current spray bloom. */
export interface NeuralSelfV3 extends NeuralSelfV2 {
  /** Spray bloom (radians, 0..SPREAD_HEAT_MAX) — Game.sprayHeatOf. */
  heat: number;
}

/** Total: v2's 47 with the bias slot repurposed to heat + a new bias = 48. */
export const FEATURE_DIM_V3 = FEATURE_DIM_V2 + 1;

const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

/**
 * The dodge organ's closest-approach scan, returning the WINNING BULLET
 * itself instead of the derived threat: among bullets whose closest approach
 * happens within (0, THREAT_HORIZON] ticks, pick the one with the smallest
 * miss distance. The selection rule is IDENTICAL to nearestBulletThreat
 * (neuralFeaturesV2.ts) — same horizon, same tie-break (strict <) — so
 * nearestBulletThreat([nearestThreatBullet(all)!]) equals
 * nearestBulletThreat(all). That identity is what makes schema-v2 rows
 * lossless: the recorder logs the winner's raw kinematics and the trainer
 * re-derives the exact BulletThreat the runtime scan would produce.
 */
export function nearestThreatBullet(
  bullets: readonly RelativeBullet[],
): RelativeBullet | null {
  let best: RelativeBullet | null = null;
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
    bestMiss = miss;
    best = b;
  }
  return best;
}

/**
 * Build the v3 policy-net input: the v2 vector with its bias slot replaced
 * by normalized own spray heat, then a fresh bias. All v2 semantics
 * (nearest-k ordering, normalizers, presence flags) are inherited verbatim
 * via delegation.
 */
export function buildNeuralFeaturesV3(
  self: NeuralSelfV3,
  enemies: readonly NeuralContactV2[],
  teammates: readonly NeuralContact[],
  threat: BulletThreat | null,
  history: ShortHistory | null,
): number[] {
  const f = buildNeuralFeaturesV2(self, enemies, teammates, threat, history);
  f[FEATURE_DIM_V2 - 1] = clamp(self.heat / NORM_HEAT, 0, 1); // was v2's bias
  f.push(1); // bias
  return f;
}
