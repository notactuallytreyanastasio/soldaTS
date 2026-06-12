// Wolf brain unit tests — stateless prey agreement (lowest health inside
// PREY_RADIUS, nearest-to-centroid fallback beyond it), crossfire bearings
// (top wolf high, side wolves split by X), cohesion regroup, mag discipline,
// and the auto/tap fire ladder.
//
// Harness: a hand-built sim world (map === null so line of sight is always
// clear — every enemy is "seen by the pack"); the brain's only output is the
// bot's control. Fixed rng seed. Aim direction (mouseAimX sign) is used to
// observe WHICH enemy was picked as prey.

import { describe, it, expect } from 'vitest';
import { createWorld, initSimWorld, type World, type WaypointGraph } from '@soldat/sim';
import type { BotEngineContext } from './engine';
import { createWolfEngine } from './wolf';

interface SpawnOpts {
  x: number;
  y: number;
  vx?: number;
  vy?: number;
  team?: number;
  health?: number;
  jets?: number;
}

function makeWorld(seed = 1): World {
  return initSimWorld(createWorld(), { seed });
}

function spawn(world: World, i: number, o: SpawnOpts): void {
  const s = world.sprites[i]!;
  s.active = true;
  s.deadMeat = false;
  s.alpha = 255;
  s.health = o.health ?? 150;
  s.team = o.team ?? 0;
  s.jetsCount = o.jets ?? 400;
  const parts = world.spriteParts!;
  parts.posX[i] = o.x;
  parts.posY[i] = o.y;
  parts.velocityX[i] = o.vx ?? 0;
  parts.velocityY[i] = o.vy ?? 0;
}

interface CtxOpts {
  ammo?: Record<number, number>;
  reloading?: Record<number, boolean>;
  spawns?: { x: number; y: number }[];
}

function makeCtx(world: World, opts: CtxOpts = {}): BotEngineContext {
  return {
    world,
    graph: {} as WaypointGraph,
    spawns: opts.spawns ?? [{ x: 2000, y: 0 }],
    spectate: true,
    ammoOf: (i: number): number => opts.ammo?.[i] ?? 30,
    reloadingOf: (i: number): boolean => opts.reloading?.[i] ?? false,
    magSize: 30,
  };
}

function control(world: World, i: number) {
  return world.sprites[i]!.control;
}

function makeBrain() {
  return createWolfEngine().createBrain();
}

describe('wolf: prey selection (one prey, by convention)', () => {
  it('picks the LOWEST-HEALTH enemy inside PREY_RADIUS over a healthier nearer one', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 }); // FFA: a pack of one, centroid = self
    spawn(world, 2, { x: -300, y: 0, health: 100 });
    spawn(world, 3, { x: 400, y: 0, health: 50 }); // wounded, still in radius
    const brain = makeBrain();
    world.mainTickCounter = 0; // tap clock open (0 % 6 < 1)
    brain.tick(1, makeCtx(world));
    const c = control(world, 1);
    expect(c.mouseAimX).toBeGreaterThan(0); // gun on the wounded one at +400
    expect(c.fire).toBe(true);
  });

  it('a wounded enemy INSIDE the radius beats a near-dead one outside it', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: -400, y: 0, health: 140 }); // inside 550
    spawn(world, 3, { x: 700, y: 0, health: 5 }); // outside 550
    const brain = makeBrain();
    world.mainTickCounter = 0;
    brain.tick(1, makeCtx(world));
    expect(control(world, 1).mouseAimX).toBeLessThan(0);
  });

  it('beyond PREY_RADIUS the fallback picks by centroid distance, IGNORING health', () => {
    // Reviewer finding (low): when no prey is in radius, farBest is chosen by
    // distance alone — a healthy enemy at 600px wins over a near-dead one at
    // 800px. This pins the ACTUAL current behavior.
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 600, y: 0, health: 150 }); // healthy but nearer
    spawn(world, 3, { x: -800, y: 0, health: 10 }); // wounded but farther
    const brain = makeBrain();
    world.mainTickCounter = 0;
    brain.tick(1, makeCtx(world));
    expect(control(world, 1).mouseAimX).toBeGreaterThan(0); // the healthy one
  });
});

