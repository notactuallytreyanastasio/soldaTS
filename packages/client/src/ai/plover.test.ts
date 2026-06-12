// Plover brain unit tests — the broken-wing gambit: bait designation (lowest
// health under BAIT_HP_ON), the bait's flee/window/drift state machine and
// cornered flip, the executioners' shared lowest-health focus, the staggered
// tap clock, and the committed closest-approach bullet dodge.
//
// Harness: a hand-built sim world (map === null so line of sight is always
// clear); the brain's only output is the bot's control. Fixed rng seed.
// NOTE: with map === null the LOS-based parts of bait/focus rules (e.g. the
// reviewer's "bait may be invisible to all enemies" finding) cannot diverge —
// those paths need a real PolyMap and are covered by the Game integration
// tests instead.

import { describe, it, expect } from 'vitest';
import { createWorld, initSimWorld, type World, type WaypointGraph } from '@soldat/sim';
import type { BotEngineContext } from './engine';
import { createPloverEngine, PLOVER_DEFAULTS } from './plover';

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
  return createPloverEngine().createBrain();
}

/** Team scenario: plovers 1-2 on team 1, enemies 3(+4) on team 2. */
function packScenario(world: World, opts: {
  selfHealth: number;
  mateHealth?: number;
  enemyX: number;
  enemy2?: { x: number; y: number; health?: number };
}): void {
  spawn(world, 1, { x: 0, y: 0, team: 1, health: opts.selfHealth });
  spawn(world, 2, { x: 100, y: 0, team: 1, health: opts.mateHealth ?? 150 });
  spawn(world, 3, { x: opts.enemyX, y: 0, team: 2 });
  if (opts.enemy2 !== undefined) {
    spawn(world, 4, {
      x: opts.enemy2.x,
      y: opts.enemy2.y,
      team: 2,
      health: opts.enemy2.health ?? 150,
    });
  }
}

describe('plover: bait designation', () => {
  it('a wounded packmate (health < BAIT_HP_ON) becomes the bait and plants in the window', () => {
    const world = makeWorld();
    packScenario(world, { selfHealth: 50, enemyX: 500 }); // chaser in 420..560
    const brain = makeBrain();
    brain.tick(1, makeCtx(world));
    const c = control(world, 1);
    // The bait in the window holds position (no horizontal motion): seen,
    // alive, infuriating. An executioner at this distance would advance.
    expect(c.left).toBe(false);
    expect(c.right).toBe(false);
  });

  it('an unwounded bot never baits — it executes (advances on the focus)', () => {
    const world = makeWorld();
    packScenario(world, { selfHealth: 150, enemyX: 500 }); // 500 > HUNT_BAND_MAX
    const brain = makeBrain();
    brain.tick(1, makeCtx(world));
    expect(control(world, 1).right).toBe(true); // closing toward the band
  });

  it('no bait role in FFA (pack of one), even when wounded', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0, team: 0, health: 50 });
    spawn(world, 2, { x: 500, y: 0, team: 0 });
    const brain = makeBrain();
    brain.tick(1, makeCtx(world));
    expect(control(world, 1).right).toBe(true); // engaging, not planting as bait
  });

  it('the wounded bait keeps its mag topped up while it runs', () => {
    const world = makeWorld();
    packScenario(world, { selfHealth: 50, enemyX: 500 });
    const brain = makeBrain();
    brain.tick(1, makeCtx(world, { ammo: { 1: 5 } })); // ≤ RELOAD_LOW
    expect(control(world, 1).reload).toBe(true);
  });
});

describe('plover: bait flight (the broken wing)', () => {
  it('flees and climbs when the lead chaser is inside BAIT_NEAR', () => {
    const world = makeWorld();
    packScenario(world, { selfHealth: 50, enemyX: 300 }); // 300 < 420
    const brain = makeBrain();
    brain.tick(1, makeCtx(world));
    const c = control(world, 1);
    expect(c.left).toBe(true); // away from the chaser centroid
    expect(c.right).toBe(false);
    expect(c.jetpack).toBe(true); // altitude is escape the chasers pay fuel for
  });

  it('drifts back toward the chaser when beyond BAIT_FAR (stay seen, hold aggro)', () => {
    const world = makeWorld();
    packScenario(world, { selfHealth: 50, enemyX: 700 }); // 700 > 560
    const brain = makeBrain();
    brain.tick(1, makeCtx(world));
    const c = control(world, 1);
    expect(c.right).toBe(true);
    expect(c.left).toBe(false);
  });

  it('commits to a reverse break after BAIT_STUCK_TICKS of no horizontal progress', () => {
    const world = makeWorld();
    packScenario(world, { selfHealth: 50, enemyX: 300 }); // fleeing left, vx = 0
    const brain = makeBrain();
    const ctx = makeCtx(world);
    tick(brain, 1, ctx);
    expect(control(world, 1).left).toBe(true); // initial flee direction
    for (let t = 0; t < PLOVER_DEFAULTS.BAIT_STUCK_TICKS + 1; t++) {
      tick(brain, 1, ctx);
    }
    // Cornered (zero velocity the whole time): the wing breaks back the
    // other way and commits to it.
    expect(control(world, 1).right).toBe(true);
    expect(control(world, 1).left).toBe(false);
  });
});

