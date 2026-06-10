// applyAimAssist — the pure aim-bending helper behind the player's light
// aim assist (goal node 102). The Game wiring is a thin loop over live
// enemies; the magnetism rules all live here.

import { describe, it, expect } from 'vitest';
import {
  applyAimAssist,
  ASSIST_CONE,
  ASSIST_MAX_BEND,
  ASSIST_RANGE,
} from './game';

const angleOf = (v: { x: number; y: number }): number => Math.atan2(v.y, v.x);

describe('applyAimAssist', () => {
  it('snaps exactly onto a target inside the max bend', () => {
    // Target 1° above the aim line, 300px out.
    const t = { x: 300 * Math.cos(-0.017), y: 300 * Math.sin(-0.017) };
    const bent = applyAimAssist(1, 0, 0, 0, [t]);
    expect(angleOf(bent)).toBeCloseTo(-0.017, 3);
  });

  it('bends only by ASSIST_MAX_BEND toward a target deeper in the cone', () => {
    // Target at 8° — inside the 9° cone but past the 2.9° bend cap.
    const off = 0.14;
    const t = { x: 300 * Math.cos(off), y: 300 * Math.sin(off) };
    const bent = applyAimAssist(1, 0, 0, 0, [t]);
    expect(angleOf(bent)).toBeCloseTo(ASSIST_MAX_BEND, 6);
    expect(angleOf(bent)).toBeLessThan(off); // still requires real aim
  });

  it('ignores targets outside the cone', () => {
    const off = ASSIST_CONE * 2;
    const t = { x: 300 * Math.cos(off), y: 300 * Math.sin(off) };
    const bent = applyAimAssist(1, 0, 0, 0, [t]);
    expect(bent).toEqual({ x: 1, y: 0 });
  });

  it('ignores targets beyond the range', () => {
    const d = ASSIST_RANGE + 50;
    const t = { x: d * Math.cos(0.02), y: d * Math.sin(0.02) };
    const bent = applyAimAssist(1, 0, 0, 0, [t]);
    expect(bent).toEqual({ x: 1, y: 0 });
  });

  it('picks the angularly-closest of several targets', () => {
    const near = { x: 300 * Math.cos(0.02), y: 300 * Math.sin(0.02) };
    const far = { x: 200 * Math.cos(-0.1), y: 200 * Math.sin(-0.1) };
    const bent = applyAimAssist(1, 0, 0, 0, [far, near]);
    expect(angleOf(bent)).toBeCloseTo(0.02, 3); // snapped to the 1.1° one
  });

  it('returns the aim untouched with no targets', () => {
    expect(applyAimAssist(0, -1, 0, 0, [])).toEqual({ x: 0, y: -1 });
  });

  it('handles aim across the ±PI seam (aiming left)', () => {
    // Aiming left (angle PI); target just above the leftward line.
    const t = { x: -300, y: -6 }; // ~1.1° off the PI line
    const bent = applyAimAssist(-1, 0, 0, 0, [t]);
    const offFromTarget = Math.abs(
      angleOf(bent) - Math.atan2(t.y, t.x),
    );
    expect(Math.min(offFromTarget, 2 * Math.PI - offFromTarget)).toBeLessThan(
      0.01,
    );
  });
});
