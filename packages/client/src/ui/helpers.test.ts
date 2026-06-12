// Edge-case coverage for the pure HUD helpers. The happy paths live in
// hud.test.ts; this file pins down boundary and degenerate inputs (zero /
// negative / non-finite values) so the formatting and layout math cannot
// silently regress on weird frames.

import { describe, expect, it } from 'vitest';
import {
  DESIGN_HEIGHT,
  DESIGN_WIDTH,
  START_HEALTH,
  barFillRatio,
  formatAmmo,
  formatRank,
  formatScore,
  formatTeamScore,
  interfaceScale,
} from './helpers';

describe('barFillRatio edge cases', () => {
  it('is exactly 1 at full health against START_HEALTH', () => {
    expect(barFillRatio(START_HEALTH, START_HEALTH)).toBe(1);
  });

  it('guards NaN and -Infinity max via the !(max > 0) check', () => {
    expect(barFillRatio(5, Number.NaN)).toBe(0);
    expect(barFillRatio(5, Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it('an Infinity max yields ratio 0 for any finite value', () => {
    expect(barFillRatio(150, Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('clamps an Infinity value to 1', () => {
    expect(barFillRatio(Number.POSITIVE_INFINITY, 150)).toBe(1);
  });

  it('clamps boundary values exactly (no float fuzz at 0 and 1)', () => {
    expect(barFillRatio(0, 1)).toBe(0);
    expect(barFillRatio(1, 1)).toBe(1);
    // -0/150 = -0 is not < 0, so the raw (negative-zero) ratio comes back.
    expect(Object.is(barFillRatio(-0, 150), -0)).toBe(true);
  });

  it('passes a NaN value through unclamped (NaN compares false on both bounds)', () => {
    // SUSPECT: a NaN health would propagate to the bar width. The sim never
    // produces NaN health, but the helper does not guard it — pinned here so
    // a future guard is a deliberate change.
    expect(Number.isNaN(barFillRatio(Number.NaN, 150))).toBe(true);
  });
});

describe('interfaceScale edge cases', () => {
  it('is limited by the width on a tall (portrait) viewport', () => {
    expect(interfaceScale(DESIGN_WIDTH, DESIGN_HEIGHT * 3)).toBe(1);
    expect(interfaceScale(DESIGN_WIDTH / 2, DESIGN_HEIGHT * 3)).toBe(0.5);
  });

  it('scales down uniformly below the design resolution', () => {
    expect(interfaceScale(DESIGN_WIDTH / 4, DESIGN_HEIGHT / 4)).toBe(0.25);
  });

  it('returns 0 for a zero-sized viewport (degenerate but finite)', () => {
    expect(interfaceScale(0, 0)).toBe(0);
    expect(interfaceScale(0, DESIGN_HEIGHT)).toBe(0);
  });

  it('returns a negative scale for negative dimensions (no clamping)', () => {
    // The helper does not guard negative sizes; callers own that invariant.
    expect(interfaceScale(-DESIGN_WIDTH, DESIGN_HEIGHT)).toBe(-1);
  });
});

describe('formatScore edge cases', () => {
  it('renders a negative gap while leading without a double sign', () => {
    // leading + gap < 0 should never co-occur, but the formatter must not
    // print "+-2" if it does.
    expect(formatScore(5, true, -2)).toBe('5 (-2)');
  });

  it('renders zero gap when trailing without any sign', () => {
    expect(formatScore(5, false, 0)).toBe('5 (0)');
  });

  it('handles large values verbatim', () => {
    expect(formatScore(1000, true, 999)).toBe('1000 (+999)');
  });
});

describe('formatRank / formatTeamScore / formatAmmo edge cases', () => {
  it('formats single-position lobbies', () => {
    expect(formatRank(1, 1)).toBe('1/1');
  });

  it('formats double-digit positions', () => {
    expect(formatRank(12, 32)).toBe('12/32');
  });

  it('formats zero and large team scores with the colon separator', () => {
    expect(formatTeamScore(0, 0)).toBe('0 : 0');
    expect(formatTeamScore(100, 99)).toBe('100 : 99');
  });

  it('formats negative ammo verbatim (no clamping in the formatter)', () => {
    expect(formatAmmo(-1)).toBe('-1');
  });

  it('formats triple-digit ammo', () => {
    expect(formatAmmo(250)).toBe('250');
  });
});
