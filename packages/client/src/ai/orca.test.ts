// Orca brain unit tests — the pod hunts the gap: per-tick stateless prey
// selection keyed on the enemy's mag clock (wave / stalk / ebb), the
// hardware-aware SPAS rules (a SPAS prey only opens while RELOADING; the wave
// brakes outside the fan; an own-SPAS orca fights at the envelope's edge),
// the wounded deep swim, off-beat reload discipline, the fan-threat override,
// height parity, and the committed bullet dodge.
//
// Harness: a hand-built sim world (map === null so line of sight is always
// clear); weapon labels and mag state are injected through the ctx hooks the
// same way the real host provides them. Fixed rng seed.

import { describe, it, expect } from 'vitest';
import { createWorld, initSimWorld, type World, type WaypointGraph } from '@soldat/sim';
import type { BotEngineContext } from './engine';
import { createOrcaEngine, ORCA_DEFAULTS } from './orca';

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

function makeBrain() {
  return createOrcaEngine().createBrain();
}

describe('orca: the ebb (hot enemy mag → refuse the duel)', () => {
  it('plants in the poke band (no horizontal motion)', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 450, y: 0 }); // in 380..520, mag full
    const brain = makeBrain();
    brain.tick(1, makeCtx(world));
    const c = control(world, 1);
    expect(c.left).toBe(false);
    expect(c.right).toBe(false);
  });

  it('gives ground inside POKE_MIN, drifts in beyond POKE_MAX', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 300, y: 0 }); // < 380
    const brain = makeBrain();
    brain.tick(1, makeCtx(world));
    expect(control(world, 1).left).toBe(true);

    const world2 = makeWorld();
    spawn(world2, 1, { x: 0, y: 0 });
    spawn(world2, 2, { x: 600, y: 0 }); // > 520
    const brain2 = makeBrain();
    brain2.tick(1, makeCtx(world2));
    expect(control(world2, 1).right).toBe(true);
  });

  it('taps on the staggered cooldown clock beyond AUTO_RANGE', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 450, y: 0 });
    const brain = makeBrain();
    const ctx = makeCtx(world);
    world.mainTickCounter = 3; // bot 1: (3 + 3) % 6 = 0 → tap open
    brain.tick(1, ctx);
    expect(control(world, 1).fire).toBe(true);
    world.mainTickCounter = 1; // (1 + 3) % 6 = 4 → closed
    brain.tick(1, ctx);
    expect(control(world, 1).fire).toBe(false);
  });
});

describe('orca: the wave (reload window → dash)', () => {
  it('launches the wave the very tick the prey starts reloading', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 450, y: 0 });
    const reloading: Record<number, boolean> = { 2: false };
    const brain = makeBrain();
    const ctx = makeCtx(world, { reloading });
    brain.tick(1, ctx);
    expect(control(world, 1).right).toBe(false); // hot mag: planted

    reloading[2] = true; // the prey's mag drops THIS tick
    world.mainTickCounter += 1;
    brain.tick(1, ctx);
    expect(control(world, 1).right).toBe(true); // per-tick re-read: dash NOW
  });

  it('a near-dry AK mag (≤ LOW_MAG_OPEN) opens the window early', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 450, y: 0 });
    const brain = makeBrain();
    brain.tick(1, makeCtx(world, { ammo: { 2: 4 } }));
    expect(control(world, 1).right).toBe(true);
  });

  it('a near-dry SPAS mag does NOT open the window (only an actual reload does)', () => {
    // Reviewer focus: four shells left in a fan is not an open window — the
    // disarm check for SPAS carriers is reload-only, by design.
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 450, y: 0 });
    const brain = makeBrain();
    brain.tick(
      1,
      makeCtx(world, { weapons: { 2: 'SPAS12' }, ammo: { 2: 2 } }),
    );
    const c = control(world, 1);
    expect(c.left).toBe(false); // no stalk either: SPAS prey is never stalked
    expect(c.right).toBe(false); // planted in the poke band instead

    // The same carrier mid-reload IS a window.
    const world2 = makeWorld();
    spawn(world2, 1, { x: 0, y: 0 });
    spawn(world2, 2, { x: 450, y: 0 });
    const brain2 = makeBrain();
    brain2.tick(
      1,
      makeCtx(world2, { weapons: { 2: 'SPAS12' }, reloading: { 2: true } }),
    );
    expect(control(world2, 1).right).toBe(true);
  });

  it('the wave on a reloading SPAS carrier brakes at SPAS_STANDOFF, not point-blank', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 300, y: 0 }); // inside SPAS_STANDOFF (330)
    const brain = makeBrain();
    brain.tick(
      1,
      makeCtx(world, { weapons: { 2: 'SPAS12' }, reloading: { 2: true } }),
    );
    const c = control(world, 1);
    expect(c.left).toBe(false); // holds: it finishes that reload with 6 shells
    expect(c.right).toBe(false);
  });

  it('goes full-auto from WINDOW_AUTO in during the wave', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 300, y: 0 }); // ≤ WINDOW_AUTO 360
    const brain = makeBrain();
    world.mainTickCounter = 1; // tap clock CLOSED for bot 1 — auto must carry it
    brain.tick(1, makeCtx(world, { reloading: { 2: true } }));
    expect(control(world, 1).fire).toBe(true);

    // Same distance with a hot mag: beyond AUTO_RANGE (230) → tap-gated.
    const world2 = makeWorld();
    spawn(world2, 1, { x: 0, y: 0 });
    spawn(world2, 2, { x: 300, y: 0 });
    const brain2 = makeBrain();
    world2.mainTickCounter = 1;
    brain2.tick(1, makeCtx(world2));
    expect(control(world2, 1).fire).toBe(false);
  });
});

