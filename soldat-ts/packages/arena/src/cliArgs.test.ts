// Pure CLI-helper tests (goal node 170): teams parsing in all three accepted
// forms, tweak/sweep parsing, and run-plan construction (sweep layering).

import { describe, it, expect } from 'vitest';
import { buildRunPlans, parseSweep, parseTeams, parseTweaks } from './cliArgs';

describe('parseTeams', () => {
  it('accepts the quoted "a vs b" form', () => {
    expect(parseTeams('pilot vs reaper', [])).toEqual(['pilot', 'reaper']);
  });

  it('accepts the unquoted form (vs + b land in positionals)', () => {
    expect(parseTeams('pilot', ['vs', 'reaper'])).toEqual(['pilot', 'reaper']);
  });

  it('accepts the comma form', () => {
    expect(parseTeams('pilot,reaper', [])).toEqual(['pilot', 'reaper']);
  });

  it('defaults to pilot vs reaper', () => {
    expect(parseTeams(undefined, [])).toEqual(['pilot', 'reaper']);
  });

  it('rejects mirror matches', () => {
    expect(() => parseTeams('pilot vs pilot', [])).toThrow(/mirror matches/);
  });

  it('rejects garbage', () => {
    expect(() => parseTeams('what even is this', [])).toThrow(/--teams/);
    expect(() => parseTeams('justone', [])).toThrow(/--teams/);
  });
});

describe('parseTweaks', () => {
  it('parses KEY=NUMBER pairs', () => {
    expect(parseTweaks(['RANGE_MAX=500', 'FUEL_RESERVE=90'])).toEqual({
      RANGE_MAX: 500,
      FUEL_RESERVE: 90,
    });
  });

  it('undefined → {}', () => {
    expect(parseTweaks(undefined)).toEqual({});
  });

  it('throws on malformed entries', () => {
    expect(() => parseTweaks(['RANGE_MAX'])).toThrow(/KEY=NUMBER/);
    expect(() => parseTweaks(['X=abc'])).toThrow(/KEY=NUMBER/);
  });
});

describe('parseSweep', () => {
  it('parses a team-a sweep', () => {
    expect(parseSweep('a:RANGE_MAX=380,420,460')).toEqual({
      team: 'a',
      key: 'RANGE_MAX',
      values: [380, 420, 460],
    });
  });

  it('null when undefined', () => {
    expect(parseSweep(undefined)).toBeNull();
  });

  it('throws on malformed specs', () => {
    expect(() => parseSweep('c:X=1')).toThrow(/sweep/);
    expect(() => parseSweep('a:X=')).toThrow(/sweep/);
  });
});

describe('buildRunPlans', () => {
  const baseArgs = {
    teams: ['pilot', 'reaper'] as [string, string],
    tweakA: { RANGE_MAX: 500 },
    tweakB: { KILL_RANGE: 220 },
    sweep: null,
    matches: 4,
    seedBase: 1337,
    botCount: 6,
    variant: 'baseline',
    roundSeconds: 120,
  };

  it('no sweep → one plan with the merged tweaks and roundTicks = secs*60', () => {
    const plans = buildRunPlans(baseArgs);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.teams[0]).toEqual({ engine: 'pilot', tweaks: { RANGE_MAX: 500 } });
    expect(plans[0]!.teams[1]).toEqual({ engine: 'reaper', tweaks: { KILL_RANGE: 220 } });
    expect(plans[0]!.roundTicks).toBe(7200);
    expect(plans[0]!.runIdSuffix).toBeUndefined();
  });

  it('sweep → one plan per value, knob layered over the right team, shared seedBase', () => {
    const plans = buildRunPlans({
      ...baseArgs,
      sweep: { team: 'a', key: 'FUEL_RESERVE', values: [90, 130, 170] },
    });
    expect(plans).toHaveLength(3);
    expect(plans.map((p) => p.label)).toEqual([
      'FUEL_RESERVE-90',
      'FUEL_RESERVE-130',
      'FUEL_RESERVE-170',
    ]);
    for (const [i, value] of [90, 130, 170].entries()) {
      const plan = plans[i]!;
      // The sweep key layers over team a's base tweaks; team b untouched.
      expect(plan.teams[0].tweaks).toEqual({ RANGE_MAX: 500, FUEL_RESERVE: value });
      expect(plan.teams[1].tweaks).toEqual({ KILL_RANGE: 220 });
      expect(plan.seedBase).toBe(1337); // identical seed series isolates the knob
      expect(plan.runIdSuffix).toBe(plan.label);
    }
  });
});
