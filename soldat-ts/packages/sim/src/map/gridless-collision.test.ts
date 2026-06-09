import { describe, it, expect } from 'vitest';

import { createWorld, initSimWorld, stepWorld } from '../index';
import { buildPolyMap } from './buildPolyMap';

/**
 * Regression: a map without a sector grid AND with degenerate polygon normals
 * (e.g. a hand-built / synthetic dev map) must still collide. Previously the
 * zero normals produced zero edge perpendiculars, so collision was "detected"
 * but pushed the entity out by (0,0) → players fell straight through the floor.
 * buildPolyMap now derives inward edge normals geometrically when the stored
 * normals are degenerate, and PolyMap falls back to brute-forcing all polygons
 * when there is no sector grid.
 */
function gridlessGround() {
  const tri = (a: [number, number], b: [number, number], c: [number, number]) => ({
    vertices: [a, b, c].map(([x, y]) => ({
      x,
      y,
      z: 0,
      rhw: 1,
      color: [40, 40, 50, 255] as [number, number, number, number],
      u: 0,
      v: 0,
    })),
    // Degenerate normals — the bug trigger.
    normals: [
      { x: 0, y: 0, z: 1 },
      { x: 0, y: 0, z: 1 },
      { x: 0, y: 0, z: 1 },
    ] as const,
    polyType: 0,
    textureIndex: 0,
  });
  return {
    polygons: [tri([-400, 240], [400, 240], [-400, 320]), tri([400, 240], [400, 320], [-400, 320])],
    sectorsDivision: 0,
    sectorsNum: 0,
    sectors: [] as never[],
  };
}

describe('gridless + degenerate-normal map collision', () => {
  it('derives non-zero inward edge perpendiculars', () => {
    const pm = buildPolyMap(gridlessGround() as never);
    // Top edge of the ground (v0->v1 is horizontal) → inward normal points down (+y).
    const poly0 = (pm as unknown as { polys: { perp: { x: number; y: number }[] }[] }).polys[0]!;
    const lengths = poly0.perp.map((p) => Math.hypot(p.x, p.y));
    expect(Math.max(...lengths)).toBeGreaterThan(0.5); // not the old (0,0)
  });

  it('a player falls and rests ON the ground (does not sink through)', () => {
    const w = initSimWorld(createWorld(), { seed: 1 });
    w.map = buildPolyMap(gridlessGround() as never);
    const parts = w.spriteParts!;
    const sprite = w.sprites[1]!;
    sprite.active = true;
    sprite.num = 1;
    parts.active[1] = true;
    parts.posX[1] = 0;
    parts.posY[1] = 0;
    parts.oneOverMass[1] = 1;

    for (let i = 0; i < 300; i++) stepWorld(w, { spriteRadius: 0 });

    // Ground top is y=240; the player rests just above it, never falls through.
    expect(parts.posY[1]).toBeLessThan(245);
    expect(parts.posY[1]).toBeGreaterThan(220);
    expect(sprite.onGround).toBe(true);
  });
});
