import { describe, expect, it } from 'vitest';
import {
  DESIGN_HEIGHT,
  DESIGN_WIDTH,
  barFillRatio,
  formatAmmo,
  formatRank,
  formatScore,
  formatTeamScore,
  interfaceScale,
} from './helpers';

describe('barFillRatio', () => {
  it('returns value/max within range', () => {
    expect(barFillRatio(75, 150)).toBe(0.5);
    expect(barFillRatio(150, 150)).toBe(1);
    expect(barFillRatio(0, 150)).toBe(0);
  });

  it('clamps to [0,1] like RenderBar (InterfaceGraphics.pas:418)', () => {
    expect(barFillRatio(300, 150)).toBe(1);
    expect(barFillRatio(-10, 150)).toBe(0);
  });

  it('guards a non-positive max', () => {
    expect(barFillRatio(5, 0)).toBe(0);
    expect(barFillRatio(5, -1)).toBe(0);
  });
});

describe('interfaceScale', () => {
  it('is 1 at the design resolution', () => {
    expect(interfaceScale(DESIGN_WIDTH, DESIGN_HEIGHT)).toBe(1);
  });

  it('takes the smaller axis ratio so nothing overflows', () => {
    // Double width, same height -> limited by height (1).
    expect(interfaceScale(DESIGN_WIDTH * 2, DESIGN_HEIGHT)).toBe(1);
    // Both doubled -> 2.
    expect(interfaceScale(DESIGN_WIDTH * 2, DESIGN_HEIGHT * 2)).toBe(2);
  });
});

describe('formatScore', () => {
  it('shows a signed gap with + when leading', () => {
    expect(formatScore(12, true, 3)).toBe('12 (+3)');
  });

  it('omits + when leading but tied (gap 0)', () => {
    expect(formatScore(12, true, 0)).toBe('12 (0)');
  });

  it('shows the negative gap to the leader when not leading', () => {
    expect(formatScore(8, false, -4)).toBe('8 (-4)');
  });
});

describe('formatRank / formatTeamScore / formatAmmo', () => {
  it('formats rank as pos/total', () => {
    expect(formatRank(2, 6)).toBe('2/6');
  });

  it('formats team score as "a : b"', () => {
    expect(formatTeamScore(3, 2)).toBe('3 : 2');
  });

  it('formats ammo as a plain integer string', () => {
    expect(formatAmmo(0)).toBe('0');
    expect(formatAmmo(31)).toBe('31');
  });
});