describe('wolf: crossfire bearings', () => {
  it('the highest-indexed wolf takes the TOP bearing (climbs above the prey)', () => {
    const world = makeWorld();
    spawn(world, 1, { x: -100, y: 0, team: 1 });
    spawn(world, 2, { x: 100, y: 0, team: 1 });
    spawn(world, 3, { x: 10, y: 0, team: 1 }); // top wolf, in slot X, level w/ prey
    spawn(world, 4, { x: 0, y: 0, team: 2 });
    const brain = makeBrain();
    brain.tick(3, makeCtx(world));
    const c = control(world, 3);
    expect(c.jetpack).toBe(true); // slotY = prey - HIGH_OFF is far above
    expect(c.left !== c.right).toBe(true); // in-slot juke, never parked
  });

  it('side wolves split left/right of the prey by current X position', () => {
    const world = makeWorld();
    spawn(world, 1, { x: -50, y: 0, team: 1 }); // leftmost side wolf
    spawn(world, 2, { x: 50, y: 0, team: 1 }); // rightmost side wolf
    spawn(world, 3, { x: 0, y: -150, team: 1 }); // top wolf
    spawn(world, 4, { x: 0, y: 400, team: 2 }); // prey at x = 0
    const b1 = makeBrain();
    const b2 = makeBrain();
    b1.tick(1, makeCtx(world));
    b2.tick(2, makeCtx(world));
    // Wolf 1 heads for the LEFT slot (prey.x - PACK_RANGE = -360).
    expect(control(world, 1).left).toBe(true);
    expect(control(world, 1).right).toBe(false);
    // Wolf 2 heads for the RIGHT slot (prey.x + PACK_RANGE = +360).
    expect(control(world, 2).right).toBe(true);
    expect(control(world, 2).left).toBe(false);
  });
});

describe('wolf: cohesion (regroup before glory)', () => {
  it('an isolated wolf moves to the pack centroid, away from the prey', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0, team: 1 }); // isolated
    spawn(world, 2, { x: -1000, y: 0, team: 1 });
    spawn(world, 3, { x: -1100, y: 0, team: 1 });
    spawn(world, 4, { x: 400, y: 0, team: 2 }); // prey to the RIGHT
    const brain = makeBrain();
    world.mainTickCounter = 0;
    brain.tick(1, makeCtx(world));
    const c = control(world, 1);
    expect(c.left).toBe(true); // toward the pack at ~(-1050)
    expect(c.right).toBe(false);
    // ...but the gun stays opportunistic: it still shoots the prey on the way.
    expect(c.mouseAimX).toBeGreaterThan(0);
    expect(c.fire).toBe(true); // dist 400 ≤ FIRE_MAX_DIST, tap open at clock 0
  });
});

describe('wolf: mag discipline', () => {
  it('reloads when dry', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 300, y: 0 });
    const brain = makeBrain();
    brain.tick(1, makeCtx(world, { ammo: { 1: 0 } }));
    expect(control(world, 1).reload).toBe(true);
  });

  it('proactively reloads at SELF_RELOAD_AT only when the prey is out of reach', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 600, y: 0 }); // dist > PACK_RANGE + 120 = 480
    const brain = makeBrain();
    brain.tick(1, makeCtx(world, { ammo: { 1: 8 } }));
    expect(control(world, 1).reload).toBe(true);

    const world2 = makeWorld();
    spawn(world2, 1, { x: 0, y: 0 });
    spawn(world2, 2, { x: 300, y: 0 }); // close: keep the gun in the fight
    const brain2 = makeBrain();
    brain2.tick(1, makeCtx(world2, { ammo: { 1: 8 } }));
    expect(control(world2, 1).reload).toBe(false);
  });

  it('disengages while reloading: opens range, takes cheap height, holds fire', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 400, y: 0 }); // prey to the right
    const brain = makeBrain();
    brain.tick(1, makeCtx(world, { reloading: { 1: true } }));
    const c = control(world, 1);
    expect(c.left).toBe(true);
    expect(c.right).toBe(false);
    expect(c.jetpack).toBe(true);
    expect(c.fire).toBe(false);
  });
});

describe('wolf: fire ladder', () => {
  it('full-auto inside AUTO_RANGE even when the tap clock is closed', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 200, y: 0 }); // 200 ≤ 240
    const brain = makeBrain();
    world.mainTickCounter = 3; // 3 % 6 ≥ 1: tap would be closed
    brain.tick(1, makeCtx(world));
    expect(control(world, 1).fire).toBe(true);
  });

  it('taps on the TAP_PERIOD clock beyond AUTO_RANGE', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 400, y: 0 });
    const brain = makeBrain();
    const ctx = makeCtx(world);
    world.mainTickCounter = 3; // closed
    brain.tick(1, ctx);
    expect(control(world, 1).fire).toBe(false);
    world.mainTickCounter = 6; // 6 % 6 = 0 < 1: open
    brain.tick(1, ctx);
    expect(control(world, 1).fire).toBe(true);
  });

  it('holds fire entirely beyond FIRE_MAX_DIST when no closer threat exists', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 700, y: 0 }); // 700 > 620
    const brain = makeBrain();
    world.mainTickCounter = 0; // tap clock open — distance is what gates it
    brain.tick(1, makeCtx(world));
    expect(control(world, 1).fire).toBe(false);
  });
});
