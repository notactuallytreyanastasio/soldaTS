/**
 * Tests for the shared Vec2 API (`TVector2` port, shared/Vector.pas).
 *
 * Plain f64 (STRICT_F32 off): we assert algebraic correctness, argument
 * preservation (functions are pure — no mutation of inputs), and the
 * documented zero-vector behavior of normalize.
 */
import { describe, it, expect } from 'vitest';
import {
  vec2,
  clone,
  add,
  sub,
  scale,
  dot,
  lengthSq,
  length,
  normalize,
} from './vec2';

describe('vec2 constructor', () => {
  it('defaults to the zero vector', () => {
    expect(vec2()).toEqual({ x: 0, y: 0 });
  });

  it('stores the given components', () => {
    expect(vec2(3, -4)).toEqual({ x: 3, y: -4 });
  });

  it('returns a fresh object on every call (no shared zero singleton)', () => {
    const a = vec2();
    const b = vec2();
    expect(a).not.toBe(b);
    a.x = 7;
    expect(b.x).toBe(0);
  });
});

describe('clone', () => {
  it('produces an equal but independent copy (no aliasing)', () => {
    const a = vec2(1, 2);
    const c = clone(a);
    expect(c).toEqual(a);
    expect(c).not.toBe(a);
    c.x = 99;
    expect(a.x).toBe(1);
  });
});

describe('add / sub', () => {
  it('adds component-wise', () => {
    expect(add(vec2(1, 2), vec2(3, 4))).toEqual({ x: 4, y: 6 });
  });

  it('subtracts component-wise', () => {
    expect(sub(vec2(5, 7), vec2(2, 10))).toEqual({ x: 3, y: -3 });
  });

  it('keeps components independent (x never bleeds into y)', () => {
    expect(add(vec2(1, 0), vec2(0, 2))).toEqual({ x: 1, y: 2 });
    expect(sub(vec2(1, 0), vec2(0, 2))).toEqual({ x: 1, y: -2 });
  });

  it('sub(a, a) is the zero vector', () => {
    const a = vec2(3.5, -7.25);
    expect(sub(a, a)).toEqual({ x: 0, y: 0 });
  });

  it('does not mutate its arguments', () => {
    const a = vec2(1, 2);
    const b = vec2(3, 4);
    add(a, b);
    sub(a, b);
    expect(a).toEqual({ x: 1, y: 2 });
    expect(b).toEqual({ x: 3, y: 4 });
  });
});

describe('scale', () => {
  it('scales both components', () => {
    expect(scale(vec2(2, -3), 2)).toEqual({ x: 4, y: -6 });
  });

  it('scale by 0 yields the zero vector', () => {
    expect(scale(vec2(123.456, -789), 0)).toEqual({ x: 0, y: -0 });
    // -0 === 0 numerically; collision math compares magnitudes, not signs.
    expect(scale(vec2(1, 1), 0).y).toBe(0);
  });

  it('scale by -1 negates', () => {
    expect(scale(vec2(3, -4), -1)).toEqual({ x: -3, y: 4 });
  });

  it('does not mutate its argument', () => {
    const a = vec2(1, 2);
    scale(a, 10);
    expect(a).toEqual({ x: 1, y: 2 });
  });
});

describe('dot', () => {
  it('is 0 for perpendicular vectors', () => {
    expect(dot(vec2(1, 0), vec2(0, 1))).toBe(0);
    expect(dot(vec2(3, 4), vec2(-4, 3))).toBeCloseTo(0, 10);
  });

  it('equals the product of lengths for parallel vectors', () => {
    const a = vec2(3, 4); // length 5
    const b = vec2(6, 8); // length 10
    expect(dot(a, b)).toBeCloseTo(50, 10);
  });

  it('is negative the product of lengths for anti-parallel vectors', () => {
    expect(dot(vec2(3, 4), vec2(-3, -4))).toBeCloseTo(-25, 10);
  });

  it('is commutative', () => {
    const a = vec2(1.5, -2.5);
    const b = vec2(-7, 0.25);
    expect(dot(a, b)).toBe(dot(b, a));
  });
});

describe('length / lengthSq', () => {
  it('zero vector has length and lengthSq 0', () => {
    expect(length(vec2())).toBe(0);
    expect(lengthSq(vec2())).toBe(0);
  });

  it('matches the manual sqrt(x^2 + y^2) calculation', () => {
    const a = vec2(3, 4);
    expect(length(a)).toBe(5);
    expect(lengthSq(a)).toBe(25);
    const b = vec2(-1.5, 2.5);
    expect(length(b)).toBeCloseTo(Math.sqrt(1.5 * 1.5 + 2.5 * 2.5), 10);
  });

  it('lengthSq(a) === length(a)^2 (within f64 precision)', () => {
    const a = vec2(7.25, -0.5);
    expect(lengthSq(a)).toBeCloseTo(length(a) * length(a), 10);
  });

  it('is sign-independent', () => {
    expect(length(vec2(-3, -4))).toBe(5);
  });
});

describe('normalize', () => {
  it('maps the zero vector to (0, 0) — documented contract', () => {
    expect(normalize(vec2())).toEqual({ x: 0, y: 0 });
  });

  it('returns approximately the same vector for an already-unit vector', () => {
    const u = vec2(Math.SQRT1_2, Math.SQRT1_2);
    const n = normalize(u);
    expect(n.x).toBeCloseTo(u.x, 10);
    expect(n.y).toBeCloseTo(u.y, 10);
  });

  it('produces a unit-length vector preserving direction', () => {
    const n = normalize(vec2(3, 4));
    expect(n.x).toBeCloseTo(0.6, 10);
    expect(n.y).toBeCloseTo(0.8, 10);
    expect(length(n)).toBeCloseTo(1, 10);
  });

  it('handles very small (subnormal-adjacent) vectors without blowing up', () => {
    const n = normalize(vec2(1e-150, 0));
    expect(n.x).toBeCloseTo(1, 10);
    expect(n.y).toBe(0);
  });

  it('does not mutate its argument', () => {
    const a = vec2(3, 4);
    normalize(a);
    expect(a).toEqual({ x: 3, y: 4 });
  });

  // Defensive documentation of current behavior with non-finite inputs. The sim
  // should never feed these, but if it does the results are NOT sanitized:
  it('NaN components fall into the zero-vector branch (length NaN is not > 0)', () => {
    expect(normalize(vec2(NaN, 0))).toEqual({ x: 0, y: 0 });
  });

  it('Infinity components produce NaN (1/Infinity * Infinity)', () => {
    const n = normalize(vec2(Infinity, 0));
    expect(Number.isNaN(n.x)).toBe(true);
    expect(n.y).toBe(0);
  });
});
