import { describe, it, expect } from 'vitest';
import {
  computePan,
  scaleVolumeSetting,
  SOUND_MAXDIST,
  SOUND_METERLENGTH,
} from './audio';

describe('computePan — distance attenuation', () => {
  it('is loud and centred at the listener position', () => {
    const { pan, gain } = computePan(0, 0);
    expect(gain).toBe(1);
    expect(pan).toBe(0);
  });

  it('falls off linearly with distance', () => {
    // Half the max distance -> half gain. PORT: Sound.pas:472 (1 - Dist).
    const half = computePan(SOUND_MAXDIST / 2, 0);
    expect(half.gain).toBeCloseTo(0.5, 6);

    const quarter = computePan(SOUND_MAXDIST / 4, 0);
    expect(quarter.gain).toBeCloseTo(0.75, 6);

    // Nearer is louder than farther.
    expect(quarter.gain).toBeGreaterThan(half.gain);
  });

  it('is silent at and beyond max distance', () => {
    expect(computePan(SOUND_MAXDIST, 0).gain).toBeCloseTo(0, 6);
    // Past max distance -> gain 0 (source never plays). PORT: Sound.pas:448.
    const far = computePan(SOUND_MAXDIST * 2, 0);
    expect(far.gain).toBe(0);
    expect(far.pan).toBe(0);
  });

  it('uses Euclidean distance across both axes', () => {
    // (dx,dy) on a 3-4-5 triangle: hypotenuse = SOUND_MAXDIST -> silent.
    const r = computePan(0.6 * SOUND_MAXDIST, 0.8 * SOUND_MAXDIST);
    expect(r.gain).toBeCloseTo(0, 6);
  });
});

describe('computePan — stereo pan sign', () => {
  // Use a large maxDist so these cases stay audible (gain > 0) and we isolate
  // the pan sign from the distance cutoff (default SOUND_MAXDIST = 750).
  const AUDIBLE = SOUND_METERLENGTH * 10;

  it('pans right for an emitter to the right (+dx)', () => {
    const { pan } = computePan(SOUND_METERLENGTH / 2, 0, AUDIBLE);
    expect(pan).toBeGreaterThan(0);
    expect(pan).toBeCloseTo(0.5, 6); // dx / SOUND_METERLENGTH
  });

  it('pans left for an emitter to the left (-dx)', () => {
    const { pan } = computePan(-SOUND_METERLENGTH / 2, 0, AUDIBLE);
    expect(pan).toBeLessThan(0);
    expect(pan).toBeCloseTo(-0.5, 6);
  });

  it('clamps pan to the [-1, 1] StereoPanner range', () => {
    expect(computePan(SOUND_METERLENGTH * 10, 0, SOUND_MAXDIST * 100).pan).toBe(
      1,
    );
    expect(
      computePan(-SOUND_METERLENGTH * 10, 0, SOUND_MAXDIST * 100).pan,
    ).toBe(-1);
  });

  it('honours a custom maxDist for attenuation', () => {
    // With a tiny maxDist the same offset is fully attenuated...
    expect(computePan(100, 0, 50).gain).toBe(0);
    // ...but within a large maxDist it is nearly full gain.
    expect(computePan(100, 0, 100000).gain).toBeGreaterThan(0.99);
  });
});

describe('scaleVolumeSetting', () => {
  it('maps 0% to silence and 100% to full', () => {
    // PORT: Sound.pas:193-196.
    expect(scaleVolumeSetting(0)).toBeCloseTo(0, 6);
    expect(scaleVolumeSetting(100)).toBeCloseTo(1, 3);
  });

  it('is monotonically increasing', () => {
    expect(scaleVolumeSetting(50)).toBeGreaterThan(scaleVolumeSetting(25));
    expect(scaleVolumeSetting(75)).toBeGreaterThan(scaleVolumeSetting(50));
  });
});