describe('plover: executioner focus', () => {
  it('all guns on the lowest-health visible enemy', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 50, y: 0, team: 1, health: 80 }); // the bait (wounded)
    spawn(world, 2, { x: 0, y: 0, team: 1, health: 150 }); // the executioner
    spawn(world, 3, { x: -400, y: 0, team: 2, health: 80 }); // wounded enemy
    spawn(world, 4, { x: 400, y: 0, team: 2, health: 150 }); // healthy enemy
    const brain = makeBrain();
    world.mainTickCounter = 0; // bot 2's stagger: (0 + 6) % 6 = 0 → tap open
    brain.tick(2, makeCtx(world));
    const c = control(world, 2);
    expect(c.mouseAimX).toBeLessThan(0); // gun on the wounded one at -400
    expect(c.fire).toBe(true); // planted in band, tap open
  });

  it('plants in the hunt band (no horizontal motion) when the focus is in range', () => {
    const world = makeWorld();
    packScenario(world, { selfHealth: 150, mateHealth: 80, enemyX: 400 }); // in 340..480
    const brain = makeBrain();
    brain.tick(1, makeCtx(world));
    const c = control(world, 1);
    expect(c.left).toBe(false);
    expect(c.right).toBe(false);
  });

  it('gives ground when inside HUNT_BAND_MIN', () => {
    const world = makeWorld();
    packScenario(world, { selfHealth: 150, mateHealth: 80, enemyX: 300 }); // < 340
    const brain = makeBrain();
    brain.tick(1, makeCtx(world));
    const c = control(world, 1);
    expect(c.left).toBe(true);
    expect(c.right).toBe(false);
  });

  it('staggers the tap clock per bot index', () => {
    const world = makeWorld();
    packScenario(world, { selfHealth: 150, mateHealth: 80, enemyX: 400 });
    const brain = makeBrain();
    const ctx = makeCtx(world);
    // Bot 1: fire iff (clock + 3) % 6 < 1.
    world.mainTickCounter = 3; // (3 + 3) % 6 = 0 → open
    brain.tick(1, ctx);
    expect(control(world, 1).fire).toBe(true);
    world.mainTickCounter = 4; // (4 + 3) % 6 = 1 → closed
    brain.tick(1, ctx);
    expect(control(world, 1).fire).toBe(false);
  });
});

describe('plover: bullet dodge (kestrel pillar)', () => {
  function fireBullet(
    world: World,
    slot: number,
    owner: number,
    x: number,
    y: number,
    vx: number,
    vy: number,
  ): void {
    const b = world.bullets[slot]!;
    b.active = true;
    b.owner = owner;
    b.num = slot;
    const bp = world.bulletParts!;
    bp.posX[slot] = x;
    bp.posY[slot] = y;
    bp.velocityX[slot] = vx;
    bp.velocityY[slot] = vy;
  }

  it('jets vertically away from a flat (horizontal) threatening bullet', () => {
    const world = makeWorld();
    // Low fuel (< FUEL_FLOOR) so the planted bob can't be the jet source —
    // only the dodge (which needs just jets > 0) can set jetpack here.
    spawn(world, 1, { x: 0, y: 0, team: 0, jets: 50 });
    spawn(world, 2, { x: 400, y: 0, team: 0, health: 80 });
    fireBullet(world, 1, 2, -200, 0, 20, 0); // dead-on, arrives in 10 ticks
    const brain = makeBrain();
    brain.tick(1, makeCtx(world));
    expect(control(world, 1).jetpack).toBe(true);
  });

  it('strafes perpendicular to a vertical (falling) threatening bullet', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0, team: 0, jets: 50 });
    spawn(world, 2, { x: 400, y: 0, team: 0, health: 80 });
    fireBullet(world, 1, 2, 10, -300, 0, 20); // falling, misses 10px right
    const brain = makeBrain();
    brain.tick(1, makeCtx(world));
    const c = control(world, 1);
    expect(c.left).toBe(true); // dodge away from the miss side
    expect(c.right).toBe(false);
  });

  it('ignores bullets whose closest approach is outside DANGER_RADIUS', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0, team: 0, jets: 50 });
    spawn(world, 2, { x: 400, y: 0, team: 0, health: 80 });
    fireBullet(world, 1, 2, -200, 100, 20, 0); // flat but 100px below: a miss
    const brain = makeBrain();
    brain.tick(1, makeCtx(world));
    expect(control(world, 1).jetpack).toBe(false); // low fuel + no dodge
  });
});
