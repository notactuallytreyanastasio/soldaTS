// Spectate-mode Game integration (no DOM, synthetic arena, fixed seed):
//
//   (a) the player slot is NEVER spawned/resurrected (pins the health<=0
//       resurrection trap in respawnUpkeep),
//   (b) onKill fires with bot-range attribution (killer !== victim),
//   (c) victims respawn and the match sustains itself,
//   (d) bots never freeze for long stretches (pins the wander fallback),
//   plus a play-mode regression: the default Game still spawns the player.

import { describe, it, expect } from 'vitest';
import { Game } from './game';
import { buildArena, ARENA_SPAWNS } from './arena';
import { parseSpectate } from './main';

const TICK_DT = 1 / 60;
/** Ticks a dead sprite waits before respawning (game.ts RESPAWN_TICKS). */
const RESPAWN_TICKS = 180;

function spectateGame(botCount: number): Game {
  const game = new Game({ seed: 1, spawns: ARENA_SPAWNS, botCount, spectate: true });
  game.loadMap(buildArena());
  return game;
}

describe('Game spectate mode', () => {
  it('numbers the bots into slots 2..1+botCount, leaving slot 1 alone', () => {
    const game = spectateGame(4);
    expect(game.botIndices()).toEqual([2, 3, 4, 5]);
    expect(game.world.sprites[game.playerIndex]?.active).toBe(false);
  });

  it('never activates the player slot, even across respawn upkeep', () => {
    const game = spectateGame(4);
    for (let t = 0; t < 2000; t++) {
      game.tick(TICK_DT);
      expect(game.world.sprites[game.playerIndex]?.active).toBe(false);
    }
  });

  it('sustains a bot-vs-bot match: attributed kills, respawns, no freezes', () => {
    const game = spectateGame(4);
    const botIndices = game.botIndices();

    const kills: { killer: number; victim: number; tick: number }[] = [];
    // victim -> deadline (tick by which it must be alive again).
    const pendingRespawn = new Map<number, number>();
    game.onKill = (killer, victim): void => {
      kills.push({ killer, victim, tick: game.world.mainTickCounter });
      pendingRespawn.set(victim, game.world.mainTickCounter + RESPAWN_TICKS + 20);
    };

    // Per-bot longest streak of fully idle controls (pins the wander fallback:
    // without it a targetless bot's controls stay all-clear forever).
    const idleStreak = new Map<number, number>();
    const maxIdleStreak = new Map<number, number>();

    const MAX_TICKS = 10_000;
    for (let t = 0; t < MAX_TICKS; t++) {
      game.tick(TICK_DT);

      for (const [victim, deadline] of pendingRespawn) {
        const s = game.world.sprites[victim];
        if (s !== undefined && s.active && !s.deadMeat) {
          pendingRespawn.delete(victim);
        } else {
          expect(game.world.mainTickCounter).toBeLessThanOrEqual(deadline);
        }
      }

      for (const i of botIndices) {
        const s = game.world.sprites[i];
        if (s === undefined) continue;
        const idle =
          !s.control.left && !s.control.right && !s.control.up && !s.control.fire;
        const streak = idle ? (idleStreak.get(i) ?? 0) + 1 : 0;
        idleStreak.set(i, streak);
        maxIdleStreak.set(i, Math.max(maxIdleStreak.get(i) ?? 0, streak));
      }
    }

    // The match produced kills attributed within the bot roster. Suicides ARE
    // legal physics since the aerial-combat pass (node 124): bullets are
    // ballistic, so a bot that fires upward and keeps climbing can meet its
    // own falling round. They must stay a small minority of deaths, and real
    // bot-vs-bot kills must dominate.
    expect(kills.length).toBeGreaterThan(0);
    const suicides = kills.filter((k) => k.killer === k.victim);
    for (const k of kills) {
      expect(botIndices).toContain(k.victim);
      expect(botIndices).toContain(k.killer);
    }
    expect(kills.length - suicides.length).toBeGreaterThan(0);
    expect(suicides.length).toBeLessThanOrEqual(kills.length * 0.25);
    // Everyone died at least once got respawned (no pending stragglers beyond
    // their deadline was already asserted in the loop).

    // No bot froze: dead time (180 ticks of cleared controls) plus a roam
    // pause must stay well under this bound.
    for (const i of botIndices) {
      expect(maxIdleStreak.get(i) ?? 0).toBeLessThan(600);
    }
  });
});

describe('parseSpectate (variant + round params)', () => {
  it('parses ?variant by name, undefined when absent', () => {
    expect(parseSpectate('?spectate&variant=thin-air').variant).toBe('thin-air');
    expect(parseSpectate('?spectate').variant).toBeUndefined();
  });

  it('parses ?round=SECS with a 600 s default and garbage tolerance', () => {
    expect(parseSpectate('?spectate&round=20').roundSecs).toBe(20);
    expect(parseSpectate('?spectate').roundSecs).toBe(600);
    expect(parseSpectate('?spectate&round=0').roundSecs).toBe(600);
    expect(parseSpectate('?spectate&round=garbage').roundSecs).toBe(600);
  });

  it('returns both fields in play mode too (main() arms the timer only in spectate)', () => {
    const p = parseSpectate('?play&variant=x&round=9');
    expect(p.spectate).toBe(false);
    expect(p.variant).toBe('x');
    expect(p.roundSecs).toBe(9);
  });
});

describe('Game play mode (regression)', () => {
  it('still spawns the player and keeps the player-facing accessors', () => {
    const game = new Game({});
    const player = game.world.sprites[game.playerIndex];
    expect(player?.active).toBe(true);
    expect(player?.deadMeat).toBe(false);
    expect(game.playerAmmo()).toBe(game.magSize());
    expect(game.playerReloading()).toBe(false);
    expect(game.ammoOf(game.playerIndex)).toBe(game.playerAmmo());
    expect(game.botIndices()).toEqual([2, 3, 4]);
  });

  it('runs ticks with the player participating in respawn upkeep', () => {
    const game = new Game({ seed: 1, spawns: ARENA_SPAWNS, botCount: 2 });
    game.loadMap(buildArena());
    // Kill the player outright; upkeep must arm and then respawn the sprite.
    const player = game.world.sprites[game.playerIndex]!;
    player.health = 0;
    let revived = false;
    for (let t = 0; t < RESPAWN_TICKS + 60; t++) {
      game.tick(TICK_DT);
      if (player.active && !player.deadMeat && player.health > 0) {
        revived = true;
        break;
      }
    }
    expect(revived).toBe(true);
  });
});
