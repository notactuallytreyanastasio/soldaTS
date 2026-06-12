// Matador brain unit tests — the tempo counter-puncher's mag clock, pinned
// against hand-built worlds: pickTarget's hunt-the-disarmed priority (and its
// WINDOW_HUNT reach gate), the window/stalk/poke phase ladder, off-beat
// proactive reloads, the reloading retreat, EMA lead knobs, and the dist=0
// degenerate aim case the review flagged (safe: tof 0 → exact zero aim).
//
// Worlds are real sim worlds (createWorld + initSimWorld, map null so line of
// sight is always clear); only positions/velocities/ammo are staged.

import { describe, it, expect } from 'vitest';
import {
  buildWaypoints,
  createWorld,
  initSimWorld,
  type World,
} from '@soldat/sim';
import { createMatadorEngine } from './matador';
import type { BotEngineContext } from './engine';

const AK_BULLET_SPEED = 24.6;
const BULLET_GRAV = 0.06 * 2.25;

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
  };
}

/** Matador's single-pass lead + drop aim, mirrored. */
function expectedAim(
  px: number,
  py: number,
  tx: number,
  ty: number,
  emaVX: number,
  emaVY: number,
): { x: number; y: number } {
  const dist = Math.hypot(tx - px, ty - py);
  const tof = dist / AK_BULLET_SPEED;
  const drop = 0.5 * BULLET_GRAV * tof * tof;
  return {
    x: Math.round(tx + emaVX * tof - px),
    y: Math.round(ty + emaVY * tof - py - drop),
  };
}

function newBrain(tweaks?: Record<string, number>) {
  return createMatadorEngine(tweaks).createBrain();
}

describe('matador: pickTarget hunts the disarmed', () => {
  it('prefers a reloading enemy at 500px over an armed one at 200px', () => {
    const world = makeWorld();
    addBot(world, 1, { x: 0, y: 0 });
    addBot(world, 2, { x: 200, y: 0 }); // armed, nearer
    addBot(world, 3, { x: 500, y: 0 }); // reloading, farther (≤ WINDOW_HUNT 760)
    const c = world.sprites[1]!.control;
    newBrain().tick(1, makeCtx(world, { reloading: { 3: true } }));
    // Window open on the disarmed bull: dash toward it, full-auto in range.
    expect(c.mouseAimX).toBe(500); // aimed at the disarmed one, not the near one
    expect(c.right).toBe(true);
    expect(c.fire).toBe(true); // dist 500 ≤ WINDOW_AUTO 620
  });

  it('falls back to the nearest visible enemy when the disarmed one is out of WINDOW_HUNT reach', () => {
    const world = makeWorld();
    addBot(world, 1, { x: 0, y: 0 });
    addBot(world, 2, { x: 200, y: 0 }); // armed, nearer
    addBot(world, 3, { x: 800, y: 0 }); // reloading but beyond 760
    const c = world.sprites[1]!.control;
    newBrain().tick(1, makeCtx(world, { reloading: { 3: true } }));
    expect(c.mouseAimX).toBe(200); // fights the near armed one
    // Hot mag at 200px (< POKE_MIN 380): refuse the duel, give ground.
    expect(c.left).toBe(true);
  });
});

describe('matador: window / stalk / poke phases', () => {
  it('a low mag (≤ LOW_MAG_OPEN) opens the window without an actual reload', () => {
    const world = makeWorld();
    addBot(world, 1, { x: 0, y: 0 });
    addBot(world, 2, { x: 300, y: 0 });
    const c = world.sprites[1]!.control;
    newBrain().tick(1, makeCtx(world, { ammo: { 2: 4 } }));
    expect(c.right).toBe(true); // the pass: dash to point-blank
    expect(c.fire).toBe(true); // window full-auto (300 ≤ 620)
  });

  it('stalks (creeps to STALK_DIST, tap fire) when the mag runs low but is not open', () => {
    const world = makeWorld();
    addBot(world, 1, { x: 0, y: 0 });
    addBot(world, 2, { x: 400, y: 0 }); // > STALK_DIST 250
    const c = world.sprites[1]!.control;
    const ctx = makeCtx(world, { ammo: { 2: 11 } }); // ≤ STALK_MAG, > LOW_MAG_OPEN
    const brain = newBrain();
    world.mainTickCounter = 0; // burst clock open (0 % 6 < 1)
    brain.tick(1, ctx);
    expect(c.right).toBe(true); // creeping in
    expect(c.fire).toBe(true);
    world.mainTickCounter = 1; // burst clock closed
    brain.tick(1, ctx);
    expect(c.fire).toBe(false); // taps, never sprays, at the stalk standoff
  });

  it('holds the poke band against a hot mag: juke + tap, never close', () => {
    const world = makeWorld();
    addBot(world, 1, { x: 0, y: 0 });
    addBot(world, 2, { x: 450, y: 0 }); // inside [POKE_MIN 380, POKE_MAX 520]
    const c = world.sprites[1]!.control;
    world.mainTickCounter = 0;
    newBrain().tick(1, makeCtx(world)); // both mags hot
    // In the band: strafe-juke — exactly one horizontal direction is held.
    expect(c.left !== c.right).toBe(true);
    expect(c.fire).toBe(true); // tap clock open at clock 0
    expect(c.mouseAimX).toBe(450);
  });

  it('phase sequence follows the target mag: poke (hot) → stalk (11) → pass (reloading)', () => {
    const world = makeWorld();
    addBot(world, 1, { x: 0, y: 0 });
    addBot(world, 2, { x: 300, y: 0 }); // below the poke band floor
    const c = world.sprites[1]!.control;
    const ammo: Record<number, number> = { 2: 30 };
    const reloading: Record<number, boolean> = { 2: false };
    const ctx = makeCtx(world, { ammo, reloading });
    const brain = newBrain();

    brain.tick(1, ctx); // hot mag at 300 < POKE_MIN: give ground
    expect(c.left).toBe(true);

    ammo[2] = 11; // stalk: 300 > STALK_DIST 250 → creep back IN
    world.mainTickCounter = 1;
    brain.tick(1, ctx);
    expect(c.right).toBe(true);

    reloading[2] = true; // the cape drops
    world.mainTickCounter = 2;
    brain.tick(1, ctx);
    expect(c.right).toBe(true); // dash
    expect(c.fire).toBe(true); // window full-auto
  });
});

