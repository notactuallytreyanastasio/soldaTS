/**
 * Edge-case characterization tests for calc.ts helpers flagged in review.
 *
 * These pin CURRENT behavior on degenerate inputs — they do not bless it.
 * Kept separate from calc.test.ts (table-driven happy paths) so the suspect
 * cases are easy to find and to flip if/when the helpers gain guards.
 */
import { describe, it, expect } from 'vitest';
import { vec2 } from './vec2';
import { pointLineDistance, isLineIntersectingCircle, greaterPowerOf2 } from './calc';

describe('pointLineDistance — degenerate line (P1 === P2)', () => {
  // SUSPECT BEHAVIOR: when the line endpoints coincide, the denominator
  // (dx^2 + dy^2) is 0 and the numerator is also 0 (both terms multiply by
  // dx/dy), so u = 0/0 = NaN and NaN propagates to the result. The Pascal
  // original has the same hole; isLineIntersectingCircle (same module) guards
  // degenerate lines explicitly, this function does not. Callers in
  // polymap.ts closestPerpendicular would see NaN edge distances for maps
  // with duplicate polygon vertices.
  it('returns NaN when P3 is away from the degenerate point (current behavior)', () => {
    const d = pointLineDistance(vec2(1, 1), vec2(1, 1), vec2(5, 5));
    expect(Number.isNaN(d)).toBe(true);
  });

  it('returns NaN even when P3 coincides with the degenerate point (current behavior)', () => {
    const d = pointLineDistance(vec2(1, 1), vec2(1, 1), vec2(1, 1));
    expect(Number.isNaN(d)).toBe(true);
  });

  it('NaN result poisons distance comparisons (why this matters for collision)', () => {
    const d = pointLineDistance(vec2(1, 1), vec2(1, 1), vec2(5, 5));
    // Every comparison against NaN is false — a "closest edge" scan that
    // compares with < or > silently skips or always keeps such an edge.
    expect(d < 1e9).toBe(false);
    expect(d > 0).toBe(false);
  });

  it('contrast: isLineIntersectingCircle DOES guard the degenerate line', () => {
    const r = isLineIntersectingCircle(vec2(1, 1), vec2(1, 1), vec2(1, 1), 5);
    expect(r.numIntersections).toBe(0);
  });
});

describe('greaterPowerOf2 — non-positive and fractional inputs', () => {
  // SUSPECT BEHAVIOR: no n > 0 guard before Math.log2(n).
  it('returns 0 for n = 0 (log2(0) = -Infinity, 2^-Infinity = 0) — current behavior', () => {
    expect(greaterPowerOf2(0)).toBe(0);
  });

  it('returns NaN for negative n (log2 of a negative is NaN) — current behavior', () => {
    expect(Number.isNaN(greaterPowerOf2(-4))).toBe(true);
  });

  it('returns 0 for fractional n < 1 after trunc (e.g. 0.5 -> 2^-1 -> 0) — current behavior', () => {
    expect(greaterPowerOf2(0.5)).toBe(0);
  });

  it('still behaves for the valid texture-sizing domain (regression anchor)', () => {
    expect(greaterPowerOf2(1)).toBe(1);
    expect(greaterPowerOf2(1023)).toBe(1024);
    expect(greaterPowerOf2(1024)).toBe(1024);
    expect(greaterPowerOf2(1025)).toBe(2048);
  });
});
