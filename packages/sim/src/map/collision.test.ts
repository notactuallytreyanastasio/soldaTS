/**
 * M2 stand-in collision helper tests. Plain f64 (STRICT_F32 off): we assert
 * the qualitative contract of the movement-validation helpers —
 *
 *   1. flatGroundCollision boundary behaviour (at/below/above the floor,
 *      approach by velocity, the stepY friction gate vs SLIDELIMIT).
 *   2. SPRITE_COLLISION_POINTS — the four body sample points in the exact
 *      Pascal test order with their Area flags.
 *   3. segmentPointDistance — INFINITE-line semantics (not clamped to the
 *      segment), matching the ported Calc.pas PointLineDistance.
 *   4. segmentCircleCollision — first-contact selection and the
 *      inside-endpoint short circuits of Calc.pas LineCircleCollision.
 */
import { describe, it, expect } from 'vitest';
import { vec2 } from '../math/vec2';
import {
  SLIDELIMIT,
  SPRITE_COLLISION_POINTS,
  flatGroundCollision,
  segmentPointDistance,
  segmentCircleCollision,
} from './collision';

describe('flatGroundCollision', () => {
  it('particle exactly on the floor (predictedY == floorY) collides', () => {
    const r = flatGroundCollision(100, 0, 100);
    expect(r.collided).toBe(true);
    expect(r.correctedY).toBe(100);
    expect(r.stepY).toBe(1);
  });

  it('particle below the floor collides and is de-penetrated to floorY', () => {
    const r = flatGroundCollision(123.5, 0, 100);
    expect(r.collided).toBe(true);
    expect(r.correctedY).toBe(100);
  });

  it('particle above the floor with no velocity does not collide; correctedY unchanged', () => {
    const r = flatGroundCollision(50, 0, 100);
    expect(r.collided).toBe(false);
    expect(r.correctedY).toBe(50);
    expect(r.stepY).toBe(0);
  });

  it('approach: collision is tested at the PREDICTED position (posY + velY)', () => {
    // 95 + 10 = 105 >= 100 -> contact even though the current pos is above.
    const hit = flatGroundCollision(95, 10, 100);
    expect(hit.collided).toBe(true);
    expect(hit.correctedY).toBe(100);

    // 95 + 4.9 = 99.9 < 100 -> still airborne this tick.
    const miss = flatGroundCollision(95, 4.9, 100);
    expect(miss.collided).toBe(false);
    expect(miss.correctedY).toBe(95);
  });

  it('exact boundary approach: predicted lands precisely on floorY', () => {
    const r = flatGroundCollision(90, 10, 100);
    expect(r.collided).toBe(true);
    expect(r.correctedY).toBe(100);
  });

  it('upward velocity can carry a particle out of contact', () => {
    // On the floor but moving up fast enough that the prediction leaves it.
    const r = flatGroundCollision(100, -5, 100);
    expect(r.collided).toBe(false);
    expect(r.correctedY).toBe(100);
  });

  it('stepY on contact exceeds SLIDELIMIT (enables the friction branch)', () => {
    // f(0.2): exact 0.2 in f64 mode, fround(0.2) under STRICT_F32.
    expect(SLIDELIMIT).toBeCloseTo(0.2, 6);
    const r = flatGroundCollision(100, 0, 100);
    expect(r.stepY).toBeGreaterThan(SLIDELIMIT);
  });
});

