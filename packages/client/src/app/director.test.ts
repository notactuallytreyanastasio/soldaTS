// Director — the pure action-camera rules (scoreSubject / pickSubject), the
// kill board helpers (applyKill / ffaScores), and the stateful Director shell.
// All times are sim ticks; everything here is deterministic by construction.

import { describe, it, expect } from 'vitest';
import {
  DWELL_TICKS,
  KILL_HEAT_TICKS,
  FIRING_BONUS,
  HYSTERESIS,
  FEED_KEEP,
  scoreSubject,
  pickSubject,
  applyKill,
  ffaScores,
  subjectName,
  Director,
  type SubjectInfo,
  type KillBoard,
} from './director';

/** Build a SubjectInfo with watchable defaults, overridable per test. */
function subject(index: number, over: Partial<SubjectInfo> = {}): SubjectInfo {
  return {
    index,
    alive: true,
    x: 0,
    y: 0,
    firing: false,
    lastKillTick: -Infinity,
    nearestEnemyDist: Infinity,
    ...over,
  };
}

describe('scoreSubject', () => {
  it('returns -Infinity for dead subjects', () => {
    expect(scoreSubject(subject(2, { alive: false, firing: true }), 100)).toBe(-Infinity);
  });

  it('kill heat decays linearly to 0 after KILL_HEAT_TICKS', () => {
    const s = subject(2, { lastKillTick: 1000 });
    const fresh = scoreSubject(s, 1000);
    const half = scoreSubject(s, 1000 + KILL_HEAT_TICKS / 2);
    const cold = scoreSubject(s, 1000 + KILL_HEAT_TICKS);
    expect(fresh).toBe(KILL_HEAT_TICKS * 2);
    expect(half).toBe(KILL_HEAT_TICKS);
    expect(cold).toBe(0);
  });

  it('firing beats mid-range proximity', () => {
    const shooter = subject(2, { firing: true });
    const lurker = subject(3, { nearestEnemyDist: 300 });
    expect(scoreSubject(shooter, 0)).toBe(FIRING_BONUS);
    expect(scoreSubject(shooter, 0)).toBeGreaterThan(scoreSubject(lurker, 0));
  });
});

describe('pickSubject', () => {
  it('dwell blocks switching even against a much higher score', () => {
    const subjects = [subject(2), subject(3, { firing: true, lastKillTick: 100 })];
    // Switched at tick 100; now inside the dwell window.
    expect(pickSubject(subjects, 2, 0, 100 + DWELL_TICKS - 1, 100)).toBe(2);
  });

  it('after dwell, switching requires clearing the hysteresis margin', () => {
    // Challenger leads by FIRING_BONUS (150) > HYSTERESIS (100) → switch.
    const big = [subject(2), subject(3, { firing: true })];
    expect(pickSubject(big, 2, 0, DWELL_TICKS, 0)).toBe(3);
    // Challenger leads by less than HYSTERESIS → hold.
    const small = [
      subject(2, { nearestEnemyDist: 0 }), // prox max 150
      subject(3, { firing: true, nearestEnemyDist: 360 }), // 150 + 60
    ];
    expect(pickSubject(small, 2, 0, DWELL_TICKS, 0)).toBe(2);
  });

  it('dead current switches immediately, preferring the killer', () => {
    const subjects = [
      subject(2, { alive: false }),
      subject(3),
      subject(4, { firing: true, lastKillTick: 50 }),
    ];
    // Killer (3) alive → cut to the killer even though 4 scores higher.
    expect(pickSubject(subjects, 2, 3, 50, 50)).toBe(3);
  });

  it('dead current with a dead killer falls back to the argmax', () => {
    const subjects = [
      subject(2, { alive: false }),
      subject(3, { alive: false }),
      subject(4, { firing: true }),
      subject(5),
    ];
    expect(pickSubject(subjects, 2, 3, 0, 0)).toBe(4);
  });

  it('ties break to the lowest index', () => {
    const subjects = [
      subject(2, { alive: false }),
      subject(5, { firing: true }),
      subject(3, { firing: true }),
    ];
    expect(pickSubject(subjects, 2, 0, 0, 0)).toBe(3);
  });

  it('an all-dead frame keeps the current subject without crashing', () => {
    const subjects = [subject(2, { alive: false }), subject(3, { alive: false })];
    expect(pickSubject(subjects, 2, 3, 1000, 0)).toBe(2);
  });
});

