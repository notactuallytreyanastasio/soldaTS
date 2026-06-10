// runMatch smoke tests (goal node 170): a short pilot-vs-reaper round
// completes, the replay/events/telemetry artifacts are consistent with each
// other, tweak provenance is exact, and invalid team specs throw.

import { describe, it, expect } from 'vitest';
import { createEngine } from '@soldat/client/headless';
import { runMatch, type MatchResult } from './runner';
import type { ReplayRow } from './replay';

const ROUND_TICKS = 900; // 15 s — runs well under a second headless

let cached: MatchResult | null = null;
function smokeMatch(): MatchResult {
  cached ??= runMatch({
    seed: 5,
    teams: [{ engine: 'pilot' }, { engine: 'reaper' }],
    botCount: 4,
    roundTicks: ROUND_TICKS,
  });
  return cached;
}

function parseRows(result: MatchResult): ReplayRow[] {
  return result.replayJsonl
    .trimEnd()
    .split('\n')
    .map((l) => JSON.parse(l) as ReplayRow);
}

describe('runMatch', () => {
  it('completes the round (non-null verdict at/after roundTicks)', () => {
    const result = smokeMatch();
    expect(result.round).not.toBeNull();
    expect(result.round!.overAtTick).toBeGreaterThanOrEqual(ROUND_TICKS);
    expect(result.ticks).toBeGreaterThanOrEqual(ROUND_TICKS);
  });

  it('replay rows have consistent bots/teams/engines and non-decreasing ticks', () => {
    const result = smokeMatch();
    const rows = parseRows(result);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.tick).toBe(0);

    const teamOf = new Map<number, number>();
    const engineOf = new Map(result.bots.map((b) => [b.index, b.engine]));
    const rowsPerTick = new Map<number, number>();
    let prevTick = 0;
    for (const row of rows) {
      expect([2, 3, 4, 5]).toContain(row.bot);
      expect([1, 2]).toContain(row.team);
      // Team is consistent per bot across the whole match.
      const seen = teamOf.get(row.bot);
      if (seen === undefined) teamOf.set(row.bot, row.team);
      else expect(row.team).toBe(seen);
      expect(row.engine).toBe(engineOf.get(row.bot));
      expect(row.tick).toBeGreaterThanOrEqual(prevTick);
      prevTick = row.tick;
      rowsPerTick.set(row.tick, (rowsPerTick.get(row.tick) ?? 0) + 1);
    }
    // Only live bots emit rows: never more rows than bots on one tick.
    for (const count of rowsPerTick.values()) {
      expect(count).toBeLessThanOrEqual(4);
    }
  });

  it('records well-formed events that agree with the telemetry', () => {
    const result = smokeMatch();
    const shots = result.events.filter((e) => e.type === 'shot');
    expect(shots.length).toBeGreaterThan(0);
    for (const e of result.events) {
      expect(e.tick).toBeGreaterThanOrEqual(0);
      if (e.type === 'shot') expect(e.bot).toBeGreaterThan(1);
      if (e.type === 'hit') {
        expect(e.attacker).not.toBe(e.victim);
        expect(e.damage).toBeGreaterThan(0);
      }
      if (e.type === 'kill') {
        expect(e.victimPos).toBeDefined();
        if (e.killer > 0 && e.killer !== e.victim) {
          expect(e.killerPos).not.toBeNull();
          expect(e.dist).not.toBeNull();
        } else {
          expect(e.killerPos).toBeNull();
          expect(e.dist).toBeNull();
        }
      }
    }
    const kills = result.events.filter((e) => e.type === 'kill');
    expect(kills.length).toBe(result.telemetry.kills.length);
  });

  it('telemetry carries the match identity and matches the shot stream', () => {
    const result = smokeMatch();
    expect(result.telemetry.schema).toBe('soldat-match-telemetry/1');
    expect(result.telemetry.meta.variant).toBe('baseline');
    expect(result.telemetry.meta.engine).toBe('pilot+reaper');
    const shotTotal = Object.values(result.telemetry.shotsBy).reduce((a, b) => a + b, 0);
    expect(shotTotal).toBe(result.events.filter((e) => e.type === 'shot').length);
  });

  it('reports the resolved tweaks per team (defaults when none requested)', () => {
    const result = smokeMatch();
    expect(result.resolvedTweaks[0]).toEqual({ ...createEngine('pilot').tweaks });
    expect(result.resolvedTweaks[1]).toEqual({ ...createEngine('reaper').tweaks });

    const tweaked = runMatch({
      seed: 5,
      teams: [{ engine: 'pilot' }, { engine: 'reaper', tweaks: { KILL_RANGE: 220 } }],
      botCount: 4,
      roundTicks: 300,
    });
    expect(tweaked.resolvedTweaks[1].KILL_RANGE).toBe(220);
    expect(tweaked.resolvedTweaks[1].FIRE_RANGE).toBe(460);
  });

  it('throws on mirror matches and unknown engines', () => {
    expect(() =>
      runMatch({ seed: 1, teams: [{ engine: 'pilot' }, { engine: 'pilot' }], roundTicks: 60 }),
    ).toThrow(/mirror matches/);
    expect(() =>
      runMatch({ seed: 1, teams: [{ engine: 'pilot' }, { engine: 'nope' }], roundTicks: 60 }),
    ).toThrow(/unknown engine 'nope'/);
  });
});
