// Timed rounds + per-match tuning (goal node 157):
//
//   (a) decideRoundWinner — kill totals, dominance tiebreak, draw fallback,
//   (b) GameOptions.tuning — partial overrides of DEFAULT_TUNING per instance
//       (and NO tuning option = exactly the stock numbers: ?play unchanged),
//   (c) the round freeze — a teamed Game with roundTicks set stops its sim
//       clock at the verdict tick; an FFA Game with the same roundTicks runs
//       forever (the timer is only armed when teamsEnabled).

import { describe, it, expect } from 'vitest';
import { Game, decideRoundWinner, DEFAULT_TUNING } from './game';

const TICK_DT = 1 / 60;

describe('decideRoundWinner', () => {
  it('the team with more kills wins', () => {
    const r = decideRoundWinner(
      [
        { team: 1, kills: 5, deaths: 2 },
        { team: 1, kills: 4, deaths: 6 },
        { team: 2, kills: 3, deaths: 5 },
        { team: 2, kills: 4, deaths: 4 },
      ],
      36000,
    );
    expect(r.winnerTeam).toBe(1);
    expect(r.redKills).toBe(9);
    expect(r.blueKills).toBe(7);
    expect(r.overAtTick).toBe(36000);
  });

  it('blue wins on more kills', () => {
    const r = decideRoundWinner(
      [
        { team: 1, kills: 2, deaths: 1 },
        { team: 2, kills: 6, deaths: 3 },
      ],
      100,
    );
    expect(r.winnerTeam).toBe(2);
  });

  it('breaks a kill tie on total dominance (fewer deaths)', () => {
    const r = decideRoundWinner(
      [
        { team: 1, kills: 5, deaths: 8 },
        { team: 2, kills: 5, deaths: 2 },
      ],
      100,
    );
    expect(r.redKills).toBe(5);
    expect(r.blueKills).toBe(5);
    expect(r.redDom).toBe(1); // 5 - 0.5*8
    expect(r.blueDom).toBe(4); // 5 - 0.5*2
    expect(r.winnerTeam).toBe(2);
  });

  it('a kill AND dominance tie is a draw', () => {
    const r = decideRoundWinner(
      [
        { team: 1, kills: 4, deaths: 4 },
        { team: 2, kills: 4, deaths: 4 },
      ],
      100,
    );
    expect(r.winnerTeam).toBe(0);
  });

  it('empty rows draw with zeroed totals', () => {
    const r = decideRoundWinner([], 50);
    expect(r).toEqual({
      overAtTick: 50,
      winnerTeam: 0,
      redKills: 0,
      blueKills: 0,
      redDom: 0,
      blueDom: 0,
    });
  });
});

describe('Game tuning', () => {
  it('applies partial overrides and keeps defaults for the rest', () => {
    const game = new Game({ spectate: true, botCount: 2, tuning: { magSize: 5, jetFuelMax: 320 } });
    expect(game.magSize()).toBe(5);
    const bot = game.botIndices()[0]!;
    expect(game.ammoOf(bot)).toBe(5);
    expect(game.world.sprites[bot]?.jetsCount).toBe(320);
    // Unspecified keys keep the stock numbers.
    expect(game.tuning.fireInterval).toBe(DEFAULT_TUNING.fireInterval);
  });

  it('no tuning option = exactly DEFAULT_TUNING (play mode unchanged)', () => {
    const game = new Game({ spectate: true, botCount: 2 });
    expect(game.tuning).toEqual(DEFAULT_TUNING);
  });
});

describe('Game timed round', () => {
  it('decides at roundTicks and FREEZES the sim clock', () => {
    // Mixed engines → teamsEnabled defaults ON (engine warfare).
    const g = new Game({ spectate: true, botCount: 2, aiEngine: 'classic,pilot', roundTicks: 30 });
    expect(g.teamsEnabled).toBe(true);
    for (let i = 0; i < 120; i++) g.tick(TICK_DT);
    expect(g.roundResult).not.toBeNull();
    expect(g.roundResult!.overAtTick).toBe(30); // the first qualifying tick
    expect(g.world.mainTickCounter).toBe(30); // frozen — 90 extra ticks went nowhere
  });

  it('stays endless when teams are off, roundTicks notwithstanding', () => {
    // Uniform engine, no ?teams → FFA → the round timer is never armed.
    const g = new Game({ spectate: true, botCount: 2, roundTicks: 30 });
    expect(g.teamsEnabled).toBe(false);
    for (let i = 0; i < 90; i++) g.tick(TICK_DT);
    expect(g.roundResult).toBeNull();
    expect(g.world.mainTickCounter).toBe(90);
  });
});
