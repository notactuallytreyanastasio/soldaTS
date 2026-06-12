// Shrike brain unit tests — role by hardware (SPAS-12 carrier breaches, AK
// carriers overwatch), the breacher's silent approach / dive entry / shell
// discipline / SPAS ballistics, the overwatch band gunnery, and the
// escort-focus selection (behind the ESCORT_FOCUS tweak).
//
// Harness: a hand-built sim world (map === null so line of sight is always
// clear); weapons are injected through the ctx.weaponOf hook the same way the
// real host provides them. Fixed rng seed.

import { describe, it, expect } from 'vitest';
import { createWorld, initSimWorld, type World, type WaypointGraph } from '@soldat/sim';
import type { BotEngineContext } from './engine';
import { createShrikeEngine, SHRIKE_DEFAULTS } from './shrike';

const AK_BULLET_SPEED = 24.6;
const SPAS_BULLET_SPEED = 14;

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
  /** Per-sprite weapon labels; when present, unlisted sprites hold AK74.
   *  When absent entirely, ctx.weaponOf is undefined (pre-wildcard host). */
  weapons?: Record<number, string>;
  spawns?: { x: number; y: number }[];
}

function makeCtx(world: World, opts: CtxOpts = {}): BotEngineContext {
  const ctx: BotEngineContext = {
    world,
    graph: {} as WaypointGraph,
    spawns: opts.spawns ?? [{ x: 2000, y: 0 }],
    spectate: true,
    ammoOf: (i: number): number => opts.ammo?.[i] ?? 30,
    reloadingOf: (i: number): boolean => opts.reloading?.[i] ?? false,
    magSize: 30,
  };
  if (opts.weapons !== undefined) {
    const weapons = opts.weapons;
    return { ...ctx, weaponOf: (i: number): string => weapons[i] ?? 'AK74' };
  }
  return ctx;
}

function control(world: World, i: number) {
  return world.sprites[i]!.control;
}

function makeBrain(tweaks?: Record<string, number>) {
  return createShrikeEngine(tweaks).createBrain();
}

describe('shrike: breacher (SPAS-12 carrier)', () => {
  it('holds fire on the silent approach beyond EFFECT_MAX, still closing', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 350, y: 0 });
    const brain = makeBrain();
    brain.tick(1, makeCtx(world, { weapons: { 1: 'SPAS12' } }));
    const c = control(world, 1);
    expect(c.fire).toBe(false); // 350 > 280: confetti range
    expect(c.right).toBe(true); // net motion inbound, always
  });

  it('opens up inside EFFECT_MAX', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 250, y: 0 });
    const brain = makeBrain();
    brain.tick(1, makeCtx(world, { weapons: { 1: 'SPAS12' } }));
    expect(control(world, 1).fire).toBe(true);
  });

  it('aims with SPAS pellet ballistics (14 px/tick), not AK ballistics', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 250, y: 0 }); // stationary target → pure drop comp
    const brain = makeBrain();
    brain.tick(1, makeCtx(world, { weapons: { 1: 'SPAS12' } }));
    const c = control(world, 1);
    const tof = 250 / SPAS_BULLET_SPEED;
    const drop = 0.5 * SHRIKE_DEFAULTS.DROP_G * tof * tof;
    expect(c.mouseAimX).toBe(250);
    expect(c.mouseAimY).toBe(Math.round(-drop)); // ~-22: far more than AK's ~-7
    // Sanity: the SPAS drop is much deeper than the AK drop would be.
    const akTof = 250 / AK_BULLET_SPEED;
    const akDrop = 0.5 * SHRIKE_DEFAULTS.DROP_G * akTof * akTof;
    expect(Math.abs(c.mouseAimY)).toBeGreaterThan(Math.round(akDrop) + 5);
  });

  it('climbs to dive altitude on the approach', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 500, y: 0 }); // level, far: wants DIVE_HEIGHT above
    const brain = makeBrain();
    brain.tick(1, makeCtx(world, { weapons: { 1: 'SPAS12' } }));
    expect(control(world, 1).jetpack).toBe(true);
  });

  it('cuts jets for the gravity entry when close with height', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 150, y: 100 }); // above by 100 ≥ 40, dist ~180 ≤ 250
    const brain = makeBrain();
    brain.tick(1, makeCtx(world, { weapons: { 1: 'SPAS12' } }));
    expect(control(world, 1).jetpack).toBe(false);
  });

  it('dashes flat (no climb) into an open reload window', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 500, y: 0 });
    const brain = makeBrain();
    brain.tick(
      1,
      makeCtx(world, { weapons: { 1: 'SPAS12' }, reloading: { 2: true } }),
    );
    const c = control(world, 1);
    expect(c.right).toBe(true);
    expect(c.jetpack).toBe(false); // window open → sprint, don't climb
  });

  it('pushes THROUGH the mark at point-blank', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 60, y: 0 }); // dist ≤ PUSH_DIST
    const brain = makeBrain();
    brain.tick(1, makeCtx(world, { weapons: { 1: 'SPAS12' } }));
    const c = control(world, 1);
    expect(c.right).toBe(true);
    expect(c.left).toBe(false);
    expect(c.fire).toBe(true);
  });

  it('shell discipline: reloads dry, and at SHELLS_LEAVE outside blast range', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 250, y: 0 }); // > BLAST_RANGE
    const brain = makeBrain();
    brain.tick(1, makeCtx(world, { weapons: { 1: 'SPAS12' }, ammo: { 1: 1 } }));
    expect(control(world, 1).reload).toBe(true);

    // Inside blast range one shell is still a kill: stay committed.
    const world2 = makeWorld();
    spawn(world2, 1, { x: 0, y: 0 });
    spawn(world2, 2, { x: 150, y: 0 });
    const brain2 = makeBrain();
    brain2.tick(1, makeCtx(world2, { weapons: { 1: 'SPAS12' }, ammo: { 1: 1 } }));
    expect(control(world2, 1).reload).toBe(false);
  });

  it('disengages UP while reloading (height is the next dive\'s fuel)', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 250, y: 0 });
    const brain = makeBrain();
    brain.tick(
      1,
      makeCtx(world, { weapons: { 1: 'SPAS12' }, reloading: { 1: true } }),
    );
    const c = control(world, 1);
    expect(c.left).toBe(true); // away from the mark on the right
    expect(c.jetpack).toBe(true);
    expect(c.fire).toBe(false);
  });
});

