// Neural feature contract v1 (neuralFeatures.ts) — the trainer/runtime shared
// observation mapping. These tests pin the layout, normalization and
// nearest-k selection EXACTLY: any drift here silently scrambles what the
// cloned policies see, so the contract is asserted slot by slot.

import { describe, it, expect } from 'vitest';
import {
  buildNeuralFeatures,
  BUTTON_HEADS,
  ENEMY_SLOTS,
  FEATS_PER_ENEMY,
  FEATS_SELF,
  FEATS_TEAMMATE,
  FEATURE_DIM,
  NORM_AMMO,
  NORM_DIST,
  NORM_FUEL,
  NORM_HP,
  NORM_VEL,
  OUTPUT_DIM,
  type NeuralContact,
  type NeuralSelf,
} from './neuralFeatures';

const SELF: NeuralSelf = {
  vx: 0,
  vy: 0,
  fuel: 0,
  hp: 0,
  ammo: 0,
  reloading: false,
  onGround: false,
};

const contact = (over: Partial<NeuralContact>): NeuralContact => ({
  dx: 0,
  dy: 0,
  vx: 0,
  vy: 0,
  hp: 0,
  ...over,
});

describe('layout constants', () => {
  it('FEATURE_DIM is 25 = 7 self + 2*7 enemies + 3 teammate + bias', () => {
    expect(FEATURE_DIM).toBe(
      FEATS_SELF + ENEMY_SLOTS * FEATS_PER_ENEMY + FEATS_TEAMMATE + 1,
    );
    expect(FEATURE_DIM).toBe(25);
  });

  it('OUTPUT_DIM is the 7 button heads plus the aim unit vector', () => {
    expect(BUTTON_HEADS).toEqual([
      'left',
      'right',
      'up',
      'down',
      'fire',
      'jetpack',
      'reload',
    ]);
    expect(OUTPUT_DIM).toBe(9);
  });
});

describe('buildNeuralFeatures — self block', () => {
  it('returns exactly FEATURE_DIM elements', () => {
    expect(buildNeuralFeatures(SELF, [], [])).toHaveLength(FEATURE_DIM);
  });

  it('normalizes velocity, fuel, hp and ammo by their constants', () => {
    const f = buildNeuralFeatures(
      { vx: 5, vy: -10, fuel: 350, hp: 75, ammo: 15, reloading: false, onGround: false },
      [],
      [],
    );
    expect(f[0]).toBeCloseTo(5 / NORM_VEL, 12);
    expect(f[1]).toBeCloseTo(-10 / NORM_VEL, 12);
    expect(f[2]).toBeCloseTo(350 / NORM_FUEL, 12);
    expect(f[3]).toBeCloseTo(75 / NORM_HP, 12);
    expect(f[4]).toBeCloseTo(15 / NORM_AMMO, 12);
  });

  it('encodes the reloading and onGround booleans as 0/1', () => {
    const off = buildNeuralFeatures(SELF, [], []);
    expect(off[5]).toBe(0);
    expect(off[6]).toBe(0);
    const on = buildNeuralFeatures(
      { ...SELF, reloading: true, onGround: true },
      [],
      [],
    );
    expect(on[5]).toBe(1);
    expect(on[6]).toBe(1);
  });

  it('the bias slot (last element) is always 1', () => {
    expect(buildNeuralFeatures(SELF, [], [])[FEATURE_DIM - 1]).toBe(1);
    const e = contact({ dx: 100 });
    expect(buildNeuralFeatures(SELF, [e, e], [e])[FEATURE_DIM - 1]).toBe(1);
  });
});

