import { describe, it, expect } from 'vitest';
import { boneTransform } from './gostekTextured';

describe('boneTransform', () => {
  it('a horizontal bone (left->right) has rotation 0 and correct length', () => {
    const b = boneTransform(0, 0, 10, 0);
    expect(b.rotation).toBe(0);
    expect(b.length).toBe(10);
    expect(b.x).toBe(0);
    expect(b.y).toBe(0);
  });

  it('positions at p1', () => {
    const b = boneTransform(3, 7, 9, 7);
    expect(b.x).toBe(3);
    expect(b.y).toBe(7);
    expect(b.length).toBe(6);
    expect(b.rotation).toBe(0);
  });

  it('a downward bone (y down) has rotation +pi/2', () => {
    const b = boneTransform(0, 0, 0, 5);
    expect(b.rotation).toBeCloseTo(Math.PI / 2, 10);
    expect(b.length).toBeCloseTo(5, 10);
  });

  it('a leftward bone has rotation +/-pi and correct length', () => {
    const b = boneTransform(0, 0, -4, 0);
    expect(Math.abs(b.rotation)).toBeCloseTo(Math.PI, 10);
    expect(b.length).toBe(4);
  });

  it('computes a 3-4-5 diagonal length', () => {
    const b = boneTransform(0, 0, 3, 4);
    expect(b.length).toBeCloseTo(5, 10);
    expect(b.rotation).toBeCloseTo(Math.atan2(4, 3), 10);
  });
});