describe('shrike: overwatch (AK carrier)', () => {
  it('plants in the band and taps on the staggered clock', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 400, y: 0 }); // in 320..460
    const brain = makeBrain();
    world.mainTickCounter = 3; // bot 1 stagger: (3 + 3) % 6 = 0 → open
    brain.tick(1, makeCtx(world, { weapons: { 1: 'AK74' } }));
    const c = control(world, 1);
    expect(c.left).toBe(false);
    expect(c.right).toBe(false);
    expect(c.fire).toBe(true);
  });

  it('advances beyond BAND_MAX, retreats inside BAND_MIN', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 600, y: 0 });
    const brain = makeBrain();
    brain.tick(1, makeCtx(world, { weapons: { 1: 'AK74' } }));
    expect(control(world, 1).right).toBe(true);

    const world2 = makeWorld();
    spawn(world2, 1, { x: 0, y: 0 });
    spawn(world2, 2, { x: 250, y: 0 }); // < 320
    const brain2 = makeBrain();
    brain2.tick(1, makeCtx(world2, { weapons: { 1: 'AK74' } }));
    expect(control(world2, 1).left).toBe(true);
  });

  it('reloads early behind the band, never inside it', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 600, y: 0 }); // > BAND_MAX
    const brain = makeBrain();
    brain.tick(1, makeCtx(world, { weapons: { 1: 'AK74' }, ammo: { 1: 5 } }));
    expect(control(world, 1).reload).toBe(true);

    const world2 = makeWorld();
    spawn(world2, 1, { x: 0, y: 0 });
    spawn(world2, 2, { x: 400, y: 0 }); // in band
    const brain2 = makeBrain();
    brain2.tick(1, makeCtx(world2, { weapons: { 1: 'AK74' }, ammo: { 1: 5 } }));
    expect(control(world2, 1).reload).toBe(false);
  });

  it('a pre-wildcard host (no weaponOf) degrades to plain overwatch dueling', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 400, y: 0 });
    const brain = makeBrain();
    world.mainTickCounter = 3; // tap open for bot 1
    brain.tick(1, makeCtx(world)); // ctx.weaponOf undefined
    const c = control(world, 1);
    expect(c.left).toBe(false);
    expect(c.right).toBe(false);
    expect(c.fire).toBe(true);
  });
});

describe('shrike: escort focus (ESCORT_FOCUS = 1 tweak)', () => {
  it('with a live breacher, overwatch focuses the enemy NEAREST THE BREACHER', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0, team: 1 }); // overwatch (AK)
    spawn(world, 2, { x: 500, y: 0, team: 1 }); // breacher (SPAS)
    spawn(world, 3, { x: 600, y: 0, team: 2 }); // 100px from the breacher
    spawn(world, 4, { x: -300, y: 0, team: 2 }); // nearest to the overwatch
    const brain = makeBrain({ ESCORT_FOCUS: 1 });
    brain.tick(
      1,
      makeCtx(world, { weapons: { 1: 'AK74', 2: 'SPAS12', 3: 'AK74', 4: 'AK74' } }),
    );
    const c = control(world, 1);
    expect(c.mouseAimX).toBeGreaterThan(0); // gun on the breach-side enemy
    expect(c.right).toBe(true); // escorting toward it (600 > BAND_MAX)
  });

  it('without a breacher the same roster duels the nearest enemy instead', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0, team: 1 });
    spawn(world, 2, { x: 500, y: 0, team: 1 }); // mate now also on AK
    spawn(world, 3, { x: 600, y: 0, team: 2 });
    spawn(world, 4, { x: -300, y: 0, team: 2 });
    const brain = makeBrain({ ESCORT_FOCUS: 1 });
    brain.tick(
      1,
      makeCtx(world, { weapons: { 1: 'AK74', 2: 'AK74', 3: 'AK74', 4: 'AK74' } }),
    );
    expect(control(world, 1).mouseAimX).toBeLessThan(0); // nearest = -300
  });
});
