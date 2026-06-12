// Neural feature contract V2 (neuralFeaturesV2.ts) — the prodigy's senses.
// Pins the v2 layout slot by slot (self, enriched enemies, teammate, own
// weapon one-hot, bullet-threat block, one-tick history, bias) plus the
// closest-approach threat scan shared by runtime and trainer.

import { describe, it, expect } from 'vitest';
import {
  buildNeuralFeatures,
  NORM_AMMO,
  NORM_DIST,
  NORM_HP,
  NORM_VEL,
  type NeuralContact,
} from './neuralFeatures';
import {
  buildNeuralFeaturesV2,
  ENEMY_SLOTS_V2,
  FEATS_OWN_WEAPON,
  FEATS_PER_ENEMY_V2,
  FEATS_SELF_V2,
  FEATS_TEAMMATE_V2,
  FEATS_THREAT,
  FEATS_HISTORY,
  FEATURE_DIM_V2,
  NORM_BULLET_VEL,
  THREAT_HORIZON,
  nearestBulletThreat,
  weaponClassOf,
  type BulletThreat,
  type NeuralContactV2,
  type NeuralSelfV2,
  type RelativeBullet,
} from './neuralFeaturesV2';

const SELF: NeuralSelfV2 = {
  vx: 5,
  vy: -2,
  fuel: 350,
  hp: 75,
  ammo: 15,
  reloading: true,
  onGround: false,
  weapon: 0,
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

const mate = (over: Partial<NeuralContact>): NeuralContact => ({
  dx: 0,
  dy: 0,
  vx: 0,
  vy: 0,
  hp: 0,
  ...over,
});

// Block offsets, derived the same way the builder derives them.
const EO = FEATS_SELF_V2; // enemy 0
const TO = FEATS_SELF_V2 + ENEMY_SLOTS_V2 * FEATS_PER_ENEMY_V2; // teammate
const WO = TO + FEATS_TEAMMATE_V2; // own weapon one-hot
const BO = WO + FEATS_OWN_WEAPON; // bullet threat
const HO = BO + FEATS_THREAT; // history

describe('layout constants', () => {
  it('FEATURE_DIM_V2 is 47 = 7 + 2*12 + 3 + 3 + 5 + 4 + 1', () => {
    expect(FEATURE_DIM_V2).toBe(47);
    expect(HO + FEATS_HISTORY + 1).toBe(FEATURE_DIM_V2);
  });
});

describe('weaponClassOf', () => {
  it('maps the three observed classes', () => {
    expect(weaponClassOf('AK74')).toBe(0);
    expect(weaponClassOf('SPAS12')).toBe(1);
    expect(weaponClassOf('BARRETT')).toBe(2);
  });

  it('buckets missing and unknown labels to AK74 (class 0)', () => {
    expect(weaponClassOf(undefined)).toBe(0);
    expect(weaponClassOf('ROCKET')).toBe(0);
    expect(weaponClassOf('CHAINSAW')).toBe(0);
    expect(weaponClassOf('definitely-not-a-gun')).toBe(0);
  });
});

describe('buildNeuralFeaturesV2 — shared v1 blocks', () => {
  it('returns exactly FEATURE_DIM_V2 elements', () => {
    expect(buildNeuralFeaturesV2(SELF, [], [], null, null)).toHaveLength(
      FEATURE_DIM_V2,
    );
  });

  it('the 7-float self block matches v1 exactly', () => {
    const v2 = buildNeuralFeaturesV2(SELF, [], [], null, null);
    const v1 = buildNeuralFeatures(SELF, [], []);
    expect(v2.slice(0, FEATS_SELF_V2)).toEqual(v1.slice(0, FEATS_SELF_V2));
  });

  it('the per-enemy kinematic prefix (7 floats) matches v1 semantics', () => {
    const e = enemyV2({ dx: 300, dy: -150, vx: 2, vy: -3, hp: 75 });
    const f = buildNeuralFeaturesV2(SELF, [e], [], null, null);
    expect(f[EO]).toBe(1);
    expect(f[EO + 1]).toBeCloseTo(300 / NORM_DIST, 12);
    expect(f[EO + 2]).toBeCloseTo(-150 / NORM_DIST, 12);
    expect(f[EO + 3]).toBeCloseTo(Math.hypot(300, -150) / NORM_DIST, 12);
    expect(f[EO + 4]).toBeCloseTo(2 / NORM_VEL, 12);
    expect(f[EO + 5]).toBeCloseTo(-3 / NORM_VEL, 12);
    expect(f[EO + 6]).toBeCloseTo(75 / NORM_HP, 12);
  });

  it('teammate slot picks the nearest with present flag', () => {
    const f = buildNeuralFeaturesV2(
      SELF,
      [],
      [mate({ dx: 900 }), mate({ dx: 120, dy: -30 })],
      null,
      null,
    );
    expect(f[TO]).toBe(1);
    expect(f[TO + 1]).toBeCloseTo(120 / NORM_DIST, 12);
    expect(f[TO + 2]).toBeCloseTo(-30 / NORM_DIST, 12);
  });

  it('the bias slot (last element) is always 1', () => {
    expect(buildNeuralFeaturesV2(SELF, [], [], null, null)[FEATURE_DIM_V2 - 1]).toBe(1);
  });
});

describe('buildNeuralFeaturesV2 — v2 enemy additions', () => {
  it('per-enemy reloading flag, ammo and weapon one-hot land at offsets 7..11', () => {
    const e = enemyV2({ dx: 100, reloading: true, ammo: 6, weapon: 1 });
    const f = buildNeuralFeaturesV2(SELF, [e], [], null, null);
    expect(f[EO + 7]).toBe(1); // reloading
    expect(f[EO + 8]).toBeCloseTo(6 / NORM_AMMO, 12);
    expect(f[EO + 9]).toBe(0); // AK
    expect(f[EO + 10]).toBe(1); // SPAS
    expect(f[EO + 11]).toBe(0); // BARRETT
  });

  it('a Barrett enemy one-hots the third weapon slot', () => {
    const e = enemyV2({ dx: 100, weapon: 2 });
    const f = buildNeuralFeaturesV2(SELF, [e], [], null, null);
    expect(f.slice(EO + 9, EO + 12)).toEqual([0, 0, 1]);
  });

  it('the second-nearest enemy fills slot 1 with its own v2 fields', () => {
    const near = enemyV2({ dx: 50 });
    const far = enemyV2({ dx: 400, reloading: true, ammo: 30, weapon: 2 });
    const f = buildNeuralFeaturesV2(SELF, [far, near], [], null, null);
    const o = EO + FEATS_PER_ENEMY_V2;
    expect(f[o]).toBe(1);
    expect(f[o + 7]).toBe(1);
    expect(f[o + 8]).toBeCloseTo(1, 12);
    expect(f[o + 11]).toBe(1);
  });
});

describe('buildNeuralFeaturesV2 — own weapon one-hot', () => {
  it('one-hots AK / SPAS / BARRETT', () => {
    for (const weapon of [0, 1, 2] as const) {
      const f = buildNeuralFeaturesV2({ ...SELF, weapon }, [], [], null, null);
      const hot = [f[WO], f[WO + 1], f[WO + 2]];
      expect(hot[weapon]).toBe(1);
      expect(hot.reduce((a, b) => (a ?? 0) + (b ?? 0), 0)).toBe(1);
    }
  });
});

describe('buildNeuralFeaturesV2 — threat block', () => {
  it('null threat leaves the block all-zero (present = 0)', () => {
    const f = buildNeuralFeaturesV2(SELF, [], [], null, null);
    for (let i = BO; i < BO + FEATS_THREAT; i++) expect(f[i]).toBe(0);
  });

  it('encodes present, dx, dy, closing and tClose with their normalizers', () => {
    const threat: BulletThreat = { dx: -300, dy: 60, closing: 15, tClose: 12 };
    const f = buildNeuralFeaturesV2(SELF, [], [], threat, null);
    expect(f[BO]).toBe(1);
    expect(f[BO + 1]).toBeCloseTo(-300 / NORM_DIST, 12);
    expect(f[BO + 2]).toBeCloseTo(60 / NORM_DIST, 12);
    expect(f[BO + 3]).toBeCloseTo(15 / NORM_BULLET_VEL, 12);
    expect(f[BO + 4]).toBeCloseTo(12 / THREAT_HORIZON, 12);
  });

  it('clamps dx/dy to [-2,2], closing to [-3,3] and tClose to [0,1]', () => {
    const threat: BulletThreat = {
      dx: 99999,
      dy: -99999,
      closing: -999,
      tClose: 999,
    };
    const f = buildNeuralFeaturesV2(SELF, [], [], threat, null);
    expect(f[BO + 1]).toBe(2);
    expect(f[BO + 2]).toBe(-2);
    expect(f[BO + 3]).toBe(-3);
    expect(f[BO + 4]).toBe(1);
  });
});

describe('buildNeuralFeaturesV2 — history block', () => {
  it('null history leaves the block all-zero', () => {
    const f = buildNeuralFeaturesV2(SELF, [], [], null, null);
    for (let i = HO; i < HO + FEATS_HISTORY; i++) expect(f[i]).toBe(0);
  });

  it('carries prev velocity (normalized) and the raw aim unit vector', () => {
    const f = buildNeuralFeaturesV2(SELF, [], [], null, {
      vx: 5,
      vy: -10,
      aimUx: 0.6,
      aimUy: -0.8,
    });
    expect(f[HO]).toBeCloseTo(5 / NORM_VEL, 12);
    expect(f[HO + 1]).toBeCloseTo(-10 / NORM_VEL, 12);
    expect(f[HO + 2]).toBeCloseTo(0.6, 12);
    expect(f[HO + 3]).toBeCloseTo(-0.8, 12);
  });
});

describe('nearestBulletThreat', () => {
  const bullet = (over: Partial<RelativeBullet>): RelativeBullet => ({
    rx: 0,
    ry: 0,
    vx: 0,
    vy: 0,
    ...over,
  });

  it('returns null for no bullets and for stationary bullets (v² < 1e-6)', () => {
    expect(nearestBulletThreat([])).toBeNull();
    expect(nearestBulletThreat([bullet({ rx: -10, ry: 0 })])).toBeNull();
    expect(
      nearestBulletThreat([bullet({ rx: -10, vx: 1e-4, vy: 1e-4 })]),
    ).toBeNull();
  });

  it('reports an incoming bullet with exact closing speed and tClose', () => {
    // 100 px to the left, flying straight at me at 10 px/tick.
    const t = nearestBulletThreat([bullet({ rx: -100, vx: 10 })]);
    expect(t).not.toBeNull();
    expect(t?.dx).toBe(-100);
    expect(t?.dy).toBe(0);
    expect(t?.closing).toBeCloseTo(10, 12); // -(r·v)/|r| = 1000/100
    expect(t?.tClose).toBeCloseTo(10, 12); // closest approach in 10 ticks
  });

  it('ignores bullets flying AWAY (tStar <= 0)', () => {
    expect(nearestBulletThreat([bullet({ rx: 100, vx: 10 })])).toBeNull();
    // Exactly perpendicular start at closest approach: tStar = 0 → excluded.
    expect(nearestBulletThreat([bullet({ rx: 0, ry: 50, vx: 10 })])).toBeNull();
  });

  it('ignores bullets whose closest approach is beyond THREAT_HORIZON', () => {
    // 400 px away at 10 px/tick → tStar 40 > 30.
    expect(nearestBulletThreat([bullet({ rx: -400, vx: 10 })])).toBeNull();
    // Exactly at the horizon qualifies (tStar <= THREAT_HORIZON).
    const edge = nearestBulletThreat([
      bullet({ rx: -10 * THREAT_HORIZON, vx: 10 }),
    ]);
    expect(edge?.tClose).toBeCloseTo(THREAT_HORIZON, 12);
  });

  it('picks the bullet with the smallest miss distance, not the nearest one', () => {
    const grazer = bullet({ rx: -100, ry: 50, vx: 10 }); // misses by 50
    const direct = bullet({ rx: -200, ry: 5, vx: 10 }); // misses by 5
    const t = nearestBulletThreat([grazer, direct]);
    expect(t?.dx).toBe(-200);
    expect(t?.dy).toBe(5);
  });

  it('breaks exact miss ties toward the FIRST bullet (strict <)', () => {
    const first = bullet({ rx: -100, ry: 20, vx: 10 });
    const second = bullet({ rx: -150, ry: 20, vx: 10 }); // same 20 px miss
    const t = nearestBulletThreat([first, second]);
    expect(t?.dx).toBe(-100);
  });

  it('falls back to bullet speed for the closing rate when r is degenerate', () => {
    // r ≈ 0 (below the 1e-6 guard) but receding-into-approaching sign makes
    // tStar positive: closing reports √(v²) instead of dividing by ~0.
    const t = nearestBulletThreat([bullet({ rx: 1e-9, vx: -10 })]);
    expect(t?.closing).toBeCloseTo(10, 9);
  });
});
