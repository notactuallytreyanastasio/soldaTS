// Evaluation gauntlet tests (goal node 427): the EVAL_SPEC_V1 constants are
// PINNED (changing them silently would invalidate every score in the
// ledger), the cell/seed enumeration is exhaustive and collision-free, the
// paired-delta statistics are exact on synthetic data, the ledger line keeps
// its shape, and a candidate gauntleted twice produces identical results.

import { describe, it, expect } from 'vitest';
import { engineIds } from '@soldat/client/headless';
import {
  EVAL_SPEC_V1,
  bootstrapCi,
  buildLedgerLine,
  cellKey,
  gauntletCells,
  pairedDeltas,
  registerCardFighter,
  runCell,
  signTest,
  summarize,
  type CellResult,
} from './evaluate';

describe('EVAL_SPEC_V1 (pinned — any change is a new spec version)', () => {
  it('reserves the held-out arenas and the 90000+ seed block', () => {
    expect(EVAL_SPEC_V1.id).toBe('EVAL_SPEC_V1');
    expect([...EVAL_SPEC_V1.arenas]).toEqual([101, 202, 303, 404, 505]);
    expect(EVAL_SPEC_V1.seedBase).toBe(90000);
    expect(EVAL_SPEC_V1.matchesPerCell).toBe(2);
    expect(EVAL_SPEC_V1.roundTicks).toBe(7200);
    expect(EVAL_SPEC_V1.botCount).toBe(6);
  });

  it('conditions are stock + both wildcard guns', () => {
    expect(EVAL_SPEC_V1.conditions.map((c) => c.name)).toEqual(['stock', 'shotgun', 'rifle']);
    expect(EVAL_SPEC_V1.conditions.map((c) => c.wildcard)).toEqual([
      undefined,
      'shotgun',
      'rifle',
    ]);
  });

  it('opponents are exactly the 12 hand-written engines (no learned ones)', () => {
    expect([...EVAL_SPEC_V1.opponents]).toEqual([
      'classic',
      'pilot',
      'reaper',
      'matador',
      'kestrel',
      'wolf',
      'plover',
      'hydra',
      'shrike',
      'cuadrilla',
      'orca',
      'angler',
    ]);
    expect(EVAL_SPEC_V1.opponents).not.toContain('neural');
    expect(EVAL_SPEC_V1.opponents).not.toContain('disciple');
    for (const opp of EVAL_SPEC_V1.opponents) expect(engineIds()).toContain(opp);
  });
});

describe('gauntletCells', () => {
  it('full gauntlet is 360 cells with unique seeds in the reserved block', () => {
    const cells = gauntletCells(false);
    expect(cells.length).toBe(12 * 3 * 5 * 2);
    const seeds = cells.map((c) => c.seed);
    expect(new Set(seeds).size).toBe(cells.length);
    expect(Math.min(...seeds)).toBe(90000);
    expect(Math.max(...seeds)).toBe(90359);
    expect(new Set(cells.map(cellKey)).size).toBe(cells.length);
    for (const c of cells) expect(EVAL_SPEC_V1.arenas).toContain(c.arenaSeed);
  });

  it('quick gauntlet (72 cells) is a strict subset with identical seeds', () => {
    const quick = gauntletCells(true);
    expect(quick.length).toBe(12 * 3 * 1 * 2);
    const fullByKey = new Map(gauntletCells(false).map((c) => [cellKey(c), c.seed]));
    for (const c of quick) {
      expect(fullByKey.get(cellKey(c))).toBe(c.seed);
      expect(c.arenaSeed).toBe(EVAL_SPEC_V1.arenas[0]);
    }
  });
});

describe('signTest (exact two-sided binomial)', () => {
  it('10 wins out of 10 → p = 2 × 0.5^10', () => {
    const st = signTest([1, 2, 1, 3, 1, 1, 2, 1, 1, 4]);
    expect(st.pos).toBe(10);
    expect(st.neg).toBe(0);
    expect(st.zero).toBe(0);
    expect(st.pValue).toBeCloseTo(2 * 0.5 ** 10, 10);
  });

  it('balanced deltas → p clamps to 1; ties are excluded', () => {
    expect(signTest([1, -1, 2, -2]).pValue).toBe(1);
    const st = signTest([0, 0, 5]);
    expect(st).toMatchObject({ pos: 1, neg: 0, zero: 2, pValue: 1 });
    expect(signTest([]).pValue).toBe(1);
    expect(signTest([0, 0]).pValue).toBe(1);
  });

  it('clearly one-sided larger samples are significant', () => {
    const deltas = Array.from({ length: 30 }, (_, i) => (i % 6 === 0 ? -1 : 1)); // 25 vs 5
    const st = signTest(deltas);
    expect(st.pos).toBe(25);
    expect(st.neg).toBe(5);
    expect(st.pValue).toBeLessThan(0.001);
  });
});

