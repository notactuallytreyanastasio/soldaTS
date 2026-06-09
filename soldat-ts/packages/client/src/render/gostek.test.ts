import { describe, it, expect } from 'vitest';
import { aimAngle, limbAngle } from './gostek';

describe('aimAngle', () => {
  it('points right (1,0) at angle 0', () => {
    expect(aimAngle(1, 0)).toBeCloseTo(0, 6);
  });

  it('points down (0,1) at +pi/2 (y is DOWN)', () => {
    expect(aimAngle(0, 1)).toBeCloseTo(Math.PI / 2, 6);
  });

  it('points left (-1,0) at +pi', () => {
    expect(aimAngle(-1, 0)).toBeCloseTo(Math.PI, 6);
  });

  it('points up (0,-1) at -pi/2', () => {
    expect(aimAngle(0, -1)).toBeCloseTo(-Math.PI / 2, 6);
  });
});

describe('limbAngle', () => {
  it('is zero at phase 0 for both legs', () => {
    expect(limbAngle(0, 1)).toBeCloseTo(0, 6);
    expect(limbAngle(0, -1)).toBeCloseTo(0, 6);
  });

  it('swings the two legs in anti-phase', () => {
    const left = limbAngle(0.25, 1);
    const right = limbAngle(0.25, -1);
    expect(left).toBeCloseTo(-right, 6);
    expect(left).not.toBeCloseTo(0, 3);
  });

  it('is periodic over phase 1', () => {
    expect(limbAngle(0.37, 1)).toBeCloseTo(limbAngle(1.37, 1), 6);
  });
});
