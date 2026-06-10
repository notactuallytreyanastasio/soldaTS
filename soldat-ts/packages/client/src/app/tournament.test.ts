// Tournament pure-core tests: standings aggregation, dominance ranking, and
// the evolutionary roster ("model more after them").

import { describe, it, expect } from 'vitest';
import { aggregateStandings, evolveRoster, parseTournament } from './tournament';
import { rankFighters, dominance } from '../ui/leaderboard';
import type { MatchDump } from './telemetry';

function dump(
  botEngines: Record<number, string>,
  perSprite: Record<number, { name: string; kills: number; deaths: number }>,
): MatchDump {
  return {
    schema: 'soldat-match-telemetry/1',
    meta: {
      map: 'Skyreach',
      botCount: Object.keys(botEngines).length,
      spectate: true,
      engine: 'classic+pilot',
      botEngines,
      tickHz: 60,
      sampleEveryTicks: 30,
      names: {},
    },
    durationTicks: 3600,
    shotsBy: {},
    hitsBy: {},
    damageBy: {},
    kills: [],
    samples: [],
    derived: {
      perSprite: Object.fromEntries(
        Object.entries(perSprite).map(([i, s]) => [
          i,
          {
            ...s,
            shots: 0,
            hits: 0,
            hitRate: 0,
            damage: 0,
            jetUsePct: 0,
            airTimePct: 0,
            avgSpeed: 0,
            ySpread: 0,
          },
        ]),
      ),
      killsPerMin: 0,
      killDist: null,
      deathClusters: [],
    },
  };
}

describe('dominance + ranking', () => {
  it('a 2-for-1 trader outranks a feeder with more kills', () => {
    expect(dominance({ kills: 6, deaths: 3 })).toBeGreaterThan(
      dominance({ kills: 7, deaths: 8 }),
    );
    const ranked = rankFighters([
      { index: 2, name: 'A', engine: 'x', team: 0, kills: 7, deaths: 8 },
      { index: 3, name: 'B', engine: 'x', team: 0, kills: 6, deaths: 3 },
    ]);
    expect(ranked[0]!.name).toBe('B');
  });
});

describe('aggregateStandings', () => {
  it('sums engines across games, crowns the most dominant, skips dead frames', () => {
    const d1 = dump(
      { 2: 'classic', 3: 'pilot' },
      { 2: { name: 'Alpha', kills: 3, deaths: 5 }, 3: { name: 'Bravo', kills: 6, deaths: 2 } },
    );
    const d2 = dump(
      { 2: 'classic', 3: 'pilot' },
      { 2: { name: 'Alpha', kills: 4, deaths: 4 }, 3: { name: 'Bravo', kills: 5, deaths: 3 } },
    );
    const s = aggregateStandings([d1, d2, null, null]);
    expect(s.engines['classic']).toEqual({ kills: 7, deaths: 9, dom: 2.5 });
    expect(s.engines['pilot']).toEqual({ kills: 11, deaths: 5, dom: 8.5 });
    expect(s.dominant).toBe('pilot');
    expect(s.fighters[0]!.name).toBe('Bravo'); // highest dominance fighter
    expect(s.fighters).toHaveLength(4);
  });
});

describe('evolveRoster (model more after the winners)', () => {
  it('weights slots by dominance, keeps every engine alive', () => {
    const roster = evolveRoster(
      { pilot: { kills: 20, deaths: 4, dom: 18 }, classic: { kills: 6, deaths: 18, dom: -3 } },
      6,
    );
    const counts = roster.split(',').reduce<Record<string, number>>((m, id) => {
      m[id] = (m[id] ?? 0) + 1;
      return m;
    }, {});
    expect(roster.split(',')).toHaveLength(6);
    expect(counts['pilot']).toBeGreaterThan(counts['classic'] ?? 0);
    expect(counts['classic']).toBeGreaterThanOrEqual(1); // comeback stays possible
  });

  it('splits evenly with no signal', () => {
    const roster = evolveRoster(
      { a: { kills: 0, deaths: 0, dom: 0 }, b: { kills: 0, deaths: 0, dom: 0 } },
      6,
    );
    const ids = roster.split(',');
    expect(ids).toHaveLength(6);
    expect(ids.filter((x) => x === 'a')).toHaveLength(3);
  });

  it('falls back to the default pairing with no engines at all', () => {
    expect(evolveRoster({}, 6)).toBe('classic,pilot');
  });
});

describe('parseTournament', () => {
  it('parses the flag and the roster override', () => {
    expect(parseTournament('?foo')).toBeNull();
    expect(parseTournament('?tournament')).toEqual({ roster: 'classic,pilot' });
    expect(parseTournament('?tournament&ai=pilot,pilot,classic')).toEqual({
      roster: 'pilot,pilot,classic',
    });
  });
});
