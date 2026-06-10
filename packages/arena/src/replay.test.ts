// Replay row builder + JSONL serializer (goal node 170).

import { describe, it, expect } from 'vitest';
import { ARENA_SPAWNS, Game, buildArena } from '@soldat/client/headless';
import { buildReplayRow, rowsToJsonl, type ReplayRow } from './replay';

function tinyGame(): Game {
  const game = new Game({
    seed: 2,
    spawns: ARENA_SPAWNS,
    botCount: 2,
    spectate: true,
    aiEngine: 'pilot,reaper',
    teams: true,
  });
  game.loadMap(buildArena());
  return game;
}

describe('buildReplayRow', () => {
  it('captures every field with correct types and rounding', () => {
    const game = tinyGame();
    for (let t = 0; t < 50; t++) game.tick(1 / 60);
    const bot = game.botIndices()[0]!;
    const row = buildReplayRow(game, bot, game.world.mainTickCounter);
    expect(row).not.toBeNull();
    const r = row!;
    expect(r.tick).toBe(game.world.mainTickCounter);
    expect(r.bot).toBe(bot);
    expect([1, 2]).toContain(r.team);
    expect(r.engine).toBe(game.engineOf(bot));
    // 2-decimal kinematics: re-rounding is the identity.
    for (const v of [r.x, r.y, r.vx, r.vy]) {
      expect(v).toBe(Number(v.toFixed(2)));
    }
    expect(r.hp).toBe(Number(r.hp.toFixed(1)));
    expect(Number.isFinite(r.fuel)).toBe(true);
    expect(Number.isInteger(r.ammo)).toBe(true);
    expect(typeof r.reloading).toBe('boolean');
    expect(typeof r.onGround).toBe('boolean');
    expect(Object.keys(r.control)).toEqual([
      'left', 'right', 'up', 'down', 'fire', 'jetpack', 'reload', 'aimX', 'aimY',
    ]);
    expect(Number.isFinite(r.control.aimX)).toBe(true);
  });

  it('returns null for dead or inactive sprites', () => {
    const game = tinyGame();
    const bot = game.botIndices()[0]!;
    game.world.sprites[bot]!.deadMeat = true;
    expect(buildReplayRow(game, bot, 0)).toBeNull();
    // Slot 1 (the never-spawned spectate player) is inactive.
    expect(buildReplayRow(game, game.playerIndex, 0)).toBeNull();
  });
});

describe('rowsToJsonl', () => {
  it('one JSON line per row plus a trailing newline; empty → empty string', () => {
    const game = tinyGame();
    const rows = game
      .botIndices()
      .map((i) => buildReplayRow(game, i, 0))
      .filter((r): r is ReplayRow => r !== null);
    expect(rows.length).toBeGreaterThan(0);
    const jsonl = rowsToJsonl(rows);
    expect(jsonl.endsWith('\n')).toBe(true);
    const lines = jsonl.trimEnd().split('\n');
    expect(lines).toHaveLength(rows.length);
    expect(lines.map((l) => JSON.parse(l) as ReplayRow)).toEqual(rows);
    expect(rowsToJsonl([])).toBe('');
  });
});
