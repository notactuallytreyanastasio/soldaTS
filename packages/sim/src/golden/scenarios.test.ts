/**
 * Reference-scenario tests (complementing golden.test.ts, which pins free fall
 * bit-for-bit over 600 ticks).
 *
 * Here we assert the SHAPE of each scenario's physics over short runs:
 *   - free fall: closed-form v_n = n*g and y_n = g*n*(n+1)/2 with eDamping 1,
 *     purely vertical motion, fixed trace metadata.
 *   - twoParticleConstraint: the infinite-mass anchor never moves, the hanging
 *     particle stays on the vertical through the anchor, the early ticks match
 *     a hand-computed reference, and the constraint visibly restrains the fall
 *     versus an unconstrained free-faller.
 */
import { describe, it, expect } from 'vitest';
import { f32, STRICT_F32 } from '../scalar';
import { freeFallScenario, twoParticleConstraint, FREEFALL_GRAVITY } from './scenarios';

const g = FREEFALL_GRAVITY;

describe('freeFallScenario', () => {
  const TICKS = 50;

  it('produces velocities matching v_n = n*g (gravity accumulation)', () => {
    const trace = freeFallScenario(TICKS).run();
    const tol = STRICT_F32 ? 1e-3 : 1e-9;
    for (let n = 0; n <= TICKS; n++) {
      const p = trace.frames[n]!.particles[0]!;
      expect(Math.abs(p.vy - n * g)).toBeLessThan(tol + Math.abs(n * g) * 1e-5);
    }
  });

  it('produces positions matching the closed form y_n = g*n*(n+1)/2', () => {
    const trace = freeFallScenario(TICKS).run();
    const tol = STRICT_F32 ? 1e-2 : 1e-9;
    for (let n = 0; n <= TICKS; n++) {
      const p = trace.frames[n]!.particles[0]!;
      const yClosed = (g * n * (n + 1)) / 2;
      expect(Math.abs(p.y - yClosed)).toBeLessThan(tol + Math.abs(yClosed) * 1e-5);
    }
  });

  it('identity damping keeps the exact iterative recurrence (f32 storage)', () => {
    const trace = freeFallScenario(TICKS).run();
    let vRef = 0;
    let yRef = 0;
    for (let n = 0; n <= TICKS; n++) {
      const p = trace.frames[n]!.particles[0]!;
      expect(p.vy).toBe(vRef);
      expect(p.y).toBe(yRef);
      vRef = f32(vRef + g);
      yRef = f32(yRef + vRef);
    }
  });

  it('motion is purely vertical and the trace metadata is fixed', () => {
    const trace = freeFallScenario(TICKS).run();
    expect(trace.scenario).toBe('freeFall');
    expect(trace.tickRate).toBe(60);
    expect(trace.frames).toHaveLength(TICKS + 1);
    for (const frame of trace.frames) {
      expect(frame.particles).toHaveLength(1);
      const p = frame.particles[0]!;
      expect(p.i).toBe(1);
      expect(p.x).toBe(0);
      expect(p.vx).toBe(0);
    }
  });
});

describe('twoParticleConstraint', () => {
  const TICKS = 100;
  const REST = 10; // restLength baked into the scenario

  it('keeps the anchor (particle 1, oneOverMass = 0) pinned at the origin', () => {
    const trace = twoParticleConstraint(TICKS).run();
    for (const frame of trace.frames) {
      const anchor = frame.particles.find((p) => p.i === 1);
      expect(anchor).toBeDefined();
      expect(anchor!.x).toBe(0);
      expect(anchor!.y).toBe(0);
      expect(anchor!.vx).toBe(0);
      expect(anchor!.vy).toBe(0);
    }
  });

  it('records exactly two particles per frame with the expected initial layout', () => {
    const trace = twoParticleConstraint(TICKS).run();
    expect(trace.scenario).toBe('twoParticleConstraint');
    for (const frame of trace.frames) {
      expect(frame.particles.map((p) => p.i)).toEqual([1, 2]);
    }
    const hanging0 = trace.frames[0]!.particles[1]!;
    expect(hanging0.x).toBe(0);
    expect(hanging0.y).toBe(REST);
  });

  it('the hanging particle stays on the vertical through the anchor', () => {
    const trace = twoParticleConstraint(TICKS).run();
    for (const frame of trace.frames) {
      const hanging = frame.particles[1]!;
      expect(hanging.x).toBe(0);
      expect(hanging.vx).toBe(0);
      // Always at or below the rest separation (gravity stretches, the solver
      // pulls back toward REST but frames are recorded post-integration).
      expect(hanging.y).toBeGreaterThanOrEqual(REST);
    }
  });

  it('early ticks match the hand-computed integrate-then-constrain sequence', () => {
    const trace = twoParticleConstraint(TICKS).run();
    // Tick 1: constraint is exactly satisfied (distance REST, diff 0), then the
    // Euler step adds vy = g and y = REST + g.
    const p1 = trace.frames[1]!.particles[1]!;
    expect(p1.vy).toBeCloseTo(g, 6);
    expect(p1.y).toBeCloseTo(REST + g, 6);

    // Tick 2: control halves the excess (only particle 2 is movable, and the
    // solver applies 0.5 * diff to it), then integrates vy = 2g.
    const y1 = REST + g;
    const diff = (y1 - REST) / y1;
    const yAfterSolve = y1 - y1 * (0.5 * diff); // = y1 - 0.5 * (y1 - REST)
    const p2 = trace.frames[2]!.particles[1]!;
    expect(p2.vy).toBeCloseTo(2 * g, 6);
    expect(p2.y).toBeCloseTo(yAfterSolve + 2 * g, 5);
  });

  it('the constraint visibly restrains the fall versus free fall', () => {
    const constrained = twoParticleConstraint(TICKS).run();
    const hangingFinal = constrained.frames[TICKS]!.particles[1]!.y;

    // Unconstrained free fall from the same start would be REST + g*n(n+1)/2.
    const freeFallY = REST + (g * TICKS * (TICKS + 1)) / 2;
    expect(hangingFinal).toBeLessThan(freeFallY / 2);
    // But it IS stretched beyond the rest length (velocity keeps accumulating).
    expect(hangingFinal).toBeGreaterThan(REST);
  });
});
