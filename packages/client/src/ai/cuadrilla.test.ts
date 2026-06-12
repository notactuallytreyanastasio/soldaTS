// Cuadrilla brain unit tests — the bullfighter's crew, pinned against
// hand-built worlds: bull determinism across members (open beats armed), the
// ROTATE_BELOW reserve withdrawal (and that the reserve never joins a pass),
// the PASS_REACH gate on the crew-wide dash, the RELOAD_SAFE_DIST quiet
// retreat, SPAS fan respect (FAN_GIVE + reload-only windows), and the
// shotgun-aware ballistic drop.
//
// Worlds are real sim worlds (createWorld + initSimWorld, map null so line of
// sight is always clear); only positions/health/ammo/weapons are staged.

import { describe, it, expect } from 'vitest';
import {
  buildWaypoints,
  createWorld,
  initSimWorld,
  type World,
} from '@soldat/sim';
import { createCuadrillaEngine } from './cuadrilla';
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

interface CtxOpts {
  ammo?: Record<number, number>;
  reloading?: Record<number, boolean>;
  weapons?: Record<number, string>;
}

function makeCtx(world: World, opts: CtxOpts = {}): BotEngineContext {
  return {
    world,
    graph: buildWaypoints({ waypoints: [] }),
    spawns: [{ x: 0, y: 0 }],
    spectate: true,
    ammoOf: (i: number): number => opts.ammo?.[i] ?? 30,
    reloadingOf: (i: number): boolean => opts.reloading?.[i] ?? false,
    magSize: 30,
    weaponOf: (i: number): string => opts.weapons?.[i] ?? 'AK74',
  };
}

function newBrain(tweaks?: Record<string, number>) {
  return createCuadrillaEngine(tweaks).createBrain();
}

describe('cuadrilla: one bull, picked by mag', () => {
  it('every member independently targets the reloading enemy over a nearer armed one', () => {
    const world = makeWorld();
    addBot(world, 1, { x: 0, y: 0, team: 1 });
    addBot(world, 2, { x: 100, y: 0, team: 1 });
    addBot(world, 3, { x: 350, y: 0, team: 2 }); // armed, nearer to the centroid
    addBot(world, 4, { x: 450, y: 0, team: 2 }); // reloading — the bull
    const ctx = makeCtx(world, { reloading: { 4: true } });
    newBrain().tick(1, ctx);
    newBrain().tick(2, ctx);
    // Stationary targets: aimX is exactly (bullX − memberX).
    expect(world.sprites[1]!.control.mouseAimX).toBe(450);
    expect(world.sprites[2]!.control.mouseAimX).toBe(350);
    // The window is open and in reach: the whole crew dashes.
    expect(world.sprites[1]!.control.right).toBe(true);
    expect(world.sprites[2]!.control.right).toBe(true);
  });
});

describe('cuadrilla: the reserve (pillar 4)', () => {
  it('the member under ROTATE_BELOW withdraws and skips the pass the fronts launch', () => {
    const world = makeWorld();
    addBot(world, 1, { x: 0, y: 0, team: 1 });
    addBot(world, 2, { x: 50, y: 0, team: 1 });
    addBot(world, 3, { x: 100, y: 0, team: 1, health: 40 }); // < ROTATE_BELOW 55
    addBot(world, 4, { x: 500, y: 0, team: 2 }); // reloading: the window is OPEN
    const ctx = makeCtx(world, { reloading: { 4: true } });
    newBrain().tick(1, ctx);
    newBrain().tick(3, ctx);
    // Front 1 passes (dash toward the bull)...
    expect(world.sprites[1]!.control.right).toBe(true);
    // ...while the wounded reserve runs the OTHER way (d 400 < ANCHOR_MIN 600),
    // window or no window.
    expect(world.sprites[3]!.control.left).toBe(true);
    expect(world.sprites[3]!.control.right).toBe(false);
  });

  it('plants in the anchor band and keeps tap-sniping from the long reserve', () => {
    const world = makeWorld();
    addBot(world, 1, { x: 0, y: 0, team: 1 });
    addBot(world, 2, { x: 50, y: 0, team: 1 });
    addBot(world, 3, { x: -150, y: 0, team: 1, health: 40 }); // d 650 ∈ [600,760]
    addBot(world, 4, { x: 500, y: 0, team: 2 });
    const c = world.sprites[3]!.control;
    world.mainTickCounter = 3; // (3 + 3·3) % 6 = 0 → tap open for bot 3
    newBrain().tick(3, makeCtx(world));
    expect(c.left).toBe(false);
    expect(c.right).toBe(false);
    expect(c.fire).toBe(true); // 650 ≤ ANCHOR_FIRE_MAX 700: free damage
  });
});

