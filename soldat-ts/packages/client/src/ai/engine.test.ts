// Bot-engine adapter tests (decision node 136): registry resolution and a
// full Game integration pass proving each engine sustains a bot-vs-bot
// match through the same adapter seam.

import { describe, it, expect } from 'vitest';
import { createEngine, engineIds } from './index';
import { Game } from '../app/game';
import { ARENA_SPAWNS } from '../app/arena';

describe('engine registry', () => {
  it('registers classic, pilot, reaper, matador, kestrel, and wolf', () => {
    expect(engineIds()).toContain('classic');
    expect(engineIds()).toContain('pilot');
    expect(engineIds()).toContain('reaper');
    expect(engineIds()).toContain('matador');
    expect(engineIds()).toContain('kestrel');
    expect(engineIds()).toContain('wolf');
  });

  it('resolves engines by id and falls back to classic on unknown ids', () => {
    expect(createEngine('pilot').id).toBe('pilot');
    expect(createEngine('classic').id).toBe('classic');
    expect(createEngine('definitely-not-real').id).toBe('classic');
    expect(createEngine(undefined).id).toBe('classic');
  });
});

describe.each(['classic', 'pilot', 'reaper', 'matador', 'kestrel', 'wolf'] as const)(
  'spectate match under the %s engine',
  (engine) => {
    it('sustains kills and respawns over 6000 ticks', () => {
      const game = new Game({
        seed: 7,
        spawns: ARENA_SPAWNS,
        botCount: 4,
        spectate: true,
        aiEngine: engine,
      });
      expect(game.aiEngineId).toBe(engine);

      const kills: { killer: number; victim: number }[] = [];
      game.onKill = (killer, victim): void => {
        kills.push({ killer, victim });
      };

      for (let t = 0; t < 6000; t++) game.tick(1 / 60);

      // The match produced kills, and dead bots came back (someone has > 0
      // active sprites at the end — all four, since respawn is 3 s).
      expect(kills.length).toBeGreaterThan(0);
      const alive = game
        .botIndices()
        .filter((i) => game.world.sprites[i]?.active).length;
      expect(alive).toBe(4);
      // Player slot stays out of spectate matches regardless of engine.
      expect(game.world.sprites[game.playerIndex]?.active).toBe(false);
    });
  },
);

describe('mixed-engine matches (one arena, several brains)', () => {
  it('splits bots round-robin across a comma list and reports groups', () => {
    const game = new Game({
      seed: 3,
      spawns: ARENA_SPAWNS,
      botCount: 4,
      spectate: true,
      aiEngine: 'classic,pilot',
    });
    expect(game.aiEngineId).toBe('classic+pilot');
    expect(game.engineGroups()).toEqual(['classic', 'pilot']);
    const assigned = game.botIndices().map((i) => game.engineOf(i));
    expect(assigned).toEqual(['classic', 'pilot', 'classic', 'pilot']);
  });

  it('hot-swap homogenizes or re-mixes the roster', () => {
    const game = new Game({
      seed: 3,
      spawns: ARENA_SPAWNS,
      botCount: 4,
      spectate: true,
      aiEngine: 'classic,pilot',
    });
    game.setEngine('pilot');
    expect(game.engineGroups()).toEqual(['pilot']);
    game.setEngine('pilot,classic');
    expect(game.botIndices().map((i) => game.engineOf(i))).toEqual([
      'pilot',
      'classic',
      'pilot',
      'classic',
    ]);
  });

  it('a mixed match sustains itself (both brains fight in one world)', () => {
    const game = new Game({
      seed: 11,
      spawns: ARENA_SPAWNS,
      botCount: 4,
      spectate: true,
      aiEngine: 'classic,pilot',
    });
    const kills: { killer: number; victim: number }[] = [];
    game.onKill = (killer, victim): void => {
      kills.push({ killer, victim });
    };
    for (let t = 0; t < 6000; t++) game.tick(1 / 60);
    expect(kills.length).toBeGreaterThan(0);
  });
});

