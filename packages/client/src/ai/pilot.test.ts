// Pilot brain unit tests — height discipline, range band, engagement
// discipline (mag state), hunt memory, and the ceiling-stall give-up.
//
// Harness: a hand-built sim world (map === null so line of sight is always
// clear) with sprites placed directly through spriteParts; the brain's only
// output is the bot's control, which is what we assert on. All randomness
// flows through world.rng with a fixed seed — fully deterministic.

import { describe, it, expect } from 'vitest';
import { createWorld, initSimWorld, type World, type WaypointGraph } from '@soldat/sim';
import type { BotEngineContext } from './engine';
import { createPilotEngine, PILOT_DEFAULTS } from './pilot';

const AK_BULLET_SPEED = 24.6;

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

/** Tick the brain once and advance the world clock. */
function tick(brain: { tick(i: number, ctx: BotEngineContext): void }, i: number, ctx: BotEngineContext): void {
  brain.tick(i, ctx);
  ctx.world.mainTickCounter += 1;
}

function makeBrain() {
  return createPilotEngine().createBrain();
}

describe('pilot: height discipline', () => {
  it('climbs when level with the target (no height edge held)', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 300, y: 0 }); // in band, heightEdge = 0 < HEIGHT_EDGE_MIN
    const brain = makeBrain();
    brain.tick(1, makeCtx(world));
    const c = control(world, 1);
    expect(c.jetpack).toBe(true);
    expect(c.down).toBe(false);
  });

  it('descends (down key) when overextended above HEIGHT_EDGE_MAX', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 200, y: 260 }); // heightEdge = +260 > 220, dist ~328 in band
    const brain = makeBrain();
    brain.tick(1, makeCtx(world));
    const c = control(world, 1);
    expect(c.down).toBe(true);
    expect(c.jetpack).toBe(false);
  });

  it('holds altitude (no climb, no descend) inside the edge window', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 300, y: 100 }); // heightEdge = +100, between 50 and 220
    const brain = makeBrain();
    brain.tick(1, makeCtx(world));
    const c = control(world, 1);
    expect(c.jetpack).toBe(false);
    expect(c.down).toBe(false);
  });
});

describe('pilot: range band', () => {
  it('backs off when closer than RANGE_MIN', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 100 }); // hold a height edge so movement is pure
    spawn(world, 2, { x: 100, y: 200 }); // dist ~141 < 200, enemy to the right
    const brain = makeBrain();
    brain.tick(1, makeCtx(world));
    const c = control(world, 1);
    expect(c.left).toBe(true);
    expect(c.right).toBe(false);
    expect(c.fire).toBe(true); // close range = full trigger
  });

  it('closes when farther than RANGE_MAX', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 500, y: 100 }); // dist ~510 > 420
    const brain = makeBrain();
    brain.tick(1, makeCtx(world));
    const c = control(world, 1);
    expect(c.right).toBe(true);
    expect(c.left).toBe(false);
  });

  it('strafe-jukes inside the band (exactly one horizontal key)', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 300, y: 100 });
    const brain = makeBrain();
    brain.tick(1, makeCtx(world));
    const c = control(world, 1);
    expect(c.left !== c.right).toBe(true);
  });
});

describe('pilot: fire discipline', () => {
  it('holds fire beyond FIRE_MAX_DIST', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 700, y: 0 }); // 700 > 600
    const brain = makeBrain();
    brain.tick(1, makeCtx(world));
    expect(control(world, 1).fire).toBe(false);
  });

  it('tap-bursts at long range on the BURST_PERIOD clock', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 500, y: 0 }); // between RANGE_MAX and FIRE_MAX_DIST
    const brain = makeBrain();
    const ctx = makeCtx(world);
    world.mainTickCounter = 0; // 0 % 14 < 5 → burst open
    brain.tick(1, ctx);
    expect(control(world, 1).fire).toBe(true);
    world.mainTickCounter = 6; // 6 % 14 >= 5 → burst closed
    brain.tick(1, ctx);
    expect(control(world, 1).fire).toBe(false);
  });

  it('aims with time-of-flight lead and drop compensation (stationary target)', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 300, y: 0 });
    const brain = makeBrain();
    brain.tick(1, makeCtx(world));
    const c = control(world, 1);
    const tof = 300 / AK_BULLET_SPEED;
    const drop = 0.5 * 0.06 * tof * tof; // pilot uses the un-doubled 0.06 g
    expect(c.mouseAimX).toBe(300);
    expect(c.mouseAimY).toBe(Math.round(-drop));
  });
});

