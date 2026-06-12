/**
 * snapshotFrame unit tests — the golden-master recording primitive.
 *
 * Covers: empty systems, field capture, the ascending-id ordering guarantee,
 * inactive-slot skipping (even when the slot holds stale data), the recorded
 * tick number, and exactness against the Float32Array storage boundary.
 */
import { describe, it, expect } from 'vitest';
import { ParticleSystem } from '../physics/particles';
import { vec2 } from '../math/vec2';
import { NUM_PARTICLES } from '../constants';
import { snapshotFrame } from './trace';

describe('snapshotFrame', () => {
  it('returns an empty particles array for a system with no active particles', () => {
    const sys = new ParticleSystem();
    const f0 = snapshotFrame(sys, 0);
    expect(f0.tick).toBe(0);
    expect(f0.particles).toEqual([]);
  });

  it('captures all four kinematic fields of one active particle', () => {
    const sys = new ParticleSystem();
    sys.createPart(vec2(1.5, -2.5), vec2(0.25, 4), 1, 7);
    const f0 = snapshotFrame(sys, 3);
    expect(f0.particles).toHaveLength(1);
    const p = f0.particles[0]!;
    expect(p.i).toBe(7);
    expect(p.x).toBe(1.5);
    expect(p.y).toBe(-2.5);
    expect(p.vx).toBe(0.25);
    expect(p.vy).toBe(4);
  });

  it('records the tick parameter verbatim', () => {
    const sys = new ParticleSystem();
    expect(snapshotFrame(sys, 0).tick).toBe(0);
    expect(snapshotFrame(sys, 599).tick).toBe(599);
  });

  it('lists particles in ascending id order regardless of activation order', () => {
    const sys = new ParticleSystem();
    // Activate out of order: 9, 2, 5, and the last valid slot.
    sys.createPart(vec2(9, 0), vec2(), 1, 9);
    sys.createPart(vec2(2, 0), vec2(), 1, 2);
    sys.createPart(vec2(5, 0), vec2(), 1, 5);
    sys.createPart(vec2(560, 0), vec2(), 1, NUM_PARTICLES);

    const ids = snapshotFrame(sys, 0).particles.map((p) => p.i);
    expect(ids).toEqual([2, 5, 9, NUM_PARTICLES]);
    // And the positions ride along with their ids.
    const xs = snapshotFrame(sys, 0).particles.map((p) => p.x);
    expect(xs).toEqual([2, 5, 9, 560]);
  });

  it('skips inactive particles even when their array slots hold stale data', () => {
    const sys = new ParticleSystem();
    sys.createPart(vec2(1, 1), vec2(), 1, 3);
    // Stale data in an INACTIVE slot must not leak into the frame.
    sys.posX[4] = 123;
    sys.posY[4] = 456;
    sys.velocityX[4] = 7;
    expect(sys.active[4]).toBe(false);

    const f0 = snapshotFrame(sys, 0);
    expect(f0.particles).toHaveLength(1);
    expect(f0.particles[0]!.i).toBe(3);
  });

  it('a deactivated particle disappears from subsequent frames', () => {
    const sys = new ParticleSystem();
    sys.createPart(vec2(1, 1), vec2(), 1, 1);
    sys.createPart(vec2(2, 2), vec2(), 1, 2);
    expect(snapshotFrame(sys, 0).particles.map((p) => p.i)).toEqual([1, 2]);

    sys.active[1] = false;
    expect(snapshotFrame(sys, 1).particles.map((p) => p.i)).toEqual([2]);
  });

  it('reads back the exact f32 values from the Float32Array storage', () => {
    const sys = new ParticleSystem();
    sys.createPart(vec2(0.1, 0.2), vec2(0.3, 0.7), 1, 1);

    const p = snapshotFrame(sys, 0).particles[0]!;
    // Positions/velocities live in Float32Array, so the snapshot is the
    // f32-rounded value — bit-for-bit, no extra loss on top of the storage.
    expect(p.x).toBe(Math.fround(0.1));
    expect(p.y).toBe(Math.fround(0.2));
    expect(p.vx).toBe(Math.fround(0.3));
    expect(p.vy).toBe(Math.fround(0.7));
    // Sanity: f32 of 0.1 is NOT the f64 literal — the boundary is real.
    expect(p.x).not.toBe(0.1);
  });

  it('the frame is a plain JSON-serializable structure', () => {
    const sys = new ParticleSystem();
    sys.createPart(vec2(1, 2), vec2(3, 4), 1, 1);
    const f0 = snapshotFrame(sys, 5);
    const roundTripped = JSON.parse(JSON.stringify(f0)) as typeof f0;
    expect(roundTripped).toEqual(f0);
  });
});