describe('orca: the stalk (their mag runs low → creep to striking distance)', () => {
  it('creeps in when the prey mag hits STALK_MAG', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 450, y: 0 });
    const brain = makeBrain();
    brain.tick(1, makeCtx(world, { ammo: { 2: 11 } }));
    expect(control(world, 1).right).toBe(true); // toward STALK_DIST, not the band
  });

  it('holds (band motion) once inside STALK_DIST', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 200, y: 0 }); // < 250
    const brain = makeBrain();
    brain.tick(1, makeCtx(world, { ammo: { 2: 11 } }));
    const c = control(world, 1);
    expect(c.left).toBe(false);
    expect(c.right).toBe(false);
  });
});

describe('orca: the wounded swim deep', () => {
  it('the pod\'s lowest-health member under EBB_HEALTH opens range from the enemy centroid', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0, team: 1, health: 50 }); // argmin, < 55
    spawn(world, 2, { x: 50, y: 0, team: 1, health: 150 });
    spawn(world, 3, { x: 300, y: 0, team: 2 });
    spawn(world, 4, { x: 350, y: 0, team: 2 });
    const brain = makeBrain();
    brain.tick(1, makeCtx(world));
    const c = control(world, 1);
    expect(c.left).toBe(true); // away from the enemy centroid at ~325
    expect(c.right).toBe(false);
  });

  it('the deep swimmer reloads freely — distance IS the safety', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0, team: 1, health: 50 });
    spawn(world, 2, { x: 50, y: 0, team: 1, health: 150 });
    spawn(world, 3, { x: 300, y: 0, team: 2 });
    const brain = makeBrain();
    brain.tick(1, makeCtx(world, { ammo: { 1: 9 } })); // ≤ SELF_RELOAD_AT
    expect(control(world, 1).reload).toBe(true);
  });

  it('no deep swim for a lone orca (FFA): it fights the band wounded', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0, team: 0, health: 50 });
    spawn(world, 2, { x: 450, y: 0, team: 0 });
    const brain = makeBrain();
    brain.tick(1, makeCtx(world));
    const c = control(world, 1);
    expect(c.left).toBe(false); // planted in the band, not fleeing
    expect(c.right).toBe(false);
  });

  it('only the argmin swims deep — the second-most-wounded keeps fighting', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0, team: 1, health: 50 });
    spawn(world, 2, { x: 50, y: 0, team: 1, health: 30 }); // the actual argmin
    spawn(world, 3, { x: 450, y: 0, team: 2 });
    spawn(world, 4, { x: 500, y: 0, team: 2 });
    const brain = makeBrain();
    brain.tick(1, makeCtx(world));
    const c = control(world, 1);
    expect(c.left).toBe(false); // bot 1 holds the poke band instead of ebbing
    expect(c.right).toBe(false);
  });
});

describe('orca: off-beat reload discipline', () => {
  it('reloads at SELF_RELOAD_AT only when NO enemy gun is inside the band', () => {
    // Prey (wounded, far) plus a healthy enemy parked nearby: the nearby gun
    // vetoes the off-beat reload.
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 450, y: 0, health: 50 }); // the prey (lowest health)
    spawn(world, 3, { x: -200, y: 0, health: 150 }); // nearer threat in the band
    const brain = makeBrain();
    brain.tick(1, makeCtx(world, { ammo: { 1: 9 } }));
    expect(control(world, 1).reload).toBe(false);

    // Same mag, no nearby gun: reload on the off-beat.
    const world2 = makeWorld();
    spawn(world2, 1, { x: 0, y: 0 });
    spawn(world2, 2, { x: 450, y: 0, health: 50 });
    const brain2 = makeBrain();
    brain2.tick(1, makeCtx(world2, { ammo: { 1: 9 } }));
    expect(control(world2, 1).reload).toBe(true);
  });

  it('reloads when dry regardless of pressure', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 450, y: 0 });
    const brain = makeBrain();
    brain.tick(1, makeCtx(world, { ammo: { 1: 0 } }));
    expect(control(world, 1).reload).toBe(true);
  });
});

