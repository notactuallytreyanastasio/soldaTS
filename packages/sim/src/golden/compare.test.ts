/**
 * compareTraces unit tests on hand-built traces (no simulation involved).
 *
 * Focus: structural divergence detection (frame counts, tick numbers,
 * particle-set mismatches in BOTH directions), epsilon boundaries, the
 * firstDivergenceTick / maxDelta reporting contract, and the review-flagged
 * equal-length-different-ids case.
 */
import { describe, it, expect } from 'vitest';
import { compareTraces } from './compare';
import type { GoldenTrace, GoldenFrame, GoldenParticle } from './trace';

function part(i: number, x = 0, y = 0, vx = 0, vy = 0): GoldenParticle {
  return { i, x, y, vx, vy };
}

function frame(tick: number, particles: GoldenParticle[]): GoldenFrame {
  return { tick, particles };
}

function trace(frames: GoldenFrame[]): GoldenTrace {
  return { tickRate: 60, scenario: 'unit', frames };
}

describe('compareTraces — matching traces', () => {
  it('identical traces match with zero maxDelta', () => {
    const a = trace([frame(0, [part(1, 1, 2, 3, 4)]), frame(1, [part(1, 5, 6, 7, 8)])]);
    const b = trace([frame(0, [part(1, 1, 2, 3, 4)]), frame(1, [part(1, 5, 6, 7, 8)])]);
    const r = compareTraces(a, b, 0);
    expect(r.match).toBe(true);
    expect(r.firstDivergenceTick).toBeNull();
    expect(r.maxDelta).toBe(0);
  });

  it('two zero-frame traces match', () => {
    const r = compareTraces(trace([]), trace([]), 0);
    expect(r.match).toBe(true);
    expect(r.firstDivergenceTick).toBeNull();
    expect(r.maxDelta).toBe(0);
  });

  it('frames with zero particles in both traces match', () => {
    const a = trace([frame(0, []), frame(1, [])]);
    const b = trace([frame(0, []), frame(1, [])]);
    const r = compareTraces(a, b, 0);
    expect(r.match).toBe(true);
    expect(r.maxDelta).toBe(0);
  });

  it('delta exactly equal to epsilon is NOT a divergence (strict >)', () => {
    const a = trace([frame(0, [part(1, 0, 0)])]);
    const b = trace([frame(0, [part(1, 0.5, 0)])]);
    const r = compareTraces(a, b, 0.5);
    expect(r.match).toBe(true);
    expect(r.firstDivergenceTick).toBeNull();
    // maxDelta still reports the observed delta even when within epsilon.
    expect(r.maxDelta).toBe(0.5);
  });
});

