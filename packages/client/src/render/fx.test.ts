import { describe, it, expect } from 'vitest';
import {
  tracerTail,
  spawnBloodBurst,
  updateBloodParticles,
  BLOOD_GRAVITY,
  type BloodParticle,
} from './fx';

describe('tracerTail', () => {
  it('places the tip at the bullet position', () => {
    const seg = tracerTail(100, 50, 10, 0, 20);
    expect(seg.tipX).toBe(100);
    expect(seg.tipY).toBe(50);
  });

  it('extends the tail back along +x velocity', () => {
    // Moving right at unit-ish speed; tail sits `len` behind the tip.
    const seg = tracerTail(100, 50, 5, 0, 20);
    expect(seg.tailX).toBeCloseTo(80, 6);
    expect(seg.tailY).toBeCloseTo(50, 6);
  });

  it('extends the tail back along -y velocity (y is down)', () => {
    const seg = tracerTail(0, 0, 0, -3, 12);
    // Velocity is upward (-y); tail is downward (+y) from the tip.
    expect(seg.tailX).toBeCloseTo(0, 6);
    expect(seg.tailY).toBeCloseTo(12, 6);
  });

  it('normalizes diagonal velocity so tail length equals len', () => {
    const seg = tracerTail(0, 0, 3, 4, 10); // |v| = 5
    const dx = seg.tipX - seg.tailX;
    const dy = seg.tipY - seg.tailY;
    expect(Math.hypot(dx, dy)).toBeCloseTo(10, 6);
    // Direction opposite the (0.6, 0.8) unit velocity.
    expect(seg.tailX).toBeCloseTo(-6, 6);
    expect(seg.tailY).toBeCloseTo(-8, 6);
  });

  it('collapses to a zero-length segment for a stationary bullet', () => {
    const seg = tracerTail(7, 9, 0, 0, 20);
    expect(seg.tailX).toBe(7);
    expect(seg.tailY).toBe(9);
    expect(seg.tipX).toBe(7);
    expect(seg.tipY).toBe(9);
  });
});

/** Deterministic stand-in for Math.random (tiny LCG) so bursts are repeatable. */
function seededRand(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe('spawnBloodBurst', () => {
  it('spawns every droplet at the hit point', () => {
    const burst = spawnBloodBurst(120, -40, 14, 0, 40, false, seededRand(1));
    expect(burst.length).toBeGreaterThan(0);
    for (const p of burst) {
      expect(p.x).toBe(120);
      expect(p.y).toBe(-40);
      expect(p.life).toBe(p.maxLife);
      expect(p.r).toBeGreaterThan(0);
    }
  });

  it('scales the droplet count with damage', () => {
    const light = spawnBloodBurst(0, 0, 14, 0, 10, false, seededRand(2));
    const heavy = spawnBloodBurst(0, 0, 14, 0, 70, false, seededRand(2));
    expect(heavy.length).toBeGreaterThan(light.length);
  });

  it('a fatal hit bursts roughly twice as big', () => {
    const hit = spawnBloodBurst(0, 0, 14, 0, 40, false, seededRand(3));
    const kill = spawnBloodBurst(0, 0, 14, 0, 40, true, seededRand(3));
    expect(kill.length).toBeGreaterThan(hit.length * 1.5);
  });

  it('biases droplet velocity along the bullet travel direction', () => {
    // Bullet flying +x: the majority of droplets must carry positive vx.
    const burst = spawnBloodBurst(0, 0, 14, 0, 40, false, seededRand(4));
    const forward = burst.filter((p) => p.vx > 0).length;
    expect(forward / burst.length).toBeGreaterThan(0.55);
  });
});

describe('updateBloodParticles', () => {
  it('integrates position and pulls droplets down with gravity', () => {
    const parts: BloodParticle[] = [
      { x: 0, y: 0, vx: 100, vy: -50, life: 1, maxLife: 1, r: 2, color: 0xb01414 },
    ];
    updateBloodParticles(parts, 0.1);
    const p = parts[0]!;
    // vy first gains gravity, then integrates: vy = -50 + 32 = -18.
    expect(p.vy).toBeCloseTo(-50 + BLOOD_GRAVITY * 0.1, 6);
    expect(p.x).toBeCloseTo(10, 6);
    expect(p.y).toBeCloseTo(p.vy * 0.1, 6);
    expect(p.life).toBeCloseTo(0.9, 6);
  });

  it('removes droplets whose life has run out', () => {
    const mk = (life: number): BloodParticle => ({
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      life,
      maxLife: 1,
      r: 2,
      color: 0xb01414,
    });
    const parts = [mk(0.05), mk(1), mk(0.02)];
    updateBloodParticles(parts, 0.1);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.life).toBeCloseTo(0.9, 6);
  });
});
