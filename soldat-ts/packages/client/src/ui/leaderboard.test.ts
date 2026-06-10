// Per-team scoreboard pure logic (goal node 157): team kill totals + the
// winningest killer per team (MVP), with the same dominance tiebreak the
// leaderboard ranking uses. The TeamScorePanel DOM shell is exercised by the
// spectate browser harness; the math is pinned here.

import { describe, it, expect } from 'vitest';
import { teamScores, type FighterRow } from './leaderboard';

const row = (
  index: number,
  name: string,
  team: number,
  kills: number,
  deaths: number,
): FighterRow => ({ index, name, engine: 'pilot', team, kills, deaths });

describe('teamScores', () => {
  it('splits kill totals per team and surfaces each MVP', () => {
    const [red, blue] = teamScores([
      row(2, 'Alpha', 1, 9, 3),
      row(3, 'Bravo', 1, 4, 7),
      row(4, 'Charlie', 2, 7, 2),
      row(5, 'Delta', 2, 3, 3),
    ]);
    expect(red.team).toBe(1);
    expect(red.kills).toBe(13);
    expect(red.mvp?.name).toBe('Alpha');
    expect(red.mvp?.kills).toBe(9);
    expect(blue.team).toBe(2);
    expect(blue.kills).toBe(10);
    expect(blue.mvp?.name).toBe('Charlie');
  });

  it('breaks an MVP kill tie on dominance (fewer deaths), then lower index', () => {
    const [red] = teamScores([
      row(2, 'Feeder', 1, 5, 9),
      row(3, 'Trader', 1, 5, 2),
    ]);
    expect(red.mvp?.name).toBe('Trader');

    const [red2] = teamScores([
      row(7, 'Late', 1, 5, 2),
      row(3, 'Early', 1, 5, 2),
    ]);
    expect(red2.mvp?.name).toBe('Early'); // identical record → lower index
  });

  it('a team with no fighters has a null MVP and zero kills', () => {
    const [red, blue] = teamScores([row(2, 'Solo', 1, 6, 1)]);
    expect(red.mvp?.name).toBe('Solo');
    expect(blue.mvp).toBeNull();
    expect(blue.kills).toBe(0);
  });

  it('excludes FFA rows (team 0) from both teams', () => {
    const [red, blue] = teamScores([
      row(2, 'Lone', 0, 99, 0),
      row(3, 'Red', 1, 2, 1),
    ]);
    expect(red.kills).toBe(2);
    expect(red.mvp?.name).toBe('Red');
    expect(blue.mvp).toBeNull();
  });
});