describe('pilot: engagement discipline (the mag decides the mode)', () => {
  it('reloads when dry', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 300, y: 0 });
    const brain = makeBrain();
    brain.tick(1, makeCtx(world, { ammo: { 1: 0 } }));
    expect(control(world, 1).reload).toBe(true);
  });

  it('proactively reloads at low mag only when out of the band', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 500, y: 0 }); // dist > RANGE_MAX
    const brain = makeBrain();
    brain.tick(1, makeCtx(world, { ammo: { 1: 5 } }));
    expect(control(world, 1).reload).toBe(true);

    // Same low mag, but inside the band: keep fighting.
    const world2 = makeWorld();
    spawn(world2, 1, { x: 0, y: 0 });
    spawn(world2, 2, { x: 300, y: 0 });
    const brain2 = makeBrain();
    brain2.tick(1, makeCtx(world2, { ammo: { 1: 5 } }));
    expect(control(world2, 1).reload).toBe(false);
  });

  it('disengages while reloading: opens range away from the threat, no fire', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 300, y: 0 }); // enemy to the right
    const brain = makeBrain();
    brain.tick(1, makeCtx(world, { reloading: { 1: true } }));
    const c = control(world, 1);
    expect(c.left).toBe(true);
    expect(c.right).toBe(false);
    expect(c.fire).toBe(false);
    expect(c.jetpack).toBe(true); // going up is safer than running on the floor
  });
});

describe('pilot: hunt memory', () => {
  it('pursues the last-seen X position after LOS is lost', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 300, y: -200 }); // above the bot
    const brain = makeBrain();
    const ctx = makeCtx(world);
    tick(brain, 1, ctx); // sees the enemy, records last-seen
    world.sprites[2]!.active = false; // enemy vanishes
    tick(brain, 1, ctx);
    const c = control(world, 1);
    expect(c.right).toBe(true); // px(0) < lastSeenX(300) - 40
    expect(c.jetpack).toBe(true); // target was above: climb toward it
  });

  it('never climbs (or descends) toward a last-seen position BELOW it', () => {
    // Reviewer finding (medium): the hunt branch only climbs when the target
    // was ABOVE the bot. A target last seen below produces pure horizontal
    // pursuit — no jetpack, no down key — which can strand the bot above
    // geometry. This pins the ACTUAL current behavior.
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 300, y: 200 }); // below the bot, dist ~360 (in band)
    const brain = makeBrain();
    const ctx = makeCtx(world);
    tick(brain, 1, ctx);
    world.sprites[2]!.active = false;
    tick(brain, 1, ctx);
    const c = control(world, 1);
    expect(c.right).toBe(true);
    expect(c.jetpack).toBe(false); // suspect: no vertical pursuit downward
    expect(c.down).toBe(false);
  });

  it('falls back to roaming after HUNT_MEMORY_TICKS', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: -300, y: 0 }); // last seen to the LEFT
    const brain = makeBrain();
    const ctx = makeCtx(world, { spawns: [{ x: 2000, y: 0 }] });
    tick(brain, 1, ctx);
    world.sprites[2]!.active = false;
    tick(brain, 1, ctx);
    expect(control(world, 1).left).toBe(true); // still hunting left

    // Jump the clock past the memory horizon: roam takes over and heads for
    // the single spawn far to the RIGHT.
    world.mainTickCounter += PILOT_DEFAULTS.HUNT_MEMORY_TICKS + 1;
    brain.tick(1, ctx);
    const c = control(world, 1);
    expect(c.right).toBe(true);
    expect(c.left).toBe(false);
  });
});

describe('pilot: ceiling-stall give-up', () => {
  it('concedes the climb after STALL_TRIGGER ticks of jetting without rising', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0, vy: 0 }); // vy = 0 ≥ STALL_RISE_VY: never rising
    spawn(world, 2, { x: 300, y: -300 }); // enemy above → wants to climb
    const brain = makeBrain();
    const ctx = makeCtx(world);

    for (let t = 0; t < PILOT_DEFAULTS.STALL_TRIGGER - 1; t++) {
      tick(brain, 1, ctx);
      expect(control(world, 1).jetpack).toBe(true);
    }
    // The trigger tick: stall counter hits STALL_TRIGGER → thrust is cut.
    tick(brain, 1, ctx);
    expect(control(world, 1).jetpack).toBe(false);
    // Climbing stays suppressed for the cooldown...
    tick(brain, 1, ctx);
    expect(control(world, 1).jetpack).toBe(false);
    // ...and resumes once the cooldown expires.
    world.mainTickCounter += PILOT_DEFAULTS.STALL_COOLDOWN;
    brain.tick(1, ctx);
    expect(control(world, 1).jetpack).toBe(true);
  });
});
