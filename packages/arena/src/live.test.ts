// LIVE.json broadcast feed: the play-by-play state every arena run maintains
// in the datasets dir for the watcher site. Atomic, best-effort, schema'd.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startLiveFeed } from './live';

const SIDES = {
  red: { coach: 'VERONICA', engine: 'matador', tweaks: { POKE_MIN: 380 }, rationale: 'the mag is the clock' },
  blue: { coach: 'FALCONER', engine: 'kestrel', tweaks: {} },
};

describe('startLiveFeed', () => {
  it('writes the header immediately, then rows, then the final standing', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'arena-live-'));
    try {
      const live = startLiveFeed(dir, {
        arenaSeed: 67,
        roundSecs: 120,
        matchesPlanned: 3,
        ...SIDES,
      });
      const file = path.join(dir, 'LIVE.json');
      const read = (): any => JSON.parse(readFileSync(file, 'utf8'));

      let state = read();
      expect(state.schema).toBe('soldat-arena-live/1');
      expect(state.status).toBe('fighting');
      expect(state.red.coach).toBe('VERONICA');
      expect(state.matches).toEqual([]);

      live.matchDone({
        n: 1, seed: 1337, winnerTeam: 1, winnerCoach: 'VERONICA',
        redKills: 40, blueKills: 38, ticks: 7200, wallSecs: 0.9,
      });
      live.matchDone({
        n: 2, seed: 1338, winnerTeam: 0, winnerCoach: null,
        redKills: 41, blueKills: 41, ticks: 7200, wallSecs: 0.8,
      });
      state = read();
      expect(state.status).toBe('fighting');
      expect(state.matches).toHaveLength(2);
      expect(state.series).toEqual({ red: 1, blue: 0, draws: 1 });

      live.finish({ dataset: '/tmp/run', watchUrl: 'http://localhost:5173/?x' });
      state = read();
      expect(state.status).toBe('done');
      expect(state.dataset).toBe('/tmp/run');
      expect(state.watchUrl).toBe('http://localhost:5173/?x');
      // No torn tmp file left behind.
      expect(existsSync(`${file}.tmp`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never throws when the directory is unwritable (broadcast is best-effort)', () => {
    const live = startLiveFeed('/dev/null/not-a-dir', {
      arenaSeed: 0,
      roundSecs: 120,
      matchesPlanned: 1,
      ...SIDES,
    });
    expect(() => {
      live.matchDone({
        n: 1, seed: 1, winnerTeam: 2, winnerCoach: 'FALCONER',
        redKills: 0, blueKills: 1, ticks: 60, wallSecs: 0.1,
      });
      live.finish({});
    }).not.toThrow();
  });
});