describe('SPRITE_COLLISION_POINTS', () => {
  it('lists the four body points in Pascal test order: head L, head R, leg R, leg L', () => {
    expect(SPRITE_COLLISION_POINTS).toHaveLength(4);
    const [headL, headR, legR, legL] = SPRITE_COLLISION_POINTS;
    expect(headL).toMatchObject({ dx: -3.5, dy: -12, area: 1, isLeg: false });
    expect(headR).toMatchObject({ dx: 3.5, dy: -12, area: 1, isLeg: false });
    expect(legR).toMatchObject({ dx: 2, dy: 2, area: 0, isLeg: true });
    expect(legL).toMatchObject({ dx: -2, dy: 2, area: 0, isLeg: true });
  });

  it('only the leg points establish OnGround, and the array is frozen', () => {
    const legs = SPRITE_COLLISION_POINTS.filter((p) => p.isLeg);
    expect(legs).toHaveLength(2);
    for (const leg of legs) {
      expect(leg.area).toBe(0);
    }
    expect(Object.isFrozen(SPRITE_COLLISION_POINTS)).toBe(true);
  });
});

describe('segmentPointDistance', () => {
  it('point on the line has distance 0', () => {
    expect(segmentPointDistance(vec2(0, 0), vec2(10, 0), vec2(5, 0))).toBe(0);
  });

  it('point off a horizontal line returns the perpendicular distance', () => {
    expect(segmentPointDistance(vec2(0, 0), vec2(10, 0), vec2(5, 5))).toBeCloseTo(5, 10);
    expect(segmentPointDistance(vec2(0, 0), vec2(10, 0), vec2(3, -7))).toBeCloseTo(7, 10);
  });

  it('uses INFINITE-line semantics: no clamping beyond the segment endpoints', () => {
    // (20, 5) projects beyond endpoint b=(10,0); the ported Calc.pas routine
    // does not clamp, so the distance is still the perpendicular 5 (not the
    // euclidean distance to b, which would be ~11.18).
    expect(segmentPointDistance(vec2(0, 0), vec2(10, 0), vec2(20, 5))).toBeCloseTo(5, 10);
  });

  it('works for a diagonal line', () => {
    // Line y = x; point (0, 2) is sqrt(2) away.
    expect(segmentPointDistance(vec2(0, 0), vec2(10, 10), vec2(0, 2))).toBeCloseTo(
      Math.SQRT2,
      6,
    );
  });
});

describe('segmentCircleCollision', () => {
  it('returns the sweep start when it begins inside the circle', () => {
    const hit = segmentCircleCollision(vec2(1, 1), vec2(50, 50), vec2(0, 0), 5);
    expect(hit).not.toBeNull();
    expect(hit!.x).toBe(1);
    expect(hit!.y).toBe(1);
  });

  it('returns the sweep end when only the end is inside the circle', () => {
    const hit = segmentCircleCollision(vec2(50, 0), vec2(2, 0), vec2(0, 0), 5);
    expect(hit).not.toBeNull();
    expect(hit!.x).toBe(2);
    expect(hit!.y).toBe(0);
  });

  it('crossing sweep returns the intersection nearest the start', () => {
    // Sweep (-10,0) -> (10,0) through a radius-5 circle at the origin:
    // intersections at x = -5 and x = +5; first contact is x = -5.
    const hit = segmentCircleCollision(vec2(-10, 0), vec2(10, 0), vec2(0, 0), 5);
    expect(hit).not.toBeNull();
    expect(hit!.x).toBeCloseTo(-5, 6);
    expect(hit!.y).toBeCloseTo(0, 6);
  });

  it('returns null when there is no contact', () => {
    expect(segmentCircleCollision(vec2(-10, 20), vec2(10, 20), vec2(0, 0), 5)).toBeNull();
  });

  it('degenerate zero-length sweep outside the circle returns null', () => {
    expect(segmentCircleCollision(vec2(30, 30), vec2(30, 30), vec2(0, 0), 5)).toBeNull();
  });

  it('tangent line (distance exactly radius) reports the tangent point', () => {
    // y = 5 line against radius-5 circle at origin: tangent at (0, 5).
    const hit = segmentCircleCollision(vec2(-10, 5), vec2(10, 5), vec2(0, 0), 5);
    expect(hit).not.toBeNull();
    expect(hit!.x).toBeCloseTo(0, 5);
    expect(hit!.y).toBeCloseTo(5, 5);
  });
});
