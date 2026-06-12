// Reaper brain unit tests — relentless gap-close, dive geometry (climb to
// altitude, then jets-cut freefall entry), knife-range commitment, the
// reload-only-when-dry mag rule, and the longer hunt memory.
//
// Harness: a hand-built sim world (map === null so line of sight is always
// clear); the brain's only output is the bot's control. Fixed rng seed.

import { describe, it, expect } from 'vitest';
import { createWorld, initSimWorld, type World, type WaypointGraph } from '@soldat/sim';
import type { BotEngineContext } from './engine';
import { createReaperEngine, REAPER_DEFAULTS } from './reaper';

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

function tick(brain: { tick(i: number, ctx: BotEngineContext): void }, i: number, ctx: BotEngineContext): void {
  brain.tick(i, ctx);
  ctx.world.mainTickCounter += 1;
}

function makeBrain() {
  return createReaperEngine().createBrain();
}

describe('reaper: knife-range commitment', () => {
  it('pushes THROUGH the target inside KILL_RANGE (never retreats)', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 100, y: 0 }); // dist 100 ≤ 180, enemy to the right
    const brain = makeBrain();
    brain.tick(1, makeCtx(world));
    const c = control(world, 1);
    expect(c.right).toBe(true);
    expect(c.left).toBe(false);
    expect(c.fire).toBe(true);
  });

  it('mirrors the push-through to the left', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: -100, y: 0 });
    const brain = makeBrain();
    brain.tick(1, makeCtx(world));
    const c = control(world, 1);
    expect(c.left).toBe(true);
    expect(c.right).toBe(false);
  });

  it('jets up into the target\'s feet when committed from below', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 50, y: -100 }); // target above (y is down), dist ~112
    const brain = makeBrain();
    brain.tick(1, makeCtx(world));
    expect(control(world, 1).jetpack).toBe(true);
  });
});

describe('reaper: dive geometry', () => {
  it('climbs toward DIVE_HEIGHT on the approach', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 400, y: 0 }); // level: above = 0 < DIVE_HEIGHT - 40
    const brain = makeBrain();
    brain.tick(1, makeCtx(world));
    const c = control(world, 1);
    expect(c.jetpack).toBe(true);
    expect(c.left || c.right).toBe(true); // approach in motion
  });

  it('cuts the jets and freefalls when close with height (dive entry)', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 150, y: 150 }); // above = 150 ≥ 40, dist ~212 ≤ 260
    const brain = makeBrain();
    brain.tick(1, makeCtx(world));
    const c = control(world, 1);
    expect(c.jetpack).toBe(false);
    expect(c.down).toBe(false); // freefall converges by itself
    expect(c.fire).toBe(true); // dist ≤ FIRE_RANGE
  });

  it('resumes the climb if the dive-entry condition breaks mid-fall', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 150, y: 150 });
    const brain = makeBrain();
    const ctx = makeCtx(world);
    tick(brain, 1, ctx);
    expect(control(world, 1).jetpack).toBe(false); // diving

    // The target escapes the entry circle but stays below: climb resumes
    // (above = 150 < DIVE_HEIGHT - 40 wants more height).
    world.spriteParts!.posX[2] = 600;
    tick(brain, 1, ctx);
    expect(control(world, 1).jetpack).toBe(true);
  });
});

describe('reaper: fire discipline', () => {
  it('returns fire on the run-in inside FIRE_RANGE', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 450, y: 0 });
    const brain = makeBrain();
    brain.tick(1, makeCtx(world));
    expect(control(world, 1).fire).toBe(true);
  });

  it('holds fire beyond FIRE_RANGE', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 500, y: 0 }); // 500 > 460
    const brain = makeBrain();
    brain.tick(1, makeCtx(world));
    expect(control(world, 1).fire).toBe(false);
  });
});

describe('reaper: mag discipline (brawler edition)', () => {
  it('reloads ONLY when dry', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 600, y: 0 });
    const brain = makeBrain();
    brain.tick(1, makeCtx(world, { ammo: { 1: 0 } }));
    expect(control(world, 1).reload).toBe(true);

    const world2 = makeWorld();
    spawn(world2, 1, { x: 0, y: 0 });
    spawn(world2, 2, { x: 600, y: 0 });
    const brain2 = makeBrain();
    brain2.tick(1, makeCtx(world2, { ammo: { 1: 1 } })); // one round left: keep closing
    expect(control(world2, 1).reload).toBe(false);
  });
});

describe('reaper: erratic approach', () => {
  it('moves net-inbound with occasional jitter legs against the approach', () => {
    const world = makeWorld(7);
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 800, y: 0 }); // long run-in to the right
    const brain = makeBrain();
    const ctx = makeCtx(world);
    let rights = 0;
    let lefts = 0;
    for (let t = 0; t < 400; t++) {
      tick(brain, 1, ctx);
      const c = control(world, 1);
      if (c.right) rights += 1;
      if (c.left) lefts += 1;
    }
    expect(rights).toBeGreaterThan(lefts); // net motion inbound
    expect(lefts).toBeGreaterThan(0); // but the line is not straight
  });
});

describe('reaper: hunt memory', () => {
  it('chases the last sighting hard, then gives up after HUNT_MEMORY_TICKS', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: -400, y: -100 }); // left and above
    const brain = makeBrain();
    const ctx = makeCtx(world, { spawns: [{ x: 2000, y: 0 }] });
    tick(brain, 1, ctx); // record last-seen
    world.sprites[2]!.active = false;
    tick(brain, 1, ctx);
    const c = control(world, 1);
    expect(c.left).toBe(true); // pursuing last-seen X
    expect(c.jetpack).toBe(true); // last seen above by > 40px

    world.mainTickCounter += REAPER_DEFAULTS.HUNT_MEMORY_TICKS + 1;
    brain.tick(1, ctx);
    // Memory expired: roams toward the lone spawn far right instead.
    expect(control(world, 1).right).toBe(true);
    expect(control(world, 1).left).toBe(false);
  });
});

describe('reaper: ceiling-stall give-up', () => {
  it('cuts thrust after STALL_TRIGGER ticks of jetting without rising', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0, vy: 0 }); // never rising
    spawn(world, 2, { x: 400, y: 0 }); // approach wants dive height → jets on
    const brain = makeBrain();
    const ctx = makeCtx(world);
    for (let t = 0; t < REAPER_DEFAULTS.STALL_TRIGGER - 1; t++) {
      tick(brain, 1, ctx);
      expect(control(world, 1).jetpack).toBe(true);
    }
    tick(brain, 1, ctx);
    expect(control(world, 1).jetpack).toBe(false); // conceded
    tick(brain, 1, ctx);
    expect(control(world, 1).jetpack).toBe(false); // suppressed by cooldown
  });
});