describe('play mode under the adapter (regression)', () => {
  it('default Game still spawns the player with classic bots', () => {
    const game = new Game({});
    expect(game.aiEngineId).toBe('classic');
    expect(game.world.sprites[game.playerIndex]?.active).toBe(true);
    expect(game.playerAmmo()).toBeGreaterThan(0);
  });
});

describe('team dynamics (red vs blue, goal node 154)', () => {
  it('mixed matches put each engine on its own team', () => {
    const game = new Game({
      seed: 5,
      spawns: ARENA_SPAWNS,
      botCount: 4,
      spectate: true,
      aiEngine: 'classic,pilot',
    });
    expect(game.teamsEnabled).toBe(true);
    const teams = game.botIndices().map((i) => game.teamOf(i));
    expect(teams).toEqual([1, 2, 1, 2]); // classic=red, pilot=blue
    // The sim sprites carry the team (renderer + targeting read it).
    for (const i of game.botIndices()) {
      expect(game.world.sprites[i]?.team).toBe(game.teamOf(i));
    }
  });

  it('uniform matches stay FFA unless ?teams forces them', () => {
    const ffa = new Game({ seed: 5, spawns: ARENA_SPAWNS, botCount: 4, spectate: true });
    expect(ffa.teamsEnabled).toBe(false);
    expect(ffa.botIndices().every((i) => ffa.teamOf(i) === 0)).toBe(true);

    const teamed = new Game({
      seed: 5,
      spawns: ARENA_SPAWNS,
      botCount: 4,
      spectate: true,
      teams: true,
    });
    expect(teamed.botIndices().map((i) => teamed.teamOf(i))).toEqual([1, 2, 1, 2]);
  });

  it('a team match sustains cross-team kills only', () => {
    const game = new Game({
      seed: 13,
      spawns: ARENA_SPAWNS,
      botCount: 4,
      spectate: true,
      aiEngine: 'classic,pilot',
    });
    const kills: { killer: number; victim: number }[] = [];
    game.onKill = (killer, victim): void => {
      kills.push({ killer, victim });
    };
    for (let t = 0; t < 6000; t++) game.tick(1 / 60);
    expect(kills.length).toBeGreaterThan(0);
    // Friendly fire is off and teammates are never targeted: every
    // attributed kill crosses teams.
    for (const k of kills) {
      if (k.killer > 0 && k.killer !== k.victim) {
        expect(game.teamOf(k.killer)).not.toBe(game.teamOf(k.victim));
      }
    }
  });
});


describe('whole teams (user correction on node 157)', () => {
  it('a lopsided roster still yields even, single-engine teams', () => {
    // Evolved-style 5:1 roster: red must still be ALL classic, blue ALL
    // pilot, split 3v3 — never 1v5 "everyone is on pilot".
    const game = new Game({
      seed: 9,
      spawns: ARENA_SPAWNS,
      botCount: 6,
      spectate: true,
      aiEngine: 'classic,pilot,pilot,pilot,pilot,pilot',
    });
    const byTeam = new Map<number, string[]>();
    for (const i of game.botIndices()) {
      const t = game.teamOf(i);
      byTeam.set(t, [...(byTeam.get(t) ?? []), game.engineOf(i)]);
    }
    expect(byTeam.get(1)).toEqual(['classic', 'classic', 'classic']);
    expect(byTeam.get(2)).toEqual(['pilot', 'pilot', 'pilot']);
  });

  it('FFA (no teams) keeps the roster proportions', () => {
    const game = new Game({
      seed: 9,
      spawns: ARENA_SPAWNS,
      botCount: 6,
      spectate: true,
      aiEngine: 'classic,pilot,pilot,pilot,pilot,pilot',
      teams: false,
    });
    const pilots = game.botIndices().filter((i) => game.engineOf(i) === 'pilot');
    expect(pilots).toHaveLength(5);
  });
});
