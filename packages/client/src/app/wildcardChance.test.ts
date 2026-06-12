// Wildcard chance resolution: pure, seed-stable, and mode-correct — the
// guarantee that "all games have a chance of wildcard play" never costs a
// byte of replay determinism. Since the rifle era, an armed 'chance' match
// picks its weapon from a SEPARATE seeded hash (now a weighted split over the
// five WILDCARD_WEAPONS (rocket/ricochet/chainsaw 3x the shotgun/rifle)); the arming roll itself (rollWildcard) is the
// unchanged shotgun-era hash.

import { describe, it, expect } from 'vitest';
import {
  WILDCARD_CHANCE_PCT,
  WILDCARD_WEAPONS,
  rollWildcard,
  pickWildcardWeapon,
  resolveWildcard,
} from './wildcardChance';

describe('rollWildcard', () => {
  it('is a pure function of the seed', () => {
    for (const seed of [0, 1, 7, 1337, 123456789]) {
      expect(rollWildcard(seed)).toBe(rollWildcard(seed));
    }
  });

  it('arms roughly the configured fraction across many seeds', () => {
    const n = 2000;
    let armed = 0;
    for (let s = 1; s <= n; s++) if (rollWildcard(s)) armed += 1;
    const pct = (armed / n) * 100;
    expect(pct).toBeGreaterThan(WILDCARD_CHANCE_PCT - 8);
    expect(pct).toBeLessThan(WILDCARD_CHANCE_PCT + 8);
  });
});

describe('pickWildcardWeapon', () => {
  it('is a pure function of the seed and weights the spectacle guns 3x', () => {
    const counts = new Map<string, number>();
    const N = 4000;
    for (let s = 1; s <= N; s++) {
      expect(pickWildcardWeapon(s)).toBe(pickWildcardWeapon(s));
      counts.set(pickWildcardWeapon(s), (counts.get(pickWildcardWeapon(s)) ?? 0) + 1);
    }
    // weights shotgun:1 rifle:1 rocket:3 ricochet:3 chainsaw:3 (total 11)
    const expected: Record<string, number> = {
      shotgun: 1 / 11, rifle: 1 / 11, rocket: 3 / 11, ricochet: 3 / 11, chainsaw: 3 / 11,
    };
    for (const weapon of WILDCARD_WEAPONS) {
      const frac = (counts.get(weapon) ?? 0) / N;
      expect(frac).toBeGreaterThan(expected[weapon]! - 0.05);
      expect(frac).toBeLessThan(expected[weapon]! + 0.05);
    }
    // each spectacle gun beats either even-split baseline gun
    for (const big of ['rocket', 'ricochet', 'chainsaw'] as const) {
      expect(counts.get(big)!).toBeGreaterThan(counts.get('shotgun')!);
    }
  });
});

describe('resolveWildcard', () => {
  it('every weapon name forces itself; \'none\'/undefined are stock, unknown is stock', () => {
    for (const weapon of WILDCARD_WEAPONS) {
      expect(resolveWildcard(weapon, 1)).toBe(weapon);
    }
    expect(resolveWildcard('none', 1)).toBeUndefined();
    expect(resolveWildcard(undefined, 1)).toBeUndefined();
    expect(resolveWildcard('definitely-not-real', 1)).toBeUndefined();
  });

  it("'chance' follows the seed roll exactly, then the seeded weapon pick", () => {
    for (const seed of [1, 2, 3, 1337, 1338, 1339]) {
      expect(resolveWildcard('chance', seed)).toBe(
        rollWildcard(seed) ? pickWildcardWeapon(seed) : undefined,
      );
    }
  });
});