describe('Director (stateful shell)', () => {
  it('manual mode holds the pinned subject regardless of scores', () => {
    const d = new Director(2);
    d.setManual(2, 0);
    const subjects = [subject(2), subject(3, { firing: true, lastKillTick: 5000 })];
    expect(d.update(subjects, 5000)).toBe(2);
    expect(d.mode).toBe('manual');
  });

  it('manual + dead followee cuts once (killer preferred) and stays manual', () => {
    const d = new Director(2);
    d.setManual(2, 0);
    d.notifyKill(3, 2, 10); // bot 3 killed the followee
    const subjects = [subject(2, { alive: false }), subject(3), subject(4)];
    expect(d.update(subjects, 10)).toBe(3);
    expect(d.mode).toBe('manual');
    expect(d.switched).toBe(true);
    // Next frame: holds the new subject (no further cuts).
    const after = [subject(2), subject(3), subject(4, { firing: true })];
    expect(d.update(after, 11)).toBe(3);
    expect(d.switched).toBe(false);
  });

  it('auto mode follows pickSubject and records the switch tick', () => {
    const d = new Director(2);
    const subjects = [subject(2), subject(3, { firing: true })];
    // After the (initial) dwell expires, the challenger takes the camera.
    expect(d.update(subjects, DWELL_TICKS)).toBe(3);
    expect(d.switched).toBe(true);
    // Fresh dwell window: an even hotter subject cannot steal it yet.
    const hotter = [subject(2, { lastKillTick: DWELL_TICKS + 1 }), subject(3, { firing: true })];
    expect(d.update(hotter, DWELL_TICKS + 2)).toBe(3);
  });
});

describe('applyKill / ffaScores', () => {
  const names = (i: number): string => subjectName(i, 1);

  function freshBoard(): KillBoard {
    return { kills: new Map<number, number>(), feed: [] };
  }

  it('credits valid kills and writes a newest-first feed entry', () => {
    const board = freshBoard();
    applyKill(board, 2, 3, names, 2);
    applyKill(board, 4, 2, names, 2);
    expect(board.kills.get(2)).toBe(1);
    expect(board.kills.get(4)).toBe(1);
    expect(board.feed[0]?.killer).toBe(subjectName(4));
    expect(board.feed[0]?.victim).toBe(subjectName(2));
    expect(board.feed[1]?.killer).toBe(subjectName(2));
    // byLocalPlayer marks kills by the followed subject (index 2 here).
    expect(board.feed[1]?.byLocalPlayer).toBe(true);
    expect(board.feed[0]?.byLocalPlayer).toBe(false);
  });

  it('suicides and unattributed deaths add no tally and an empty killer', () => {
    const board = freshBoard();
    applyKill(board, 3, 3, names, 1); // suicide
    applyKill(board, 0, 4, names, 1); // no attribution
    expect(board.kills.size).toBe(0);
    expect(board.feed).toHaveLength(2);
    expect(board.feed[0]?.killer).toBe('');
    expect(board.feed[1]?.killer).toBe('');
  });

  it('caps the feed at FEED_KEEP entries', () => {
    const board = freshBoard();
    for (let i = 0; i < FEED_KEEP + 4; i++) {
      applyKill(board, 2, 3, names, 1);
    }
    expect(board.feed).toHaveLength(FEED_KEEP);
  });

  it('maps the FFA tally onto leader/runner-up scores', () => {
    const kills = new Map<number, number>([
      [2, 5],
      [3, 3],
      [4, 1],
    ]);
    const leaderView = ffaScores(kills, 2);
    expect(leaderView).toEqual({ alpha: 5, bravo: 3, playerKills: 5, leading: true, gap: 0 });
    const trailerView = ffaScores(kills, 4);
    expect(trailerView).toEqual({ alpha: 5, bravo: 3, playerKills: 1, leading: false, gap: 4 });
  });

  it('handles a tied leader and an empty board', () => {
    const tied = new Map<number, number>([
      [2, 4],
      [3, 4],
    ]);
    expect(ffaScores(tied, 3)).toEqual({
      alpha: 4,
      bravo: 4,
      playerKills: 4,
      leading: true,
      gap: 0,
    });
    expect(ffaScores(new Map(), 2)).toEqual({
      alpha: 0,
      bravo: 0,
      playerKills: 0,
      leading: false,
      gap: 0,
    });
  });
});
