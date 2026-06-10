import { describe, it, expect } from 'vitest';
import { buildArena, ARENA_SPAWNS, generateArena } from './arena';

describe('buildArena', () => {
  const map = buildArena();

  it('returns at least 6 polygons', () => {
    expect(map.polygons.length).toBeGreaterThanOrEqual(6);
  });

  it('returns at least 4 spawnpoints', () => {
    expect(map.spawnpoints.length).toBeGreaterThanOrEqual(4);
  });

  it('emits polygons with exactly 3 vertices each', () => {
    for (const poly of map.polygons) {
      expect(poly.vertices).toHaveLength(3);
    }
  });

  it('emits an even polygon count (rectangles as triangle pairs)', () => {
    expect(map.polygons.length % 2).toBe(0);
  });

  it('marks every spawnpoint active on team 0', () => {
    expect(map.spawnpoints.length).toBeGreaterThan(0);
    for (const sp of map.spawnpoints) {
      expect(sp.active).toBe(true);
      expect(sp.team).toBe(0);
    }
  });

  it('is gridless (no sectors)', () => {
    expect(map.sectorsDivision).toBe(0);
    expect(map.sectorsNum).toBe(0);
    expect(map.sectors).toHaveLength(0);
  });

  it('exposes one ARENA_SPAWNS anchor per spawnpoint', () => {
    expect(ARENA_SPAWNS.length).toBe(map.spawnpoints.length);
    expect(ARENA_SPAWNS.length).toBeGreaterThanOrEqual(4);
  });
});

// Skyreach aerial-arena shape (goal node 124): the level must be big and
// vertical, with most spawns up in the air, or the jetpack-combat focus is
// hollow.
describe('Skyreach aerial layout', () => {
  const map = buildArena();

  it('spans a wide and tall airspace', () => {
    const xs = map.polygons.flatMap((p) => p.vertices.map((v) => v.x));
    const ys = map.polygons.flatMap((p) => p.vertices.map((v) => v.y));
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThanOrEqual(2400);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThanOrEqual(900);
  });

  it('puts most spawns well above the ground floor', () => {
    const groundTop = Math.max(
      ...map.polygons.flatMap((p) => p.vertices.map((v) => v.y)),
    );
    const airborne = ARENA_SPAWNS.filter((s) => groundTop - s.y > 250);
    expect(airborne.length).toBeGreaterThanOrEqual(ARENA_SPAWNS.length * 0.7);
  });
});

// Generated arena family (node 186): deterministic, sealed, aerial.
describe('generateArena', () => {
  it('is deterministic per seed and distinct across seeds', () => {
    const a1 = generateArena(7);
    const a2 = generateArena(7);
    const b = generateArena(8);
    expect(JSON.stringify(a1.map)).toBe(JSON.stringify(a2.map));
    expect(JSON.stringify(a1.map)).not.toBe(JSON.stringify(b.map));
    expect(a1.map.mapName).toBe('Skyreach-#7');
  });

  it('seed 0 is the canonical hand-built Skyreach', () => {
    const g = generateArena(0);
    expect(g.map.mapName).toBe('Skyreach');
    expect(g.spawns).toEqual(ARENA_SPAWNS);
  });

  it('always seals the box and provides enough aerial spawns', () => {
    for (const seed of [1, 7, 42, 1999]) {
      const g = generateArena(seed);
      const ys = g.map.polygons.flatMap((p) => p.vertices.map((v) => v.y));
      expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThanOrEqual(900);
      expect(g.spawns.length).toBeGreaterThanOrEqual(4);
      const groundTop = 560;
      // Most spawns float well above the floor — the aerial identity holds.
      const airborne = g.spawns.filter((s) => groundTop - s.y > 120);
      expect(airborne.length).toBeGreaterThanOrEqual(Math.ceil(g.spawns.length * 0.7));
    }
  });
});
