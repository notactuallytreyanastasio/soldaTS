// Dataset store (goal node 170): runId format, the on-disk run layout
// (gzip round-trip, manifest provenance, file pointers), and the cross-match
// summary math.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { DEFAULT_TUNING, VARIANTS, createEngine } from '@soldat/client/headless';
import { runMatch, type MatchResult, type TeamSpec } from './runner';
import {
  buildManifest,
  buildSummary,
  makeRunId,
  writeRun,
  type RunManifest,
  type RunSummary,
} from './store';

describe('makeRunId', () => {
  it('formats YYYYMMDD-HHMMSS-<a>-vs-<b> in UTC from the injected clock', () => {
    const now = new Date(Date.UTC(2026, 5, 10, 15, 30, 5));
    expect(makeRunId('pilot', 'reaper', undefined, now)).toBe(
      '20260610-153005-pilot-vs-reaper',
    );
  });

  it('appends the suffix when given', () => {
    const now = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));
    expect(makeRunId('pilot', 'reaper', 'RANGE_MAX-420', now)).toBe(
      '20260102-030405-pilot-vs-reaper-RANGE_MAX-420',
    );
  });
});

describe('writeRun + buildManifest + buildSummary', () => {
  let tmp: string;
  let teams: readonly [TeamSpec, TeamSpec];
  let results: MatchResult[];
  let dir: string;
  let manifest: RunManifest;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-'));
    teams = [{ engine: 'pilot', tweaks: { RANGE_MAX: 500 } }, { engine: 'reaper' }];
    // Non-baseline variant so the manifest proves TUNING resolution too.
    results = [5, 6].map((seed) =>
      runMatch({ seed, teams, botCount: 4, variant: 'high-octane', roundTicks: 600 }),
    );
    manifest = buildManifest({
      runId: 'test-run',
      teams,
      results,
      variantName: 'high-octane',
      botCount: 4,
      roundTicks: 600,
      maxTicks: 1200,
      cli: '--teams pilot vs reaper',
    });
    dir = writeRun(tmp, 'test-run', manifest, results);
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('writes every expected file', () => {
    const files = fs.readdirSync(dir).sort();
    expect(files).toEqual([
      'manifest.json',
      'match-1.events.jsonl',
      'match-1.replay.jsonl.gz',
      'match-1.telemetry.json',
      'match-2.events.jsonl',
      'match-2.replay.jsonl.gz',
      'match-2.telemetry.json',
      'summary.json',
    ]);
  });

  it('gzip round-trips the replay byte-for-byte', () => {
    const gz = fs.readFileSync(path.join(dir, 'match-1.replay.jsonl.gz'));
    expect(gunzipSync(gz).toString()).toBe(results[0]!.replayJsonl);
  });

  it('manifest carries full provenance', () => {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'),
    ) as RunManifest;
    expect(parsed.schema).toBe('soldat-arena-replay/1');
    expect(parsed.gitRev.length).toBeGreaterThan(0);
    expect(parsed.cli).toBe('--teams pilot vs reaper');
    // Resolved tweaks = the engines' full configs, overrides applied.
    expect(parsed.teams[0].requestedTweaks).toEqual({ RANGE_MAX: 500 });
    expect(parsed.teams[0].resolvedTweaks).toEqual({
      ...createEngine('pilot').tweaks,
      RANGE_MAX: 500,
    });
    expect(parsed.teams[1].resolvedTweaks).toEqual({ ...createEngine('reaper').tweaks });
    // Resolved tuning = DEFAULT_TUNING + the named variant's overrides.
    const variant = VARIANTS.find((v) => v.name === 'high-octane')!;
    expect(parsed.variant.tuning).toEqual({ ...DEFAULT_TUNING, ...variant.tuning });
    // File pointers reference real files.
    for (const m of parsed.matches) {
      for (const f of Object.values(m.files)) {
        expect(fs.existsSync(path.join(dir, f))).toBe(true);
      }
    }
  });

  it('summary totals are consistent with the match results', () => {
    const summary = JSON.parse(
      fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'),
    ) as RunSummary;
    expect(summary.schema).toBe('soldat-arena-summary/1');
    expect(summary.matches).toHaveLength(2);

    let redWins = 0;
    let blueWins = 0;
    let draws = 0;
    for (const r of results) {
      if (r.round === null || r.round.winnerTeam === 0) draws += 1;
      else if (r.round.winnerTeam === 1) redWins += 1;
      else blueWins += 1;
    }
    expect(summary.standings.red.wins).toBe(redWins);
    expect(summary.standings.blue.wins).toBe(blueWins);
    expect(summary.standings.draws).toBe(draws);
    expect(summary.standings.red.engine).toBe('pilot');
    expect(summary.standings.blue.engine).toBe('reaper');

    // Per-bot rows: summed kills match the team totals, hitRate = hits/shots.
    const redBotKills = summary.bots
      .filter((b) => b.team === 1)
      .reduce((a, b) => a + b.kills, 0);
    expect(redBotKills).toBe(summary.standings.red.kills);
    for (const b of summary.bots) {
      expect(b.hitRate).toBe(b.shots > 0 ? b.hits / b.shots : 0);
    }
    // Sorted kills desc.
    for (let i = 1; i < summary.bots.length; i++) {
      expect(summary.bots[i]!.kills).toBeLessThanOrEqual(summary.bots[i - 1]!.kills);
    }
    // Winner: more wins, kills tiebreak, '' on a dead tie.
    const expectWinner =
      redWins > blueWins
        ? 'pilot'
        : blueWins > redWins
          ? 'reaper'
          : summary.standings.red.kills > summary.standings.blue.kills
            ? 'pilot'
            : summary.standings.blue.kills > summary.standings.red.kills
              ? 'reaper'
              : '';
    expect(summary.standings.winner).toBe(expectWinner);
  });
});
