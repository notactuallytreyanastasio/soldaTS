// headless — the client package's node-safe barrel. There is no logic here,
// but the barrel IS a contract: @soldat/arena consumes the game exclusively
// through it, so this test pins the export surface (nothing silently dropped)
// and proves the whole graph imports and RUNS without a DOM — including the
// './ai' side effect that registers the engine roster.

import { describe, it, expect } from 'vitest';
import * as headless from './headless';

describe('headless barrel', () => {
  it('exports the documented game surface', () => {
    expect(typeof headless.Game).toBe('function');
    expect(typeof headless.decideRoundWinner).toBe('function');
    expect(typeof headless.applyAimAssist).toBe('function');
    expect(headless.DEFAULT_TUNING).toBeDefined();
    expect(headless.DEFAULT_TUNING.magSize).toBeGreaterThan(0);
  });

  it('exports the wildcard, telemetry, arena, director, and tournament helpers', () => {
    expect(typeof headless.rollWildcard).toBe('function');
    expect(typeof headless.pickWildcardWeapon).toBe('function');
    expect(typeof headless.resolveWildcard).toBe('function');
    expect(headless.WILDCARD_WEAPONS.length).toBeGreaterThan(0);
    expect(typeof headless.MatchRecorder).toBe('function');
    expect(typeof headless.deriveStats).toBe('function');
    expect(typeof headless.TELEMETRY_SCHEMA).toBe('string');
    expect(typeof headless.buildArena).toBe('function');
    expect(typeof headless.generateArena).toBe('function');
    expect(headless.ARENA_SPAWNS.length).toBeGreaterThan(0);
    expect(typeof headless.subjectName).toBe('function');
    expect(typeof headless.resolveVariant).toBe('function');
    expect(Object.keys(headless.VARIANTS).length).toBeGreaterThan(0);
  });

  it('importing the barrel registers the engine roster (the ./ai side effect)', () => {
    const ids = headless.engineIds();
    for (const id of ['classic', 'pilot', 'reaper']) {
      expect(ids).toContain(id);
    }
    expect(headless.createEngine('classic').id).toBe('classic');
  });

  it('a Game built through the barrel runs headlessly in node', () => {
    const game = new headless.Game({ seed: 5, spectate: true, botCount: 2 });
    game.loadMap(headless.buildArena());
    for (let i = 0; i < 60; i++) game.tick(1 / 60);
    expect(game.world.mainTickCounter).toBe(60);
    expect(game.botIndices()).toHaveLength(2);
  });
});
