// Tournament pure-core tests: standings aggregation, dominance ranking, the
// evolutionary roster ("model more after them"), gameplay variants, and the
// cross-game round report.

import { describe, it, expect } from 'vitest';
import {
  aggregateStandings,
  evolveRoster,
  parseTournament,
  resolveVariant,
  roundReport,
  VARIANTS,
} from './tournament';
import { rankFighters, dominance } from '../ui/leaderboard';
import { tuningDeltas } from './tournament';
import { DEFAULT_TUNING } from './game';
import type { MatchDump } from './telemetry';
import type { RoundResult } from './game';

function dump(
  botEngines: Record<number, string>,
  perSprite: Record<number, { name: string; kills: number; deaths: number }>,
  round: RoundResult | null = null,
): MatchDump {
  return {
    schema: 'soldat-match-telemetry/1',
    meta: {
      map: 'Skyreach',
      botCount: Object.keys(botEngines).length,
      spectate: true,
      engine: 'classic+pilot',
      botEngines,
      variant: 'baseline',
      tickHz: 60,
      sampleEveryTicks: 30,
      names: {},
    },
    durationTicks: 3600,
    round,
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
    expect(parseTournament('?tournament')).toEqual({
      roster: 'classic,pilot',
      roundSecs: 600,
      gen: 0,
    });
    expect(parseTournament('?tournament&ai=pilot,pilot,classic')).toEqual({
      roster: 'pilot,pilot,classic',
      roundSecs: 600,
      gen: 0,
    });
  });

  it('parses ?round=SECS with a 600 s default and garbage tolerance', () => {
    expect(parseTournament('?tournament&round=20')?.roundSecs).toBe(20);
    expect(parseTournament('?tournament&round=0')?.roundSecs).toBe(600);
    expect(parseTournament('?tournament&round=nope')?.roundSecs).toBe(600);
  });
});

describe('variants', () => {
  it('resolves a named variant with its real tuning overrides', () => {
    const v = resolveVariant('high-octane');
    expect(v.name).toBe('high-octane');
    expect(v.tuning.fireInterval).toBe(4);
  });

  it('falls back to baseline for unknown/absent names', () => {
    expect(resolveVariant('nope').name).toBe('baseline');
    expect(resolveVariant(undefined).name).toBe('baseline');
    expect(resolveVariant(undefined).tuning).toEqual({});
  });

  it('has 4 uniquely named variants, baseline first', () => {
    expect(VARIANTS).toHaveLength(4);
    expect(new Set(VARIANTS.map((v) => v.name)).size).toBe(4);
    expect(VARIANTS[0]!.name).toBe('baseline');
  });
});

describe('roundReport', () => {
  const win = (winnerTeam: number, winnerEngine: string, red: number, blue: number): RoundResult => ({
    overAtTick: 36000,
    winnerTeam,
    winnerEngine,
    redKills: red,
    blueKills: blue,
    redDom: red,
    blueDom: blue,
  });
  const engines = {
    pilot: { kills: 40, deaths: 20, dom: 30 },
    classic: { kills: 25, deaths: 35, dom: 7.5 },
  };

  it('is not done while dumps are missing', () => {
    const r = roundReport([null, null, null, null], engines);
    expect(r.done).toBe(false);
    expect(r.gamesOver).toBe(0);
    expect(r.champion).toBe('');
    expect(r.perGame).toEqual([null, null, null, null]);
  });

  it('counts wins per engine and crowns the most winning one', () => {
    const dumps = [
      dump({}, {}, win(1, 'pilot', 12, 8)),
      dump({}, {}, win(2, 'pilot', 7, 11)),
      dump({}, {}, win(1, 'classic', 9, 6)),
      dump({}, {}, win(1, 'pilot', 10, 4)),
    ];
    const r = roundReport(dumps, engines);
    expect(r.done).toBe(true);
    expect(r.gamesOver).toBe(4);
    expect(r.wins).toEqual({ pilot: 3, classic: 1 });
    expect(r.champion).toBe('pilot');
    expect(r.perGame[0]).toEqual({ winnerTeam: 1, winnerEngine: 'pilot', redKills: 12, blueKills: 8 });
  });

  it('breaks a win tie on aggregate dominance', () => {
    const dumps = [
      dump({}, {}, win(1, 'pilot', 5, 3)),
      dump({}, {}, win(1, 'classic', 6, 2)),
      dump({}, {}, win(2, 'pilot', 1, 4)),
      dump({}, {}, win(2, 'classic', 2, 7)),
    ];
    const r = roundReport(dumps, engines);
    expect(r.wins).toEqual({ pilot: 2, classic: 2 });
    expect(r.champion).toBe('pilot'); // engines.pilot.dom 30 > classic 7.5
  });

  it('awards nobody for a drawn game', () => {
    const dumps = [
      dump({}, {}, win(0, '', 5, 5)),
      dump({}, {}, win(1, 'pilot', 5, 3)),
      dump({}, {}, win(1, 'pilot', 6, 1)),
      dump({}, {}, win(2, 'classic', 2, 4)),
    ];
    const r = roundReport(dumps, engines);
    expect(r.done).toBe(true);
    expect(r.wins).toEqual({ pilot: 2, classic: 1 });
    expect(r.perGame[0]!.winnerTeam).toBe(0);
  });
});


describe('round generations (?gen) and knob-turn display', () => {
  it('parses ?gen with a 0 default', () => {
    expect(parseTournament('?tournament')?.gen).toBe(0);
    expect(parseTournament('?tournament&gen=3')?.gen).toBe(3);
    expect(parseTournament('?tournament&gen=-1')?.gen).toBe(0);
  });

  it('spells out the knob turns vs stock and is silent for baseline', () => {
    expect(tuningDeltas({}, DEFAULT_TUNING)).toBe('');
    expect(
      tuningDeltas({ fireInterval: 4, reloadTicks: 70 }, DEFAULT_TUNING),
    ).toBe('fire 6→4 · reload 95→70');
    // An override equal to stock is not a "turn".
    expect(tuningDeltas({ magSize: 30 }, DEFAULT_TUNING)).toBe('');
  });
});