describe('buildNeuralFeatures — enemy slots', () => {
  it('with no enemies both slots stay all-zero (present = 0)', () => {
    const f = buildNeuralFeatures(SELF, [], []);
    for (let i = FEATS_SELF; i < FEATS_SELF + ENEMY_SLOTS * FEATS_PER_ENEMY; i++) {
      expect(f[i]).toBe(0);
    }
  });

  it('one enemy fills slot 0 (present, dx, dy, dist, vx, vy, hp) and leaves slot 1 zero', () => {
    const f = buildNeuralFeatures(
      SELF,
      [contact({ dx: 300, dy: -150, vx: 2, vy: -3, hp: 75 })],
      [],
    );
    const o = FEATS_SELF;
    expect(f[o]).toBe(1);
    expect(f[o + 1]).toBeCloseTo(300 / NORM_DIST, 12);
    expect(f[o + 2]).toBeCloseTo(-150 / NORM_DIST, 12);
    expect(f[o + 3]).toBeCloseTo(Math.hypot(300, -150) / NORM_DIST, 12);
    expect(f[o + 4]).toBeCloseTo(2 / NORM_VEL, 12);
    expect(f[o + 5]).toBeCloseTo(-3 / NORM_VEL, 12);
    expect(f[o + 6]).toBeCloseTo(75 / NORM_HP, 12);
    for (let i = o + FEATS_PER_ENEMY; i < o + 2 * FEATS_PER_ENEMY; i++) {
      expect(f[i]).toBe(0);
    }
  });

  it('clamps dx/dy to [-2, 2] and caps dist at 1', () => {
    const f = buildNeuralFeatures(
      SELF,
      [contact({ dx: 5000, dy: -5000 })],
      [],
    );
    const o = FEATS_SELF;
    expect(f[o + 1]).toBe(2);
    expect(f[o + 2]).toBe(-2);
    expect(f[o + 3]).toBe(1); // min(hypot, NORM_DIST)/NORM_DIST
  });

  it('with 3+ enemies picks the 2 NEAREST by relative distance', () => {
    const near = contact({ dx: 50, hp: 10 });
    const mid = contact({ dx: -200, hp: 20 });
    const far = contact({ dx: 590, hp: 30 });
    // Caller order is scrambled on purpose; selection must re-rank.
    const f = buildNeuralFeatures(SELF, [far, near, mid], []);
    const o = FEATS_SELF;
    expect(f[o + 6]).toBeCloseTo(10 / NORM_HP, 12); // slot 0 = nearest
    expect(f[o + FEATS_PER_ENEMY + 6]).toBeCloseTo(20 / NORM_HP, 12); // slot 1
    // far's hp (30/150 = 0.2) must appear nowhere in the enemy block.
    for (let i = o; i < o + 2 * FEATS_PER_ENEMY; i++) {
      expect(f[i]).not.toBeCloseTo(30 / NORM_HP, 12);
    }
  });

  it('distance ties keep the caller order (stable sort)', () => {
    const a = contact({ dx: 100, hp: 30 });
    const b = contact({ dx: -100, hp: 60 }); // same squared distance
    const f = buildNeuralFeatures(SELF, [a, b], []);
    expect(f[FEATS_SELF + 6]).toBeCloseTo(30 / NORM_HP, 12);
    expect(f[FEATS_SELF + FEATS_PER_ENEMY + 6]).toBeCloseTo(60 / NORM_HP, 12);
  });

  it('does not mutate the caller arrays (sorts a copy)', () => {
    const enemies = Object.freeze([
      contact({ dx: 500 }),
      contact({ dx: 10 }),
    ]) as readonly NeuralContact[];
    const teammates = Object.freeze([contact({ dx: 9 })]) as readonly NeuralContact[];
    expect(() => buildNeuralFeatures(SELF, enemies, teammates)).not.toThrow();
    expect(enemies[0]?.dx).toBe(500); // order untouched
  });
});

describe('buildNeuralFeatures — teammate slot', () => {
  const TO = FEATS_SELF + ENEMY_SLOTS * FEATS_PER_ENEMY;

  it('absent teammate leaves the slot all-zero', () => {
    const f = buildNeuralFeatures(SELF, [], []);
    expect(f[TO]).toBe(0);
    expect(f[TO + 1]).toBe(0);
    expect(f[TO + 2]).toBe(0);
  });

  it('picks the single NEAREST teammate with present flag 1 and clamped dx/dy', () => {
    const f = buildNeuralFeatures(
      SELF,
      [],
      [contact({ dx: 5000, dy: 60 }), contact({ dx: 120, dy: -30 })],
    );
    expect(f[TO]).toBe(1);
    expect(f[TO + 1]).toBeCloseTo(120 / NORM_DIST, 12);
    expect(f[TO + 2]).toBeCloseTo(-30 / NORM_DIST, 12);
  });
});
