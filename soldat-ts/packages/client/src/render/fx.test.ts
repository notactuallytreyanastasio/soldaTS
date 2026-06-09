import { describe, it, expect } from 'vitest';
import { tracerTail } from './fx';

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