describe('matador: own mag on the off-beat', () => {
  it('reloads proactively only when safe and their mag is hot', () => {
    const safe = makeWorld();
    addBot(safe, 1, { x: 0, y: 0 });
    addBot(safe, 2, { x: 450, y: 0 }); // > POKE_MIN 380
    newBrain().tick(1, makeCtx(safe, { ammo: { 1: 9 } }));
    expect(safe.sprites[1]!.control.reload).toBe(true);

    const close = makeWorld(); // too close: never volunteer the mag
    addBot(close, 1, { x: 0, y: 0 });
    addBot(close, 2, { x: 300, y: 0 });
    newBrain().tick(1, makeCtx(close, { ammo: { 1: 9 } }));
    expect(close.sprites[1]!.control.reload).toBe(false);

    const window = makeWorld(); // their window is open: punish, don't reload
    addBot(window, 1, { x: 0, y: 0 });
    addBot(window, 2, { x: 450, y: 0 });
    newBrain().tick(1, makeCtx(window, { ammo: { 1: 9, 2: 0 } }));
    expect(window.sprites[1]!.control.reload).toBe(false);
  });

  it('opens range and stays dark while reloading', () => {
    const world = makeWorld();
    addBot(world, 1, { x: 0, y: 0 });
    addBot(world, 2, { x: 300, y: 0 });
    const c = world.sprites[1]!.control;
    newBrain().tick(1, makeCtx(world, { reloading: { 1: true } }));
    expect(c.left).toBe(true); // away from the enemy
    expect(c.jetpack).toBe(true); // cheap height
    expect(c.fire).toBe(false);
  });
});

describe('matador: aim', () => {
  it('VEL_EMA=1 (default) leads with instantaneous velocity', () => {
    const world = makeWorld();
    addBot(world, 1, { x: 0, y: 0 });
    addBot(world, 2, { x: 450, y: 0, vx: 0 });
    const c = world.sprites[1]!.control;
    const ctx = makeCtx(world);
    const brain = newBrain();
    brain.tick(1, ctx); // ema reset to tvx 0 on target switch
    world.spriteParts!.velocityX[2] = 4;
    world.mainTickCounter = 1;
    brain.tick(1, ctx); // ema = 0 + 1·(4−0) = 4 — fully instantaneous
    expect(c.mouseAimX).toBe(expectedAim(0, 0, 450, 0, 4, 0).x);
  });

  it('VEL_EMA<1 smooths the lead across ticks', () => {
    const world = makeWorld();
    addBot(world, 1, { x: 0, y: 0 });
    addBot(world, 2, { x: 450, y: 0, vx: 0 });
    const c = world.sprites[1]!.control;
    const ctx = makeCtx(world);
    const brain = newBrain({ VEL_EMA: 0.5 });
    brain.tick(1, ctx); // ema = 0
    world.spriteParts!.velocityX[2] = 4;
    world.mainTickCounter = 1;
    brain.tick(1, ctx); // ema = 0 + 0.5·4 = 2
    expect(c.mouseAimX).toBe(expectedAim(0, 0, 450, 0, 2, 0).x);
    expect(c.mouseAimX).toBeLessThan(expectedAim(0, 0, 450, 0, 4, 0).x);
  });

  it('keeps a finite zero aim when the bot stands on the target (dist 0)', () => {
    // Review note: tof degenerates to 0 here — the math stays exact (no NaN).
    const world = makeWorld();
    addBot(world, 1, { x: 0, y: 0 });
    addBot(world, 2, { x: 0, y: 0 });
    const c = world.sprites[1]!.control;
    newBrain().tick(1, makeCtx(world));
    expect(c.mouseAimX).toBe(0);
    expect(c.mouseAimY).toBe(0);
    expect(Number.isFinite(c.mouseAimX)).toBe(true);
    expect(Number.isFinite(c.mouseAimY)).toBe(true);
  });
});
