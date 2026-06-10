// Determinism (goal node 170): same MatchConfig ⇒ byte-identical artifacts.
// This is the dataset's reproducibility guarantee — a manifest (config +
// seed) fully determines every replay byte.

import { describe, it, expect } from 'vitest';
import { rollWildcard } from '@soldat/client/headless';
import { runMatch, type MatchConfig } from './runner';
import { buildManifest } from './store';

const CONFIG: MatchConfig = {
  seed: 11,
  teams: [{ engine: 'pilot', tweaks: { RANGE_MAX: 500 } }, { engine: 'reaper' }],
  botCount: 4,
  roundTicks: 600,
};

describe('runMatch determinism', () => {
  it('identical config ⇒ byte-identical replay, events, telemetry', () => {
    const a = runMatch(CONFIG);
    const b = runMatch(CONFIG);
    expect(a.replayJsonl === b.replayJsonl).toBe(true); // strict string equality
    expect(b.events).toEqual(a.events);
    expect(b.telemetry).toEqual(a.telemetry);
    expect(b.round).toEqual(a.round);
  });

  it('different seed ⇒ different replay', () => {
    const a = runMatch(CONFIG);
    const c = runMatch({ ...CONFIG, seed: 12 });
    expect(c.replayJsonl).not.toBe(a.replayJsonl);
  });
});

describe('shotgun wildcard determinism', () => {
  const WILD: MatchConfig = { ...CONFIG, wildcard: 'shotgun' };

  it('identical wildcard config ⇒ byte-identical artifacts', () => {
    const a = runMatch(WILD);
    const b = runMatch(WILD);
    expect(a.replayJsonl === b.replayJsonl).toBe(true);
    expect(b.events).toEqual(a.events);
    expect(b.telemetry).toEqual(a.telemetry);
    expect(b.round).toEqual(a.round);
  });

  it('explicit wildcard: undefined ⇒ byte-identical to the default config', () => {
    const a = runMatch(CONFIG);
    const b = runMatch({ ...CONFIG, wildcard: undefined });
    expect(a.replayJsonl === b.replayJsonl).toBe(true);
    expect(b.events).toEqual(a.events);
  });

  it('wildcard kills carry a weapon tag; default kills never do', () => {
    const wild = runMatch(WILD);
    const plain = runMatch(CONFIG);
    const wildKills = wild.events.filter((e) => e.type === 'kill' && e.killer > 0);
    for (const k of wildKills) {
      expect('weapon' in k && (k.weapon === 'AK74' || k.weapon === 'SPAS12')).toBe(true);
    }
    for (const k of plain.events.filter((e) => e.type === 'kill')) {
      expect('weapon' in k).toBe(false);
    }
  });

  it('the manifest records the wildcard (null when stock)', () => {
    const results = [runMatch(WILD)];
    const base = {
      runId: 'wild-test',
      teams: WILD.teams,
      results,
      variantName: 'baseline',
      botCount: 4,
      roundTicks: 600,
      maxTicks: 1200,
    };
    expect(buildManifest({ ...base, wildcard: 'shotgun' }).wildcard).toBe('shotgun');
    expect(buildManifest(base).wildcard).toBeNull();
    // 'none' is an explicit stock request — normalized to null like absence.
    expect(buildManifest({ ...base, wildcard: 'none' }).wildcard).toBeNull();
    // Per-match RESOLVED values ride on matches[] (chance runs vary by seed).
    expect(buildManifest({ ...base, wildcard: 'shotgun' }).matches[0]?.wildcard).toBe('shotgun');
  });
});

describe("'chance' wildcard mode (all games get a shot at shotgun play)", () => {
  it('resolves purely from the seed: same config ⇒ byte-identical artifacts', () => {
    const a = runMatch({ ...CONFIG, wildcard: 'chance' });
    const b = runMatch({ ...CONFIG, wildcard: 'chance' });
    expect(a.replayJsonl === b.replayJsonl).toBe(true);
    expect(b.events).toEqual(a.events);
    expect(a.wildcard).toBe(b.wildcard);
  });

  it('arms SOME seeds and not others, and records which on the result', () => {
    const armed = rollWildcard(CONFIG.seed);
    const r = runMatch({ ...CONFIG, wildcard: 'chance', roundTicks: 600 });
    expect(r.wildcard).toBe(armed ? 'shotgun' : null);
    // The roll is a real chance: both outcomes occur across nearby seeds.
    const rolls = Array.from({ length: 40 }, (_, i) => rollWildcard(i + 1));
    expect(rolls.some(Boolean)).toBe(true);
    expect(rolls.some((x) => !x)).toBe(true);
  });

  it("'none' mode is byte-identical to no wildcard at all", () => {
    const a = runMatch(CONFIG);
    const b = runMatch({ ...CONFIG, wildcard: 'none' });
    expect(a.replayJsonl === b.replayJsonl).toBe(true);
  });
});
