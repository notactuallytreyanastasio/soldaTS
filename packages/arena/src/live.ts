// Arena live feed — play-by-play state BAKED INTO THE RUNTIME.
//
// Every arena run (card fights and --teams runs alike) maintains
// `<datasets>/LIVE.json`: series header when the first match starts, a row
// per finished match, a final standing when the series ends. The broadcast
// watcher (arena-live/watch.mjs) already polls the datasets dir, so anything
// written here is on the play-by-play site within one poll interval — no
// coupling beyond the file.
//
// Wall-clock timestamps are fine here: LIVE.json is broadcast state, not a
// dataset artifact — determinism guarantees cover only what runner.ts writes
// into the run directory.

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface LiveSide {
  coach: string;
  engine: string;
  tweaks: Readonly<Record<string, number>>;
  rationale?: string | undefined;
}

export interface LiveMatchRow {
  n: number;
  seed: number;
  /** 0 = draw, 1 = red (side A), 2 = blue (side B). */
  winnerTeam: number;
  winnerCoach: string | null;
  redKills: number;
  blueKills: number;
  ticks: number;
  wallSecs: number;
}

interface LiveState {
  schema: 'soldat-arena-live/1';
  status: 'fighting' | 'done';
  startedAt: string;
  updatedAt: string;
  arenaSeed: number;
  roundSecs: number;
  matchesPlanned: number;
  red: LiveSide;
  blue: LiveSide;
  matches: LiveMatchRow[];
  series: { red: number; blue: number; draws: number };
  /** Set when the series ends. */
  dataset?: string;
  watchUrl?: string;
}

export interface LiveFeed {
  matchDone(row: LiveMatchRow): void;
  finish(extra: { dataset?: string; watchUrl?: string }): void;
}

/**
 * Open the live feed for one series. Each update rewrites LIVE.json
 * atomically (tmp + rename) so the watcher never reads a torn file. All
 * writes are best-effort: a broken disk must never kill a fight.
 */
export function startLiveFeed(
  datasetsDir: string,
  init: {
    arenaSeed: number;
    roundSecs: number;
    matchesPlanned: number;
    red: LiveSide;
    blue: LiveSide;
  },
): LiveFeed {
  const file = path.join(datasetsDir, 'LIVE.json');
  const state: LiveState = {
    schema: 'soldat-arena-live/1',
    status: 'fighting',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    arenaSeed: init.arenaSeed,
    roundSecs: init.roundSecs,
    matchesPlanned: init.matchesPlanned,
    red: init.red,
    blue: init.blue,
    matches: [],
    series: { red: 0, blue: 0, draws: 0 },
  };

  const flush = (): void => {
    state.updatedAt = new Date().toISOString();
    try {
      mkdirSync(datasetsDir, { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
      renameSync(tmp, file);
    } catch {
      // Broadcast is best-effort; the fight goes on.
    }
  };

  flush();
  return {
    matchDone(row: LiveMatchRow): void {
      state.matches.push(row);
      if (row.winnerTeam === 1) state.series.red += 1;
      else if (row.winnerTeam === 2) state.series.blue += 1;
      else state.series.draws += 1;
      flush();
    },
    finish(extra: { dataset?: string; watchUrl?: string }): void {
      state.status = 'done';
      if (extra.dataset !== undefined) state.dataset = extra.dataset;
      if (extra.watchUrl !== undefined) state.watchUrl = extra.watchUrl;
      flush();
    },
  };
}
