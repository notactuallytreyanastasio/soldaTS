// Wildcard chance resolution: pure, seed-stable, and mode-correct — the
// guarantee that "all games have a chance of shotgun play" never costs a
// byte of replay determinism.

import { describe, it, expect } from 'vitest';
import { WILDCARD_CHANCE_PCT, rollWildcard, resolveWildcard } from './wildcardChance';

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

describe('resolveWildcard', () => {
  it("'shotgun' forces, 'none'/undefined are stock, unknown is stock", () => {
    expect(resolveWildcard('shotgun', 1)).toBe('shotgun');
    expect(resolveWildcard('none', 1)).toBeUndefined();
    expect(resolveWildcard(undefined, 1)).toBeUndefined();
    expect(resolveWildcard('definitely-not-real', 1)).toBeUndefined();
  });

  it("'chance' follows the seed roll exactly", () => {
    for (const seed of [1, 2, 3, 1337, 1338, 1339]) {
      expect(resolveWildcard('chance', seed)).toBe(
        rollWildcard(seed) ? 'shotgun' : undefined,
      );
    }
  });
});
