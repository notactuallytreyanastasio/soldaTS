// Neural feature contract V3 (neuralFeaturesV3.ts) — BUTTSTEIN's senses:
// v2's vector with the bias slot repurposed to own spray heat plus a fresh
// bias, and the recorder-side nearestThreatBullet scan whose selection must
// be IDENTICAL to nearestBulletThreat's (that identity is what makes
// schema-v2 replay rows lossless).

import { describe, it, expect } from 'vitest';
import {
  buildNeuralFeaturesV2,
  FEATURE_DIM_V2,
  nearestBulletThreat,
  THREAT_HORIZON,
  type BulletThreat,
  type NeuralContactV2,
  type RelativeBullet,
} from './neuralFeaturesV2';
import {
  buildNeuralFeaturesV3,
  FEATURE_DIM_V3,
  NORM_HEAT,
  nearestThreatBullet,
  type NeuralSelfV3,
} from './neuralFeaturesV3';

const SELF: NeuralSelfV3 = {
  vx: 5,
  vy: -2,
  fuel: 350,
  hp: 75,
  ammo: 15,
  reloading: true,
  onGround: false,
  weapon: 1,
  heat: 0,
};

const enemyV2 = (over: Partial<NeuralContactV2>): NeuralContactV2 => ({
  dx: 0,
  dy: 0,
  vx: 0,
  vy: 0,
  hp: 0,
  reloading: false,
  ammo: 0,
  weapon: 0,
  ...over,
});

describe('buildNeuralFeaturesV3', () => {
  it('returns exactly FEATURE_DIM_V3 = 48 elements', () => {
    expect(FEATURE_DIM_V3).toBe(FEATURE_DIM_V2 + 1);
    expect(FEATURE_DIM_V3).toBe(48);
    expect(buildNeuralFeaturesV3(SELF, [], [], null, null)).toHaveLength(
      FEATURE_DIM_V3,
    );
  });

  it('delegates the first 46 informative floats to v2 verbatim', () => {
    const enemies = [
      enemyV2({ dx: 120, dy: -40, hp: 90, reloading: true, ammo: 3, weapon: 2 }),
    ];
    const threat: BulletThreat = { dx: -50, dy: 10, closing: 20, tClose: 8 };
    const history = { vx: 1, vy: 2, aimUx: 0.6, aimUy: 0.8 };
    const v3 = buildNeuralFeaturesV3({ ...SELF, heat: 0.05 }, enemies, [], threat, history);
    const v2 = buildNeuralFeaturesV2(SELF, enemies, [], threat, history);
    expect(v3.slice(0, FEATURE_DIM_V2 - 1)).toEqual(v2.slice(0, FEATURE_DIM_V2 - 1));
  });

  it("replaces v2's bias slot with heat/NORM_HEAT and appends a fresh bias", () => {
    const f = buildNeuralFeaturesV3({ ...SELF, heat: 0.08 }, [], [], null, null);
    expect(f[FEATURE_DIM_V2 - 1]).toBeCloseTo(0.08 / NORM_HEAT, 12); // 0.5
    expect(f[FEATURE_DIM_V3 - 1]).toBe(1);
  });

  it('heat spans [0, 1]: cool is 0, max bloom is 1, beyond clamps', () => {
    const heatSlot = FEATURE_DIM_V2 - 1;
    expect(buildNeuralFeaturesV3({ ...SELF, heat: 0 }, [], [], null, null)[heatSlot]).toBe(0);
    expect(
      buildNeuralFeaturesV3({ ...SELF, heat: NORM_HEAT }, [], [], null, null)[heatSlot],
    ).toBe(1);
    expect(
      buildNeuralFeaturesV3({ ...SELF, heat: NORM_HEAT * 2 }, [], [], null, null)[heatSlot],
    ).toBe(1);
    expect(
      buildNeuralFeaturesV3({ ...SELF, heat: -1 }, [], [], null, null)[heatSlot],
    ).toBe(0);
  });
});

describe('nearestThreatBullet', () => {
  const bullet = (over: Partial<RelativeBullet>): RelativeBullet => ({
    rx: 0,
    ry: 0,
    vx: 0,
    vy: 0,
    ...over,
  });

  it('returns null for no bullets, stationary bullets, receding bullets and beyond-horizon bullets', () => {
    expect(nearestThreatBullet([])).toBeNull();
    expect(nearestThreatBullet([bullet({ rx: -10 })])).toBeNull(); // v² < 1e-6
    expect(nearestThreatBullet([bullet({ rx: 100, vx: 10 })])).toBeNull(); // tStar < 0
    expect(nearestThreatBullet([bullet({ rx: -400, vx: 10 })])).toBeNull(); // tStar 40 > 30
  });

  it('returns the WINNING BULLET OBJECT itself (smallest miss distance)', () => {
    const grazer = bullet({ rx: -100, ry: 50, vx: 10 });
    const direct = bullet({ rx: -200, ry: 5, vx: 10 });
    expect(nearestThreatBullet([grazer, direct])).toBe(direct);
  });

  it('breaks exact miss ties toward the FIRST bullet (strict <)', () => {
    const first = bullet({ rx: -100, ry: 20, vx: 10 });
    const second = bullet({ rx: -150, ry: 20, vx: 10 });
    expect(nearestThreatBullet([first, second])).toBe(first);
  });

  it('qualifies a bullet exactly at the horizon (tStar <= THREAT_HORIZON)', () => {
    const edge = bullet({ rx: -10 * THREAT_HORIZON, vx: 10 });
    expect(nearestThreatBullet([edge])).toBe(edge);
  });

  it('selection is identical to nearestBulletThreat: scanning the winner alone reproduces the full-scan threat', () => {
    const swarms: RelativeBullet[][] = [
      [
        bullet({ rx: -100, ry: 50, vx: 10 }),
        bullet({ rx: -200, ry: 5, vx: 10, vy: 1 }),
        bullet({ rx: 80, ry: -40, vx: -6, vy: 3 }),
        bullet({ rx: 100, vx: 10 }), // receding — filtered by both
        bullet({ rx: -10 }), // stationary — filtered by both
      ],
      [
        bullet({ rx: 250, ry: -250, vx: -9, vy: 9 }),
        bullet({ rx: -60, ry: -60, vx: 4, vy: 4 }),
      ],
    ];
    for (const all of swarms) {
      const winner = nearestThreatBullet(all);
      expect(winner).not.toBeNull();
      expect(nearestBulletThreat([winner as RelativeBullet])).toEqual(
        nearestBulletThreat(all),
      );
    }
  });
});