describe('compareTraces — structural divergence', () => {
  it('equal particle counts but different ids ARE detected (a -> b direction)', () => {
    // Review-flagged scenario: frame A has [1,3], frame B has [2,3]. The b-side
    // scan is gated on a length mismatch, but the a -> b loop already catches
    // particle 1 missing from B, so this case IS reported as divergent.
    const a = trace([frame(0, [part(1), part(3)])]);
    const b = trace([frame(0, [part(2), part(3)])]);
    const r = compareTraces(a, b, 1e-6);
    expect(r.match).toBe(false);
    expect(r.firstDivergenceTick).toBe(0);
    expect(r.maxDelta).toBe(Number.POSITIVE_INFINITY);
  });

  it('equal particle counts but different ids ARE detected (swapped args)', () => {
    const a = trace([frame(0, [part(2), part(3)])]);
    const b = trace([frame(0, [part(1), part(3)])]);
    const r = compareTraces(a, b, 1e-6);
    expect(r.match).toBe(false);
    expect(r.firstDivergenceTick).toBe(0);
    expect(r.maxDelta).toBe(Number.POSITIVE_INFINITY);
  });

  it('SUSPECT: duplicate ids in frame A can mask a b-only particle', () => {
    // The "present-in-b but missing-in-a" scan only runs when the particle
    // COUNTS differ (compare.ts:107). snapshotFrame can never emit duplicate
    // ids, but for out-of-contract input with duplicates the counts match,
    // every a-particle resolves in B, and B's extra particle 2 goes
    // undetected: compareTraces reports match=true for structurally different
    // particle sets. Pinning the CURRENT behaviour, not endorsing it.
    const a = trace([frame(0, [part(3), part(3)])]);
    const b = trace([frame(0, [part(2), part(3)])]);
    const r = compareTraces(a, b, 1e-6);
    expect(r.match).toBe(true); // suspect: B's particle 2 is invisible here
    expect(r.firstDivergenceTick).toBeNull();
  });

  it('particle appearing mid-trace (absent -> present) diverges at that tick', () => {
    const a = trace([frame(0, [part(1)]), frame(1, [part(1)]), frame(2, [part(1)])]);
    const b = trace([
      frame(0, [part(1)]),
      frame(1, [part(1)]),
      frame(2, [part(1), part(2)]), // particle 2 appears only in B
    ]);
    const r = compareTraces(a, b, 1e-6);
    expect(r.match).toBe(false);
    expect(r.firstDivergenceTick).toBe(2);
    expect(r.maxDelta).toBe(Number.POSITIVE_INFINITY);
  });

  it('frame counts differing by exactly 1 diverge at the first extra frame', () => {
    const a = trace([frame(0, [part(1)]), frame(1, [part(1)])]);
    const b = trace([frame(0, [part(1)]), frame(1, [part(1)]), frame(2, [part(1)])]);
    const r = compareTraces(a, b, 1e-6);
    expect(r.match).toBe(false);
    // The divergence tick is the tick number of the first unmatched frame.
    expect(r.firstDivergenceTick).toBe(2);
    expect(r.maxDelta).toBe(Number.POSITIVE_INFINITY);
  });

  it('frame count mismatch is symmetric (shorter trace first or second)', () => {
    const short = trace([frame(0, [part(1)])]);
    const long = trace([frame(0, [part(1)]), frame(1, [part(1)])]);
    expect(compareTraces(short, long, 0).match).toBe(false);
    expect(compareTraces(long, short, 0).match).toBe(false);
    expect(compareTraces(long, short, 0).firstDivergenceTick).toBe(1);
  });

  it('mismatched tick numbers at the same frame index diverge', () => {
    const a = trace([frame(0, [part(1)]), frame(1, [part(1)])]);
    const b = trace([frame(0, [part(1)]), frame(99, [part(1)])]);
    const r = compareTraces(a, b, 1e-6);
    expect(r.match).toBe(false);
    expect(r.firstDivergenceTick).toBe(1); // reported as trace-a's tick
    expect(r.maxDelta).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('compareTraces — numeric divergence reporting', () => {
  it('divergence at frame 0 reports firstDivergenceTick 0', () => {
    const a = trace([frame(0, [part(1, 0)]), frame(1, [part(1, 0)])]);
    const b = trace([frame(0, [part(1, 10)]), frame(1, [part(1, 0)])]);
    const r = compareTraces(a, b, 1e-3);
    expect(r.match).toBe(false);
    expect(r.firstDivergenceTick).toBe(0);
    expect(r.maxDelta).toBe(10);
  });

  it('firstDivergenceTick is the EARLIEST exceedance; maxDelta the global worst', () => {
    const a = trace([
      frame(0, [part(1, 0)]),
      frame(1, [part(1, 0)]),
      frame(2, [part(1, 0)]),
      frame(3, [part(1, 0)]),
    ]);
    const b = trace([
      frame(0, [part(1, 0)]),
      frame(1, [part(1, 2)]), // delta 2 — first exceedance
      frame(2, [part(1, 0)]),
      frame(3, [part(1, 0, 7)]), // delta 7 — global worst, on y
    ]);
    const r = compareTraces(a, b, 1);
    expect(r.match).toBe(false);
    expect(r.firstDivergenceTick).toBe(1);
    expect(r.maxDelta).toBe(7);
  });

  it('maxDelta is the worst across ALL four kinematic fields', () => {
    const a = trace([frame(0, [part(1, 1, 2, 3, 4)])]);
    const b = trace([frame(0, [part(1, 1.1, 2.2, 3.3, 4 + 0.9)])]);
    const r = compareTraces(a, b, 10); // generous epsilon: no divergence...
    expect(r.match).toBe(true);
    expect(r.maxDelta).toBeCloseTo(0.9, 10); // ...but the vy delta is recorded
  });

  it('a sub-epsilon delta after the divergence does not reset the report', () => {
    const a = trace([frame(0, [part(1, 0)]), frame(1, [part(1, 0)])]);
    const b = trace([frame(0, [part(1, 5)]), frame(1, [part(1, 0)])]);
    const r = compareTraces(a, b, 1);
    expect(r.firstDivergenceTick).toBe(0);
    expect(r.match).toBe(false);
    expect(r.maxDelta).toBe(5);
  });
});
