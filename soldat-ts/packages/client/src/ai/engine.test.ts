// Bot-engine adapter tests (decision node 136): registry resolution and a
// full Game integration pass proving each engine sustains a bot-vs-bot
// match through the same adapter seam.

import { describe, it, expect } from 'vitest';
import { createEngine, engineIds } from './index';
import { Game } from '../app/game';
import { ARENA_SPAWNS } from '../app/arena';

describe('engine registry', () => {
  it('registers classic and pilot', () => {
    expect(engineIds()).toContain('classic');
    expect(engineIds()).toContain('pilot');
  });

  it('resolves engines by id and falls back to classic on unknown ids', () => {
    expect(createEngine('pilot').id).toBe('pilot');
    expect(createEngine('classic').id).toBe('classic');
    expect(createEngine('definitely-not-real').id).toBe('classic');
    expect(createEngine(undefined).id).toBe('classic');
  });
});

describe.each(['classic', 'pilot'] as const)(
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

describe('play mode under the adapter (regression)', () => {
  it('default Game still spawns the player with classic bots', () => {
    const game = new Game({});
    expect(game.aiEngineId).toBe('classic');
    expect(game.world.sprites[game.playerIndex]?.active).toBe(true);
    expect(game.playerAmmo()).toBeGreaterThan(0);
  });
});
