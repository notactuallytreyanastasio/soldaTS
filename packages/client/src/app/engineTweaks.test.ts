// Game engineTweaks wiring (goal node 170):
//   - per-engine tweak overrides reach the engines (resolvedTweaks reports
//     the FULL config each side ran with),
//   - NO tweaks ⇒ byte-identical behavior to a Game built without the option
//     (the browser game is untouched),
//   - tweaks actually change the simulation (divergence),
//   - setEngine hot-swaps preserve the match's tweaks,
//   - the onBrainsTicked replay seam fires once per sim tick, post-think,
//     and stops at the round freeze.

import { describe, it, expect } from 'vitest';
import { Game } from './game';
import { buildArena, ARENA_SPAWNS } from './arena';

const TICK_DT = 1 / 60;

function mixedGame(engineTweaks?: Record<string, Record<string, number>>): Game {
  const game = new Game({
    seed: 7,
    spawns: ARENA_SPAWNS,
    botCount: 4,
    spectate: true,
    aiEngine: 'pilot,reaper',
    ...(engineTweaks !== undefined ? { engineTweaks } : {}),
  });
  game.loadMap(buildArena());
  return game;
}

/** Sprite positions of every bot, for behavior-identity comparisons. */
function positions(game: Game): [number, number][] {
  const parts = game.world.spriteParts!;
  return game.botIndices().map((i) => [parts.posX[i] ?? 0, parts.posY[i] ?? 0]);
}

describe('Game engineTweaks', () => {
  it('propagates per-engine overrides; untouched knobs stay default', () => {
    const game = new Game({
      seed: 1,
      spawns: ARENA_SPAWNS,
      botCount: 4,
      spectate: true,
      aiEngine: 'pilot,reaper',
      engineTweaks: { pilot: { RANGE_MAX: 500 }, reaper: { KILL_RANGE: 220 } },
    });
    expect(game.resolvedTweaks('pilot')!.RANGE_MAX).toBe(500);
    expect(game.resolvedTweaks('reaper')!.KILL_RANGE).toBe(220);
    expect(game.resolvedTweaks('pilot')!.RANGE_MIN).toBe(200);
    expect(game.resolvedTweaks('classic')).toBeUndefined();
  });

  it('no tweaks and empty tweaks are byte-identical over 2000 ticks', () => {
    const plain = mixedGame();
    const empty = mixedGame({});
    for (let t = 0; t < 2000; t++) {
      plain.tick(TICK_DT);
      empty.tick(TICK_DT);
    }
    expect(positions(empty)).toEqual(positions(plain));
  });

  it('a tweak changes the sim: positions diverge within 3000 ticks', () => {
    const plain = mixedGame();
    const tweaked = mixedGame({ pilot: { RANGE_MAX: 900 } });
    let diverged = false;
    for (let t = 0; t < 3000 && !diverged; t++) {
      plain.tick(TICK_DT);
      tweaked.tick(TICK_DT);
      diverged = JSON.stringify(positions(plain)) !== JSON.stringify(positions(tweaked));
    }
    expect(diverged).toBe(true);
  });

  it('setEngine hot-swap preserves the match tweaks', () => {
    const game = mixedGame({ pilot: { RANGE_MAX: 500 } });
    game.setEngine('pilot,reaper');
    expect(game.resolvedTweaks('pilot')!.RANGE_MAX).toBe(500);
  });
});

describe('Game.onBrainsTicked (replay seam)', () => {
  it('fires once per sim tick with strictly increasing ticks from 0, controls readable', () => {
    const game = mixedGame();
    const ticks: number[] = [];
    game.onBrainsTicked = (tick): void => {
      ticks.push(tick);
      // Every live bot's freshly-written control is readable mid-callback.
      for (const i of game.botIndices()) {
        const s = game.world.sprites[i];
        if (s === undefined || !s.active || s.deadMeat) continue;
        expect(typeof s.control.fire).toBe('boolean');
        expect(Number.isFinite(s.control.mouseAimX)).toBe(true);
      }
    };
    for (let t = 0; t < 100; t++) game.tick(TICK_DT);
    expect(ticks).toHaveLength(100);
    expect(ticks[0]).toBe(0);
    for (let i = 1; i < ticks.length; i++) expect(ticks[i]).toBeGreaterThan(ticks[i - 1]!);
  });

  it('stops firing once the round result freezes the game', () => {
    const game = new Game({
      seed: 3,
      spawns: ARENA_SPAWNS,
      botCount: 4,
      spectate: true,
      aiEngine: 'pilot,reaper',
      teams: true,
      roundTicks: 120,
    });
    game.loadMap(buildArena());
    let calls = 0;
    game.onBrainsTicked = (): void => {
      calls += 1;
    };
    for (let t = 0; t < 400; t++) game.tick(TICK_DT);
    expect(game.roundResult).not.toBeNull();
    const atFreeze = calls;
    for (let t = 0; t < 100; t++) game.tick(TICK_DT);
    expect(calls).toBe(atFreeze);
  });
});