describe('bootstrapCi', () => {
  it('is deterministic (seeded) and brackets the mean', () => {
    const deltas = Array.from({ length: 50 }, (_, i) => 1 + (i % 5) * 0.1);
    const a = bootstrapCi(deltas);
    const b = bootstrapCi(deltas);
    expect(a).toEqual(b);
    expect(a.lo).toBeLessThanOrEqual(a.mean);
    expect(a.hi).toBeGreaterThanOrEqual(a.mean);
    expect(a.lo).toBeGreaterThan(0); // all-positive data → CI excludes 0
  });

  it('degenerate inputs collapse cleanly', () => {
    expect(bootstrapCi([])).toMatchObject({ mean: 0, lo: 0, hi: 0 });
    const same = bootstrapCi([2, 2, 2, 2]);
    expect(same.lo).toBe(2);
    expect(same.hi).toBe(2);
    expect(same.mean).toBe(2);
  });
});

function fakeCell(opponent: string, key: string, killsFor: number, killsAgainst: number): CellResult {
  return {
    key,
    opponent,
    condition: 'stock',
    arenaSeed: 101,
    seed: 90000,
    win: killsFor > killsAgainst ? 1 : 0,
    draw: killsFor === killsAgainst ? 1 : 0,
    killsFor,
    killsAgainst,
    domFor: killsFor,
    domAgainst: killsAgainst,
    shots: 100,
    hits: 10,
  };
}

describe('summarize + pairedDeltas', () => {
  it('score equal-weights opponents regardless of cell counts', () => {
    const results = [
      fakeCell('classic', 'classic/a', 4, 0), // +4
      fakeCell('classic', 'classic/b', 4, 0), // +4 (classic mean +4)
      fakeCell('pilot', 'pilot/a', 0, 2), // pilot mean −2
    ];
    const s = summarize(results);
    expect(s.perOpponent['classic']?.killDiffPerMatch).toBe(4);
    expect(s.perOpponent['pilot']?.killDiffPerMatch).toBe(-2);
    expect(s.score).toBe((4 + -2) / 2); // NOT the per-match mean (which is +2)
    expect(s.overall.matches).toBe(3);
    expect(s.overall.wins).toBe(2);
    expect(s.overall.hitPct).toBeCloseTo(10);
  });

  it('paired deltas match by cell key and refuse unpaired sets', () => {
    const cand = [fakeCell('classic', 'k1', 5, 1), fakeCell('classic', 'k2', 2, 2)];
    const base = [fakeCell('classic', 'k2', 1, 3), fakeCell('classic', 'k1', 3, 1)];
    const deltas = pairedDeltas(cand, base);
    expect(deltas.map((d) => d.delta)).toEqual([2, 2]); // (5−1)−(3−1), (2−2)−(1−3)
    expect(() => pairedDeltas(cand, base.slice(0, 1))).toThrow(/paired/);
    expect(() =>
      pairedDeltas(cand, [fakeCell('classic', 'k1', 0, 0), fakeCell('classic', 'kX', 0, 0)]),
    ).toThrow(/missing cell/);
  });
});

describe('ledger line', () => {
  it('keeps the registry shape (spec id, score, ci, identities)', () => {
    const results = summarize([fakeCell('classic', 'k1', 3, 1)]);
    const line = buildLedgerLine({
      ts: '2026-06-10T00:00:00.000Z',
      quick: true,
      candidate: { path: 'fights/x.json', coach: 'X', engine: 'pilot', tweaks: {}, hash: 'abc' },
      weights: null,
      baseline: null,
      results,
      baselineResults: null,
      paired: null,
      secs: 1.5,
    });
    expect(Object.keys(line).sort()).toEqual(
      [
        'ts',
        'spec',
        'quick',
        'candidate',
        'weights',
        'baseline',
        'results',
        'baselineResults',
        'score',
        'ci',
        'paired',
        'secs',
      ].sort(),
    );
    expect(line.spec).toBe('EVAL_SPEC_V1');
    expect(line.score).toBe(results.score);
    expect(line.ci).toBeNull();
    expect(JSON.parse(JSON.stringify(line))).toEqual(line); // JSONL-safe
  });
});

describe('determinism (in-memory runCell)', () => {
  it('the same candidate through the same cell twice → identical results', () => {
    registerCardFighter('eval-test-cand', 'pilot', {});
    const cell = gauntletCells(true)[0]!; // classic / stock / arena 101 / seed 90000
    const a = runCell('eval-test-cand', cell, 900); // 15 s round — fast
    const b = runCell('eval-test-cand', cell, 900);
    expect(a).toEqual(b);
    expect(a.opponent).toBe('classic');
    expect(a.seed).toBe(90000);
    expect(a.shots).toBeGreaterThan(0);
  });
});
