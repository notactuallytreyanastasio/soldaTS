// Match-telemetry pure-derivation tests (percentile, death clustering,
// deriveStats) plus the additive round/variant dump fields. The MatchRecorder
// shell is otherwise exercised end-to-end by the spectate browser harness;
// the math is pinned here.

import { describe, it, expect } from 'vitest';
import {
  MatchRecorder,
  SCHEMA,
  percentile,
  clusterDeaths,
  deriveStats,
  type KillEvent,
  type Sample,
} from './telemetry';
import { Game } from './game';

describe('percentile', () => {
  it('interpolates linearly', () => {
    expect(percentile([0, 10], 0.5)).toBe(5);
    expect(percentile([1, 2, 3, 4], 0.25)).toBeCloseTo(1.75, 12);
    expect(percentile([7], 0.9)).toBe(7);
    expect(Number.isNaN(percentile([], 0.5))).toBe(true);
  });
});

describe('clusterDeaths', () => {
  it('bins nearby deaths into one cluster at the centroid, biggest first', () => {
    const clusters = clusterDeaths(
      [
        { x: 10, y: 10 },
        { x: 30, y: 20 }, // same 160px cell as above
        { x: 1000, y: 1000 },
      ],
      160,
    );
    expect(clusters).toHaveLength(2);
    expect(clusters[0]).toEqual({ x: 20, y: 15, count: 2 });
    expect(clusters[1]).toEqual({ x: 1000, y: 1000, count: 1 });
  });

  it('respects cell boundaries (negative coords bin separately)', () => {
    const clusters = clusterDeaths(
      [
        { x: -10, y: 0 },
        { x: 10, y: 0 },
      ],
      160,
    );
    expect(clusters).toHaveLength(2);
  });
});

describe('deriveStats', () => {
  const samples: Sample[] = [
    {
      tick: 0,
      sprites: [
        { i: 2, x: 0, y: 0, vx: 3, vy: 4, hp: 150, jetFuel: 700, jetting: true, firing: false, air: true },
        { i: 3, x: 100, y: 50, vx: 0, vy: 0, hp: 150, jetFuel: 700, jetting: false, firing: true, air: false },
      ],
    },
    {
      tick: 30,
      sprites: [
        { i: 2, x: 10, y: 100, vx: 3, vy: 4, hp: 100, jetFuel: 600, jetting: false, firing: true, air: false },
        { i: 3, x: 100, y: 50, vx: 0, vy: 0, hp: 150, jetFuel: 700, jetting: false, firing: false, air: false },
      ],
    },
  ];
  const kills: KillEvent[] = [
    { tick: 60, killer: 2, victim: 3, killerPos: { x: 0, y: 0 }, victimPos: { x: 300, y: 400 }, dist: 500 },
    { tick: 120, killer: 0, victim: 2, killerPos: null, victimPos: { x: 5, y: 5 }, dist: null },
  ];
  const raw = {
    shotsBy: { 2: 10, 3: 4 },
    hitsBy: { 2: 4 },
    damageBy: { 2: 92 },
    kills,
    samples,
    durationTicks: 3600, // exactly one minute
  };
  const names = { 2: 'Alpha', 3: 'Bravo' };

  it('computes hit rates, kills/deaths, and jet/air percentages', () => {
    const d = deriveStats(raw, names);
    const a = d.perSprite[2]!;
    expect(a.name).toBe('Alpha');
    expect(a.hitRate).toBeCloseTo(0.4, 12); // 4 / 10
    expect(a.kills).toBe(1);
    expect(a.deaths).toBe(1); // the unattributed death still counts
    expect(a.jetUsePct).toBeCloseTo(0.5, 12); // jetting in 1 of 2 samples
    expect(a.airTimePct).toBeCloseTo(0.5, 12);
    expect(a.avgSpeed).toBeCloseTo(5, 12); // |(3,4)| both samples
    const b = d.perSprite[3]!;
    expect(b.hitRate).toBe(0); // shots but no hits
    expect(b.ySpread).toBe(0); // never moved vertically
  });

  it('computes pacing and kill-distance stats over attributed kills only', () => {
    const d = deriveStats(raw, names);
    expect(d.killsPerMin).toBeCloseTo(2, 12); // 2 deaths in 1 min
    expect(d.killDist).not.toBeNull();
    expect(d.killDist!.median).toBe(500); // single attributed kill
    expect(d.deathClusters.reduce((n, c) => n + c.count, 0)).toBe(2);
  });

  it('handles an empty match without NaN explosions', () => {
    const d = deriveStats(
      { shotsBy: {}, hitsBy: {}, damageBy: {}, kills: [], samples: [], durationTicks: 0 },
      {},
    );
    expect(d.killsPerMin).toBe(0);
    expect(d.killDist).toBeNull();
    expect(d.deathClusters).toEqual([]);
  });
});

describe('MatchRecorder round + variant fields (additive, schema unchanged)', () => {
  it('records the variant name in meta (baseline by default)', () => {
    const game = new Game({ spectate: true, botCount: 2 });
    const tagged = new MatchRecorder(game, 'Skyreach', 2, true, 'marksman');
    expect(tagged.dump().meta.variant).toBe('marksman');
    const plain = new MatchRecorder(game, 'Skyreach', 2, true);
    expect(plain.dump().meta.variant).toBe('baseline');
  });

  it('dump().round mirrors the game verdict: null while running, set after', () => {
    // Mixed engines → teams on; a tiny roundTicks ends the round quickly.
    const game = new Game({
      spectate: true,
      botCount: 2,
      aiEngine: 'classic,pilot',
      roundTicks: 10,
    });
    const recorder = new MatchRecorder(game, 'Skyreach', 2, true, 'baseline');
    expect(recorder.dump().round).toBeNull();
    for (let i = 0; i < 30; i++) game.tick(1 / 60);
    const dump = recorder.dump();
    expect(dump.round).not.toBeNull();
    expect(dump.round!.overAtTick).toBe(10);
    expect(dump.schema).toBe(SCHEMA);
    expect(dump.schema).toBe('soldat-match-telemetry/1');
  });
});