describe('orca: the fan comes first (armed SPAS threat override)', () => {
  it('backs away from an armed SPAS in FAN_RESPECT and hoses IT, not the prey', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 300, y: 0 }); // armed SPAS carrier closing in
    spawn(world, 3, { x: -450, y: 0, health: 50 }); // the nominal prey (argmin)
    const brain = makeBrain();
    world.mainTickCounter = 3; // tap open for bot 1
    brain.tick(
      1,
      makeCtx(world, { weapons: { 2: 'SPAS12' }, ammo: { 2: 4 } }),
    );
    const c = control(world, 1);
    expect(c.left).toBe(true); // away from the fan on the right
    expect(c.mouseAimX).toBeGreaterThan(0); // gun ON the carrier
    expect(c.fire).toBe(true);
  });

  it('the same carrier with no weaponOf host hook reads as a near-dry AK — wave, not flight', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 300, y: 0 });
    spawn(world, 3, { x: -450, y: 0, health: 50 });
    const brain = makeBrain();
    world.mainTickCounter = 3;
    brain.tick(1, makeCtx(world, { ammo: { 2: 4 } })); // ammo 4 → AK window opens
    const c = control(world, 1);
    // Treated as everyone-on-AK74: 4 rounds is an open window, so the orca
    // DASHES at the carrier instead of backing off — the exact mistake the
    // hardware check exists to prevent.
    expect(c.right).toBe(true);
    expect(c.left).toBe(false);
    expect(c.mouseAimX).toBeGreaterThan(0);
  });
});

describe('orca: own-SPAS doctrine', () => {
  it('closes to the envelope edge instead of holding the AK poke band', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 450, y: 0 });
    const brain = makeBrain();
    world.mainTickCounter = 3;
    brain.tick(1, makeCtx(world, { weapons: { 1: 'SPAS12' } }));
    const c = control(world, 1);
    expect(c.right).toBe(true); // an AK orca would PLANT at 450
    // And the aim runs pellet ballistics: deep drop compensation.
    const tof = 450 / SPAS_BULLET_SPEED;
    const drop = 0.5 * ORCA_DEFAULTS.DROP_G * tof * tof;
    expect(c.mouseAimY).toBe(Math.round(-drop)); // ≈ -70 (AK math would be ~-23)
    expect(c.fire).toBe(true); // 450 ≤ SPAS_FIRE_MAX, tap open
  });
});

describe('orca: height parity, not greed', () => {
  it('erases a height deficit beyond LEVEL_BAND', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0 });
    spawn(world, 2, { x: 450, y: -100 }); // prey above by 100 > 50
    const brain = makeBrain();
    brain.tick(1, makeCtx(world));
    expect(control(world, 1).jetpack).toBe(true);
  });

  it('gives back overextension past HEIGHT_CAP with the down key', () => {
    const world = makeWorld();
    // Low fuel so the planted bob does not also pulse the jets here.
    spawn(world, 1, { x: 0, y: 0, jets: 50 });
    spawn(world, 2, { x: 400, y: 250 }); // prey below by 250 > 200
    const brain = makeBrain();
    brain.tick(1, makeCtx(world));
    const c = control(world, 1);
    expect(c.down).toBe(true);
    expect(c.jetpack).toBe(false);
  });
});

describe('orca: bullet dodge', () => {
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

  it('jets vertically off a flat threatening bullet (the untaxed axis)', () => {
    const world = makeWorld();
    // jets below FUEL_RESERVE so the planted bob cannot be the jet source.
    spawn(world, 1, { x: 0, y: 0, jets: 50 });
    spawn(world, 2, { x: 450, y: 0 });
    fireBullet(world, 1, 2, -200, 0, 20, 0); // dead-on, arrives in 10 ticks
    const brain = makeBrain();
    brain.tick(1, makeCtx(world));
    expect(control(world, 1).jetpack).toBe(true);
  });

  it('strafes off a falling bullet, committed for DODGE_COMMIT ticks', () => {
    const world = makeWorld();
    spawn(world, 1, { x: 0, y: 0, jets: 50 });
    spawn(world, 2, { x: 450, y: 0 });
    fireBullet(world, 1, 2, 10, -300, 0, 20); // vertical, misses 10px right
    const brain = makeBrain();
    const ctx = makeCtx(world);
    brain.tick(1, ctx);
    expect(control(world, 1).left).toBe(true);
    // The bullet disappears but the dodge stays committed.
    world.bullets[1]!.active = false;
    world.mainTickCounter += 1;
    brain.tick(1, ctx);
    expect(control(world, 1).left).toBe(true);
  });
});
