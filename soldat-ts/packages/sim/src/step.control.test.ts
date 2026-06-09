import { describe, it, expect } from 'vitest';

import { createWorld, initSimWorld, stepWorld } from './index';
import { buildPolyMap } from './map/buildPolyMap';

/**
 * Regression: stepWorld's map path must apply control input. It previously only
 * integrated + collided (never calling applyControl), so on a map the player
 * could not move or jump — input did nothing. stepWorld now drives the full
 * updateSpriteMovementMap (integrate -> collide -> clamp -> applyControl).
 */
function landedPlayer() {
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
    normals: [
      { x: 0, y: 0, z: 1 },
      { x: 0, y: 0, z: 1 },
      { x: 0, y: 0, z: 1 },
    ] as const,
    polyType: 0,
    textureIndex: 0,
  });
  const w = initSimWorld(createWorld(), { seed: 1 });
  w.map = buildPolyMap({
    polygons: [tri([-500, 240], [500, 240], [-500, 320]), tri([500, 240], [500, 320], [-500, 320])],
    sectorsDivision: 0,
    sectorsNum: 0,
    sectors: [] as never[],
  } as never);
  const p = w.spriteParts!;
  const s = w.sprites[1]!;
  s.active = true;
  s.num = 1;
  p.active[1] = true;
  p.posX[1] = 0;
  p.posY[1] = 0;
  p.oneOverMass[1] = 1;
  s.jetsCount = 250;
  for (let i = 0; i < 200; i++) stepWorld(w, { spriteRadius: 0 });
  return { w, p, s };
}

describe('stepWorld applies control on the map path', () => {
  it('control.right moves the player right', () => {
    const { w, p, s } = landedPlayer();
    const x0 = p.posX[1]!;
    s.control = { ...s.control, right: true };
    for (let i = 0; i < 60; i++) stepWorld(w, { spriteRadius: 0 });
    expect(p.posX[1]!).toBeGreaterThan(x0 + 5);
  });

  it('control.up produces a real jump (not a one-tick hop)', () => {
    const { w, p, s } = landedPlayer();
    const ground = p.posY[1]!;
    let peak = ground;
    for (let i = 0; i < 120; i++) {
      s.control = { ...s.control, up: true };
      stepWorld(w, { spriteRadius: 0 });
      peak = Math.min(peak, p.posY[1]!);
    }
    expect(ground - peak).toBeGreaterThan(60); // a real jump arc
  });

  it('control.jetpack lifts the player while it has fuel', () => {
    const { w, p, s } = landedPlayer();
    const ground = p.posY[1]!;
    let top = ground;
    for (let i = 0; i < 80; i++) {
      s.control = { ...s.control, jetpack: true };
      stepWorld(w, { spriteRadius: 0 });
      top = Math.min(top, p.posY[1]!);
    }
    expect(ground - top).toBeGreaterThan(40); // lifted off
    expect(s.jetsCount).toBeLessThan(250); // burned fuel
  });
});
