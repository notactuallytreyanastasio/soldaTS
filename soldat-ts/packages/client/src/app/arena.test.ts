import { describe, it, expect } from 'vitest';
import { buildArena, ARENA_SPAWNS } from './arena';

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
