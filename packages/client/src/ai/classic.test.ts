// Classic brain unit tests — the adapter wrapped around the faithful Pascal
// port. The wrapper owns two client-side behaviors worth pinning: the
// absolute→relative mouseAim conversion (spectate only — the Pascal AI writes
// ABSOLUTE world coords) and the roam-when-idle fallback (including the
// stuck-against-geometry up/jet pulse).
//
// Worlds are real sim worlds (createWorld + initSimWorld, map null so line of
// sight is always clear); the waypoint graph is empty, so targetless bots
// fall through navigation to the roam helper.

import { describe, it, expect } from 'vitest';
import {
  buildWaypoints,
  createWorld,
  initSimWorld,
  type World,
} from '@soldat/sim';
import { createClassicEngine } from './classic';
import type { BotEngineContext } from './engine';

interface BotSpec {
  x: number;
  y: number;
  vx?: number;
  vy?: number;
  team?: number;
  health?: number;
  jets?: number;
}

function makeWorld(seed = 7): World {
  return initSimWorld(createWorld(), { seed });
}

function addBot(world: World, i: number, spec: BotSpec): void {
  const s = world.sprites[i]!;
  s.active = true;
  s.deadMeat = false;
  s.alpha = 255;
  s.team = spec.team ?? 0;
  s.health = spec.health ?? 150;
  s.jetsCount = spec.jets ?? 1000;
  const p = world.spriteParts!;
  p.posX[i] = spec.x;
  p.posY[i] = spec.y;
  p.velocityX[i] = spec.vx ?? 0;
  p.velocityY[i] = spec.vy ?? 0;
}

function makeCtx(
  world: World,
  opts: { spectate?: boolean; spawns?: { x: number; y: number }[] } = {},
): BotEngineContext {
  return {
    world,
    graph: buildWaypoints({ waypoints: [] }),
    spawns: opts.spawns ?? [{ x: 0, y: 0 }],
    spectate: opts.spectate ?? true,
    ammoOf: (): number => 30,
    reloadingOf: (): boolean => false,
    magSize: 30,
  };
}

function newBrain() {
  return createClassicEngine().createBrain();
}

describe('classic: absolute→relative aim conversion (spectate)', () => {
  it('converts the Pascal absolute aim into a shooter-relative offset', () => {
    const world = makeWorld();
    addBot(world, 1, { x: 100, y: 100 });
    addBot(world, 2, { x: 400, y: 100 }); // |dx| 300 → DIST_FAR band
    const c = world.sprites[1]!.control;
    newBrain().tick(1, makeCtx(world));
    // Absolute leadX would be 400; relative = 400 − 100.
    expect(c.mouseAimX).toBe(300);
    // Y carries the band drop term (1.75·350/18 ≈ 34) minus a 0..9 jitter,
    // all relative to the shooter's y.
    expect(c.mouseAimY).toBeGreaterThanOrEqual(-43);
    expect(c.mouseAimY).toBeLessThanOrEqual(-34);
    // And the Pascal combat layer is live: face + fire at DIST_FAR.
    expect(c.right).toBe(true);
    expect(c.fire).toBe(true);
  });

  it('leaves the absolute aim untouched outside spectate (byte-identical old path)', () => {
    const world = makeWorld();
    addBot(world, 1, { x: 100, y: 100 });
    addBot(world, 2, { x: 400, y: 100 });
    const c = world.sprites[1]!.control;
    newBrain().tick(1, makeCtx(world, { spectate: false }));
    expect(c.mouseAimX).toBe(400); // ABSOLUTE world coordinate
  });

  it('converts at close range too (DIST_VERY_CLOSE holds ground and fires)', () => {
    const world = makeWorld();
    addBot(world, 1, { x: 100, y: 100 });
    addBot(world, 2, { x: 150, y: 100 }); // |dx| 50 → DIST_VERY_CLOSE band
    const c = world.sprites[1]!.control;
    newBrain().tick(1, makeCtx(world));
    expect(c.mouseAimX).toBe(50);
    expect(c.left).toBe(false);
    expect(c.right).toBe(false);
    expect(c.fire).toBe(true);
  });

  it('skips the conversion when the AI wrote no aim this tick (no target)', () => {
    const world = makeWorld();
    addBot(world, 1, { x: 500, y: 100 }); // alone — no target, empty graph
    const c = world.sprites[1]!.control;
    newBrain().tick(1, makeCtx(world, { spawns: [{ x: 1000, y: 100 }] }));
    // If the conversion ran anyway, mouseAimX would have become −500.
    expect(c.mouseAimX).toBe(0);
    expect(c.mouseAimY).toBe(0);
  });
});

describe('classic: roam fallback (spectate sustainment)', () => {
  it('roams toward a spawn when truly idle (no target, no movement intent)', () => {
    const world = makeWorld();
    addBot(world, 1, { x: 500, y: 100 });
    const c = world.sprites[1]!.control;
    newBrain().tick(1, makeCtx(world, { spawns: [{ x: 1000, y: 100 }] }));
    expect(c.right).toBe(true); // walking toward the spawn pad at x=1000
    expect(c.left).toBe(false);
  });

  it('does not roam while engaging (combat output wins over the wanderer)', () => {
    const world = makeWorld();
    addBot(world, 1, { x: 100, y: 100 });
    addBot(world, 2, { x: 400, y: 100 }); // enemy to the RIGHT
    const c = world.sprites[1]!.control;
    // Spawn far to the LEFT: roam would command left; combat commands right.
    newBrain().tick(1, makeCtx(world, { spawns: [{ x: -2000, y: 100 }] }));
    expect(c.right).toBe(true);
    expect(c.left).toBe(false);
    expect(c.fire).toBe(true);
  });

  it('pulses up+jet after grinding against geometry (stuckTicks past trigger)', () => {
    const world = makeWorld();
    addBot(world, 1, { x: 500, y: 100 }); // velocity stays 0 → "stuck"
    const c = world.sprites[1]!.control;
    const ctx = makeCtx(world, { spawns: [{ x: 1000, y: 100 }] });
    const brain = newBrain();
    let pulsed = false;
    for (let t = 0; t < 60; t++) {
      world.mainTickCounter = t;
      brain.tick(1, ctx);
      if (c.up && c.jetpack) pulsed = true;
    }
    // STUCK_TRIGGER is 45 ticks of commanded movement with |vx| < 0.3.
    expect(pulsed).toBe(true);
  });
});