describe('cuadrilla: the pass gate (PASS_REACH)', () => {
  it('dashes when the open window is in reach, backs out when the crew centroid is too far', () => {
    // Identical bot/bull geometry; only the OTHER crew member moves.
    const inReach = makeWorld();
    addBot(inReach, 1, { x: 200, y: 0, team: 1 });
    addBot(inReach, 2, { x: 240, y: 0, team: 1 });
    addBot(inReach, 3, { x: 0, y: 0, team: 2 }); // reloading bull, 200 px out
    newBrain().tick(1, makeCtx(inReach, { reloading: { 3: true } }));
    // Fronts centroid (220,0) → reach 220 ≤ 560: THE PASS — close to 120.
    expect(inReach.sprites[1]!.control.left).toBe(true);
    expect(inReach.sprites[1]!.control.right).toBe(false);

    const outOfReach = makeWorld();
    addBot(outOfReach, 1, { x: 200, y: 0, team: 1 });
    addBot(outOfReach, 2, { x: 1100, y: 0, team: 1 }); // drags the centroid away
    addBot(outOfReach, 3, { x: 0, y: 0, team: 2 });
    newBrain().tick(1, makeCtx(outOfReach, { reloading: { 3: true } }));
    // Centroid (650,0) → reach 650 > 560: no pass. At 200 px the hot-mag
    // give-ground rule applies instead — the torero backs OUT.
    expect(outOfReach.sprites[1]!.control.right).toBe(true);
    expect(outOfReach.sprites[1]!.control.left).toBe(false);
  });
});

describe('cuadrilla: own mag, out of reach (RELOAD_SAFE_DIST)', () => {
  it('retreats quietly without flagging reload while inside the enemy reach', () => {
    const world = makeWorld();
    addBot(world, 1, { x: 0, y: 0, team: 1 });
    addBot(world, 2, { x: 500, y: 0, team: 2 }); // ecenDist 500 ≤ 620
    const c = world.sprites[1]!.control;
    newBrain().tick(1, makeCtx(world, { ammo: { 1: 8 } })); // ≤ SELF_RELOAD_AT 9
    expect(c.reload).toBe(false); // never crosses a window trigger in reach
    expect(c.left).toBe(true); // opening range from the enemy centroid
    expect(c.fire).toBe(false); // staying dark
  });

  it('reloads once safely beyond RELOAD_SAFE_DIST of the enemy centroid', () => {
    const world = makeWorld();
    addBot(world, 1, { x: 0, y: 0, team: 1 });
    addBot(world, 2, { x: 700, y: 0, team: 2 }); // ecenDist 700 > 620
    const c = world.sprites[1]!.control;
    newBrain().tick(1, makeCtx(world, { ammo: { 1: 8 } }));
    expect(c.reload).toBe(true);
    expect(c.left).toBe(true); // still opening range while the mag cycles
  });
});

describe('cuadrilla: SPAS fan respect', () => {
  it('an ARMED SPAS bull gets FAN_GIVE ground where an AK bull holds the slot walk', () => {
    const spas = makeWorld();
    addBot(spas, 1, { x: 300, y: 0 }); // FFA crew of one
    addBot(spas, 2, { x: 0, y: 0 });
    newBrain().tick(1, makeCtx(spas, { weapons: { 2: 'SPAS12' }, ammo: { 2: 2 } }));
    // Two shells in a fan is NOT a window — and 300 < FAN_GIVE 330: back out.
    expect(spas.sprites[1]!.control.right).toBe(true);

    const ak = makeWorld();
    addBot(ak, 1, { x: 300, y: 0 });
    addBot(ak, 2, { x: 0, y: 0 });
    newBrain().tick(1, makeCtx(ak)); // AK, hot mag, 300 ≥ GIVE_GROUND 240
    expect(ak.sprites[1]!.control.left).toBe(true); // walking its bearing slot
  });

  it('a SPAS bull actually reloading IS the window: the pass launches', () => {
    const world = makeWorld();
    addBot(world, 1, { x: 300, y: 0 });
    addBot(world, 2, { x: 0, y: 0 });
    const c = world.sprites[1]!.control;
    newBrain().tick(
      1,
      makeCtx(world, { weapons: { 2: 'SPAS12' }, reloading: { 2: true } }),
    );
    expect(c.left).toBe(true); // dash toward the bull
    expect(c.fire).toBe(true); // 300 ≤ WINDOW_AUTO 360: full-auto
  });

  it('compensates drop for its OWN carried weapon (SPAS shells fly at 14 px/tick)', () => {
    const spas = makeWorld();
    addBot(spas, 1, { x: 0, y: 0 });
    addBot(spas, 2, { x: 300, y: 0 });
    newBrain().tick(1, makeCtx(spas, { weapons: { 1: 'SPAS12' } }));
    // tof = 300/14 ≈ 21.43 → drop ≈ 31 px.
    expect(spas.sprites[1]!.control.mouseAimY).toBe(-31);

    const ak = makeWorld();
    addBot(ak, 1, { x: 0, y: 0 });
    addBot(ak, 2, { x: 300, y: 0 });
    newBrain().tick(1, makeCtx(ak));
    // tof = 300/24.6 ≈ 12.20 → drop ≈ 10 px.
    expect(ak.sprites[1]!.control.mouseAimY).toBe(-10);
  });
});
